/**
 * Goal / Agent Graph durable supervisor。
 *
 * Graph 节点的 readiness、intent claim 和 wake 都落在 SQLite；模型只负责执行节点
 * prompt，不能通过伪造普通用户消息改变 graph 状态。
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { InteractiveRuntimeHandle } from "./InteractiveAgentRuntime.js";
import type { RuntimeEventAuthority, RuntimeRunStatus } from "./RuntimeAuthority.js";
import { isTaskRunTerminal, type DurableTaskRunStore, type TaskAttemptRecord, type TaskRunStatus } from "./TaskRunStore.js";
import { runTaskClosure } from "./TaskClosure.js";
import { readTaskDefinition, type TaskCommandExecutor } from "./taskVerification.js";

export type GoalStatus = "active" | "paused" | "completed" | "failed" | "blocked" | "cancelled";
export type GraphStatus = "draft" | "running" | "paused" | "completed" | "failed" | "blocked" | "cancelled";
export type GraphNodeStatus = "pending" | "ready" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export interface GoalRecord {
  goalId: string;
  workspaceId: string;
  title: string;
  status: GoalStatus;
  payload: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface GraphNodeInput {
  nodeKey: string;
  prompt: string;
  dependencies?: string[];
  intent?: unknown;
  verification?: unknown;
}

export interface GraphNodeRecord {
  nodeId: string;
  graphId: string;
  nodeKey: string;
  status: GraphNodeStatus;
  dependencies: string[];
  intent: unknown;
  taskRunId?: string;
  artifact?: unknown;
  revision: number;
}

export interface GraphRecord {
  graphId: string;
  workspaceId: string;
  goalId?: string;
  status: GraphStatus;
  revision: number;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
  nodes: GraphNodeRecord[];
}

export interface GraphClaim {
  claimId: string;
  graphId: string;
  nodeId: string;
  intentFingerprint: string;
  claimToken: string;
  status: string;
  claimedAt: string;
}

interface GoalRow {
  goal_id: unknown;
  workspace_id: unknown;
  title: unknown;
  status: unknown;
  payload_json: unknown;
  revision: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface GraphRow {
  graph_id: unknown;
  workspace_id: unknown;
  goal_id: unknown;
  status: unknown;
  revision: unknown;
  payload_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface NodeRow {
  node_id: unknown;
  graph_id: unknown;
  node_key: unknown;
  status: unknown;
  dependencies_json: unknown;
  intent_json: unknown;
  task_run_id: unknown;
  artifact_json: unknown;
  revision: unknown;
}

export class GoalGraphStore {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly authority: RuntimeEventAuthority
  ) {}

  static async open(persistenceRoot: string, authority: RuntimeEventAuthority): Promise<GoalGraphStore> {
    void persistenceRoot;
    return new GoalGraphStore(authority.databaseHandle(), authority);
  }

  createGoal(title: string, payload: unknown = {}, goalId: string = randomUUID()): GoalRecord {
    this.assertOpen();
    if (!title.trim()) throw new Error("Goal title cannot be empty.");
    const existing = this.getGoal(goalId);
    if (existing) return existing;
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: "goal:" + goalId + ":created",
      sessionId: "goal:" + goalId,
      invocationId: goalId,
      runId: "goal:" + goalId,
      turnId: "goal:" + goalId,
      eventType: "goal.created",
      payload: { title, payload },
      createdAt: now
    }, () => {
      this.database.prepare("INSERT INTO goals (goal_id, workspace_id, status, title, payload_json, created_at, updated_at, revision) VALUES (?, ?, 'active', ?, ?, ?, ?, 0)").run(goalId, this.authority.workspaceId, title.trim(), stringify(payload), now, now);
      return this.requireGoal(goalId);
    });
  }

  getGoal(goalId: string): GoalRecord | undefined {
    const row = this.database.prepare("SELECT goal_id, workspace_id, title, status, payload_json, revision, created_at, updated_at FROM goals WHERE goal_id = ? AND workspace_id = ?").get(goalId, this.authority.workspaceId) as unknown as GoalRow | undefined;
    return row ? toGoal(row) : undefined;
  }

  listGoals(): GoalRecord[] {
    const rows = this.database.prepare("SELECT goal_id, workspace_id, title, status, payload_json, revision, created_at, updated_at FROM goals WHERE workspace_id = ? ORDER BY created_at ASC").all(this.authority.workspaceId) as unknown as GoalRow[];
    return rows.map(toGoal);
  }

  updateGoal(goalId: string, status: GoalStatus): GoalRecord {
    const goal = this.requireGoal(goalId);
    if (goal.status === status) return goal;
    if (!isAllowedGoalTransition(goal.status, status)) {
      throw new Error(`Goal ${goalId} cannot transition from ${goal.status} to ${status}.`);
    }
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: "goal:" + goalId + ":revision:" + String(goal.revision + 1),
      sessionId: "goal:" + goalId,
      invocationId: goalId,
      runId: "goal:" + goalId,
      turnId: "goal:" + goalId,
      eventType: "goal.status",
      payload: { status },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE goals SET status = ?, revision = revision + 1, updated_at = ? WHERE goal_id = ?").run(status, now, goalId);
      return this.requireGoal(goalId);
    });
  }

  createGraph(goalId: string | undefined, nodes: readonly GraphNodeInput[], payload: unknown = {}, graphId: string = randomUUID()): GraphRecord {
    this.assertOpen();
    if (!nodes.length) throw new Error("Graph requires at least one node.");
    if (goalId !== undefined && !this.getGoal(goalId)) throw new Error("Graph goal does not exist.");
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: "graph:" + graphId + ":created",
      sessionId: "graph:" + graphId,
      invocationId: graphId,
      runId: "graph:" + graphId,
      turnId: "graph:" + graphId,
      eventType: "graph.created",
      payload: { goalId, nodes, payload },
      createdAt: now
    }, () => {
      this.database.prepare("INSERT INTO graphs (graph_id, workspace_id, goal_id, status, revision, payload_json, created_at, updated_at) VALUES (?, ?, ?, 'draft', 0, ?, ?, ?)").run(graphId, this.authority.workspaceId, goalId ?? null, stringify(payload), now, now);
      const insert = this.database.prepare("INSERT INTO graph_nodes (node_id, graph_id, node_key, status, dependencies_json, intent_json, revision) VALUES (?, ?, ?, 'pending', ?, ?, 0)");
      for (const node of nodes) {
        if (!node.nodeKey.trim() || !node.prompt.trim()) throw new Error("Graph node key and prompt cannot be empty.");
        const intent = node.intent ?? { prompt: node.prompt, verification: node.verification };
        readTaskDefinition(intent);
        insert.run(
          randomUUID(),
          graphId,
          node.nodeKey,
          stringify(node.dependencies ?? []),
          stringify(intent)
        );
      }
      return this.requireGraph(graphId);
    });
  }

  getGraph(graphId: string): GraphRecord | undefined {
    const row = this.database.prepare("SELECT graph_id, workspace_id, goal_id, status, revision, payload_json, created_at, updated_at FROM graphs WHERE graph_id = ? AND workspace_id = ?").get(graphId, this.authority.workspaceId) as unknown as GraphRow | undefined;
    return row ? { ...toGraph(row), nodes: this.nodes(graphId) } : undefined;
  }

  listGraphs(): GraphRecord[] {
    const rows = this.database.prepare("SELECT graph_id, workspace_id, goal_id, status, revision, payload_json, created_at, updated_at FROM graphs WHERE workspace_id = ? ORDER BY created_at ASC").all(this.authority.workspaceId) as unknown as GraphRow[];
    return rows.map((row) => ({ ...toGraph(row), nodes: this.nodes(stringValue(row.graph_id)) }));
  }

  startGraph(graphId: string): GraphRecord {
    return this.updateGraph(graphId, "running");
  }

  pauseGraph(graphId: string): GraphRecord {
    return this.updateGraph(graphId, "paused");
  }

  resumeGraph(graphId: string): GraphRecord {
    return this.updateGraph(graphId, "running");
  }

  cancelGraph(graphId: string): GraphRecord {
    const graph = this.updateGraph(graphId, "cancelled");
    for (const node of graph.nodes.filter((candidate) => candidate.status !== "completed" && candidate.status !== "failed" && candidate.status !== "cancelled")) {
      const now = new Date().toISOString();
      this.withGraphEvent({
        eventId: "graph:" + graphId + ":node:" + node.nodeId + ":cancelled:" + String(node.revision + 1),
        sessionId: "graph:" + graphId,
        invocationId: node.nodeId,
        runId: "graph:" + graphId,
        turnId: "graph:" + graphId,
        eventType: "graph.node.status",
        payload: { graphId, nodeId: node.nodeId, status: "cancelled", reason: "graph_cancelled" },
        createdAt: now
      }, () => {
        this.database.prepare("UPDATE graph_nodes SET status = 'cancelled', revision = revision + 1 WHERE graph_id = ? AND node_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')").run(graphId, node.nodeId);
        this.database.prepare("UPDATE graph_intent_claims SET status = 'cancelled' WHERE graph_id = ? AND node_id = ? AND status = 'claimed'").run(graphId, node.nodeId);
      });
    }
    if (graph.goalId !== undefined) {
      const goal = this.getGoal(graph.goalId);
      if (goal && goal.status !== "cancelled" && goal.status !== "completed" && goal.status !== "failed" && goal.status !== "blocked") {
        this.updateGoal(graph.goalId, "cancelled");
      }
    }
    return this.requireGraph(graphId);
  }

  inspectGraph(graphId: string): GraphRecord {
    return this.requireGraph(graphId);
  }

  readyNodes(graphId: string): GraphNodeRecord[] {
    const graph = this.requireGraph(graphId);
    if (graph.status !== "running") return [];
    return graph.nodes.filter((node) => node.status === "pending" || node.status === "ready").filter((node) => node.dependencies.every((dependency) => graph.nodes.find((candidate) => candidate.nodeKey === dependency)?.status === "completed"));
  }

  claimIntent(graphId: string, nodeId: string, claimToken = randomUUID(), taskRunId?: string): GraphClaim | undefined {
    const graph = this.requireGraph(graphId);
    const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new Error("Graph node does not exist.");
    if (node.status !== "pending" && node.status !== "ready") return undefined;
    if (!node.dependencies.every((dependency) => graph.nodes.find((candidate) => candidate.nodeKey === dependency)?.status === "completed")) return undefined;
    const fingerprint = createHash("sha256").update(JSON.stringify({ graphId, nodeId, intent: node.intent })).digest("hex");
    const existing = this.database.prepare("SELECT claim_id, graph_id, node_id, intent_fingerprint, claim_token, status, claimed_at FROM graph_intent_claims WHERE graph_id = ? AND node_id = ? AND intent_fingerprint = ?").get(graphId, nodeId, fingerprint) as Record<string, unknown> | undefined;
    if (existing && stringValue(existing.status) === "claimed") return toClaim(existing);
    const now = new Date().toISOString();
    const claimId = randomUUID();
    return this.withGraphEvent({
      eventId: "graph:" + graphId + ":intent:" + fingerprint + ":" + claimId,
      sessionId: "graph:" + graphId,
      invocationId: claimId,
      runId: "graph:" + graphId,
      turnId: "graph:" + graphId,
      eventType: "graph.intent.claimed",
      payload: { graphId, nodeId, fingerprint, claimToken },
      createdAt: now
    }, () => {
      if (existing) {
        this.database.prepare("UPDATE graph_intent_claims SET claim_id = ?, claim_token = ?, status = 'claimed', claimed_at = ? WHERE graph_id = ? AND node_id = ? AND intent_fingerprint = ?").run(claimId, claimToken, now, graphId, nodeId, fingerprint);
      } else {
        this.database.prepare("INSERT INTO graph_intent_claims (claim_id, graph_id, node_id, intent_fingerprint, claim_token, status, claimed_at) VALUES (?, ?, ?, ?, ?, 'claimed', ?)").run(claimId, graphId, nodeId, fingerprint, claimToken, now);
      }
      this.database.prepare("UPDATE graph_nodes SET status = 'running', task_run_id = ?, revision = revision + 1 WHERE graph_id = ? AND node_id = ? AND status IN ('pending', 'ready')").run(taskRunId ?? null, graphId, nodeId);
      return { claimId, graphId, nodeId, intentFingerprint: fingerprint, claimToken, status: "claimed", claimedAt: now };
    });
  }

  completeNode(graphId: string, nodeId: string, status: Exclude<GraphNodeStatus, "pending" | "ready" | "running">, artifact?: unknown, taskRunId?: string): GraphRecord {
    const graph = this.requireGraph(graphId);
    const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new Error("Graph node does not exist.");
    // 取消、失败或已完成的 Graph 不接受旧 AgentRun 的晚到结果；否则旧结果会把
    // cancelled 节点重新写成 completed，并进一步恢复整个 Graph 的终态。
    if (isGraphTerminal(graph.status) || node.status !== "running") return graph;
    const now = new Date().toISOString();
    this.withGraphEvent({
      eventId: "graph:" + graphId + ":node:" + nodeId + ":revision:" + String(node.revision + 1),
      sessionId: "graph:" + graphId,
      invocationId: taskRunId ?? nodeId,
      runId: taskRunId ?? "graph:" + graphId,
      turnId: "graph:" + graphId,
      eventType: "graph.node.status",
      payload: { graphId, nodeId, status, artifact, taskRunId },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE graph_nodes SET status = ?, artifact_json = ?, task_run_id = COALESCE(?, task_run_id), revision = revision + 1 WHERE graph_id = ? AND node_id = ? AND status = 'running'").run(status, stringifyOptional(artifact), taskRunId ?? null, graphId, nodeId);
      this.database.prepare("UPDATE graph_intent_claims SET status = ? WHERE graph_id = ? AND node_id = ? AND status = 'claimed'").run(status, graphId, nodeId);
    });
    return this.projectGraphStatus(graphId);
  }

  /** Host 启动时回收上一个进程留下的 running claim，避免 Graph 永久停滞。 */
  recoverRunningNodes(taskRuns?: DurableTaskRunStore): void {
    for (const graphId of this.listRunningGraphIds()) {
      const graph = this.requireGraph(graphId);
      for (const node of graph.nodes.filter((candidate) => candidate.status === "running")) {
        const task = node.taskRunId === undefined ? undefined : taskRuns?.get(node.taskRunId);
        const attempt = task?.attempts.at(-1);
        const runtimeRun = attempt === undefined ? undefined : this.authority.getRun(attempt.runId);
        const terminalStatus = runtimeRun?.terminalStatus ?? (task !== undefined && isTaskRunTerminal(task.status) ? task.status : undefined);
        const verificationEnabled = task === undefined ? false : readTaskDefinition(task.task).verification !== undefined;
        if (task?.status === "verifying") {
          // 候选产物已经落盘，退回 ready 后由同一闭环只恢复验收；不得把模型完成事件当作验收通过。
          this.recoverNode(graphId, node.nodeId, "ready", "Resuming persisted candidate verification after Host restart.", node.taskRunId);
          continue;
        }
        if (verificationEnabled && terminalStatus === "completed") {
          // TaskRun 可能已经持久化了完整通过证据，只是进程在 Graph 投影前退出。
          // 先退回 ready，由共享闭环重新核对契约、定义输入和产物指纹后再补投影。
          this.recoverNode(graphId, node.nodeId, "ready", "Reconciling persisted TaskRun verification after Host restart.", node.taskRunId);
          continue;
        }
        if (terminalStatus !== undefined) {
          if (taskRuns && task && !isTaskRunTerminal(task.status)) {
            try {
              taskRuns.transition(task.taskRunId, recoveredTaskStatus(terminalStatus), { attemptId: attempt?.attemptId });
            } catch {
              // Graph recovery must remain fail-closed if a concurrent task update won the race.
            }
          }
          this.completeNode(graphId, node.nodeId, recoveredNodeStatus(terminalStatus), { recovered: true, terminalStatus }, node.taskRunId);
          continue;
        }
        if (task === undefined || attempt === undefined || (runtimeRun === undefined && (task.status === "created" || task.status === "queued") && attempt.status === "queued")) {
          this.recoverNode(graphId, node.nodeId, "ready", "claim abandoned before AgentRun dispatch.");
          continue;
        }
        this.recoverNode(graphId, node.nodeId, "blocked", "Host restarted before the AgentRun outcome was proven.", node.taskRunId);
      }
    }
  }

  createWake(graphId: string, reason: string): string {
    this.requireGraph(graphId);
    const wakeId = randomUUID();
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: "graph:" + graphId + ":wake:" + wakeId + ":created",
      sessionId: "graph:" + graphId,
      invocationId: wakeId,
      runId: "graph:" + graphId,
      turnId: "graph:" + graphId,
      eventType: "graph.wake.created",
      payload: { graphId, wakeId, reason },
      createdAt: now
    }, () => {
      this.database.prepare("INSERT INTO graph_wakes (wake_id, graph_id, reason, status, attempt, created_at) VALUES (?, ?, ?, 'pending', 0, ?)").run(wakeId, graphId, reason, now);
      return wakeId;
    });
  }

  claimWake(graphId: string): string | undefined {
    this.requireGraph(graphId);
    const row = this.database.prepare("SELECT wake_id, reason, attempt FROM graph_wakes WHERE graph_id = ? AND status IN ('pending', 'claimed') ORDER BY created_at ASC LIMIT 1").get(graphId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const wakeId = stringValue(row.wake_id);
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: "graph:" + graphId + ":wake:" + wakeId + ":attempt:" + String(integerValue(row.attempt) + 1),
      sessionId: "graph:" + graphId,
      invocationId: wakeId,
      runId: "graph:" + graphId,
      turnId: "graph:" + graphId,
      eventType: "graph.wake.claimed",
      payload: { graphId, wakeId, reason: row.reason, attempt: integerValue(row.attempt) + 1 },
      createdAt: now
    }, () => {
      const result = this.database.prepare("UPDATE graph_wakes SET status = 'claimed', attempt = attempt + 1 WHERE wake_id = ? AND status IN ('pending', 'claimed') AND attempt = ?").run(wakeId, integerValue(row.attempt));
      return result.changes === 0 ? undefined : wakeId;
    });
  }

  completeWake(wakeId: string): void {
    const now = new Date().toISOString();
    const row = this.database.prepare("SELECT graph_id FROM graph_wakes WHERE wake_id = ?").get(wakeId) as Record<string, unknown> | undefined;
    if (!row) return;
    const graphId = stringValue(row.graph_id);
    this.withGraphEvent({
      eventId: "graph:" + graphId + ":wake:" + wakeId + ":completed",
      sessionId: "graph:" + graphId,
      invocationId: wakeId,
      runId: "graph:" + graphId,
      turnId: "graph:" + graphId,
      eventType: "graph.wake.completed",
      payload: { graphId, wakeId },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE graph_wakes SET status = 'completed', completed_at = ? WHERE wake_id = ? AND status = 'claimed'").run(now, wakeId);
    });
  }

  listRunningGraphIds(): string[] {
    const rows = this.database.prepare("SELECT graph_id FROM graphs WHERE workspace_id = ? AND status = 'running' ORDER BY created_at ASC").all(this.authority.workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => stringValue(row.graph_id));
  }

  listGraphEvents(graphId: string): ReturnType<RuntimeEventAuthority["readEvents"]> {
    return this.authority.readEvents({ runId: "graph:" + graphId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }

  private updateGraph(graphId: string, status: GraphStatus): GraphRecord {
    const graph = this.requireGraph(graphId);
    if (graph.status === status) return graph;
    if (!isAllowedGraphTransition(graph.status, status)) {
      throw new Error(`Graph ${graphId} cannot transition from ${graph.status} to ${status}.`);
    }
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: "graph:" + graphId + ":revision:" + String(graph.revision + 1),
      sessionId: "graph:" + graphId,
      invocationId: graphId,
      runId: "graph:" + graphId,
      turnId: "graph:" + graphId,
      eventType: "graph.status",
      payload: { status },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE graphs SET status = ?, revision = revision + 1, updated_at = ? WHERE graph_id = ?").run(status, now, graphId);
      return this.requireGraph(graphId);
    });
  }

  private projectGraphStatus(graphId: string): GraphRecord {
    const graph = this.requireGraph(graphId);
    if (isGraphTerminal(graph.status)) return graph;
    const statuses = graph.nodes.map((node) => node.status);
    const status: GraphStatus = statuses.every((nodeStatus) => nodeStatus === "completed")
      ? "completed"
      : statuses.some((nodeStatus) => nodeStatus === "failed")
        ? "failed"
        : statuses.some((nodeStatus) => nodeStatus === "blocked")
          ? "blocked"
          : graph.status;
    const projected = status === graph.status ? graph : this.updateGraph(graphId, status);
    if (projected.goalId !== undefined && (status === "completed" || status === "failed" || status === "blocked" || status === "cancelled")) {
      const goal = this.getGoal(projected.goalId);
      const goalStatus: GoalStatus = status === "completed" ? "completed" : status;
      if (goal && goal.status !== goalStatus) this.updateGoal(projected.goalId, goalStatus);
    }
    return projected;
  }

  /** 把 running 节点退回 ready/blocked 并放弃当前 claim；Host 重启回收与 supervisor 的 busy 重试共用。 */
  recoverNode(graphId: string, nodeId: string, status: "ready" | "blocked", reason: string, taskRunId?: string): GraphRecord {
    const graph = this.requireGraph(graphId);
    const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node || graph.status !== "running" || node.status !== "running") return graph;
    const now = new Date().toISOString();
    this.withGraphEvent({
      eventId: "graph:" + graphId + ":node:" + nodeId + ":recovered:" + String(node.revision + 1),
      sessionId: "graph:" + graphId,
      invocationId: taskRunId ?? nodeId,
      runId: taskRunId ?? "graph:" + graphId,
      turnId: "graph:" + graphId,
      eventType: "graph.node.recovered",
      payload: { graphId, nodeId, status, reason },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE graph_nodes SET status = ?, task_run_id = COALESCE(?, task_run_id), revision = revision + 1 WHERE graph_id = ? AND node_id = ? AND status = 'running'").run(status, taskRunId ?? null, graphId, nodeId);
      this.database.prepare("UPDATE graph_intent_claims SET status = 'abandoned' WHERE graph_id = ? AND node_id = ? AND status = 'claimed'").run(graphId, nodeId);
    });
    return this.projectGraphStatus(graphId);
  }

  private nodes(graphId: string): GraphNodeRecord[] {
    const rows = this.database.prepare("SELECT node_id, graph_id, node_key, status, dependencies_json, intent_json, task_run_id, artifact_json, revision FROM graph_nodes WHERE graph_id = ? ORDER BY rowid ASC").all(graphId) as unknown as NodeRow[];
    return rows.map(toNode);
  }

  private requireGoal(goalId: string): GoalRecord {
    const goal = this.getGoal(goalId);
    if (!goal) throw new Error("Goal " + goalId + " does not exist.");
    return goal;
  }

  private requireGraph(graphId: string): GraphRecord {
    const graph = this.getGraph(graphId);
    if (!graph) throw new Error("Graph " + graphId + " does not exist.");
    return graph;
  }

  private withGraphEvent<T>(input: {
    eventId: string;
    sessionId: string;
    invocationId: string;
    runId: string;
    turnId: string;
    eventType: string;
    payload: unknown;
    createdAt: string;
  }, execute: () => T): T {
    return this.authority.runEventTransaction(input, execute);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Goal graph store is closed.");
  }
}

export interface GraphSupervisorOptions {
  store?: GoalGraphStore;
  getStore?: () => GoalGraphStore;
  runtime?: InteractiveRuntimeHandle;
  getRuntime?: () => InteractiveRuntimeHandle;
  taskRuns?: DurableTaskRunStore;
  getTaskRuns?: () => DurableTaskRunStore | undefined;
  getTaskCommandExecutor?: () => TaskCommandExecutor | undefined;
  getWorkspaceRoot?: () => string;
  getWorkspaceIgnore?: () => readonly string[];
  tickMs?: number;
  concurrency?: number;
}

export class GraphSupervisor {
  private readonly tickMs: number;
  private readonly concurrency: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = 0;
  private stopped = false;

  constructor(private readonly options: GraphSupervisorOptions) {
    this.tickMs = options.tickMs ?? 1_000;
    const requestedConcurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
      throw new Error("Graph supervisor concurrency must be a positive integer.");
    }
    // 一个 InteractiveRuntimeHandle 同时只允许一个 AgentRun；并发 claim 会把
    // 第二个节点写成 running 后再因 runtime busy 失败，因此这里固定为串行调度。
    this.concurrency = 1;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.store().recoverRunningNodes(this.taskRuns());
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.tickMs);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.active >= this.concurrency) return;
    const store = this.store();
    const graphIds = store.listRunningGraphIds();
    for (const graphId of graphIds) {
      const wakeId = store.claimWake(graphId);
      for (const node of store.readyNodes(graphId)) {
        if (this.active >= this.concurrency) return;
        const claim = store.claimIntent(graphId, node.nodeId, randomUUID(), "graph:" + graphId + ":" + node.nodeId);
        if (!claim) continue;
        this.active += 1;
        void this.executeNode(graphId, node, claim).catch(() => undefined).finally(() => { this.active -= 1; });
      }
      if (wakeId !== undefined) store.completeWake(wakeId);
    }
  }

  private async executeNode(graphId: string, node: GraphNodeRecord, claim: GraphClaim): Promise<void> {
    let taskRunId: string | undefined;
    let attempt: TaskAttemptRecord | undefined;
    const store = this.store();
    const taskRuns = this.taskRuns();
    const runtime = this.runtime();
    try {
      // runtime 忙于交互会话或其他 run 不是节点执行失败：退回 ready，等后续 tick 重新 claim。
      if (runtime.getSnapshot().state.kind !== "idle") {
        store.recoverNode(graphId, node.nodeId, "ready", "Runtime is busy; node execution deferred.");
        return;
      }
      const parentRunId = "graph:" + graphId;
      const task = taskRuns?.create({ taskRunId: "graph:" + graphId + ":" + node.nodeId, task: node.intent, parentRunId });
      taskRunId = task?.taskRunId;
      if (!task || !taskRuns) {
        const runId = randomUUID();
        const turnId = randomUUID();
        const submitted = runtime.submitPrompt(String((node.intent as { prompt?: unknown })?.prompt ?? node.nodeKey), [], {
          runId,
          turnId,
          parentRunId,
          continuationSource: "graph:" + graphId + ":intent:" + claim.claimId
        });
        const outcome = await submitted.completion;
        if (outcome.status !== "completed") throw new Error(outcome.error ?? `Graph worker stopped with ${outcome.status}.`);
        store.completeNode(graphId, node.nodeId, "completed", { output: outcome.output }, taskRunId);
        return;
      }
      const executor = this.options.getTaskCommandExecutor?.() ?? {
        executeTaskCheck: async () => { throw new Error("Graph task verification runtime is unavailable."); }
      };
      const workspaceRoot = this.options.getWorkspaceRoot?.() ?? process.cwd();
      const result = await runTaskClosure({
        taskRuns,
        taskRunId: task.taskRunId,
        workspaceRoot,
        ignore: this.options.getWorkspaceIgnore?.() ?? [],
        executor,
        executeAttempt: async (prompt, currentAttempt) => {
          attempt = currentAttempt;
          const submitted = runtime.submitPrompt(prompt, [], {
            runId: currentAttempt.runId,
            turnId: currentAttempt.turnId,
            parentRunId,
            continuationSource: "graph:" + graphId + ":intent:" + claim.claimId
          });
          const outcome = await submitted.completion;
          if (outcome.status !== "completed") throw new Error(outcome.error ?? `Graph worker stopped with ${outcome.status}.`);
          return outcome.output;
        }
      });
      if (result.status === "completed") {
        store.completeNode(graphId, node.nodeId, "completed", { output: result.output, verification: result.evidence }, taskRunId);
      } else if (result.status === "blocked" || result.status === "cancelled") {
        store.completeNode(graphId, node.nodeId, "blocked", { error: result.reason, verification: result.evidence }, taskRunId);
      } else {
        store.completeNode(graphId, node.nodeId, "failed", { error: result.reason, verification: result.evidence }, taskRunId);
      }
    } catch (error) {
      // 空闲检查之后仍可能撞上 busy 竞态（本地 submit 同步抛错、Host 经 completion 异步拒绝）；
      // busy 一律退回 ready 重试，只有真实执行失败才允许把节点和 graph 判成 failed。
      if (isRuntimeBusyError(error)) {
        store.recoverNode(graphId, node.nodeId, "ready", "Runtime is busy; node execution deferred.");
        return;
      }
      this.transitionTask(taskRuns, taskRunId, "failed", attempt?.attemptId, { error: error instanceof Error ? error.message : String(error) });
      store.completeNode(graphId, node.nodeId, "failed", { error: error instanceof Error ? error.message : String(error) }, taskRunId);
    }
  }

  private transitionTask(
    taskRuns: DurableTaskRunStore | undefined,
    taskRunId: string | undefined,
    status: TaskRunStatus,
    attemptId?: string,
    failure?: unknown
  ): void {
    if (!taskRuns || taskRunId === undefined) return;
    try {
      const task = taskRuns.get(taskRunId);
      if (!task || isTaskRunTerminal(task.status)) return;
      taskRuns.transition(taskRunId, status, { attemptId, failure });
    } catch {
      // 取消或 Host 重启后的晚到结果不能再次改变 durable 终态。
    }
  }

  private runtime(): InteractiveRuntimeHandle {
    const runtime = this.options.getRuntime?.() ?? this.options.runtime;
    if (!runtime) throw new Error("Graph supervisor runtime is unavailable.");
    return runtime;
  }

  private store(): GoalGraphStore {
    const store = this.options.getStore?.() ?? this.options.store;
    if (!store) throw new Error("Graph supervisor store is unavailable.");
    return store;
  }

  private taskRuns(): DurableTaskRunStore | undefined {
    return this.options.getTaskRuns?.() ?? this.options.taskRuns;
  }
}

function toGoal(row: GoalRow): GoalRecord {
  return {
    goalId: stringValue(row.goal_id),
    workspaceId: stringValue(row.workspace_id),
    title: stringValue(row.title),
    status: goalStatus(row.status),
    payload: parse(row.payload_json),
    revision: integerValue(row.revision),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  };
}

function toGraph(row: GraphRow): Omit<GraphRecord, "nodes"> {
  return {
    graphId: stringValue(row.graph_id),
    workspaceId: stringValue(row.workspace_id),
    goalId: optionalString(row.goal_id),
    status: graphStatus(row.status),
    revision: integerValue(row.revision),
    payload: parse(row.payload_json),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  };
}

function toNode(row: NodeRow): GraphNodeRecord {
  return {
    nodeId: stringValue(row.node_id),
    graphId: stringValue(row.graph_id),
    nodeKey: stringValue(row.node_key),
    status: nodeStatus(row.status),
    dependencies: parse(row.dependencies_json) as string[],
    intent: parse(row.intent_json),
    taskRunId: optionalString(row.task_run_id),
    artifact: parseOptional(row.artifact_json),
    revision: integerValue(row.revision)
  };
}

function toClaim(row: Record<string, unknown>): GraphClaim {
  return {
    claimId: stringValue(row.claim_id),
    graphId: stringValue(row.graph_id),
    nodeId: stringValue(row.node_id),
    intentFingerprint: stringValue(row.intent_fingerprint),
    claimToken: stringValue(row.claim_token),
    status: stringValue(row.status),
    claimedAt: stringValue(row.claimed_at)
  };
}

function goalStatus(value: unknown): GoalStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "failed" || value === "blocked" || value === "cancelled") return value;
  throw new Error("Invalid goal status: " + String(value));
}

function graphStatus(value: unknown): GraphStatus {
  if (value === "draft" || value === "running" || value === "paused" || value === "completed" || value === "failed" || value === "blocked" || value === "cancelled") return value;
  throw new Error("Invalid graph status: " + String(value));
}

function nodeStatus(value: unknown): GraphNodeStatus {
  if (value === "pending" || value === "ready" || value === "running" || value === "completed" || value === "failed" || value === "blocked" || value === "cancelled") return value;
  throw new Error("Invalid graph node status: " + String(value));
}

function isGraphTerminal(status: GraphStatus): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "cancelled";
}

/** InteractiveAgentRuntime/Host 在 runtime 忙时抛出的 admission 错误；busy 是可重试信号，不是执行失败。 */
function isRuntimeBusyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("while the runtime is busy");
}

function isAllowedGoalTransition(from: GoalStatus, to: GoalStatus): boolean {
  if (isGoalTerminal(from)) return false;
  return (from === "active" || from === "paused")
    && (to === "active" || to === "paused" || isGoalTerminal(to));
}

function isGoalTerminal(status: GoalStatus): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "cancelled";
}

function isAllowedGraphTransition(from: GraphStatus, to: GraphStatus): boolean {
  if (isGraphTerminal(from)) return false;
  if (from === "draft") return to === "running" || to === "cancelled";
  if (from === "running") return to === "paused" || isGraphTerminal(to);
  if (from === "paused") return to === "running" || isGraphTerminal(to);
  return false;
}

function recoveredNodeStatus(status: TaskRunStatus | RuntimeRunStatus): Exclude<GraphNodeStatus, "pending" | "ready" | "running"> {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "aborted") return "blocked";
  return "blocked";
}

function recoveredTaskStatus(status: TaskRunStatus | RuntimeRunStatus): TaskRunStatus {
  if (status === "completed" || status === "failed" || status === "incomplete" || status === "blocked" || status === "policy_denied" || status === "budget_exhausted" || status === "needs_approval" || status === "aborted" || status === "cancelled") return status;
  return "blocked";
}

function stringify(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

function parseOptional(value: unknown): unknown {
  return value === null || value === undefined ? undefined : parse(value);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid graph storage string.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value);
}

function integerValue(value: unknown): number {
  const candidate = typeof value === "bigint" ? Number(value) : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) throw new Error("Invalid graph storage integer.");
  return candidate;
}
