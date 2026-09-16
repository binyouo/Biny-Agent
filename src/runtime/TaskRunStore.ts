/**
 * Durable TaskRun / TaskAttempt 存储。
 *
 * SubagentTaskManager 继续负责内存中的并发和 AbortController；本模块负责任务状态、
 * attempt lineage 和 task event 的持久化。任务状态的写入先追加 RuntimeEvent，再更新
 * task ledger，Host 重启后查询不会依赖旧进程里的 Map。
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SubagentTaskSnapshot } from "./SubagentTaskManager.js";
import { RuntimeEventAuthority } from "./RuntimeAuthority.js";

export type TaskRunStatus =
  | "queued"
  | "created"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "incomplete"
  | "blocked"
  | "policy_denied"
  | "budget_exhausted"
  | "needs_approval"
  | "aborted"
  | "cancelled";

export type TaskRetrySafety = "safe" | "idempotent" | "unsafe" | "unknown";

export interface TaskRunRecord {
  taskRunId: string;
  workspaceId: string;
  sessionId?: string;
  parentRunId?: string;
  status: TaskRunStatus;
  task: unknown;
  createdAt: string;
  updatedAt: string;
  terminalEventId?: string;
  revision: number;
}

export interface TaskAttemptRecord {
  attemptId: string;
  taskRunId: string;
  runId: string;
  turnId: string;
  parentRunId?: string;
  status: TaskRunStatus;
  highWaterSequence?: number;
  retrySafety: TaskRetrySafety;
  verification?: unknown;
  artifacts?: unknown;
  failure?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRunWithAttempts extends TaskRunRecord {
  attempts: TaskAttemptRecord[];
}

export interface TaskRunCreateInput {
  taskRunId?: string;
  sessionId?: string;
  parentRunId?: string;
  task: unknown;
}

export interface TaskAttemptCreateInput {
  attemptId?: string;
  runId?: string;
  turnId?: string;
  parentRunId?: string;
  retrySafety?: TaskRetrySafety;
}

export interface TaskRunListOptions {
  status?: TaskRunStatus;
  limit?: number;
  cursor?: number;
}

interface TaskRunRow {
  task_run_id: unknown;
  workspace_id: unknown;
  session_id: unknown;
  parent_run_id: unknown;
  status: unknown;
  task_json: unknown;
  created_at: unknown;
  updated_at: unknown;
  terminal_event_id: unknown;
  revision: unknown;
}

interface TaskAttemptRow {
  attempt_id: unknown;
  task_run_id: unknown;
  run_id: unknown;
  turn_id: unknown;
  parent_run_id: unknown;
  status: unknown;
  high_water_sequence: unknown;
  retry_safety: unknown;
  verification_json: unknown;
  artifacts_json: unknown;
  failure_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface TaskEventRow {
  event_id: unknown;
  task_run_id: unknown;
  attempt_id: unknown;
  event_type: unknown;
  payload_json: unknown;
  created_at: unknown;
}

export class DurableTaskRunStore {
  readonly databasePath: string;
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly authority: RuntimeEventAuthority
  ) {
    this.databasePath = authority.databasePath;
  }

  static async open(persistenceRoot: string, authority: RuntimeEventAuthority): Promise<DurableTaskRunStore> {
    void persistenceRoot;
    return new DurableTaskRunStore(authority.databaseHandle(), authority);
  }

  create(input: TaskRunCreateInput): TaskRunRecord {
    this.assertOpen();
    const taskRunId = input.taskRunId ?? randomUUID();
    const existing = this.read(taskRunId);
    if (existing) return existing;
    const now = new Date().toISOString();
    return this.authority.runEventTransaction({
      eventId: `task:${taskRunId}:created`,
      sessionId: input.sessionId ?? `task:${taskRunId}`,
      invocationId: taskRunId,
      runId: input.parentRunId ?? `task:${taskRunId}`,
      turnId: `task:${taskRunId}`,
      eventType: "task.created",
      payload: { taskRunId, task: input.task, parentRunId: input.parentRunId },
      createdAt: now
    }, () => {
      this.database.prepare(`
        INSERT INTO task_runs (
          task_run_id, workspace_id, session_id, parent_run_id, status,
          task_json, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, 'created', ?, ?, ?, 0)
      `).run(
        taskRunId,
        this.authority.workspaceId,
        input.sessionId ?? null,
        input.parentRunId ?? null,
        stringify(input.task),
        now,
        now
      );
      return this.require(taskRunId);
    });
  }

  createAttempt(taskRunId: string, input: TaskAttemptCreateInput = {}): TaskAttemptRecord {
    this.assertOpen();
    const task = this.require(taskRunId);
    const attemptId = input.attemptId ?? randomUUID();
    const existing = this.readAttempt(attemptId);
    if (existing) return existing;
    const runId = input.runId ?? randomUUID();
    const turnId = input.turnId ?? randomUUID();
    const now = new Date().toISOString();
    return this.authority.runEventTransaction({
      eventId: `task:${taskRunId}:attempt:${attemptId}:created`,
      sessionId: task.sessionId ?? `task:${taskRunId}`,
      invocationId: runId,
      runId,
      turnId,
      eventType: "task.attempt.created",
      payload: { taskRunId, attemptId, parentRunId: input.parentRunId ?? task.parentRunId },
      createdAt: now
    }, () => {
      this.database.prepare(`
        INSERT INTO task_attempts (
          attempt_id, task_run_id, run_id, turn_id, parent_run_id, status,
          retry_safety, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(
        attemptId,
        taskRunId,
        runId,
        turnId,
        input.parentRunId ?? task.parentRunId ?? null,
        input.retrySafety ?? "unknown",
        now,
        now
      );
      return this.readAttempt(attemptId) ?? (() => { throw new Error(`Task attempt ${attemptId} was not persisted.`); })();
    });
  }

  transition(
    taskRunId: string,
    status: TaskRunStatus,
    input: {
      attemptId?: string;
      highWaterSequence?: number;
      verification?: unknown;
      artifacts?: unknown;
      failure?: unknown;
    } = {}
  ): TaskRunWithAttempts {
    this.assertOpen();
    const task = this.require(taskRunId);
    const attempt = input.attemptId === undefined ? this.latestAttempt(taskRunId) : this.readAttempt(input.attemptId);
    if (input.attemptId !== undefined && (!attempt || attempt.taskRunId !== taskRunId)) {
      throw new Error(`TaskAttempt ${input.attemptId} does not belong to TaskRun ${taskRunId}.`);
    }
    if (attempt && this.latestAttempt(taskRunId)?.attemptId !== attempt.attemptId) {
      throw new Error(`TaskAttempt ${attempt.attemptId} is stale for TaskRun ${taskRunId}.`);
    }
    if (task.status === status) {
      if (!attempt || (input.verification === undefined && input.artifacts === undefined && input.failure === undefined && input.highWaterSequence === undefined)) {
        return this.requireWithAttempts(taskRunId);
      }
      if (isTaskRunTerminal(status)) assertCompatibleTerminalEvidence(attempt, input);
      const now = new Date().toISOString();
      return this.authority.runEventTransaction({
        eventId: `task:${taskRunId}:revision:${String(task.revision + 1)}`,
        sessionId: task.sessionId ?? `task:${taskRunId}`,
        invocationId: attempt.runId,
        runId: attempt.runId,
        turnId: attempt.turnId,
        eventType: "task.attempt.updated",
        payload: { taskRunId, attemptId: attempt.attemptId, status, ...input },
        createdAt: now
      }, () => {
        const update = this.database.prepare(`
          UPDATE task_runs SET updated_at = ?, revision = revision + 1
          WHERE task_run_id = ? AND status = ? AND revision = ?
        `).run(now, taskRunId, status, task.revision);
        if (update.changes !== 1) throw new Error(`TaskRun ${taskRunId} changed while persisting Attempt evidence.`);
        this.database.prepare(`
          UPDATE task_attempts SET high_water_sequence = COALESCE(?, high_water_sequence), verification_json = COALESCE(?, verification_json),
            artifacts_json = COALESCE(?, artifacts_json), failure_json = COALESCE(?, failure_json), updated_at = ? WHERE attempt_id = ?
        `).run(
          input.highWaterSequence ?? null,
          stringifyOptional(input.verification),
          stringifyOptional(input.artifacts),
          stringifyOptional(input.failure),
          now,
          attempt.attemptId
        );
        this.database.prepare(`
          INSERT INTO task_events (event_id, task_run_id, attempt_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, 'task.attempt.updated', ?, ?)
        `).run(
          `task:${taskRunId}:revision:${String(task.revision + 1)}`,
          taskRunId,
          attempt.attemptId,
          stringify({ status, ...input }),
          now
        );
        return this.requireWithAttempts(taskRunId);
      });
    }
    if (isTaskRunTerminal(task.status)) {
      throw new Error(`TaskRun ${taskRunId} is already terminal (${task.status}) and cannot transition to ${status}.`);
    }
    if (!isAllowedTaskTransition(task.status, status)) {
      throw new Error(`TaskRun ${taskRunId} cannot transition from ${task.status} to ${status}.`);
    }
    const now = new Date().toISOString();
    const runId = attempt?.runId ?? `task:${taskRunId}`;
    const turnId = attempt?.turnId ?? `task:${taskRunId}`;
    return this.authority.runEventTransaction({
      eventId: `task:${taskRunId}:revision:${String(task.revision + 1)}`,
      sessionId: task.sessionId ?? `task:${taskRunId}`,
      invocationId: runId,
      runId,
      turnId,
      eventType: "task.status",
      payload: { taskRunId, attemptId: attempt?.attemptId, status, ...input },
      createdAt: now
    }, () => {
      const eventId = `task:${taskRunId}:revision:${String(task.revision + 1)}`;
      const update = this.database.prepare(`
        UPDATE task_runs SET status = ?, terminal_event_id = ?, updated_at = ?, revision = revision + 1 WHERE task_run_id = ? AND status = ?
      `).run(status, isTaskRunTerminal(status) ? eventId : task.terminalEventId ?? null, now, taskRunId, task.status);
      if (update.changes !== 1) throw new Error(`TaskRun ${taskRunId} changed while transitioning to ${status}.`);
      this.database.prepare(`
        INSERT OR IGNORE INTO task_events (event_id, task_run_id, attempt_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, 'task.status', ?, ?)
      `).run(
        `task:${taskRunId}:revision:${String(task.revision + 1)}`,
        taskRunId,
        attempt?.attemptId ?? null,
        stringify({ status, ...input }),
        now
      );
      if (attempt) {
        this.database.prepare(`
          UPDATE task_attempts SET status = ?, high_water_sequence = ?, verification_json = ?,
            artifacts_json = ?, failure_json = ?, updated_at = ? WHERE attempt_id = ?
        `).run(
          status,
          input.highWaterSequence ?? null,
          stringifyOptional(input.verification),
          stringifyOptional(input.artifacts),
          stringifyOptional(input.failure),
          now,
          attempt.attemptId
        );
      }
      return this.requireWithAttempts(taskRunId);
    });
  }

  /** 进程重启后，旧的 queued/running 投影可以安全回到队列，再由新进程重新派发。 */
  requeue(taskRunId: string, reason = "TaskRun execution was recovered after a process restart."): TaskRunWithAttempts {
    const task = this.require(taskRunId);
    if (task.status === "queued" || task.status === "created") return this.requireWithAttempts(taskRunId);
    if (isTaskRunTerminal(task.status)) throw new Error(`TaskRun ${taskRunId} is already terminal (${task.status}).`);
    return this.transition(taskRunId, "queued", { failure: { message: reason } });
  }

  /**
   * 验收失败只结束当前 Attempt，TaskRun 回到队列等待同一闭环的定向修复。
   * 旧 Attempt 的失败证据必须保留，不能被下一次 Attempt 的 queued 状态覆盖。
   */
  prepareVerificationRepair(
    taskRunId: string,
    attemptId: string,
    input: { verification: unknown; artifacts: unknown; failure: unknown }
  ): TaskRunWithAttempts {
    this.assertOpen();
    const task = this.require(taskRunId);
    const attempt = this.readAttempt(attemptId);
    if (task.status !== "verifying") throw new Error(`TaskRun ${taskRunId} is not verifying.`);
    if (!attempt || attempt.taskRunId !== taskRunId || this.latestAttempt(taskRunId)?.attemptId !== attemptId) {
      throw new Error(`TaskAttempt ${attemptId} is not the current Attempt for TaskRun ${taskRunId}.`);
    }
    const now = new Date().toISOString();
    return this.authority.runEventTransaction({
      eventId: `task:${taskRunId}:repair:${String(task.revision + 1)}`,
      sessionId: task.sessionId ?? `task:${taskRunId}`,
      invocationId: attempt.runId,
      runId: attempt.runId,
      turnId: attempt.turnId,
      eventType: "task.verification.repair",
      payload: { taskRunId, attemptId, ...input },
      createdAt: now
    }, () => {
      const update = this.database.prepare(`
        UPDATE task_runs SET status = 'queued', updated_at = ?, revision = revision + 1
        WHERE task_run_id = ? AND status = 'verifying' AND revision = ?
      `).run(now, taskRunId, task.revision);
      if (update.changes !== 1) throw new Error(`TaskRun ${taskRunId} changed while scheduling verification repair.`);
      this.database.prepare(`
        UPDATE task_attempts SET status = 'failed', verification_json = ?, artifacts_json = ?, failure_json = ?, updated_at = ?
        WHERE attempt_id = ? AND task_run_id = ?
      `).run(stringify(input.verification), stringify(input.artifacts), stringify(input.failure), now, attemptId, taskRunId);
      this.database.prepare(`
        INSERT OR IGNORE INTO task_events (event_id, task_run_id, attempt_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, 'task.verification.repair', ?, ?)
      `).run(
        `task:${taskRunId}:repair:${String(task.revision + 1)}`,
        taskRunId,
        attemptId,
        stringify(input),
        now
      );
      return this.requireWithAttempts(taskRunId);
    });
  }

  /** 只有失败任务可以显式重试；新 attempt 会在执行入口创建。 */
  retry(taskRunId: string): TaskRunWithAttempts {
    const task = this.require(taskRunId);
    if (task.status !== "failed") throw new Error(`TaskRun ${taskRunId} is not failed and cannot retry.`);
    const now = new Date().toISOString();
    return this.authority.runEventTransaction({
      eventId: `task:${taskRunId}:retry:${String(task.revision + 1)}`,
      sessionId: task.sessionId ?? `task:${taskRunId}`,
      invocationId: task.parentRunId ?? `task:${taskRunId}`,
      runId: task.parentRunId ?? `task:${taskRunId}`,
      turnId: `task:${taskRunId}`,
      eventType: "task.retry",
      payload: { taskRunId },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE task_runs SET status = 'queued', terminal_event_id = NULL, revision = revision + 1, updated_at = ? WHERE task_run_id = ? AND status = 'failed'").run(now, taskRunId);
      this.database.prepare("INSERT OR IGNORE INTO task_events (event_id, task_run_id, event_type, payload_json, created_at) VALUES (?, ?, 'task.retry', ?, ?)").run(`task:${taskRunId}:retry:${String(task.revision + 1)}`, taskRunId, stringify({ taskRunId }), now);
      return this.requireWithAttempts(taskRunId);
    });
  }

  syncSubagentSnapshot(
    snapshot: SubagentTaskSnapshot,
    binding: { taskRunId?: string; attemptId?: string; completedStatus?: "completed" | "verifying" } = {}
  ): TaskRunWithAttempts {
    const taskRunId = binding.taskRunId ?? snapshot.taskId;
    const existing = this.read(taskRunId);
    if (!existing) this.create({ taskRunId, parentRunId: snapshot.parentRunId, task: snapshot.task });
    const task = this.require(taskRunId);
    const boundAttempt = binding.attemptId === undefined ? undefined : this.readAttempt(binding.attemptId);
    const attempt = boundAttempt ?? this.latestAttempt(taskRunId) ?? this.createAttempt(taskRunId, {
      runId: `task-run:${snapshot.taskId}`,
      turnId: `task-turn:${snapshot.taskId}`,
      parentRunId: snapshot.parentRunId,
      retrySafety: "unknown"
    });
    if (attempt.taskRunId !== taskRunId) throw new Error(`TaskAttempt ${attempt.attemptId} does not belong to TaskRun ${taskRunId}.`);
    if (isTaskRunTerminal(task.status) || this.latestAttempt(taskRunId)?.attemptId !== attempt.attemptId) {
      return this.requireWithAttempts(taskRunId);
    }
    const status = snapshot.status === "timed_out"
      ? "failed"
      : snapshot.status === "completed"
        ? binding.completedStatus ?? "completed"
        : snapshot.status;
    return this.transition(taskRunId, status, {
      attemptId: attempt.attemptId,
      failure: snapshot.error === undefined ? undefined : { message: snapshot.error }
    });
  }

  get(taskRunId: string): TaskRunWithAttempts | undefined {
    this.assertOpen();
    return this.read(taskRunId) ? this.requireWithAttempts(taskRunId) : undefined;
  }

  list(options: TaskRunListOptions = {}): { tasks: TaskRunWithAttempts[]; nextCursor?: number; hasMore: boolean } {
    this.assertOpen();
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Task page size must be between 1 and 1000.");
    const rows = this.database.prepare(`
      SELECT rowid, task_run_id, workspace_id, session_id, parent_run_id, status,
             task_json, created_at, updated_at, terminal_event_id, revision
      FROM task_runs
      WHERE workspace_id = ? AND rowid > ? ${options.status === undefined ? "" : "AND status = ?"}
      ORDER BY rowid ASC LIMIT ?
    `).all(
      this.authority.workspaceId,
      options.cursor ?? 0,
      ...(options.status === undefined ? [] : [options.status]),
      limit + 1
    ) as unknown as Array<TaskRunRow & { rowid: unknown }>;
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      tasks: visible.map((row) => this.requireWithAttempts(toString(row.task_run_id))),
      nextCursor: hasMore ? toInteger(visible.at(-1)?.rowid) : undefined,
      hasMore
    };
  }

  events(taskRunId: string, limit = 100): Array<{ eventId: string; attemptId?: string; eventType: string; payload: unknown; createdAt: string }> {
    this.assertOpen();
    this.require(taskRunId);
    const rows = this.database.prepare(`
      SELECT event_id, task_run_id, attempt_id, event_type, payload_json, created_at
      FROM task_events WHERE task_run_id = ? ORDER BY rowid ASC LIMIT ?
    `).all(taskRunId, limit) as unknown as TaskEventRow[];
    return rows.map((row) => ({
      eventId: toString(row.event_id),
      attemptId: optionalString(row.attempt_id),
      eventType: toString(row.event_type),
      payload: parse(row.payload_json),
      createdAt: toString(row.created_at)
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }

  private read(taskRunId: string): TaskRunRecord | undefined {
    const row = this.database.prepare(`
      SELECT task_run_id, workspace_id, session_id, parent_run_id, status,
             task_json, created_at, updated_at, terminal_event_id, revision
      FROM task_runs WHERE task_run_id = ? AND workspace_id = ?
    `).get(taskRunId, this.authority.workspaceId) as unknown as TaskRunRow | undefined;
    return row ? toTaskRun(row) : undefined;
  }

  private require(taskRunId: string): TaskRunRecord {
    const task = this.read(taskRunId);
    if (!task) throw new Error(`TaskRun ${taskRunId} does not exist.`);
    return task;
  }

  private readAttempt(attemptId: string): TaskAttemptRecord | undefined {
    const row = this.database.prepare(`
      SELECT attempt_id, task_run_id, run_id, turn_id, parent_run_id, status,
             high_water_sequence, retry_safety, verification_json, artifacts_json,
             failure_json, created_at, updated_at
      FROM task_attempts WHERE attempt_id = ?
    `).get(attemptId) as unknown as TaskAttemptRow | undefined;
    return row ? toTaskAttempt(row) : undefined;
  }

  private latestAttempt(taskRunId: string): TaskAttemptRecord | undefined {
    const row = this.database.prepare(`
      SELECT attempt_id, task_run_id, run_id, turn_id, parent_run_id, status,
             high_water_sequence, retry_safety, verification_json, artifacts_json,
             failure_json, created_at, updated_at
      FROM task_attempts WHERE task_run_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(taskRunId) as unknown as TaskAttemptRow | undefined;
    return row ? toTaskAttempt(row) : undefined;
  }

  private requireWithAttempts(taskRunId: string): TaskRunWithAttempts {
    const task = this.require(taskRunId);
    const rows = this.database.prepare(`
      SELECT attempt_id, task_run_id, run_id, turn_id, parent_run_id, status,
             high_water_sequence, retry_safety, verification_json, artifacts_json,
             failure_json, created_at, updated_at
      FROM task_attempts WHERE task_run_id = ? ORDER BY rowid ASC
    `).all(taskRunId) as unknown as TaskAttemptRow[];
    return { ...task, attempts: rows.map(toTaskAttempt) };
  }

  private transaction<T>(execute: () => T): T {
    return this.authority.runTransaction(execute);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("TaskRun store is closed.");
  }
}

function toTaskRun(row: TaskRunRow): TaskRunRecord {
  return {
    taskRunId: toString(row.task_run_id),
    workspaceId: toString(row.workspace_id),
    sessionId: optionalString(row.session_id),
    parentRunId: optionalString(row.parent_run_id),
    status: taskStatus(row.status),
    task: parse(row.task_json),
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at),
    terminalEventId: optionalString(row.terminal_event_id),
    revision: toInteger(row.revision)
  };
}

function toTaskAttempt(row: TaskAttemptRow): TaskAttemptRecord {
  return {
    attemptId: toString(row.attempt_id),
    taskRunId: toString(row.task_run_id),
    runId: toString(row.run_id),
    turnId: toString(row.turn_id),
    parentRunId: optionalString(row.parent_run_id),
    status: taskStatus(row.status),
    highWaterSequence: row.high_water_sequence === null ? undefined : toInteger(row.high_water_sequence),
    retrySafety: retrySafety(row.retry_safety),
    verification: parseOptional(row.verification_json),
    artifacts: parseOptional(row.artifacts_json),
    failure: parseOptional(row.failure_json),
    createdAt: toString(row.created_at),
    updatedAt: toString(row.updated_at)
  };
}

function taskStatus(value: unknown): TaskRunStatus {
  if (value === "queued" || value === "created" || value === "running" || value === "verifying" || value === "completed" || value === "failed" || value === "incomplete" || value === "blocked" || value === "policy_denied" || value === "budget_exhausted" || value === "needs_approval" || value === "aborted" || value === "cancelled") return value;
  throw new Error(`Invalid TaskRun status: ${String(value)}`);
}

function retrySafety(value: unknown): TaskRetrySafety {
  if (value === "safe" || value === "idempotent" || value === "unsafe" || value === "unknown") return value;
  throw new Error(`Invalid task retry safety: ${String(value)}`);
}

export function isTaskRunTerminal(status: TaskRunStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "incomplete"
    || status === "blocked"
    || status === "policy_denied"
    || status === "budget_exhausted"
    || status === "needs_approval"
    || status === "aborted"
    || status === "cancelled";
}

function isAllowedTaskTransition(from: TaskRunStatus, to: TaskRunStatus): boolean {
  const allowed: Record<TaskRunStatus, readonly TaskRunStatus[]> = {
    queued: ["running", "verifying", "completed", "failed", "incomplete", "blocked", "policy_denied", "budget_exhausted", "needs_approval", "aborted", "cancelled"],
    created: ["queued", "running", "verifying", "completed", "failed", "incomplete", "blocked", "policy_denied", "budget_exhausted", "needs_approval", "aborted", "cancelled"],
    running: ["queued", "verifying", "completed", "failed", "incomplete", "blocked", "policy_denied", "budget_exhausted", "needs_approval", "aborted", "cancelled"],
    verifying: ["queued", "completed", "failed", "incomplete", "blocked", "policy_denied", "budget_exhausted", "needs_approval", "aborted", "cancelled"],
    completed: [],
    failed: [],
    incomplete: [],
    blocked: [],
    policy_denied: [],
    budget_exhausted: [],
    needs_approval: [],
    aborted: [],
    cancelled: []
  };
  return allowed[from].includes(to);
}

function stringify(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function assertCompatibleTerminalEvidence(
  attempt: TaskAttemptRecord,
  input: { verification?: unknown; artifacts?: unknown; failure?: unknown; highWaterSequence?: number }
): void {
  if (attempt.highWaterSequence !== undefined
    && input.highWaterSequence !== undefined
    && attempt.highWaterSequence !== input.highWaterSequence) {
    throw new Error(`Terminal TaskAttempt ${attempt.attemptId} high-water sequence cannot be overwritten.`);
  }
  for (const [label, current, next] of [
    ["verification", attempt.verification, input.verification],
    ["artifacts", attempt.artifacts, input.artifacts],
    ["failure", attempt.failure, input.failure]
  ] as const) {
    if (current !== undefined && next !== undefined && JSON.stringify(current) !== JSON.stringify(next)) {
      throw new Error(`Terminal TaskAttempt ${attempt.attemptId} ${label} cannot be overwritten.`);
    }
  }
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function parseOptional(value: unknown): unknown {
  return value === null || value === undefined ? undefined : parse(value);
}

function toString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid TaskRun storage string.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : toString(value);
}

function toInteger(value: unknown): number {
  const candidate = typeof value === "bigint" ? Number(value) : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) throw new Error("Invalid TaskRun storage integer.");
  return candidate;
}
