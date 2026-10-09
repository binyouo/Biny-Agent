/**
 * Workspace 级 Runtime authority。
 *
 * Runtime Host、Task、Automation、Graph 和会话目标共用可跨进程恢复的事实来源。
 * 这里使用 Node 内置 node:sqlite，不依赖 native npm 数据库；session JSONL 是
 * 会话事实来源，authority 只保存可重建的运行投影和后台运行域事实。
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ensureAgentDirs, agentDir, listSessionFilePaths, resolveSessionFile, sessionIdFromFile } from "../session/store.js";
import { readSessionEvents, readSessionEventsForBackfill } from "../session/events.js";
import type { SessionEvent } from "../session/recorder.js";
import { assertRuntimeEventSequence, validateRuntimeEventStream, type RuntimeEventIdentity, type RuntimeEventSink } from "../session/runtimeEvent.js";

const schemaVersion = 13;
const busyTimeoutMs = 5_000;
const taskAttemptIndexName = "task_attempts_task_run_idx";
const defaultPageSize = 100;
const maxPageSize = 1_000;

export type RuntimeRunStatus =
  | "admitted"
  | "running"
  | "completed"
  | "blocked"
  | "incomplete"
  | "cancelled"
  | "aborted"
  | "failed"
  | "unknown";

export interface RuntimeEvent {
  eventId: string;
  workspaceId: string;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  eventSeq?: number;
  sequence: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface RuntimeEventPage {
  events: RuntimeEvent[];
  nextCursor?: number;
  hasMore: boolean;
  /** 当前数据库没有事件裁剪，因此 cursor 永远不会产生 gap。保留字段供 Host 协议使用。 */
  gap: false;
}

export interface RuntimeRunRecord {
  runId: string;
  workspaceId: string;
  sessionId: string;
  invocationId: string;
  turnId: string;
  parentRunId?: string;
  continuationSource?: string;
  status: RuntimeRunStatus;
  createdAt: string;
  updatedAt: string;
  terminalEventId?: string;
  terminalStatus?: RuntimeRunStatus;
  terminalPayload?: unknown;
  payload?: unknown;
}

export interface RuntimeRunStartInput {
  runId: string;
  sessionId: string;
  invocationId?: string;
  turnId: string;
  parentRunId?: string;
  continuationSource?: string;
  /** 重新生成的目标消息 identity；存在时表示本次运行是同一消息槽的版本重试。 */
  retryOfMessageId?: string;
  payload?: unknown;
  createdAt?: string;
}

export interface RuntimeRunStartResult extends RuntimeRunRecord {
  /** 仅表示本次调用是否真正创建了 admission；重试不会重新执行 AgentRun。 */
  created: boolean;
}

export interface RuntimeRunFinishInput {
  runId: string;
  status: RuntimeRunStatus;
  /** Omission preserves a terminal payload; repeated canonical session projections only enrich known evidence fields. */
  payload?: unknown;
  terminalEventId?: string;
  createdAt?: string;
}

export interface RuntimeRunListOptions {
  sessionId?: string;
  status?: RuntimeRunStatus;
  limit?: number;
  cursor?: string;
}

export interface RuntimeRunPage {
  runs: RuntimeRunRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface RuntimeContinuationClaim {
  sourceRunId: string;
  childRunId: string;
  claimToken: string;
  createdAt: string;
}

export interface RuntimeAuthorityOptions {
  workspaceId?: string;
  backfillLegacySessions?: boolean;
}

export interface RuntimeEventAppendInput {
  eventId?: string;
  eventSeq?: number;
  sessionId: string;
  invocationId?: string;
  runId: string;
  turnId: string;
  eventType: string;
  payload?: unknown;
  createdAt?: string;
}

interface RuntimeEventRow {
  event_id: unknown;
  workspace_id: unknown;
  session_id: unknown;
  invocation_id: unknown;
  run_id: unknown;
  turn_id: unknown;
  event_seq: unknown;
  sequence: unknown;
  event_type: unknown;
  payload_json: unknown;
  created_at: unknown;
}

interface RuntimeRunRow {
  run_id: unknown;
  workspace_id: unknown;
  session_id: unknown;
  invocation_id: unknown;
  turn_id: unknown;
  parent_run_id: unknown;
  continuation_source: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  terminal_event_id: unknown;
  terminal_status: unknown;
  terminal_payload_json: unknown;
  payload_json: unknown;
}

/** SQLite authority 的 workspace 级打开句柄。每个进程只应持有短生命周期的同步操作。 */
export class RuntimeEventAuthority implements RuntimeEventSink {
  readonly databasePath: string;
  readonly workspaceId: string;
  private closed = false;

  private constructor(
    private readonly persistenceRoot: string,
    private readonly database: DatabaseSync,
    workspaceId: string
  ) {
    this.databasePath = path.join(agentDir(persistenceRoot), "runtime.sqlite");
    this.workspaceId = workspaceId;
  }

  static async open(persistenceRoot: string, options: RuntimeAuthorityOptions = {}): Promise<RuntimeEventAuthority> {
    await ensureAgentDirs(persistenceRoot);
    const databasePath = path.join(agentDir(persistenceRoot), "runtime.sqlite");
    const database = new DatabaseSync(databasePath, {
      timeout: busyTimeoutMs,
      enableForeignKeyConstraints: true
    });
    const authority = new RuntimeEventAuthority(
      path.resolve(persistenceRoot),
      database,
      options.workspaceId ?? workspaceIdForRoot(persistenceRoot)
    );
    try {
      authority.migrate();
      authority.ensureTaskAttemptIndex();
      if (options.backfillLegacySessions !== false) await authority.reconcileSessionProjections();
      return authority;
    } catch (error) {
      authority.close();
      throw error;
    }
  }

  /** 浏览持久化投影不创建数据库、不迁移 schema，也不修复在途执行状态。 */
  static async openReadOnly(persistenceRoot: string): Promise<RuntimeEventAuthority | undefined> {
    const databasePath = path.join(agentDir(persistenceRoot), "runtime.sqlite");
    try {
      await fs.stat(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const database = new DatabaseSync(databasePath, { readOnly: true, timeout: busyTimeoutMs });
    const authority = new RuntimeEventAuthority(path.resolve(persistenceRoot), database, workspaceIdForRoot(persistenceRoot));
    try {
      const revision = authority.schemaRevision();
      if (revision !== schemaVersion) throw new Error(`Runtime schema revision ${String(revision)} requires an explicit runtime startup before reading projections.`);
      return authority;
    } catch (error) {
      authority.close();
      throw error;
    }
  }

  /** 让 CommandRuntime 把自身的 SessionRecorder 绑定到同一 authority。 */
  asSink(): RuntimeEventSink {
    return this;
  }

  /** Store 与 authority 共用一个 DatabaseSync，避免跨连接双写无法原子提交。 */
  databaseHandle(): DatabaseSync {
    this.assertOpen();
    return this.database;
  }

  /** 仅用于没有额外事实事件的 projection-only 更新。 */
  runTransaction<T>(execute: () => T): T {
    return this.transaction(execute);
  }

  /** 将 runtime fact 与其 SQLite projection 放入同一 SQLite transaction。 */
  runEventTransaction<T>(input: RuntimeEventAppendInput | (() => RuntimeEventAppendInput | undefined), execute: () => T): T {
    return this.transaction(() => {
      // A synchronous state guard can select an event, or an already-applied no-op, under this same transaction.
      const event = typeof input === "function" ? input() : input;
      if (event !== undefined) this.appendEventInTransaction(event);
      return execute();
    });
  }

  appendSessionEvent(input: {
    sessionId: string;
    runtime: RuntimeEventIdentity;
    event: unknown;
    createdAt: string;
  }): void {
    const runtime = input.runtime;
    const runId = runtime.runId ?? `session:${input.sessionId}`;
    const turnId = runtime.turnId ?? runId;
    this.appendEvent({
      eventId: runtime.eventId,
      eventSeq: runtime.eventSeq,
      sessionId: input.sessionId,
      invocationId: runtime.runId ?? runtime.eventId,
      runId,
      turnId,
      eventType: sessionEventType(input.event),
      payload: input.event,
      createdAt: input.createdAt
    });
  }

  /**
   * 根 run admission 是不可重复的：同一个 runId 重试只返回已有 header，
   * 但如果客户端试图复用它表示另一个 turn，则 fail-closed。
   */
  startRun(input: RuntimeRunStartInput): RuntimeRunStartResult {
    this.assertOpen();
    assertNonEmpty(input.runId, "runId");
    assertNonEmpty(input.sessionId, "sessionId");
    assertNonEmpty(input.turnId, "turnId");
    const now = input.createdAt ?? new Date().toISOString();
    const invocationId = input.invocationId ?? input.runId;
    return this.transaction(() => {
      const existing = this.readRun(input.runId);
      if (existing) {
        if (existing.sessionId !== input.sessionId || existing.turnId !== input.turnId) {
          throw new Error(`Runtime run ${input.runId} is already bound to another session or turn.`);
        }
        return { ...existing, created: false };
      }
      this.database.prepare(`
        INSERT INTO agent_runs (
          run_id, workspace_id, session_id, invocation_id, turn_id,
          parent_run_id, continuation_source, status, created_at, updated_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?)
      `).run(
        input.runId,
        this.workspaceId,
        input.sessionId,
        invocationId,
        input.turnId,
        input.parentRunId ?? null,
        input.continuationSource ?? null,
        now,
        now,
        json(input.payload)
      );
      this.appendEventInTransaction({
        eventId: `run-admitted:${input.runId}`,
        sessionId: input.sessionId,
        invocationId,
        runId: input.runId,
        turnId: input.turnId,
        eventType: "run.admitted",
        payload: {
          parentRunId: input.parentRunId,
          continuationSource: input.continuationSource,
          payload: input.payload
        },
        createdAt: now
      });
      const admitted = this.readRun(input.runId);
      if (!admitted) throw new Error(`Runtime run ${input.runId} was not persisted.`);
      return { ...admitted, created: true };
    });
  }

  /** 把 Host 的 accepted/running 状态投影到 authority；不会覆盖 terminal run。 */
  markRunRunning(runId: string, createdAt = new Date().toISOString()): RuntimeRunRecord {
    return this.transaction(() => {
      const run = this.requireRun(runId);
      if (run.status === "running" || isTerminalRunStatus(run.status)) return run;
      this.appendEventInTransaction({
        eventId: `run-running:${runId}`,
        sessionId: run.sessionId,
        invocationId: run.invocationId,
        runId: run.runId,
        turnId: run.turnId,
        eventType: "run.running",
        payload: { previousStatus: run.status },
        createdAt
      });
      this.database.prepare("UPDATE agent_runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(createdAt, runId);
      return this.requireRun(runId);
    });
  }

  finishRun(input: RuntimeRunFinishInput): RuntimeRunRecord {
    this.assertOpen();
    assertNonEmpty(input.runId, "runId");
    if (!isTerminalRunStatus(input.status)) throw new Error(`Run status is not terminal: ${input.status}`);
    const now = input.createdAt ?? new Date().toISOString();
    return this.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.terminalStatus !== undefined) {
        if (run.terminalStatus !== input.status) {
          throw new Error(`Runtime run ${input.runId} already has terminal status ${run.terminalStatus}.`);
        }
        if (input.terminalEventId !== undefined && run.terminalEventId !== input.terminalEventId) {
          throw new Error(`Runtime run ${input.runId} already has a different terminal event.`);
        }
        const terminalEvent = run.terminalEventId === undefined ? undefined : this.readEventById(run.terminalEventId);
        if (!terminalEvent) throw new Error(`Runtime run ${input.runId} has no persisted terminal fact.`);
        assertTerminalEventMatchesRun(terminalEvent, run, input.status, input.payload === undefined ? run.terminalPayload : input.payload);
        // Omitted payload means no new projection evidence, never a request to clear it.
        if (input.payload === undefined || json(run.terminalPayload) === json(input.payload)) return run;
        if (input.terminalEventId === undefined || terminalEvent.eventType !== "session.turn_status") {
          throw new Error(`Runtime run ${input.runId} already has a different terminal fact.`);
        }
        // Only the known Host projection can enrich a canonical session terminal.
        // Self-contained run.terminal facts and opaque payloads remain immutable.
        const payload = enrichSessionTerminalPayload(terminalEvent, run.terminalPayload, input.payload);
        if (json(payload) === json(run.terminalPayload)) return run;
        this.database.prepare("UPDATE agent_runs SET terminal_payload_json = ?, updated_at = ? WHERE run_id = ?").run(json(payload), now, input.runId);
        return this.requireRun(input.runId);
      }
      const terminalEventId = input.terminalEventId ?? `run-terminal:${input.runId}`;
      const existingTerminalEvent = input.terminalEventId === undefined
        ? undefined
        : this.readEventById(input.terminalEventId);
      if (existingTerminalEvent) {
        assertTerminalEventMatchesRun(existingTerminalEvent, run, input.status, input.payload);
      } else {
        this.appendEventInTransaction({
          eventId: terminalEventId,
          sessionId: run.sessionId,
          invocationId: run.invocationId,
          runId: run.runId,
          turnId: run.turnId,
          eventType: "run.terminal",
          payload: { status: input.status, payload: input.payload },
          createdAt: now
        });
      }
      this.database.prepare(`
        UPDATE agent_runs
        SET status = ?, terminal_event_id = ?, terminal_status = ?, terminal_payload_json = ?, updated_at = ?
        WHERE run_id = ?
      `).run(input.status, terminalEventId, input.status, json(input.payload), now, input.runId);
      return this.requireRun(input.runId);
    });
  }

  /**
   * continuation 的幂等 claim。重连或 Host takeover 重试时，已经 claim 的 source
   * 只返回原 child，不会再次启动一个可能重复副作用的 AgentRun。
   */
  claimContinuation(sourceRunId: string, childRunId: string, claimToken = randomUUID(), createdAt = new Date().toISOString()): RuntimeContinuationClaim {
    this.assertOpen();
    assertNonEmpty(sourceRunId, "sourceRunId");
    assertNonEmpty(childRunId, "childRunId");
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT source_run_id, child_run_id, claim_token, created_at
        FROM run_continuation_claims WHERE source_run_id = ? AND workspace_id = ?
      `).get(sourceRunId, this.workspaceId) as Record<string, unknown> | undefined;
      if (existing) {
        const claim = toContinuationClaim(existing);
        if (claim.childRunId !== childRunId) throw new Error(`Run ${sourceRunId} already has another continuation claim.`);
        return claim;
      }
      const source = this.requireRun(sourceRunId);
      this.database.prepare(`
        INSERT INTO run_continuation_claims (source_run_id, workspace_id, child_run_id, claim_token, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sourceRunId, this.workspaceId, childRunId, claimToken, createdAt);
      this.appendEventInTransaction({
        eventId: `continuation-claim:${sourceRunId}:${claimToken}`,
        sessionId: source.sessionId,
        invocationId: childRunId,
        runId: childRunId,
        turnId: source.turnId,
        eventType: "run.continuation.claimed",
        payload: { sourceRunId, childRunId, claimToken },
        createdAt
      });
      return { sourceRunId, childRunId, claimToken, createdAt };
    });
  }

  /**
   * 释放尚未创建 child run 的 continuation claim。child 一旦落库就不能删除 claim，
   * 否则恢复重试会再次执行同一个 continuation。
   */
  releaseContinuationClaim(
    sourceRunId: string,
    childRunId: string,
    reason = "continuation admission failed",
    createdAt = new Date().toISOString()
  ): boolean {
    this.assertOpen();
    assertNonEmpty(sourceRunId, "sourceRunId");
    assertNonEmpty(childRunId, "childRunId");
    return this.transaction(() => {
      const row = this.database.prepare("SELECT source_run_id, workspace_id, child_run_id, claim_token, created_at FROM run_continuation_claims WHERE source_run_id = ? AND workspace_id = ?").get(sourceRunId, this.workspaceId) as Record<string, unknown> | undefined;
      if (!row) return false;
      const claim = toContinuationClaim(row);
      if (claim.childRunId !== childRunId) throw new Error(`Run ${sourceRunId} is claimed by another continuation.`);
      if (this.readRun(childRunId)) return false;
      const source = this.requireRun(sourceRunId);
      this.database.prepare("DELETE FROM run_continuation_claims WHERE source_run_id = ? AND workspace_id = ? AND child_run_id = ?").run(sourceRunId, this.workspaceId, childRunId);
      this.appendEventInTransaction({
        eventId: `continuation-release:${sourceRunId}:${claim.claimToken}`,
        sessionId: source.sessionId,
        invocationId: childRunId,
        runId: childRunId,
        turnId: source.turnId,
        eventType: "run.continuation.released",
        payload: { sourceRunId, childRunId, claimToken: claim.claimToken, reason },
        createdAt
      });
      return true;
    });
  }

  appendEvent(input: {
    eventId?: string;
    eventSeq?: number;
    sessionId: string;
    invocationId?: string;
    runId: string;
    turnId: string;
    eventType: string;
    payload?: unknown;
    createdAt?: string;
  }): RuntimeEvent {
    this.assertOpen();
    return this.transaction(() => this.appendEventInTransaction(input));
  }

  readEvents(options: { afterSequence?: number; limit?: number; runId?: string; sessionId?: string; runOrTurnId?: string } = {}): RuntimeEventPage {
    this.assertOpen();
    const afterSequence = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative safe integer.");
    const limit = pageSize(options.limit);
    const clauses = ["workspace_id = ?", "sequence > ?"];
    const parameters: Array<string | number> = [this.workspaceId, afterSequence];
    if (options.runId !== undefined) {
      clauses.push("run_id = ?");
      parameters.push(options.runId);
    }
    if (options.sessionId !== undefined) {
      clauses.push("session_id = ?");
      parameters.push(options.sessionId);
    }
    if (options.runOrTurnId !== undefined) {
      clauses.push("(run_id = ? OR turn_id = ?)");
      parameters.push(options.runOrTurnId, options.runOrTurnId);
    }
    const rows = this.database.prepare(`
      SELECT event_id, workspace_id, session_id, invocation_id, run_id, turn_id,
             event_seq, sequence, event_type, payload_json, created_at
      FROM runtime_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY sequence ASC
      LIMIT ?
    `).all(...parameters, limit + 1) as unknown as RuntimeEventRow[];
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const events = visible.map(toRuntimeEvent);
    return {
      events,
      nextCursor: hasMore ? events.at(-1)?.sequence : undefined,
      hasMore,
      gap: false
    };
  }

  /** 按稳定 toolCallId 从统一事实表读取跨 Session 的工具事件，供 Host 接管后恢复同一次操作。 */
  readToolEvents(toolCallIds: readonly string[]): RuntimeEvent[] {
    this.assertOpen();
    const ids = [...new Set(toolCallIds)];
    if (!ids.length || ids.some((toolCallId) => !toolCallId)) return [];
    const placeholders = ids.map(() => "?").join(", ");
    // 多 ID 的排序可能让优化器退回工作区扫描；恢复查询固定走 toolCallId 索引。
    const rows = this.database.prepare(`
      SELECT event_id, workspace_id, session_id, invocation_id, run_id, turn_id,
             event_seq, sequence, event_type, payload_json, created_at
      FROM runtime_events INDEXED BY runtime_events_toolcall_idx
      WHERE workspace_id = ?
        AND event_type IN ('session.tool_call', 'session.tool_execution', 'session.tool_result')
        AND json_extract(payload_json, '$.toolCallId') IN (${placeholders})
      ORDER BY sequence ASC
    `).all(this.workspaceId, ...ids) as unknown as RuntimeEventRow[];
    return rows.map(toRuntimeEvent);
  }

  getRun(runId: string): RuntimeRunRecord | undefined {
    this.assertOpen();
    return this.readRun(runId);
  }

  /**
   * 把某个 run 已落盘的 JSONL 终态立即补投影到 SQLite。
   *
   * AgentSession 的 turn_status 是 canonical fact；Host 在取消与收尾竞争中若未能完成
   * projection，可以调用这里恢复 authority，而不用等 owner 进程重启后做全量 backfill。
   */
  async reconcileRunFromSession(runId: string): Promise<RuntimeRunRecord | undefined> {
    this.assertOpen();
    const run = this.readRun(runId);
    if (!run) return undefined;
    const events = await readSessionEvents(await resolveSessionFile(this.persistenceRoot, run.sessionId));
    validateRuntimeEventStream(events);
    const terminals = events.filter((event): event is Extract<SessionEvent, { type: "turn_status" }> => {
      return event.type === "turn_status" && event.runtime?.runId === runId;
    });
    if (terminals.length > 1) throw new Error(`Runtime run ${runId} has multiple canonical terminal events.`);
    const terminal = terminals[0];
    const terminalRuntime = terminal?.runtime;
    if (!terminalRuntime) return run;
    if (terminalRuntime.turnId !== run.turnId) {
      throw new Error(`Runtime run ${runId} does not match its canonical terminal turn.`);
    }
    return this.transaction(() => {
      this.appendEventInTransaction({
        eventId: terminalRuntime.eventId,
        eventSeq: terminalRuntime.eventSeq,
        sessionId: run.sessionId,
        invocationId: run.invocationId,
        runId,
        turnId: run.turnId,
        eventType: sessionEventType(terminal),
        payload: terminal,
        createdAt: terminal.time ?? run.updatedAt
      });
      this.reconcileTerminalRunInTransaction(
        run.sessionId,
        terminal,
        terminalRuntime,
        runId,
        run.turnId,
        terminalRuntime.eventId
      );
      return this.requireRun(runId);
    });
  }

  listRuns(options: RuntimeRunListOptions = {}): RuntimeRunPage {
    this.assertOpen();
    const limit = pageSize(options.limit);
    const cursor = options.cursor === undefined ? 0 : parseRunCursor(options.cursor);
    const clauses = ["workspace_id = ?", "rowid > ?"];
    const parameters: Array<string | number> = [this.workspaceId, cursor];
    if (options.sessionId !== undefined) {
      clauses.push("session_id = ?");
      parameters.push(options.sessionId);
    }
    if (options.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(options.status);
    }
    const rows = this.database.prepare(`
      SELECT rowid, run_id, workspace_id, session_id, invocation_id, turn_id,
             parent_run_id, continuation_source, status, created_at, updated_at,
             terminal_event_id, terminal_status, terminal_payload_json, payload_json
      FROM agent_runs
      WHERE ${clauses.join(" AND ")}
      ORDER BY rowid ASC
      LIMIT ?
    `).all(...parameters, limit + 1) as unknown as Array<RuntimeRunRow & { rowid: unknown }>;
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      runs: visible.map(toRuntimeRun),
      nextCursor: hasMore ? String(visible.at(-1)?.rowid ?? "") : undefined,
      hasMore
    };
  }

  schemaRevision(): number {
    this.assertOpen();
    const row = this.database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    const value = row?.user_version;
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  /** 将变化过的 JSONL 事实幂等投影到 authority，修复进程崩溃留下的缺口。 */
  private async reconcileSessionProjections(): Promise<void> {
    const sessions = await listSessionFilePaths(this.persistenceRoot);
    for (const filePath of sessions) {
      const sessionId = sessionIdFromFile(filePath);
      let before: Awaited<ReturnType<typeof fs.stat>>;
      try {
        before = await fs.stat(filePath);
      } catch {
        // 列目录到解析之间文件可能已被并发清理（草稿回收/删除会话）；
        // 修复扫描跳过它即可，不能让单个消失的会话阻断 authority open。
        continue;
      }
      const fileSize = before.size;
      const modifiedAtMs = Math.trunc(before.mtimeMs);
      const backfill = this.database.prepare(
        "SELECT file_size, modified_at_ms, file_mtime_ms, changed_at_ms, file_dev, file_ino, event_count, content_hash FROM runtime_backfills WHERE session_id = ?"
      ).get(sessionId) as Record<string, unknown> | undefined;
      const hasDigest = typeof backfill?.content_hash === "string" && /^[a-f0-9]{64}$/u.test(backfill.content_hash);
      const unchanged = hasDigest
        ? Number(backfill?.file_size) === fileSize
          && Number(backfill?.file_mtime_ms) === before.mtimeMs
          && Number(backfill?.changed_at_ms) === before.ctimeMs
          && backfill?.file_dev === String(before.dev)
          && backfill?.file_ino === String(before.ino)
        : Number(backfill?.file_size) === fileSize && Number(backfill?.modified_at_ms) === modifiedAtMs;
      if (unchanged) continue;
      let events: SessionEvent[];
      let contentHash: string;
      let prefixHash: string | undefined;
      try {
        const read = await readSessionEventsForBackfill(filePath, Number(backfill?.file_size));
        events = read.events;
        contentHash = read.contentHash;
        prefixHash = read.prefixHash;
      } catch {
        // 坏的旧尾部仍交给 session 恢复逻辑处理；authority 不凭损坏数据伪造事实。
        continue;
      }
      try {
        validateRuntimeEventStream(events);
      } catch {
        // runtime metadata 损坏时不把 SQLite projection 当成新的事实来源；
        // session 恢复路径会报告更具体的顺序/重复 ID 错误。
        continue;
      }
      let after: Awaited<ReturnType<typeof fs.stat>>;
      try {
        after = await fs.stat(filePath);
      } catch {
        // 读事件期间文件被并发删除时不记录水位；下次 open 会再次完成投影。
        continue;
      }
      if (after.size !== fileSize || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || after.dev !== before.dev || after.ino !== before.ino) {
        // 读事件期间文件发生变化时不记录水位；下次 open 再核对。
        continue;
      }
      const previousCount = Number(backfill?.event_count);
      const unchangedPrefix = hasDigest && prefixHash === backfill?.content_hash
        && Number.isSafeInteger(previousCount) && previousCount >= 0 && previousCount <= events.length;
      this.transaction(() => {
        for (let index = unchangedPrefix ? previousCount : 0; index < events.length; index++) {
          const event = events[index]!;
          const runtime = event.runtime;
          const runId = runtime
            ? runtime.runId ?? `session:${sessionId}`
            : `legacy:${sessionId}`;
          const turnId = runtime?.turnId ?? runId;
          const eventId = runtime?.eventId ?? legacyEventId(sessionId, index + 1);
          this.appendEventInTransaction({
            eventId,
            eventSeq: runtime?.eventSeq,
            sessionId,
            invocationId: runtime?.runId ?? eventId,
            runId,
            turnId,
            eventType: runtime ? sessionEventType(event) : `legacy.${event.type}`,
            payload: event,
            createdAt: event.time ?? new Date(0).toISOString()
          });
          this.reconcileTerminalRunInTransaction(sessionId, event, runtime, runId, turnId, eventId);
        }
        this.database.prepare(`
          INSERT OR REPLACE INTO runtime_backfills
            (session_id, completed_at, event_count, file_size, modified_at_ms,
             file_mtime_ms, changed_at_ms, file_dev, file_ino, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId,
          new Date().toISOString(),
          events.length,
          fileSize,
          modifiedAtMs,
          before.mtimeMs,
          before.ctimeMs,
          String(before.dev),
          String(before.ino),
          contentHash
        );
      });
    }
  }

  private reconcileTerminalRunInTransaction(
    sessionId: string,
    event: SessionEvent,
    runtime: RuntimeEventIdentity | undefined,
    runId: string,
    turnId: string,
    eventId: string
  ): void {
    if (event.type !== "turn_status" || runtime?.runId === undefined) return;
    const terminalStatus = runtimeRunStatusFromSessionStatus(event.status);
    const run = this.readRun(runId);
    if (!run) return;
    if (run.sessionId !== sessionId || run.turnId !== turnId) {
      throw new Error(`Runtime run ${runId} does not match reconciled session turn.`);
    }
    if (run.terminalStatus !== undefined) {
      if (run.terminalStatus !== terminalStatus || run.terminalEventId !== eventId) {
        throw new Error(`Runtime run ${runId} has a conflicting reconciled terminal event.`);
      }
      return;
    }
    const now = event.time ?? new Date().toISOString();
    this.database.prepare(`
      UPDATE agent_runs
      SET status = ?, terminal_event_id = ?, terminal_status = ?, terminal_payload_json = ?, updated_at = ?
      WHERE run_id = ? AND workspace_id = ? AND terminal_status IS NULL
    `).run(
      terminalStatus,
      eventId,
      terminalStatus,
      json(terminalPayloadFromSessionEvent(event)),
      now,
      runId,
      this.workspaceId
    );
  }

  private migrate(): void {
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    const revision = this.schemaRevision();
    if (revision > schemaVersion) throw new Error(`Unsupported runtime schema revision ${String(revision)}.`);
    if (revision === 0) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS runtime_events (
            event_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            invocation_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            event_seq INTEGER,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (workspace_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS runtime_events_toolcall_idx
          ON runtime_events (workspace_id, json_extract(payload_json, '$.toolCallId'), sequence)
          WHERE event_type IN ('session.tool_call', 'session.tool_execution', 'session.tool_result');
          CREATE INDEX IF NOT EXISTS runtime_events_run_idx ON runtime_events (workspace_id, run_id, sequence);
          CREATE INDEX IF NOT EXISTS runtime_events_session_idx ON runtime_events (workspace_id, session_id, sequence);
          CREATE UNIQUE INDEX IF NOT EXISTS runtime_events_session_event_seq_idx ON runtime_events (workspace_id, session_id, event_seq) WHERE event_seq IS NOT NULL;

          CREATE TABLE IF NOT EXISTS agent_runs (
            run_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            invocation_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            parent_run_id TEXT,
            continuation_source TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            terminal_event_id TEXT,
            terminal_status TEXT,
            terminal_payload_json TEXT,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS agent_runs_workspace_idx ON agent_runs (workspace_id, created_at);
          CREATE INDEX IF NOT EXISTS agent_runs_session_idx ON agent_runs (workspace_id, session_id, created_at);
          CREATE TABLE IF NOT EXISTS run_continuation_claims (
            source_run_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            child_run_id TEXT NOT NULL,
            claim_token TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS task_runs (
            task_run_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            session_id TEXT,
            parent_run_id TEXT,
            status TEXT NOT NULL,
            task_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            terminal_event_id TEXT,
            revision INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS task_attempts (
            attempt_id TEXT PRIMARY KEY,
            task_run_id TEXT NOT NULL REFERENCES task_runs(task_run_id) ON DELETE CASCADE,
            run_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            parent_run_id TEXT,
            status TEXT NOT NULL,
            high_water_sequence INTEGER,
            retry_safety TEXT NOT NULL,
            verification_json TEXT,
            artifacts_json TEXT,
            failure_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS task_events (
            event_id TEXT PRIMARY KEY,
            task_run_id TEXT NOT NULL REFERENCES task_runs(task_run_id) ON DELETE CASCADE,
            attempt_id TEXT,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS automations (
            automation_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            trigger_type TEXT NOT NULL,
            schedule_json TEXT NOT NULL,
            execution_template_json TEXT NOT NULL,
            status TEXT NOT NULL,
            next_fire_at TEXT,
            last_fire_at TEXT,
            fire_count INTEGER NOT NULL DEFAULT 0,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            max_fires INTEGER,
            expires_at TEXT,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS automation_pending_fires (
            fire_id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(automation_id) ON DELETE CASCADE,
            scheduled_at TEXT NOT NULL,
            claim_token TEXT,
            claimed_at TEXT,
            status TEXT NOT NULL,
            run_id TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (automation_id, scheduled_at)
          );

          CREATE TABLE IF NOT EXISTS graphs (
            graph_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            status TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'fixed',
            supervisor_session_id TEXT,
            max_replans INTEGER NOT NULL DEFAULT 0,
            replan_count INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS graph_nodes (
            node_id TEXT PRIMARY KEY,
            graph_id TEXT NOT NULL REFERENCES graphs(graph_id) ON DELETE CASCADE,
            node_key TEXT NOT NULL,
            status TEXT NOT NULL,
            dependencies_json TEXT NOT NULL,
            intent_json TEXT NOT NULL,
            task_run_id TEXT,
            artifact_json TEXT,
            replaces_node_id TEXT REFERENCES graph_nodes(node_id),
            revision INTEGER NOT NULL DEFAULT 0,
            UNIQUE (graph_id, node_key)
          );
          CREATE TABLE IF NOT EXISTS graph_intent_claims (
            claim_id TEXT PRIMARY KEY,
            graph_id TEXT NOT NULL REFERENCES graphs(graph_id) ON DELETE CASCADE,
            node_id TEXT NOT NULL REFERENCES graph_nodes(node_id) ON DELETE CASCADE,
            intent_fingerprint TEXT NOT NULL,
            claim_token TEXT NOT NULL,
            status TEXT NOT NULL,
            claimed_at TEXT NOT NULL,
            UNIQUE (graph_id, node_id, intent_fingerprint)
          );
          CREATE TABLE IF NOT EXISTS graph_wakes (
            wake_id TEXT PRIMARY KEY,
            graph_id TEXT NOT NULL REFERENCES graphs(graph_id) ON DELETE CASCADE,
            reason TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'dispatch',
            graph_revision INTEGER,
            checkpoint TEXT,
            session_id TEXT,
            run_id TEXT,
            status TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            completed_at TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS graph_supervisor_wakes_unique
            ON graph_wakes (graph_id, graph_revision, checkpoint, session_id)
            WHERE kind = 'supervisor';

          CREATE TABLE IF NOT EXISTS capability_registrations (
            registration_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            owner_type TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            capability_name TEXT NOT NULL,
            revision INTEGER NOT NULL,
            schema_json TEXT NOT NULL,
            status TEXT NOT NULL,
            expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (workspace_id, owner_id, capability_name)
          );
          CREATE TABLE IF NOT EXISTS capability_invocations (
            invocation_id TEXT PRIMARY KEY,
            registration_id TEXT NOT NULL REFERENCES capability_registrations(registration_id) ON DELETE CASCADE,
            offer_id TEXT,
            session_id TEXT,
            turn_id TEXT,
            tool_call_id TEXT,
            status TEXT NOT NULL,
            request_json TEXT NOT NULL,
            request_hash TEXT,
            dispatch_state TEXT NOT NULL DEFAULT 'dispatched',
            result_json TEXT,
            error TEXT,
            outcome_unknown_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS capability_invocations_offer_idx ON capability_invocations (registration_id, offer_id);
          CREATE TABLE IF NOT EXISTS capability_invocation_chunks (
            invocation_id TEXT NOT NULL REFERENCES capability_invocations(invocation_id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            data_json TEXT NOT NULL,
            final INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            PRIMARY KEY (invocation_id, chunk_index)
          );

          CREATE TABLE IF NOT EXISTS runtime_backfills (
            session_id TEXT PRIMARY KEY,
            completed_at TEXT NOT NULL,
            event_count INTEGER NOT NULL,
            file_size INTEGER,
            modified_at_ms INTEGER,
            file_mtime_ms REAL,
            changed_at_ms REAL,
            file_dev TEXT,
            file_ino TEXT,
            content_hash TEXT
          );
        `);
        this.createSessionGoalSchema();
        // Keep initial schema and index creation atomic without a second write transaction.
        if (!this.hasTaskAttemptIndex()) {
          this.database.exec(`CREATE INDEX IF NOT EXISTS ${taskAttemptIndexName} ON task_attempts(task_run_id)`);
          if (!this.hasTaskAttemptIndex()) throw new Error(`Optional task-attempt index ${taskAttemptIndexName} was not created.`);
        }
        this.database.exec(`PRAGMA user_version = ${String(schemaVersion)};`);
      });
    } else {
      let currentRevision = revision;
      if (currentRevision < 2) {
      this.transaction(() => {
        if (!this.hasColumn("agent_runs", "terminal_payload_json")) {
          this.database.exec("ALTER TABLE agent_runs ADD COLUMN terminal_payload_json TEXT");
        }
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS run_continuation_claims (
            source_run_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            child_run_id TEXT NOT NULL,
            claim_token TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `);
        this.database.exec("PRAGMA user_version = 2");
      });
        currentRevision = 2;
      }
      if (currentRevision < 3) {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS capability_invocation_chunks (
              invocation_id TEXT NOT NULL REFERENCES capability_invocations(invocation_id) ON DELETE CASCADE,
              chunk_index INTEGER NOT NULL,
              data_json TEXT NOT NULL,
              final INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              PRIMARY KEY (invocation_id, chunk_index)
            );
          `);
          this.database.exec("PRAGMA user_version = 3");
        });
      }
      if (currentRevision < 4) {
        this.transaction(() => {
          if (!this.hasColumn("runtime_events", "event_seq")) {
            this.database.exec("ALTER TABLE runtime_events ADD COLUMN event_seq INTEGER");
          }
          this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS runtime_events_session_event_seq_idx ON runtime_events (workspace_id, session_id, event_seq) WHERE event_seq IS NOT NULL");
          this.database.exec("PRAGMA user_version = 4");
        });
        currentRevision = 4;
      }
      if (currentRevision < 5) {
        this.transaction(() => {
          if (!this.hasColumn("runtime_backfills", "file_size")) {
            this.database.exec("ALTER TABLE runtime_backfills ADD COLUMN file_size INTEGER");
          }
          if (!this.hasColumn("runtime_backfills", "modified_at_ms")) {
            this.database.exec("ALTER TABLE runtime_backfills ADD COLUMN modified_at_ms INTEGER");
          }
          this.database.exec("PRAGMA user_version = 5");
        });
        currentRevision = 5;
      }
      if (currentRevision < 6) {
        this.transaction(() => {
          if (!this.hasColumn("graphs", "mode")) {
            this.database.exec("ALTER TABLE graphs ADD COLUMN mode TEXT NOT NULL DEFAULT 'fixed'");
          }
          if (!this.hasColumn("graphs", "supervisor_session_id")) {
            this.database.exec("ALTER TABLE graphs ADD COLUMN supervisor_session_id TEXT");
          }
          if (!this.hasColumn("graphs", "max_replans")) {
            this.database.exec("ALTER TABLE graphs ADD COLUMN max_replans INTEGER NOT NULL DEFAULT 0");
          }
          if (!this.hasColumn("graphs", "replan_count")) {
            this.database.exec("ALTER TABLE graphs ADD COLUMN replan_count INTEGER NOT NULL DEFAULT 0");
          }
          if (!this.hasColumn("graph_nodes", "replaces_node_id")) {
            this.database.exec("ALTER TABLE graph_nodes ADD COLUMN replaces_node_id TEXT REFERENCES graph_nodes(node_id)");
          }
          if (!this.hasColumn("graph_wakes", "kind")) {
            this.database.exec("ALTER TABLE graph_wakes ADD COLUMN kind TEXT NOT NULL DEFAULT 'dispatch'");
          }
          if (!this.hasColumn("graph_wakes", "graph_revision")) {
            this.database.exec("ALTER TABLE graph_wakes ADD COLUMN graph_revision INTEGER");
          }
          if (!this.hasColumn("graph_wakes", "checkpoint")) {
            this.database.exec("ALTER TABLE graph_wakes ADD COLUMN checkpoint TEXT");
          }
          if (!this.hasColumn("graph_wakes", "session_id")) {
            this.database.exec("ALTER TABLE graph_wakes ADD COLUMN session_id TEXT");
          }
          if (!this.hasColumn("graph_wakes", "run_id")) {
            this.database.exec("ALTER TABLE graph_wakes ADD COLUMN run_id TEXT");
          }
          this.database.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS graph_supervisor_wakes_unique
              ON graph_wakes (graph_id, graph_revision, checkpoint, session_id)
              WHERE kind = 'supervisor'
          `);
          this.database.exec("PRAGMA user_version = 6");
        });
      }
      if (currentRevision < 7) {
        this.transaction(() => {
          // 来源 run 已保存在 graph.created 事件中，无需再维护一份可变投影。
          if (this.hasColumn("graphs", "supervisor_run_id")) {
            this.database.exec("ALTER TABLE graphs DROP COLUMN supervisor_run_id");
          }
          this.database.exec("PRAGMA user_version = 7");
        });
        currentRevision = 7;
      }
      if (currentRevision < 8) {
        this.transaction(() => {
          if (!this.hasColumn("capability_invocations", "request_hash")) {
            this.database.exec("ALTER TABLE capability_invocations ADD COLUMN request_hash TEXT");
          }
          if (!this.hasColumn("capability_invocations", "outcome_unknown_reason")) {
            this.database.exec("ALTER TABLE capability_invocations ADD COLUMN outcome_unknown_reason TEXT");
          }
          this.database.exec("CREATE INDEX IF NOT EXISTS capability_invocations_offer_idx ON capability_invocations (registration_id, offer_id)");
          this.database.exec("PRAGMA user_version = 8");
        });
        currentRevision = 8;
      }
      if (currentRevision < 9) {
        this.transaction(() => {
          if (!this.hasColumn("capability_invocations", "dispatch_state")) {
            // 旧版本没有派发边界证据，沿用保守解释：在途记录可能已到达外部执行器。
            this.database.exec("ALTER TABLE capability_invocations ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'dispatched'");
          }
          this.database.exec("PRAGMA user_version = 9");
        });
      }
      if (currentRevision < 10) {
        this.transaction(() => {
          this.database.exec(`CREATE INDEX IF NOT EXISTS runtime_events_toolcall_idx
          ON runtime_events (workspace_id, json_extract(payload_json, '$.toolCallId'), sequence)
          WHERE event_type IN ('session.tool_call', 'session.tool_execution', 'session.tool_result');
            PRAGMA user_version = 10;`);
        });
      }
      if (currentRevision < 11) {
        this.transaction(() => {
          for (const [column, type] of [
            ["file_mtime_ms", "REAL"], ["changed_at_ms", "REAL"],
            ["file_dev", "TEXT"], ["file_ino", "TEXT"], ["content_hash", "TEXT"]
          ] as const) {
            if (!this.hasColumn("runtime_backfills", column)) {
              this.database.exec(`ALTER TABLE runtime_backfills ADD COLUMN ${column} ${type}`);
            }
          }
          this.database.exec("PRAGMA user_version = 11");
        });
      }
      if (currentRevision < 12) {
        this.transaction(() => {
          this.createSessionGoalSchema();
          this.database.exec("PRAGMA user_version = 12");
        });
      }
      if (currentRevision < 13) {
        this.transaction(() => {
          // 移除工作区目标记录；任务图、会话目标和审计事件保留。
          this.database.exec("DROP TABLE IF EXISTS goals");
          if (this.hasColumn("graphs", "goal_id")) this.database.exec("ALTER TABLE graphs DROP COLUMN goal_id");
          this.database.exec("PRAGMA user_version = 13");
        });
      }
    }
  }

  /** Optional physical optimization; schema-13 readers never require this index. */
  private ensureTaskAttemptIndex(): void {
    if (this.hasTaskAttemptIndex()) return;
    const timeout = toInteger(this.database.prepare("PRAGMA busy_timeout").get()?.timeout, "busy_timeout");
    let transactionRequested = false;
    let callbackStarted = false;
    let failed = false;
    let failure: unknown;
    try {
      this.database.exec("PRAGMA busy_timeout = 0");
      transactionRequested = true;
      this.transaction(() => {
        callbackStarted = true;
        const revision = this.schemaRevision();
        if (revision !== schemaVersion) throw new Error(`Runtime schema revision ${String(revision)} changed before optional index maintenance.`);
        if (this.hasTaskAttemptIndex()) return;
        this.database.exec(`CREATE INDEX IF NOT EXISTS ${taskAttemptIndexName} ON task_attempts(task_run_id)`);
        if (!this.hasTaskAttemptIndex()) throw new Error(`Optional task-attempt index ${taskAttemptIndexName} was not created.`);
      });
    } catch (error) {
      // Only another writer winning BEGIN may defer this optional work to a later open.
      // DDL, callback, commit, extended codes and required-migration errors stay fatal.
      const beginBusy = transactionRequested && !callbackStarted
        && error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR"
        && "errcode" in error && error.errcode === 5;
      if (!beginBusy) { failed = true; failure = error; }
    }
    try {
      this.database.exec(`PRAGMA busy_timeout = ${String(timeout)}`);
    } catch (error) {
      if (!failed) throw error;
      // open() closes this connection; preserve the primary error if restoration also fails.
    }
    if (failed) throw failure;
  }

  /** Reading a valid existing index must not acquire a write lock. */
  private hasTaskAttemptIndex(): boolean {
    const object = this.database.prepare("SELECT type, tbl_name FROM sqlite_schema WHERE name = ? COLLATE NOCASE").get(taskAttemptIndexName);
    if (!object) return false;
    const mismatch = (): never => { throw new Error(`Optional task-attempt index ${taskAttemptIndexName} has an incompatible definition.`); };
    if (object.type !== "index" || typeof object.tbl_name !== "string" || object.tbl_name.toLowerCase() !== "task_attempts") mismatch();
    const definition = this.database.prepare("PRAGMA index_list('task_attempts')").all()
      .find((index) => typeof index.name === "string" && index.name.toLowerCase() === taskAttemptIndexName);
    const columns = this.database.prepare(`PRAGMA index_xinfo('${taskAttemptIndexName}')`).all();
    const keys = columns.filter((column) => column.key === 1);
    const auxiliary = columns.filter((column) => column.key === 0);
    if (!definition || definition.unique !== 0 || definition.partial !== 0
      || keys.length !== 1 || typeof keys[0]?.name !== "string" || keys[0].name.toLowerCase() !== "task_run_id"
      || keys[0].desc !== 0 || typeof keys[0].coll !== "string" || keys[0].coll.toUpperCase() !== "BINARY"
      || auxiliary.length !== 1 || auxiliary[0]?.cid !== -1 || auxiliary[0].name !== null || auxiliary[0].desc !== 0) mismatch();
    return true;
  }

  private createSessionGoalSchema(): void {
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS agent_runs_continuation_source_idx
        ON agent_runs (workspace_id, session_id, continuation_source);
      CREATE TABLE IF NOT EXISTS session_goals (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        goal_id TEXT NOT NULL UNIQUE,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_ms INTEGER NOT NULL DEFAULT 0,
        usage_known INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS session_goals_status_idx ON session_goals (workspace_id, status);
      CREATE TABLE IF NOT EXISTS session_goal_usage (
        workspace_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        usage_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, goal_id, usage_id)
      );
    `);
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    return rows.some((row) => row.name === column);
  }

  private appendEventInTransaction(input: RuntimeEventAppendInput): RuntimeEvent {
    assertNonEmpty(input.sessionId, "sessionId");
    assertNonEmpty(input.runId, "runId");
    assertNonEmpty(input.turnId, "turnId");
    assertNonEmpty(input.eventType, "eventType");
    if (input.eventSeq !== undefined) assertRuntimeEventSequence(input.eventSeq);
    const eventId = input.eventId ?? randomUUID();
    const existing = this.database.prepare(`
      SELECT event_id, workspace_id, session_id, invocation_id, run_id, turn_id,
             event_seq, sequence, event_type, payload_json, created_at
      FROM runtime_events WHERE event_id = ?
    `).get(eventId) as unknown as RuntimeEventRow | undefined;
    if (existing) {
      const current = toRuntimeEvent(existing);
      const payloadMatches = current.eventType.startsWith("session.")
        ? sessionPayloadJson(current.payload) === sessionPayloadJson(input.payload)
        : json(current.payload) === json(input.payload);
      const conflictingFields = Object.entries({
        workspaceId: current.workspaceId !== this.workspaceId,
        sessionId: current.sessionId !== input.sessionId,
        runId: current.runId !== input.runId,
        turnId: current.turnId !== input.turnId,
        eventType: current.eventType !== input.eventType,
        eventSeq: current.eventSeq !== undefined && current.eventSeq !== input.eventSeq
      }).filter(([, differs]) => differs).map(([field]) => field);
      if (!payloadMatches) {
        const saved = current.payload;
        const incoming = input.payload;
        // 只报告固定的字段名称；消息、工具参数和元数据值不能进入启动诊断。
        const payloadFields = saved && incoming && typeof saved === "object" && typeof incoming === "object"
          ? ["type", "content", "message", "messageId", "parentMessageId", "slotId", "runtime", "metadata"]
            .filter((field) => json((saved as Record<string, unknown>)[field]) !== json((incoming as Record<string, unknown>)[field]))
            .map((field) => `payload.${field}`)
          : [];
        conflictingFields.push(...(payloadFields.length ? payloadFields : ["payload"]));
      }
      if (conflictingFields.length) {
        throw new Error(`Runtime event id ${eventId} is already bound to another fact. `
          + `Session: ${input.sessionId}. Conflicting fields: ${conflictingFields.join(", ")}. `
          + "Check the session JSONL against a verified backup; the saved event was not overwritten.");
      }
      if (current.eventSeq === undefined && input.eventSeq !== undefined) {
        this.database.prepare("UPDATE runtime_events SET event_seq = ? WHERE event_id = ?").run(input.eventSeq, eventId);
        return { ...current, eventSeq: input.eventSeq };
      }
      return current;
    }
    const next = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM runtime_events WHERE workspace_id = ?").get(this.workspaceId) as Record<string, unknown> | undefined;
    const sequence = toInteger(next?.sequence, "runtime sequence");
    const event: RuntimeEvent = {
      eventId,
      workspaceId: this.workspaceId,
      sessionId: input.sessionId,
      invocationId: input.invocationId ?? eventId,
      runId: input.runId,
      turnId: input.turnId,
      eventSeq: input.eventSeq,
      sequence,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    this.database.prepare(`
      INSERT INTO runtime_events (
        event_id, workspace_id, session_id, invocation_id, run_id, turn_id,
        event_seq, sequence, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.workspaceId,
      event.sessionId,
      event.invocationId,
      event.runId,
      event.turnId,
      event.eventSeq ?? null,
      event.sequence,
      event.eventType,
      json(event.payload),
      event.createdAt
    );
    return event;
  }

  private readRun(runId: string): RuntimeRunRecord | undefined {
    const row = this.database.prepare(`
      SELECT run_id, workspace_id, session_id, invocation_id, turn_id,
             parent_run_id, continuation_source, status, created_at, updated_at,
             terminal_event_id, terminal_status, terminal_payload_json, payload_json
      FROM agent_runs WHERE run_id = ? AND workspace_id = ?
    `).get(runId, this.workspaceId) as unknown as RuntimeRunRow | undefined;
    return row ? toRuntimeRun(row) : undefined;
  }

  private readEventById(eventId: string): RuntimeEvent | undefined {
    const row = this.database.prepare(`
      SELECT event_id, workspace_id, session_id, invocation_id, run_id, turn_id,
             event_seq, sequence, event_type, payload_json, created_at
      FROM runtime_events WHERE event_id = ? AND workspace_id = ?
    `).get(eventId, this.workspaceId) as unknown as RuntimeEventRow | undefined;
    return row ? toRuntimeEvent(row) : undefined;
  }

  private requireRun(runId: string): RuntimeRunRecord {
    const run = this.readRun(runId);
    if (!run) throw new Error(`Runtime run ${runId} does not exist.`);
    return run;
  }

  private transaction<T>(execute: () => T): T {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = execute();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // 保留原始失败；SQLite 连接后续会在 Host 关闭时释放。
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Runtime authority is closed.");
  }
}

function workspaceIdForRoot(root: string): string {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32);
}

function sessionEventType(event: unknown): string {
  if (typeof event === "object" && event !== null && "type" in event && typeof (event as { type?: unknown }).type === "string") {
    return `session.${(event as { type: string }).type}`;
  }
  return "session.unknown";
}

function legacyEventId(sessionId: string, sequence: number): string {
  return `legacy-event:${createHash("sha256").update(`${sessionId}:${String(sequence)}`).digest("hex")}`;
}

function assertTerminalEventMatchesRun(
  event: RuntimeEvent,
  run: RuntimeRunRecord,
  status: RuntimeRunStatus,
  projection: unknown
): void {
  if (event.sessionId !== run.sessionId || event.runId !== run.runId || event.turnId !== run.turnId) {
    throw new Error(`Runtime terminal event ${event.eventId} belongs to another run or turn.`);
  }
  const eventPayload = event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : undefined;
  if (event.eventType === "session.turn_status") {
    if (eventPayload?.status !== status) throw new Error(`Runtime terminal event ${event.eventId} has a different status.`);
    const projectionRecord = projection !== null && typeof projection === "object" && !Array.isArray(projection)
      ? projection as Record<string, unknown>
      : undefined;
    const displayProjection = terminalRecord(projectionRecord?.projection);
    if (displayProjection?.status !== undefined && displayProjection.status !== status) {
      throw new Error(`Runtime terminal event ${event.eventId} has a different projection status.`);
    }
    for (const [field, canonicalField] of [["stopReason", "stopReason"], ["finishReason", "finishReason"], ["steps", "steps"], ["error", "summary"]] as const) {
      if (projectionRecord?.[field] !== undefined && json(eventPayload[canonicalField]) !== json(projectionRecord[field])) {
        throw new Error(`Runtime terminal event ${event.eventId} has a different ${field === "stopReason" ? "stop reason" : field}.`);
      }
    }
    return;
  }
  if (event.eventType !== "run.terminal" || eventPayload?.status !== status || json(eventPayload.payload) !== json(projection)) {
    throw new Error(`Runtime terminal event ${event.eventId} is not the requested terminal fact.`);
  }
}

const terminalPayloadFields = ["stopReason", "finishReason", "steps", "output", "error", "projection"] as const;
const terminalProjectionFields = ["status", "durationMs", "stopReason", "finishReason", "steps", "resumable", "blockedReason", "requiredAction", "error"] as const;

/** Exactly the two known projection levels; this is not a merge policy for arbitrary payloads. */
function enrichSessionTerminalPayload(event: RuntimeEvent, current: unknown, incoming: unknown): Record<string, unknown> {
  const previous = terminalRecord(current);
  const next = terminalRecord(incoming);
  if (!previous || !next) throw new Error(`Runtime terminal event ${event.eventId} cannot replace an opaque terminal payload.`);
  const result = enrichTerminalFields(previous, next, terminalPayloadFields, "output");
  if (next.projection !== undefined) {
    const previousProjection = previous.projection === undefined ? {} : terminalRecord(previous.projection);
    const nextProjection = terminalRecord(next.projection);
    if (!previousProjection || !nextProjection) throw new Error(`Runtime terminal event ${event.eventId} cannot clear its projection.`);
    // Startup's exact canonical projection is provisional display metadata. Host
    // may fill its normalized error/reason as well as zero-duration placeholders.
    const canonical = event.payload as Extract<SessionEvent, { type: "turn_status" }>;
    const recovering = json(current) === json(terminalPayloadFromSessionEvent(canonical));
    result.projection = enrichTerminalFields(previousProjection, nextProjection, terminalProjectionFields, "durationMs", recovering);
  }
  return result;
}

function terminalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function enrichTerminalFields(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  allowed: readonly string[],
  placeholder: "output" | "durationMs",
  recovering = false
): Record<string, unknown> {
  if ([...Object.keys(previous), ...Object.keys(next)].some((key) => !allowed.includes(key))) {
    throw new Error("Runtime terminal payload has unsupported enrichment fields.");
  }
  const result = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || key === "projection") continue;
    if (value === null) throw new Error(`Runtime terminal ${key} cannot be cleared.`);
    if (key === "output" && typeof value !== "string"
      || key === "durationMs" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`Runtime terminal ${key} has invalid enrichment evidence.`);
    }
    const old = previous[key];
    if (old !== undefined && old !== "" && value === "") throw new Error(`Runtime terminal ${key} cannot be cleared.`);
    const fillsPlaceholder = key === placeholder && old === (placeholder === "output" ? "" : 0);
    const fillsDisplayProjection = recovering && ["error", "blockedReason", "requiredAction"].includes(key);
    if (old !== undefined && json(old) !== json(value) && !fillsPlaceholder && !fillsDisplayProjection) {
      throw new Error(`Runtime terminal ${key} already has different evidence.`);
    }
    result[key] = value;
  }
  return result;
}

function isTerminalRunStatus(status: RuntimeRunStatus): boolean {
  return status === "completed"
    || status === "blocked"
    || status === "incomplete"
    || status === "cancelled"
    || status === "aborted"
    || status === "failed";
}

function runtimeRunStatusFromSessionStatus(status: Extract<SessionEvent, { type: "turn_status" }>['status']): RuntimeRunStatus {
  if (status === "completed" || status === "blocked" || status === "incomplete" || status === "cancelled" || status === "aborted" || status === "failed") return status;
  throw new Error(`Session turn status ${status} is not a runtime terminal status.`);
}

function terminalPayloadFromSessionEvent(event: Extract<SessionEvent, { type: "turn_status" }>): Record<string, unknown> {
  return {
    stopReason: event.stopReason,
    finishReason: event.finishReason,
    steps: event.steps,
    output: "",
    error: event.summary,
    projection: {
      status: event.status,
      durationMs: 0,
      stopReason: event.stopReason,
      finishReason: event.finishReason,
      steps: event.steps,
      resumable: event.resumable,
      blockedReason: event.blockedReason,
      requiredAction: event.requiredAction,
      error: event.summary
    }
  };
}

function pageSize(value: number | undefined): number {
  const resolved = value ?? defaultPageSize;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maxPageSize) {
    throw new Error(`Page size must be an integer between 1 and ${String(maxPageSize)}.`);
  }
  return resolved;
}

function parseRunCursor(value: string): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error("Invalid run cursor.");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid run cursor.");
  return cursor;
}

function json(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value === undefined ? null : value));
}

/** JSONL 写入器会补上 time；旧 authority 投影可能没有该字段，不能因此拒绝回填。 */
function sessionPayloadJson(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return json(value);
  const payload = { ...(value as Record<string, unknown>) };
  delete payload.time;
  return json(payload);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalJsonValue(object[key])])
    );
  }
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function toRuntimeEvent(row: RuntimeEventRow): RuntimeEvent {
  return {
    eventId: toString(row.event_id, "event_id"),
    workspaceId: toString(row.workspace_id, "workspace_id"),
    sessionId: toString(row.session_id, "session_id"),
    invocationId: toString(row.invocation_id, "invocation_id"),
    runId: toString(row.run_id, "run_id"),
    turnId: toString(row.turn_id, "turn_id"),
    eventSeq: row.event_seq === null || row.event_seq === undefined ? undefined : toInteger(row.event_seq, "event_seq"),
    sequence: toInteger(row.sequence, "sequence"),
    eventType: toString(row.event_type, "event_type"),
    payload: parseJson(row.payload_json),
    createdAt: toString(row.created_at, "created_at")
  };
}

function toRuntimeRun(row: RuntimeRunRow): RuntimeRunRecord {
  return {
    runId: toString(row.run_id, "run_id"),
    workspaceId: toString(row.workspace_id, "workspace_id"),
    sessionId: toString(row.session_id, "session_id"),
    invocationId: toString(row.invocation_id, "invocation_id"),
    turnId: toString(row.turn_id, "turn_id"),
    parentRunId: optionalString(row.parent_run_id),
    continuationSource: optionalString(row.continuation_source),
    status: runtimeRunStatus(row.status),
    createdAt: toString(row.created_at, "created_at"),
    updatedAt: toString(row.updated_at, "updated_at"),
    terminalEventId: optionalString(row.terminal_event_id),
    terminalStatus: optionalRuntimeRunStatus(row.terminal_status),
    terminalPayload: parseJson(row.terminal_payload_json),
    payload: parseJson(row.payload_json)
  };
}

function toContinuationClaim(row: Record<string, unknown>): RuntimeContinuationClaim {
  return {
    sourceRunId: toString(row.source_run_id, "source_run_id"),
    childRunId: toString(row.child_run_id, "child_run_id"),
    claimToken: toString(row.claim_token, "claim_token"),
    createdAt: toString(row.created_at, "created_at")
  };
}

function runtimeRunStatus(value: unknown): RuntimeRunStatus {
  if (value === "admitted" || value === "running" || value === "completed" || value === "blocked" || value === "incomplete" || value === "cancelled" || value === "aborted" || value === "failed" || value === "unknown") return value;
  throw new Error(`Invalid runtime run status: ${String(value)}`);
}

function optionalRuntimeRunStatus(value: unknown): RuntimeRunStatus | undefined {
  return value === null || value === undefined ? undefined : runtimeRunStatus(value);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : toString(value, "value");
}

function toString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field} in runtime authority row.`);
  return value;
}

function toInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isSafeInteger(numberValue)) throw new Error(`Invalid ${field} in runtime authority row.`);
  return numberValue;
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} cannot be empty.`);
}
