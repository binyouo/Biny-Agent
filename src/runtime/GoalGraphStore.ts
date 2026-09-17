/**
 * Goal / Agent Graph durable supervisor。
 *
 * Graph 节点的 readiness、intent claim 和 wake 都落在 SQLite；模型只负责执行节点
 * prompt，不能通过伪造普通用户消息改变 graph 状态。
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { InteractiveRuntimeHandle } from "./InteractiveAgentRuntime.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import type { RuntimeEventAuthority, RuntimeRunStatus } from "./RuntimeAuthority.js";
import { isTaskRunTerminal, type DurableTaskRunStore, type TaskAttemptRecord, type TaskRunStatus } from "./TaskRunStore.js";
import { runTaskClosure, type TaskClosureResult } from "./TaskClosure.js";
import { readTaskDefinition, type TaskCommandExecutor } from "./taskVerification.js";
import { latestPlanNode, planBlock, planReviewResultSchema, planWorkPacket } from "./planWork.js";

export type GoalStatus = "active" | "paused" | "completed" | "failed" | "blocked" | "cancelled";
export type GraphStatus = "draft" | "running" | "paused" | "completed" | "failed" | "blocked" | "cancelled";
export type GraphNodeStatus = "pending" | "ready" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export type GraphMode = "fixed" | "supervised";
export type SupervisorCheckpoint = "needs_attention" | "settled";

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
  replacesNodeId?: string;
  revision: number;
}

export interface GraphRecord {
  graphId: string;
  workspaceId: string;
  goalId?: string;
  status: GraphStatus;
  mode: GraphMode;
  supervisorSessionId?: string;
  maxReplans: number;
  replanCount: number;
  revision: number;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
  nodes: GraphNodeRecord[];
}

export interface SupervisedGraphInput {
  goalId?: string;
  graphId?: string;
  supervisorSessionId: string;
  supervisorRunId?: string;
  nodes: readonly GraphNodeInput[];
  payload?: unknown;
  maxReplans?: number;
}

export interface GraphWakeRecord {
  wakeId: string;
  graphId: string;
  kind: "dispatch" | "supervisor";
  reason: string;
  status: "pending" | "claimed" | "completed" | "discarded" | "blocked";
  attempt: number;
  graphRevision?: number;
  checkpoint?: SupervisorCheckpoint;
  sessionId?: string;
  runId?: string;
  createdAt: string;
  completedAt?: string;
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
  mode: unknown;
  supervisor_session_id: unknown;
  max_replans: unknown;
  replan_count: unknown;
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
  replaces_node_id: unknown;
  revision: unknown;
}

export class GoalGraphStore {
  private closed = false;
  private readonly changeListeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

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
    return this.createGraphRecord({ goalId, nodes, payload, graphId, mode: "fixed", maxReplans: 0 });
  }

  createSupervisedGraph(input: SupervisedGraphInput): GraphRecord {
    const sessionId = input.supervisorSessionId.trim();
    if (!sessionId) throw new Error("Supervised graph requires a supervisor session.");
    const maxReplans = input.maxReplans ?? 2;
    if (!Number.isSafeInteger(maxReplans) || maxReplans < 0 || maxReplans > 2) {
      throw new Error("Supervised graph maxReplans must be between 0 and 2.");
    }
    return this.createGraphRecord({
      goalId: input.goalId,
      nodes: input.nodes,
      payload: input.payload ?? {},
      graphId: input.graphId ?? randomUUID(),
      mode: "supervised",
      supervisorSessionId: sessionId,
      supervisorRunId: input.supervisorRunId,
      maxReplans
    });
  }

  private createGraphRecord(input: {
    goalId?: string;
    nodes: readonly GraphNodeInput[];
    payload: unknown;
    graphId: string;
    mode: GraphMode;
    supervisorSessionId?: string;
    supervisorRunId?: string;
    maxReplans: number;
  }): GraphRecord {
    this.assertOpen();
    validateGraphNodes(input.nodes, 20);
    if (input.goalId !== undefined && !this.getGoal(input.goalId)) throw new Error("Graph goal does not exist.");
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: "graph:" + input.graphId + ":created",
      sessionId: "graph:" + input.graphId,
      invocationId: input.graphId,
      runId: "graph:" + input.graphId,
      turnId: "graph:" + input.graphId,
      eventType: "graph.created",
      payload: {
        goalId: input.goalId,
        nodes: input.nodes,
        payload: input.payload,
        mode: input.mode,
        supervisorSessionId: input.supervisorSessionId,
        supervisorRunId: input.supervisorRunId,
        maxReplans: input.maxReplans
      },
      createdAt: now
    }, () => {
      this.database.prepare(`
        INSERT INTO graphs (
          graph_id, workspace_id, goal_id, status, mode, supervisor_session_id,
          max_replans, replan_count, revision, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, 0, 0, ?, ?, ?)
      `).run(
        input.graphId,
        this.authority.workspaceId,
        input.goalId ?? null,
        input.mode,
        input.supervisorSessionId ?? null,
        input.maxReplans,
        stringify(input.payload),
        now,
        now
      );
      const insert = this.database.prepare("INSERT INTO graph_nodes (node_id, graph_id, node_key, status, dependencies_json, intent_json, replaces_node_id, revision) VALUES (?, ?, ?, 'pending', ?, ?, NULL, 0)");
      for (const node of input.nodes) {
        const intent = node.intent ?? { prompt: node.prompt, verification: node.verification };
        readTaskDefinition(intent);
        insert.run(
          randomUUID(),
          input.graphId,
          node.nodeKey,
          stringify(node.dependencies ?? []),
          stringify(intent)
        );
      }
      return this.requireGraph(input.graphId);
    });
  }

  getGraph(graphId: string): GraphRecord | undefined {
    const row = this.database.prepare("SELECT graph_id, workspace_id, goal_id, status, mode, supervisor_session_id, max_replans, replan_count, revision, payload_json, created_at, updated_at FROM graphs WHERE graph_id = ? AND workspace_id = ?").get(graphId, this.authority.workspaceId) as unknown as GraphRow | undefined;
    return row ? { ...toGraph(row), nodes: this.nodes(graphId) } : undefined;
  }

  listGraphs(): GraphRecord[] {
    const rows = this.database.prepare("SELECT graph_id, workspace_id, goal_id, status, mode, supervisor_session_id, max_replans, replan_count, revision, payload_json, created_at, updated_at FROM graphs WHERE workspace_id = ? ORDER BY created_at ASC").all(this.authority.workspaceId) as unknown as GraphRow[];
    return rows.map((row) => ({ ...toGraph(row), nodes: this.nodes(stringValue(row.graph_id)) }));
  }

  startGraph(graphId: string): GraphRecord {
    return this.updateGraph(graphId, "running");
  }

  startSupervisedDraft(graphId: string, sessionId: string, revision: number): GraphRecord {
    const graph = this.requireGraph(graphId);
    if (graph.mode !== "supervised" || graph.supervisorSessionId !== sessionId) throw new Error("Plan belongs to another session.");
    if (graph.status !== "draft" || graph.revision !== revision) throw new Error("Plan revision changed or plan already started.");
    return this.startGraph(graphId);
  }

  reviseSupervisedDraft(graphId: string, sessionId: string, revision: number, nodes: GraphNodeInput[], payload: unknown): GraphRecord {
    const graph = this.requireGraph(graphId);
    if (graph.supervisorSessionId !== sessionId || graph.mode !== "supervised") throw new Error("Plan belongs to another session.");
    if (graph.status !== "draft" || graph.revision !== revision) throw new Error("Only the current draft revision may be edited.");
    validateGraphNodes(nodes, 20);
    for (const node of nodes) readTaskDefinition(node.intent);
    const now = new Date().toISOString();
    return this.withGraphEvent({ eventId: `graph:${graphId}:draft:${revision + 1}`, sessionId, invocationId: graphId, runId: `graph:${graphId}`, turnId: `graph:${graphId}`, eventType: "graph.draft.updated", payload: { nodes, payload }, createdAt: now }, () => {
      // 草稿从未派发，无执行历史；旧草稿全文保留在追加事件中。
      this.database.prepare("DELETE FROM graph_nodes WHERE graph_id = ?").run(graphId);
      for (const node of nodes) this.database.prepare("INSERT INTO graph_nodes (node_id, graph_id, node_key, status, dependencies_json, intent_json, revision) VALUES (?, ?, ?, 'pending', ?, ?, 0)")
        .run(randomUUID(), graphId, node.nodeKey, stringify(node.dependencies ?? []), stringify(node.intent));
      this.database.prepare("UPDATE graphs SET payload_json = ?, revision = revision + 1, updated_at = ? WHERE graph_id = ?").run(stringify(payload), now, graphId);
      return this.requireGraph(graphId);
    });
  }

  reworkSupervisedNode(graphId: string, sessionId: string, nodeId: string): GraphRecord {
    const graph = this.requireSupervisedGraph(graphId, sessionId);
    this.assertReplanAvailable(graph);
    const review = graph.nodes.find((node) => node.nodeId === nodeId);
    if (!review || planBlock(review.intent)?.kind !== "review" || review.status !== "blocked") throw new Error("Rework requires a rejected review.");
    if (graph.nodes.some((node) => node.replacesNodeId === nodeId)) throw new Error("Review already has a replacement.");
    const parsedFeedback = planReviewResultSchema.safeParse((review.artifact as { review?: unknown } | undefined)?.review);
    if (!parsedFeedback.success || parsedFeedback.data.verdict !== "needs_changes") throw new Error("Rework requires persisted needs_changes evidence.");
    const feedback = parsedFeedback.data;
    const source = latestPlanNode(graph, planBlock(review.intent)!.reviewTarget!);
    const key = `${source.nodeKey}:repair-${graph.replanCount + 1}`;
    const replacementKey = `${review.nodeKey}:retry-${graph.replanCount + 1}`;
    const repairIntent = { ...source.intent as object, prompt: `${readTaskDefinition(source.intent).prompt}\n\nRequired changes (keep original acceptance):\n${JSON.stringify(feedback)}`, planBlock: { ...planBlock(source.intent), rework: true } };
    const reviewIntent = { ...review.intent as object, planBlock: { ...planBlock(review.intent), reviewTarget: key, rework: true } };
    const additions = [
      { nodeKey: key, prompt: repairIntent.prompt, dependencies: source.dependencies, intent: repairIntent },
      { nodeKey: replacementKey, prompt: readTaskDefinition(review.intent).prompt, dependencies: [key], intent: reviewIntent }
    ];
    validateGraphNodes([...graph.nodes.map(nodeInputFromRecord), ...additions], 20);
    const now = new Date().toISOString();
    return this.withGraphEvent({ eventId: `graph:${graphId}:replan:${graph.replanCount + 1}:rework`, sessionId, invocationId: graphId, runId: `graph:${graphId}`, turnId: `graph:${graphId}`, eventType: "graph.replanned", payload: { action: "rework", nodeId, additions }, createdAt: now }, () => {
      for (const [index, node] of additions.entries()) this.database.prepare("INSERT INTO graph_nodes (node_id, graph_id, node_key, status, dependencies_json, intent_json, replaces_node_id, revision) VALUES (?, ?, ?, 'pending', ?, ?, ?, 0)")
        .run(randomUUID(), graphId, node.nodeKey, stringify(node.dependencies ?? []), stringify(node.intent), index === 1 ? nodeId : null);
      this.database.prepare("UPDATE graphs SET replan_count = replan_count + 1, revision = revision + 1, updated_at = ? WHERE graph_id = ?").run(now, graphId);
      return this.requireGraph(graphId);
    });
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

  addSupervisedNodes(graphId: string, sessionId: string, nodes: readonly GraphNodeInput[]): GraphRecord {
    const graph = this.requireSupervisedGraph(graphId, sessionId);
    this.assertReplanAvailable(graph);
    if (!nodes.length) throw new Error("Plan add requires at least one node.");
    validateGraphNodes([...graph.nodes.map(nodeInputFromRecord), ...nodes], 20);
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: `graph:${graphId}:replan:${String(graph.replanCount + 1)}:add`,
      sessionId: graph.supervisorSessionId!,
      invocationId: graphId,
      runId: `graph:${graphId}`,
      turnId: `graph:${graphId}`,
      eventType: "graph.replanned",
      payload: { action: "add", nodes },
      createdAt: now
    }, () => {
      const insert = this.database.prepare("INSERT INTO graph_nodes (node_id, graph_id, node_key, status, dependencies_json, intent_json, replaces_node_id, revision) VALUES (?, ?, ?, 'pending', ?, ?, NULL, 0)");
      for (const node of nodes) {
        const intent = node.intent ?? { prompt: node.prompt, verification: node.verification };
        readTaskDefinition(intent);
        insert.run(randomUUID(), graphId, node.nodeKey, stringify(node.dependencies ?? []), stringify(intent));
      }
      this.database.prepare("UPDATE graphs SET replan_count = replan_count + 1, revision = revision + 1, updated_at = ? WHERE graph_id = ?").run(now, graphId);
      return this.requireGraph(graphId);
    });
  }

  replaceSupervisedNode(
    graphId: string,
    sessionId: string,
    nodeId: string,
    replacement: { nodeKey: string; prompt: string }
  ): GraphRecord {
    const graph = this.requireSupervisedGraph(graphId, sessionId);
    this.assertReplanAvailable(graph);
    const source = graph.nodes.find((node) => node.nodeId === nodeId);
    if (!source) throw new Error(`Graph node ${nodeId} does not exist.`);
    if (source.status !== "failed" && source.status !== "blocked" && source.status !== "cancelled") {
      throw new Error("Only failed, blocked, or cancelled work can be replaced.");
    }
    if (graph.nodes.some((node) => node.replacesNodeId === source.nodeId)) {
      throw new Error(`Graph node ${nodeId} already has a replacement.`);
    }
    const sourceDefinition = readTaskDefinition(source.intent);
    const intent = {
      ...(typeof source.intent === "object" && source.intent !== null ? source.intent : {}),
      prompt: replacement.prompt,
      verification: sourceDefinition.verification
    };
    const replacementInput: GraphNodeInput = {
      nodeKey: replacement.nodeKey,
      prompt: replacement.prompt,
      dependencies: [...source.dependencies],
      intent
    };
    validateGraphNodes([...graph.nodes.map(nodeInputFromRecord), replacementInput], 20);
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: `graph:${graphId}:replan:${String(graph.replanCount + 1)}:replace`,
      sessionId: graph.supervisorSessionId!,
      invocationId: graphId,
      runId: `graph:${graphId}`,
      turnId: `graph:${graphId}`,
      eventType: "graph.replanned",
      payload: { action: "replace", nodeId, replacement: replacementInput },
      createdAt: now
    }, () => {
      this.database.prepare("INSERT INTO graph_nodes (node_id, graph_id, node_key, status, dependencies_json, intent_json, replaces_node_id, revision) VALUES (?, ?, ?, 'pending', ?, ?, ?, 0)").run(
        randomUUID(),
        graphId,
        replacement.nodeKey,
        stringify(source.dependencies),
        stringify(intent),
        source.nodeId
      );
      this.database.prepare("UPDATE graphs SET replan_count = replan_count + 1, revision = revision + 1, updated_at = ? WHERE graph_id = ?").run(now, graphId);
      return this.requireGraph(graphId);
    });
  }

  finishSupervisedGraph(
    graphId: string,
    sessionId: string,
    status: "completed" | "failed" | "blocked",
    summary?: string
  ): GraphRecord {
    const graph = this.requireSupervisedGraph(graphId, sessionId);
    const current = currentGraphNodes(graph);
    const active = current.some((node) => node.status === "running"
      || node.status === "ready"
      || (node.status === "pending" && node.dependencies.every((dependency) => dependencyCompleted(graph, dependency))));
    if (active) throw new Error("A supervised graph cannot finish while current work is runnable or running.");
    if (status === "completed" && !current.length) throw new Error("A supervised graph cannot finish without current work.");
    if (status === "completed" && current.some((node) => node.status !== "completed")) {
      throw new Error("A supervised graph can complete only after every current node has passed.");
    }
    const finished = this.updateGraph(graphId, status, summary === undefined ? undefined : { summary });
    if (finished.goalId !== undefined) {
      const goal = this.getGoal(finished.goalId);
      const goalStatus: GoalStatus = status === "completed" ? "completed" : status;
      if (goal && goal.status !== goalStatus) this.updateGoal(finished.goalId, goalStatus);
    }
    return this.requireGraph(graphId);
  }

  readyNodes(graphId: string): GraphNodeRecord[] {
    const graph = this.requireGraph(graphId);
    if (graph.status !== "running") return [];
    return currentGraphNodes(graph)
      .filter((node) => node.status === "pending" || node.status === "ready")
      .filter((node) => node.dependencies.every((dependency) => dependencyCompleted(graph, dependency)))
      .sort((left, right) => Number(planBlock(right.intent)?.rework ?? false) - Number(planBlock(left.intent)?.rework ?? false));
  }

  claimIntent(graphId: string, nodeId: string, claimToken = randomUUID(), taskRunId?: string): GraphClaim | undefined {
    const graph = this.requireGraph(graphId);
    if (graph.status !== "running") return undefined;
    const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new Error("Graph node does not exist.");
    if (node.status !== "pending" && node.status !== "ready") return undefined;
    if (!node.dependencies.every((dependency) => dependencyCompleted(graph, dependency))) return undefined;
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
      this.touchGraph(graphId, now);
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
      this.touchGraph(graphId, now);
    });
    const projected = this.projectGraphStatus(graphId);
    this.queueCurrentSupervisorCheckpoint(projected);
    return this.requireGraph(graphId);
  }

  /** task.approve 复用 TaskRun 闭环后，由 Graph 自己补齐唯一的节点投影。 */
  projectTaskClosure(taskRunId: string, result: TaskClosureResult): GraphRecord | undefined {
    const row = this.database.prepare(`
      SELECT graph_id, node_id FROM graph_nodes
      WHERE task_run_id = ? AND status = 'running'
    `).get(taskRunId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const graphId = stringValue(row.graph_id);
    const nodeId = stringValue(row.node_id);
    if (result.review) return this.completeNode(graphId, nodeId, result.review.verdict === "passed" ? "completed" : "blocked", { output: result.output, review: result.review }, taskRunId);
    if (result.status === "needs_approval") return this.noteSupervisorCheckpoint(graphId, "needs_attention");
    if (result.status === "completed") {
      return this.completeNode(graphId, nodeId, "completed", { output: result.output, verification: result.evidence }, taskRunId);
    }
    if (result.status === "blocked" || result.status === "cancelled") {
      return this.completeNode(graphId, nodeId, "blocked", { error: result.reason, verification: result.evidence }, taskRunId);
    }
    return this.completeNode(graphId, nodeId, "failed", { error: result.reason, verification: result.evidence }, taskRunId);
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
        const definition = task === undefined ? undefined : readTaskDefinition(task.task);
        const closureRequired = Boolean(definition?.verification || definition?.review || definition?.reportOnly);
        if (task?.status === "needs_approval") {
          // 权限等待已经持久化；保留 running 节点与 claim，等待 task.approve 精确恢复同一 Attempt。
          continue;
        }
        if (task?.status === "verifying") {
          // 候选产物或报告已经落盘，退回 ready 后只恢复闭环；不得把模型完成事件当作验收通过。
          this.recoverNode(graphId, node.nodeId, "ready", "Resuming persisted candidate verification after Host restart.", node.taskRunId);
          continue;
        }
        if (closureRequired && terminalStatus === "completed") {
          // TaskRun 已有证据或报告，但进程可能在 Graph 投影前退出。
          // 先退回 ready，由共享闭环核对持久产出；验收任务还需重新核对指纹。
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

  noteSupervisorCheckpoint(graphId: string, checkpoint: SupervisorCheckpoint): GraphRecord {
    const graph = this.requireGraph(graphId);
    if (graph.mode !== "supervised" || graph.status !== "running") return graph;
    const now = new Date().toISOString();
    this.touchGraph(graphId, now);
    const current = this.requireGraph(graphId);
    this.createSupervisorWake(current, checkpoint);
    return current;
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
      this.database.prepare("INSERT INTO graph_wakes (wake_id, graph_id, reason, kind, status, attempt, created_at) VALUES (?, ?, ?, 'dispatch', 'pending', 0, ?)").run(wakeId, graphId, reason, now);
      return wakeId;
    });
  }

  claimWake(graphId: string): string | undefined {
    this.requireGraph(graphId);
    const row = this.database.prepare("SELECT wake_id, reason, attempt FROM graph_wakes WHERE graph_id = ? AND kind = 'dispatch' AND status IN ('pending', 'claimed') ORDER BY created_at ASC LIMIT 1").get(graphId) as Record<string, unknown> | undefined;
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

  listSupervisorWakes(): GraphWakeRecord[] {
    const rows = this.database.prepare(`
      SELECT wake_id, graph_id, kind, reason, status, attempt, graph_revision,
             checkpoint, session_id, run_id, created_at, completed_at
      FROM graph_wakes
      WHERE kind = 'supervisor' AND status IN ('pending', 'claimed')
      ORDER BY created_at ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map(toWake);
  }

  claimSupervisorWake(wakeId: string): GraphWakeRecord | undefined {
    const row = this.database.prepare(`
      SELECT wake_id, graph_id, kind, reason, status, attempt, graph_revision,
             checkpoint, session_id, run_id, created_at, completed_at
      FROM graph_wakes WHERE wake_id = ? AND kind = 'supervisor'
    `).get(wakeId) as Record<string, unknown> | undefined;
    if (!row || (row.status !== "pending" && row.status !== "claimed")) return undefined;
    const wake = toWake(row);
    const graph = this.getGraph(wake.graphId);
    if (!graph || graph.status !== "running" || graph.mode !== "supervised" || graph.revision !== wake.graphRevision || graph.supervisorSessionId !== wake.sessionId) {
      this.finishSupervisorWake(wakeId, "discarded");
      return undefined;
    }
    const now = new Date().toISOString();
    return this.withGraphEvent({
      eventId: `graph:${wake.graphId}:supervisor-wake:${wakeId}:attempt:${String(wake.attempt + 1)}`,
      sessionId: wake.sessionId ?? `graph:${wake.graphId}`,
      invocationId: wakeId,
      runId: `graph:${wake.graphId}`,
      turnId: `graph:${wake.graphId}`,
      eventType: "graph.supervisor_wake.claimed",
      payload: { wakeId, graphId: wake.graphId, attempt: wake.attempt + 1, runId: wake.runId },
      createdAt: now
    }, () => {
      const result = this.database.prepare("UPDATE graph_wakes SET status = 'claimed', attempt = attempt + 1 WHERE wake_id = ? AND status IN ('pending', 'claimed') AND attempt = ?").run(wakeId, wake.attempt);
      return result.changes === 0 ? undefined : { ...wake, status: "claimed", attempt: wake.attempt + 1 };
    });
  }

  finishSupervisorWake(wakeId: string, status: "completed" | "discarded" | "blocked"): void {
    const now = new Date().toISOString();
    const row = this.database.prepare("SELECT graph_id, session_id, run_id, status FROM graph_wakes WHERE wake_id = ? AND kind = 'supervisor'").get(wakeId) as Record<string, unknown> | undefined;
    if (!row || (row.status !== "pending" && row.status !== "claimed")) return;
    const graphId = stringValue(row.graph_id);
    this.withGraphEvent({
      eventId: `graph:${graphId}:supervisor-wake:${wakeId}:${status}`,
      sessionId: optionalString(row.session_id) ?? `graph:${graphId}`,
      invocationId: wakeId,
      runId: `graph:${graphId}`,
      turnId: `graph:${graphId}`,
      eventType: "graph.supervisor_wake.finished",
      payload: { wakeId, graphId, status, runId: optionalString(row.run_id) },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE graph_wakes SET status = ?, completed_at = ? WHERE wake_id = ? AND kind = 'supervisor' AND status IN ('pending', 'claimed')").run(status, now, wakeId);
    });
  }

  runtimeRun(runId: string): ReturnType<RuntimeEventAuthority["getRun"]> {
    return this.authority.getRun(runId);
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

  private updateGraph(graphId: string, status: GraphStatus, terminalPayload?: unknown): GraphRecord {
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
      payload: { status, terminalPayload },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE graphs SET status = ?, revision = revision + 1, updated_at = ? WHERE graph_id = ?").run(status, now, graphId);
      return this.requireGraph(graphId);
    });
  }

  private projectGraphStatus(graphId: string): GraphRecord {
    const graph = this.requireGraph(graphId);
    if (isGraphTerminal(graph.status)) return graph;
    // supervised Graph 的节点终态只是监督检查点，不能替主 Agent宣告用户目标完成。
    if (graph.mode === "supervised") return graph;
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
      this.touchGraph(graphId, now);
    });
    const projected = this.projectGraphStatus(graphId);
    this.queueCurrentSupervisorCheckpoint(projected);
    return this.requireGraph(graphId);
  }

  private nodes(graphId: string): GraphNodeRecord[] {
    const rows = this.database.prepare("SELECT node_id, graph_id, node_key, status, dependencies_json, intent_json, task_run_id, artifact_json, replaces_node_id, revision FROM graph_nodes WHERE graph_id = ? ORDER BY rowid ASC").all(graphId) as unknown as NodeRow[];
    return rows.map(toNode);
  }

  private requireSupervisedGraph(graphId: string, sessionId: string): GraphRecord {
    const graph = this.requireGraph(graphId);
    if (graph.mode !== "supervised") throw new Error(`Graph ${graphId} is not supervised.`);
    if (graph.supervisorSessionId !== sessionId) throw new Error(`Graph ${graphId} belongs to another session.`);
    if (graph.status !== "running") throw new Error(`Supervised graph ${graphId} is not running.`);
    return graph;
  }

  private assertReplanAvailable(graph: GraphRecord): void {
    if (graph.replanCount >= graph.maxReplans) {
      throw new Error(`Supervised graph ${graph.graphId} reached its replan limit (${String(graph.maxReplans)}).`);
    }
  }

  private touchGraph(graphId: string, now = new Date().toISOString()): void {
    this.database.prepare("UPDATE graphs SET revision = revision + 1, updated_at = ? WHERE graph_id = ?").run(now, graphId);
  }

  /** 展示与调度共享同一检查点定义，审批事实只读取 TaskRun，不复制到节点状态。 */
  supervisorCheckpoint(graph: GraphRecord): SupervisorCheckpoint | undefined {
    if (graph.mode !== "supervised" || graph.status !== "running") return undefined;
    const current = currentGraphNodes(graph);
    const pendingApproval = current.some((node) => node.taskRunId !== undefined
      && this.database.prepare("SELECT 1 FROM task_runs WHERE task_run_id = ? AND status = 'needs_approval'").get(node.taskRunId) !== undefined);
    return pendingApproval || current.some((node) => node.status === "failed" || node.status === "blocked" || node.status === "cancelled")
      ? "needs_attention"
      : current.every((node) => node.status === "completed")
        ? "settled"
        : current.some((node) => node.status === "running" || node.status === "ready" || (node.status === "pending" && node.dependencies.every((dependency) => dependencyCompleted(graph, dependency))))
          ? undefined
          : "settled";
  }

  private queueCurrentSupervisorCheckpoint(graph: GraphRecord): void {
    const checkpoint = this.supervisorCheckpoint(graph);
    if (checkpoint) this.createSupervisorWake(this.requireGraph(graph.graphId), checkpoint);
  }

  private createSupervisorWake(graph: GraphRecord, checkpoint: SupervisorCheckpoint): string {
    if (graph.mode !== "supervised" || graph.supervisorSessionId === undefined) {
      throw new Error("Supervisor wake requires a supervised graph with a session.");
    }
    const supervisorSessionId = graph.supervisorSessionId;
    const identity = `${graph.graphId}\0${String(graph.revision)}\0${checkpoint}\0${supervisorSessionId}`;
    const fingerprint = createHash("sha256").update(identity).digest("hex");
    const wakeId = `supervisor:${fingerprint}`;
    const runId = `plan-wake:${fingerprint}`;
    const now = new Date().toISOString();
    this.withGraphEvent({
      eventId: `graph:${graph.graphId}:supervisor:${fingerprint}:created`,
      sessionId: supervisorSessionId,
      invocationId: wakeId,
      runId: `graph:${graph.graphId}`,
      turnId: `graph:${graph.graphId}`,
      eventType: "graph.supervisor_wake.created",
      payload: { graphId: graph.graphId, graphRevision: graph.revision, checkpoint, sessionId: supervisorSessionId, runId },
      createdAt: now
    }, () => {
      this.database.prepare(`
        INSERT OR IGNORE INTO graph_wakes (
          wake_id, graph_id, reason, kind, graph_revision, checkpoint,
          session_id, run_id, status, attempt, created_at
        ) VALUES (?, ?, ?, 'supervisor', ?, ?, ?, ?, 'pending', 0, ?)
      `).run(wakeId, graph.graphId, checkpoint, graph.revision, checkpoint, supervisorSessionId, runId, now);
    });
    return wakeId;
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
    const result = this.authority.runEventTransaction(input, execute);
    if (!input.eventType.startsWith("graph.wake.")) {
      for (const listener of this.changeListeners) queueMicrotask(listener);
    }
    return result;
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
  resolveSupervisorRuntime?: (sessionId: string) => Promise<InteractiveRuntimeHandle>;
  resolveSupervisorCommands?: (sessionId: string) => Promise<CommandRuntime>;
  supervisorSessionExists?: (sessionId: string) => Promise<boolean>;
}

export class GraphSupervisor {
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private started = false;
  private scanning = false;
  private active = 0;
  private stopped = false;

  constructor(private readonly options: GraphSupervisorOptions) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.store().recoverRunningNodes(this.taskRuns());
    this.requestTick();
  }

  /** Host 写操作、工具完成及会话恢复空闲时唤醒；合并同一批通知，不维护另一份队列。 */
  requestTick(): void {
    if (!this.started || this.stopped || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      void this.tick().catch(() => undefined);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.active || this.scanning) return;
    this.scanning = true;
    try {
      await this.scan();
    } finally {
      this.scanning = false;
    }
  }

  private async scan(): Promise<void> {
    const store = this.store();
    // 先交付已有检查点，再派发新工作；否则独立 ready 节点会推迟审批通知，
    // 甚至不断推进 revision，使等待交付的监督唤醒过期。繁忙会话仍跳过，不抢 writer。
    for (const wake of store.listSupervisorWakes()) {
      if (this.active || this.stopped) return;
      if (!wake.sessionId || !wake.runId || !wake.checkpoint || wake.graphRevision === undefined) {
        store.finishSupervisorWake(wake.wakeId, "blocked");
        continue;
      }
      if (this.options.supervisorSessionExists && !await this.options.supervisorSessionExists(wake.sessionId)) {
        store.finishSupervisorWake(wake.wakeId, "discarded");
        continue;
      }
      const runtime = await this.supervisorRuntime(wake.sessionId);
      if (this.stopped) return;
      if (runtime.getSnapshot().state.kind !== "idle" || runtime.getSnapshot().info.planning) continue;
      const claimed = store.claimSupervisorWake(wake.wakeId);
      if (!claimed) continue;
      this.active += 1;
      void this.executeSupervisorWake(claimed, runtime).catch(() => {
        store.finishSupervisorWake(claimed.wakeId, "blocked");
      }).finally(() => {
        this.active -= 1;
        this.requestTick();
      });
      return;
    }
    for (const graphId of store.listRunningGraphIds()) {
      const ready = store.readyNodes(graphId);
      if (!ready.length) continue;
      const graph = store.inspectGraph(graphId);
      const runtime = graph.supervisorSessionId === undefined
        ? this.runtime()
        : await this.supervisorRuntime(graph.supervisorSessionId);
      if (this.stopped) return;
      if (runtime.getSnapshot().state.kind !== "idle" || runtime.getSnapshot().info.planning) continue;
      for (const node of ready) {
        const claim = store.claimIntent(graphId, node.nodeId, randomUUID(), "graph:" + graphId + ":" + node.nodeId);
        if (!claim) continue;
        const wakeId = store.claimWake(graphId);
        if (wakeId !== undefined) store.completeWake(wakeId);
        this.active += 1;
        void this.executeNode(graphId, node, claim).catch(() => undefined).finally(() => {
          this.active -= 1;
          this.requestTick();
        });
        return;
      }
    }
  }

  private async executeSupervisorWake(wake: GraphWakeRecord, runtime: InteractiveRuntimeHandle): Promise<void> {
    const store = this.store();
    const existing = wake.runId === undefined ? undefined : store.runtimeRun(wake.runId);
    if (existing?.terminalStatus !== undefined) {
      store.finishSupervisorWake(wake.wakeId, "completed");
      return;
    }
    if (existing) {
      const recoveryRunId = `${wake.runId}:recovery:${String(wake.attempt)}`;
      const recovered = await runtime.startInterruptedTurn({
        runId: recoveryRunId,
        turnId: recoveryRunId,
        parentRunId: wake.runId,
        continuationSource: `plan-wake:${wake.wakeId}:recovery`
      });
      if (!recovered) {
        // 没有可证明的 TurnStore 断点时不能新开一轮覆盖未知工具副作用。
        store.finishSupervisorWake(wake.wakeId, "blocked");
        return;
      }
      const outcome = await recovered.completion;
      store.finishSupervisorWake(wake.wakeId, outcome.status === "completed" ? "completed" : "blocked");
      return;
    }
    if (!runtime.submitSupervisionTurn || !wake.runId || !wake.checkpoint || wake.graphRevision === undefined) {
      store.finishSupervisorWake(wake.wakeId, "blocked");
      return;
    }
    const prompt = [
      `Supervise durable plan ${wake.graphId} at ${wake.checkpoint} revision ${String(wake.graphRevision)}.`,
      "First call PlanStatus with this graphId. Inspect persisted reports against their acceptance criteria and verification evidence where present; report completion is not deterministic verification.",
      "If approval is pending, report the exact approvalId, command, cwd, and reason without approving it.",
      "If attention is needed, make at most one bounded PlanUpdate or finish blocked/failed.",
      "For a review with needs_changes, use PlanUpdate action rework: it appends a scoped implementation repair and replacement read-only review. Never lower acceptance criteria. If the shared replan budget is exhausted, finish blocked with the evidence and request user direction.",
      "If settled, finish completed only when every current node is completed and its acceptance criteria are satisfied. Distinguish read-only findings from verified changes, state remaining uncertainty, and summarize in this original session."
    ].join("\n");
    const submitted = runtime.submitSupervisionTurn(prompt, {
      runId: wake.runId,
      turnId: wake.runId,
      parentRunId: `graph:${wake.graphId}`,
      continuationSource: `plan-wake:${wake.wakeId}`
    });
    const outcome = await submitted.completion;
    store.finishSupervisorWake(wake.wakeId, outcome.status === "completed" ? "completed" : "blocked");
  }

  private async executeNode(graphId: string, node: GraphNodeRecord, claim: GraphClaim): Promise<void> {
    let taskRunId: string | undefined;
    let attempt: TaskAttemptRecord | undefined;
    const store = this.store();
    const taskRuns = this.taskRuns();
    const graph = store.inspectGraph(graphId);
    const runtime = graph.mode === "supervised" && graph.supervisorSessionId !== undefined
      ? await this.supervisorRuntime(graph.supervisorSessionId)
      : this.runtime();
    try {
      // runtime 忙于交互会话或其他 run 不是节点执行失败：退回 ready，等后续 tick 重新 claim。
      if (runtime.getSnapshot().state.kind !== "idle" || runtime.getSnapshot().info.planning) {
        store.recoverNode(graphId, node.nodeId, "ready", "Runtime is busy; node execution deferred.");
        return;
      }
      const parentRunId = "graph:" + graphId;
      if (graph.mode === "supervised" && graph.supervisorSessionId !== undefined && this.options.resolveSupervisorCommands) {
        const commands = await this.options.resolveSupervisorCommands(graph.supervisorSessionId);
        if (store.inspectGraph(graphId).status !== "running") return;
        const durableTaskRunId = `graph:${graphId}:${node.nodeId}`;
        const block = planBlock(node.intent);
        let review: import("./planWork.js").PlanReviewCandidate | undefined;
        if (block?.kind === "review") {
          const candidate = latestPlanNode(graph, block.reviewTarget!);
          const task = candidate.taskRunId ? commands.taskRuns.get(candidate.taskRunId) : undefined;
          const attempt = task?.attempts.at(-1);
          const contract = readTaskDefinition(candidate.intent).verification;
          if (!task || !attempt || !contract || task.status !== "completed") throw new Error("Review requires completed candidate evidence.");
          review = { taskRunId: task.taskRunId, attemptId: attempt.attemptId, contract, evidence: attempt.verification as import("./taskVerification.js").TaskVerificationEvidence };
        }
        commands.taskRuns.create({
          taskRunId: durableTaskRunId,
          task: { ...node.intent as object, prompt: planWorkPacket(graph, node), review },
          sessionId: graph.supervisorSessionId,
          parentRunId
        });
        taskRunId = durableTaskRunId;
        // Worker 和验收也会向原会话写审计事件，必须持有同一维护锁/lease。
        // 不能仅用监督器的串行计数阻止第二个交互 writer。
        const result = await runtime.runExclusiveOperation("subagent", async (signal) => {
          const cancel = (): void => { commands.cancelTaskRun(durableTaskRunId, "Plan execution cancelled."); };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            signal.throwIfAborted();
            const started = await commands.startTaskRun(durableTaskRunId);
            return await started.completion;
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        });
        store.projectTaskClosure(durableTaskRunId, result);
        return;
      }
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
      } else if (result.status === "needs_approval") {
        // 节点仍由当前 TaskRun 持有，批准前不失败、不解锁下游，也不重新派发 Worker。
        store.noteSupervisorCheckpoint(graphId, "needs_attention");
        return;
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

  private async supervisorRuntime(sessionId: string): Promise<InteractiveRuntimeHandle> {
    if (this.options.resolveSupervisorRuntime) return await this.options.resolveSupervisorRuntime(sessionId);
    const runtime = this.runtime();
    if (runtime.getSnapshot().info.sessionId !== sessionId) {
      throw new Error(`Supervisor session runtime ${sessionId} is unavailable.`);
    }
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
    mode: graphMode(row.mode),
    supervisorSessionId: optionalString(row.supervisor_session_id),
    maxReplans: integerValue(row.max_replans),
    replanCount: integerValue(row.replan_count),
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
    replacesNodeId: optionalString(row.replaces_node_id),
    revision: integerValue(row.revision)
  };
}

function toWake(row: Record<string, unknown>): GraphWakeRecord {
  const checkpoint = optionalString(row.checkpoint);
  if (checkpoint !== undefined && checkpoint !== "needs_attention" && checkpoint !== "settled") {
    throw new Error(`Invalid supervisor checkpoint: ${checkpoint}`);
  }
  const kind = stringValue(row.kind);
  if (kind !== "dispatch" && kind !== "supervisor") throw new Error(`Invalid graph wake kind: ${kind}`);
  const status = stringValue(row.status);
  if (status !== "pending" && status !== "claimed" && status !== "completed" && status !== "discarded" && status !== "blocked") {
    throw new Error(`Invalid graph wake status: ${status}`);
  }
  return {
    wakeId: stringValue(row.wake_id),
    graphId: stringValue(row.graph_id),
    kind,
    reason: stringValue(row.reason),
    status,
    attempt: integerValue(row.attempt),
    graphRevision: optionalInteger(row.graph_revision),
    checkpoint,
    sessionId: optionalString(row.session_id),
    runId: optionalString(row.run_id),
    createdAt: stringValue(row.created_at),
    completedAt: optionalString(row.completed_at)
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

function graphMode(value: unknown): GraphMode {
  if (value === "fixed" || value === "supervised") return value;
  throw new Error("Invalid graph mode: " + String(value));
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

function optionalInteger(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : integerValue(value);
}

function nodeInputFromRecord(node: GraphNodeRecord): GraphNodeInput {
  const definition = readTaskDefinition(node.intent);
  return {
    nodeKey: node.nodeKey,
    prompt: definition.prompt,
    dependencies: [...node.dependencies],
    intent: node.intent,
    verification: definition.verification
  };
}

function validateGraphNodes(nodes: readonly GraphNodeInput[], limit: number): void {
  if (!nodes.length) throw new Error("Graph requires at least one node.");
  if (nodes.length > limit) throw new Error(`Graph cannot contain more than ${String(limit)} nodes.`);
  const keys = new Set<string>();
  for (const node of nodes) {
    if (!node.nodeKey.trim() || !node.prompt.trim()) throw new Error("Graph node key and prompt cannot be empty.");
    if (keys.has(node.nodeKey)) throw new Error(`Graph node key must be unique: ${node.nodeKey}`);
    keys.add(node.nodeKey);
    readTaskDefinition(node.intent ?? { prompt: node.prompt, verification: node.verification });
  }
  for (const node of nodes) {
    for (const dependency of node.dependencies ?? []) {
      if (!keys.has(dependency)) throw new Error(`Graph node ${node.nodeKey} depends on missing node ${dependency}.`);
      if (dependency === node.nodeKey) throw new Error(`Graph node ${node.nodeKey} cannot depend on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error("Graph dependencies cannot contain a cycle.");
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependencies ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key);
}

function currentGraphNodes(graph: GraphRecord): GraphNodeRecord[] {
  const replaced = new Set(graph.nodes.flatMap((node) => node.replacesNodeId === undefined ? [] : [node.replacesNodeId]));
  return graph.nodes.filter((node) => !replaced.has(node.nodeId));
}

function dependencyCompleted(graph: GraphRecord, dependencyKey: string): boolean {
  let current = graph.nodes.find((node) => node.nodeKey === dependencyKey);
  if (!current) return false;
  const visited = new Set<string>();
  while (!visited.has(current.nodeId)) {
    visited.add(current.nodeId);
    const replacement = graph.nodes.find((node) => node.replacesNodeId === current!.nodeId);
    if (!replacement) break;
    current = replacement;
  }
  return current.status === "completed";
}
