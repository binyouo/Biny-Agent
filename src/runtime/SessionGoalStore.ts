import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEventAuthority } from "./RuntimeAuthority.js";

export type SessionGoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "completed";

export interface SessionGoalExpected {
  goalId: string;
  revision: number;
}
export type SessionGoalExpectation = SessionGoalExpected;

export interface SessionGoalEvidence {
  summary: string;
  requirements: Array<{ requirement: string; evidence: string }>;
}

export interface SessionGoalRecord extends SessionGoalExpected {
  workspaceId: string;
  sessionId: string;
  objective: string;
  status: SessionGoalStatus;
  tokenBudget?: number;
  /** 完整 usage 已确认的累计值；usageKnown=false 时不能当作总用量。 */
  tokensUsed: number;
  timeUsedMs: number;
  usageKnown: boolean;
  generation: number;
  evidence?: SessionGoalEvidence;
  createdAt: string;
  updatedAt: string;
}

export interface SessionGoalSetOptions {
  tokenBudget?: number;
  expected?: SessionGoalExpected;
}

export interface SessionGoalUsage {
  goalId: string;
  usageId: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  timeUsedMs?: number;
}

export class SessionGoalConflictError extends Error {
  readonly code = "session_goal_conflict";
  constructor() {
    super("Session goal identity or revision changed; read the current goal before updating it.");
    this.name = "SessionGoalConflictError";
  }
}

/** 会话目标与 Graph Goal 分开定义状态；两者共用同一 authority 的事务与事实事件。 */
export class SessionGoalStore {
  private closed = false;
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly database: DatabaseSync, private readonly authority: RuntimeEventAuthority) {}

  static async open(persistenceRoot: string, authority: RuntimeEventAuthority): Promise<SessionGoalStore> {
    void persistenceRoot;
    return new SessionGoalStore(authority.databaseHandle(), authority);
  }

  subscribe(listener: () => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(sessionId: string): SessionGoalRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM session_goals WHERE workspace_id = ? AND session_id = ?")
      .get(this.authority.workspaceId, nonEmpty(sessionId, "sessionId")) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toGoal(row);
  }

  list(options: { status?: SessionGoalStatus } = {}): SessionGoalRecord[] {
    this.assertOpen();
    const rows = options.status === undefined
      ? this.database.prepare("SELECT * FROM session_goals WHERE workspace_id = ? ORDER BY created_at, session_id").all(this.authority.workspaceId)
      : this.database.prepare("SELECT * FROM session_goals WHERE workspace_id = ? AND status = ? ORDER BY created_at, session_id").all(this.authority.workspaceId, readStatus(options.status));
    return (rows as Array<Record<string, unknown>>).map(toGoal);
  }

  set(sessionId: string, objective: string, options: SessionGoalSetOptions = {}): SessionGoalRecord {
    const normalizedSession = nonEmpty(sessionId, "sessionId");
    const normalizedObjective = nonEmpty(objective, "objective");
    if (normalizedObjective.length > 20_000) throw new Error("Session goal objective cannot exceed 20,000 characters.");
    if (options.tokenBudget !== undefined) positiveInteger(options.tokenBudget, "token budget");
    const current = this.get(normalizedSession);
    assertExpected(current, options.expected);
    const now = new Date().toISOString();
    const existing = current?.status !== "completed" ? current : undefined;
    const tokenBudget = options.tokenBudget ?? existing?.tokenBudget;
    if (existing && existing.objective === normalizedObjective && tokenBudget === existing.tokenBudget) return existing;
    const goal: SessionGoalRecord = {
      goalId: existing?.goalId ?? randomUUID(),
      workspaceId: this.authority.workspaceId,
      sessionId: normalizedSession,
      objective: normalizedObjective,
      status: existing?.status ?? "active",
      tokenBudget,
      tokensUsed: existing?.tokensUsed ?? 0,
      timeUsedMs: existing?.timeUsedMs ?? 0,
      usageKnown: existing?.usageKnown ?? true,
      generation: (existing?.generation ?? 0) + 1,
      revision: existing === undefined ? 0 : existing.revision + 1,
      evidence: existing?.evidence,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) goal.status = "budget_limited";
    if (goal.tokenBudget !== undefined && !goal.usageKnown) {
      goal.status = "blocked";
      goal.evidence = unknownUsageEvidence();
    }
    return this.persist("session_goal.set", current, goal);
  }

  pause(sessionId: string, expected?: SessionGoalExpected, evidence?: SessionGoalEvidence): SessionGoalRecord {
    const current = this.requireGoal(sessionId, expected);
    if (current.status === "completed") throw new Error("A completed session goal cannot be paused.");
    if (current.status === "paused") return current;
    return this.persist("session_goal.paused", current, { ...current, status: "paused", revision: current.revision + 1, evidence: evidence === undefined ? current.evidence : readEvidence(evidence), updatedAt: new Date().toISOString() });
  }

  resume(sessionId: string, expected?: SessionGoalExpected): SessionGoalRecord {
    const current = this.requireGoal(sessionId, expected);
    if (current.status === "completed") throw new Error("A completed session goal cannot be resumed.");
    if (current.tokenBudget !== undefined && !current.usageKnown) throw new Error("Session goal usage is unknown; its explicit budget cannot be enforced.");
    if (current.tokenBudget !== undefined && current.tokensUsed >= current.tokenBudget) throw new Error("Session goal token budget is exhausted.");
    if (current.status === "active") return current;
    return this.persist("session_goal.resumed", current, { ...current, status: "active", generation: current.generation + 1, revision: current.revision + 1, evidence: undefined, updatedAt: new Date().toISOString() });
  }

  clear(sessionId: string, expected?: SessionGoalExpected): void {
    const current = this.get(sessionId);
    assertExpected(current, expected);
    if (current === undefined) return;
    this.persist("session_goal.cleared", current, undefined);
  }

  complete(sessionId: string, expected: SessionGoalExpected, evidence: SessionGoalEvidence): SessionGoalRecord {
    return this.finish(sessionId, expected, "completed", evidence);
  }

  block(sessionId: string, expected: SessionGoalExpected, evidence: SessionGoalEvidence): SessionGoalRecord {
    return this.finish(sessionId, expected, "blocked", evidence);
  }

  recordUsage(sessionId: string, input: SessionGoalUsage): SessionGoalRecord | undefined {
    const current = this.get(sessionId);
    if (current === undefined || current.goalId !== input.goalId) return undefined;
    nonEmpty(input.usageId, "usageId");
    for (const [field, value] of [["inputTokens", input.inputTokens], ["cachedInputTokens", input.cachedInputTokens], ["outputTokens", input.outputTokens]] as const) {
      if (value !== undefined) nonNegativeInteger(value, field);
    }
    if (input.cachedInputTokens !== undefined && input.inputTokens !== undefined && input.cachedInputTokens > input.inputTokens) throw new Error("cachedInputTokens cannot exceed inputTokens.");
    if (input.timeUsedMs !== undefined) nonNegativeInteger(input.timeUsedMs, "timeUsedMs");
    const payload = JSON.stringify({ inputTokens: input.inputTokens, cachedInputTokens: input.cachedInputTokens, outputTokens: input.outputTokens, timeUsedMs: input.timeUsedMs });
    const existing = this.database.prepare("SELECT session_id, payload_json FROM session_goal_usage WHERE workspace_id = ? AND goal_id = ? AND usage_id = ?")
      .get(this.authority.workspaceId, input.goalId, input.usageId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.session_id !== current.sessionId || existing.payload_json !== payload) throw new Error("Session goal usage id is already bound to another usage fact.");
      return current;
    }
    const known = input.inputTokens !== undefined && input.cachedInputTokens !== undefined && input.outputTokens !== undefined;
    const tokens = known ? input.inputTokens! - input.cachedInputTokens! + input.outputTokens! : 0;
    const goal: SessionGoalRecord = {
      ...current,
      tokensUsed: current.tokensUsed + tokens,
      timeUsedMs: current.timeUsedMs + (input.timeUsedMs ?? 0),
      usageKnown: current.usageKnown && known,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString()
    };
    nonNegativeInteger(goal.tokensUsed, "cumulative tokensUsed");
    nonNegativeInteger(goal.timeUsedMs, "cumulative timeUsedMs");
    // 暂停与完成保留用户/模型的状态决定；已结束请求的晚到用量仍需计入同一目标。
    if (goal.status !== "completed" && goal.status !== "paused" && goal.tokenBudget !== undefined) {
      if (!goal.usageKnown) { goal.status = "blocked"; goal.evidence = unknownUsageEvidence(); }
      else if (goal.tokensUsed >= goal.tokenBudget) goal.status = "budget_limited";
    }
    return this.persist("session_goal.usage", current, goal, { usageId: input.usageId, ...JSON.parse(payload) as object }, () => {
      this.database.prepare("INSERT INTO session_goal_usage (workspace_id, goal_id, usage_id, session_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.authority.workspaceId, input.goalId, input.usageId, current.sessionId, payload, goal.updatedAt);
    });
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  private finish(sessionId: string, expected: SessionGoalExpected, status: "completed" | "blocked", evidence: SessionGoalEvidence): SessionGoalRecord {
    const current = this.requireGoal(sessionId, expected);
    if (current.status !== "active") throw new Error(`Only an active session goal can become ${status}.`);
    const validated = readEvidence(evidence);
    return this.persist(`session_goal.${status}`, current, { ...current, status, evidence: validated, revision: current.revision + 1, updatedAt: new Date().toISOString() });
  }

  private requireGoal(sessionId: string, expected?: SessionGoalExpected): SessionGoalRecord {
    const current = this.get(sessionId);
    assertExpected(current, expected);
    if (current === undefined) throw new Error("Session goal does not exist.");
    return current;
  }

  private persist(eventType: string, previous: SessionGoalRecord | undefined, goal: SessionGoalRecord): SessionGoalRecord;
  private persist(eventType: string, previous: SessionGoalRecord, goal: undefined): void;
  private persist(eventType: string, previous: SessionGoalRecord, goal: SessionGoalRecord, detail: unknown, beforeWrite: () => void): SessionGoalRecord;
  private persist(eventType: string, previous: SessionGoalRecord | undefined, goal: SessionGoalRecord | undefined, detail?: unknown, beforeWrite?: () => void): SessionGoalRecord | undefined {
    const identity = goal ?? previous!;
    this.authority.runEventTransaction({
      eventId: randomUUID(),
      sessionId: identity.sessionId,
      invocationId: identity.goalId,
      runId: `session-goal:${identity.goalId}`,
      turnId: `session-goal:${identity.goalId}`,
      eventType,
      payload: { goal: goal ?? null, goalId: identity.goalId, detail },
      createdAt: goal?.updatedAt ?? new Date().toISOString()
    }, () => {
      const current = this.get(identity.sessionId);
      if (previous === undefined ? current !== undefined : current?.goalId !== previous.goalId || current.revision !== previous.revision) throw new SessionGoalConflictError();
      beforeWrite?.();
      if (goal === undefined) {
        this.database.prepare("DELETE FROM session_goals WHERE workspace_id = ? AND session_id = ? AND goal_id = ? AND revision = ?")
          .run(identity.workspaceId, identity.sessionId, identity.goalId, previous!.revision);
      } else {
        this.database.prepare(`INSERT INTO session_goals
          (workspace_id, session_id, goal_id, objective, status, token_budget, tokens_used, time_used_ms,
           usage_known, generation, revision, evidence_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, session_id) DO UPDATE SET
            goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status,
            token_budget=excluded.token_budget, tokens_used=excluded.tokens_used, time_used_ms=excluded.time_used_ms,
            usage_known=excluded.usage_known, generation=excluded.generation, revision=excluded.revision,
            evidence_json=excluded.evidence_json, created_at=excluded.created_at, updated_at=excluded.updated_at`)
          .run(goal.workspaceId, goal.sessionId, goal.goalId, goal.objective, goal.status, goal.tokenBudget ?? null,
            goal.tokensUsed, goal.timeUsedMs, Number(goal.usageKnown), goal.generation, goal.revision,
            goal.evidence === undefined ? null : JSON.stringify(goal.evidence), goal.createdAt, goal.updatedAt);
      }
    });
    for (const listener of this.listeners) queueMicrotask(listener);
    return goal;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Session goal store is closed.");
  }
}

function assertExpected(current: SessionGoalRecord | undefined, expected: SessionGoalExpected | undefined): void {
  if (expected !== undefined && (current?.goalId !== expected.goalId || current.revision !== expected.revision)) throw new SessionGoalConflictError();
}

function nonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Session goal ${name} cannot be empty.`);
  return value.trim();
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Session goal ${name} must be a non-negative safe integer.`);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Session goal ${name} must be a positive safe integer.`);
}

function readStatus(value: unknown): SessionGoalStatus {
  if (value === "active" || value === "paused" || value === "blocked" || value === "budget_limited" || value === "completed") return value;
  throw new Error(`Invalid session goal status: ${String(value)}`);
}

function readEvidence(value: SessionGoalEvidence): SessionGoalEvidence {
  if (typeof value !== "object" || value === null || !Array.isArray(value.requirements) || !value.requirements.length) throw new Error("Session goal evidence must name at least one requirement and its evidence.");
  return {
    summary: nonEmpty(value.summary, "evidence summary"),
    requirements: value.requirements.map((item) => {
      if (typeof item !== "object" || item === null) throw new Error("Invalid session goal requirement evidence.");
      return { requirement: nonEmpty(item.requirement, "requirement"), evidence: nonEmpty(item.evidence, "requirement evidence") };
    })
  };
}

function unknownUsageEvidence(): SessionGoalEvidence {
  return { summary: "Provider usage is unknown; the explicit token budget cannot be enforced.", requirements: [{ requirement: "Enforce the explicit token budget", evidence: "A provider request omitted input, cached input, or output token usage." }] };
}

function toGoal(row: Record<string, unknown>): SessionGoalRecord {
  return {
    workspaceId: String(row.workspace_id), sessionId: String(row.session_id), goalId: String(row.goal_id),
    objective: String(row.objective), status: readStatus(row.status), tokenBudget: row.token_budget === null ? undefined : Number(row.token_budget),
    tokensUsed: Number(row.tokens_used), timeUsedMs: Number(row.time_used_ms), usageKnown: row.usage_known === 1,
    generation: Number(row.generation), revision: Number(row.revision),
    evidence: row.evidence_json === null ? undefined : readEvidence(JSON.parse(String(row.evidence_json)) as SessionGoalEvidence),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}
