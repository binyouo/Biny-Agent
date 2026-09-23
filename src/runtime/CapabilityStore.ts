/**
 * Host / client Capability envelope 的 durable authority。
 *
 * 能力的执行者可以是 Host 或连接到 Unix socket 的 client；无论执行发生在哪一侧，
 * registration、invocation、分块结果和释放都先落到同一个 runtime.sqlite，避免 UI
 * 内存状态被误当成调用事实。真正的 MCP/Plugin 连接仍由 Host 持有，这里只统一它们
 * 对外的审计与恢复边界。
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ToolOutcomeUnknownError, type ToolOutcomeUnknownReason } from "../tools/types.js";
import type { RuntimeEventAuthority } from "./RuntimeAuthority.js";

export type CapabilityOwnerType = "host" | "client";
export type CapabilityRegistrationStatus = "registered" | "replaced" | "admitted" | "rejected" | "released";
export type CapabilityInvocationStatus = "admitted" | "accepted" | "running" | "result" | "failed" | "cancelled" | "unknown";
export type CapabilityDispatchState = "not_dispatched" | "dispatched";

export class CapabilityIdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";
  readonly retrySafe = false;

  constructor(readonly operationId: string, detail = "The operation id is already bound to different arguments.") {
    super(detail);
    this.name = "CapabilityIdempotencyConflictError";
  }
}

export class CapabilityOutcomeUnknownError extends Error {
  readonly code = "outcome_unknown";
  readonly retrySafe = false;

  constructor(
    readonly operationId: string,
    readonly reason: ToolOutcomeUnknownReason,
    detail = "The operation may have taken effect; do not retry it automatically."
  ) {
    super(`Capability outcome is unknown (${reason}): ${detail}`);
    this.name = "CapabilityOutcomeUnknownError";
  }
}

export class CapabilityInvocationCancelledError extends Error {
  readonly code = "operation_cancelled_before_dispatch";
  readonly retrySafe = false;

  constructor(readonly operationId: string, readonly reason: ToolOutcomeUnknownReason) {
    super(`Capability operation ${operationId} was cancelled before dispatch (${reason}).`);
    this.name = "CapabilityInvocationCancelledError";
  }
}

export class CapabilityInvocationAlreadySettledError extends Error {
  readonly code = "operation_already_settled";
  readonly retrySafe = false;

  constructor(readonly operationId: string, readonly status: "failed" | "cancelled") {
    super(`Capability operation ${operationId} is already settled as ${status}; use a new operation id to request another attempt.`);
    this.name = "CapabilityInvocationAlreadySettledError";
  }
}

const maxPayloadBytes = 1_024 * 1_024;
const maxChunkBytes = 256 * 1_024;

export interface CapabilityRegistrationInput {
  registrationId?: string;
  ownerType: CapabilityOwnerType;
  ownerId: string;
  capabilityName: string;
  schema: unknown;
  expiresAt?: string;
}

export interface CapabilityRegistration {
  registrationId: string;
  workspaceId: string;
  ownerType: CapabilityOwnerType;
  ownerId: string;
  capabilityName: string;
  revision: number;
  schema: unknown;
  status: CapabilityRegistrationStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityInvocationInput {
  registrationId: string;
  offerId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  request: unknown;
}

export interface HostCapabilityExecutionInput {
  capabilityName: string;
  schema: unknown;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  toolCallId?: string;
  offerId?: string;
  request: unknown;
  dispatchBoundary?: "immediate" | "reported";
  timeoutMs?: number;
}

export interface CapabilityInvocation {
  invocationId: string;
  registrationId: string;
  offerId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  status: CapabilityInvocationStatus;
  dispatchState: CapabilityDispatchState;
  request: unknown;
  result?: unknown;
  error?: string;
  outcomeUnknownReason?: ToolOutcomeUnknownReason;
  chunks: CapabilityResultChunk[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityResultChunk {
  invocationId: string;
  chunkIndex: number;
  data: unknown;
  final: boolean;
  createdAt: string;
}

interface RegistrationRow {
  registration_id: unknown;
  workspace_id: unknown;
  owner_type: unknown;
  owner_id: unknown;
  capability_name: unknown;
  revision: unknown;
  schema_json: unknown;
  status: unknown;
  expires_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface InvocationRow {
  invocation_id: unknown;
  registration_id: unknown;
  offer_id: unknown;
  session_id: unknown;
  turn_id: unknown;
  tool_call_id: unknown;
  status: unknown;
  request_json: unknown;
  request_hash: unknown;
  dispatch_state: unknown;
  result_json: unknown;
  error: unknown;
  outcome_unknown_reason: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface ActiveHostCapabilityExecution {
  store: CapabilityStore;
  requestHash: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  promise: Promise<unknown>;
}

interface CapabilityInvocationRecord extends CapabilityInvocation {
  requestHash?: string;
}

const activeHostCapabilityExecutions = new Map<string, ActiveHostCapabilityExecution>();

interface ChunkRow {
  invocation_id: unknown;
  chunk_index: unknown;
  data_json: unknown;
  final: unknown;
  created_at: unknown;
}

export class CapabilityStore {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly authority: RuntimeEventAuthority
  ) {}

  static async open(persistenceRoot: string, authority: RuntimeEventAuthority): Promise<CapabilityStore> {
    void persistenceRoot;
    return new CapabilityStore(authority.databaseHandle(), authority);
  }

  register(input: CapabilityRegistrationInput): CapabilityRegistration {
    this.assertOpen();
    validateRegistrationInput(input);
    const existingByKey = this.database.prepare(
      "SELECT registration_id, workspace_id, owner_type, owner_id, capability_name, revision, schema_json, status, expires_at, created_at, updated_at FROM capability_registrations WHERE workspace_id = ? AND owner_id = ? AND capability_name = ?"
    ).get(this.authority.workspaceId, input.ownerId, input.capabilityName) as unknown as RegistrationRow | undefined;
    if (existingByKey) return toRegistration(existingByKey);
    const registrationId = input.registrationId ?? randomUUID();
    const now = new Date().toISOString();
    const status: CapabilityRegistrationStatus = input.ownerType === "host" ? "admitted" : "registered";
    return this.withEvent({
      eventId: "capability-registration:" + registrationId + ":capability.registered:0",
      sessionId: "capability:" + registrationId,
      invocationId: registrationId,
      runId: "capability:" + registrationId,
      turnId: "capability:" + registrationId,
      eventType: "capability.registered",
      payload: {
        ownerId: input.ownerId,
        ownerType: input.ownerType,
        capabilityName: input.capabilityName,
        schema: redact(input.schema)
      },
      createdAt: now
    }, () => {
      this.database.prepare(
        "INSERT INTO capability_registrations (registration_id, workspace_id, owner_type, owner_id, capability_name, revision, schema_json, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)"
      ).run(
        registrationId,
        this.authority.workspaceId,
        input.ownerType,
        input.ownerId,
        input.capabilityName,
        encode(input.schema, maxPayloadBytes),
        status,
        input.expiresAt ?? null,
        now,
        now
      );
      return this.requireRegistration(registrationId);
    });
  }

  /** 确保 Host-owned MCP/Plugin 工具在第一次执行前已经有 durable registration。 */
  ensureHostCapability(capabilityName: string, schema: unknown): CapabilityRegistration {
    const current = this.register({ ownerType: "host", ownerId: "host", capabilityName, schema });
    if (current.status === "released" || current.status === "rejected") return this.replace(current.registrationId, schema);
    if (current.status !== "admitted") return this.admit(current.registrationId);
    return current;
  }

  /**
   * Host-owned 工具仍在 Host 内执行，但它们的 invocation/result/failure 会与 client-owned
   * capability 使用完全相同的 authority envelope。超时或取消后 fail-closed 为 unknown，
   * 不把可能已经发生的副作用误报成普通失败。
   */
  async executeHostCapability<TResult>(
    input: HostCapabilityExecutionInput,
    execute: (signal?: AbortSignal, onDispatched?: () => void) => Promise<TResult>,
    signal?: AbortSignal
  ): Promise<TResult> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    const key = input.offerId === undefined
      ? undefined
      : `${this.authority.databasePath}\0${input.capabilityName}\0${input.offerId}`;
    if (key !== undefined) {
      const active = activeHostCapabilityExecutions.get(key);
      if (active) {
        if (active.requestHash !== requestIdentityHash(input.request)
          || active.sessionId !== input.sessionId
          || active.turnId !== input.turnId
          || active.toolCallId !== input.toolCallId) {
          throw new CapabilityIdempotencyConflictError(input.offerId!, "The operation id is already executing with another request identity.");
        }
        return await active.promise as TResult;
      }
      const execution = this.executeHostCapabilityOnce(input, execute, signal);
      activeHostCapabilityExecutions.set(key, {
        store: this,
        requestHash: requestIdentityHash(input.request),
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        promise: execution
      });
      try {
        return await execution;
      } finally {
        if (activeHostCapabilityExecutions.get(key)?.promise === execution) activeHostCapabilityExecutions.delete(key);
      }
    }
    return await this.executeHostCapabilityOnce(input, execute, signal);
  }

  private async executeHostCapabilityOnce<TResult>(
    input: HostCapabilityExecutionInput,
    execute: (signal?: AbortSignal, onDispatched?: () => void) => Promise<TResult>,
    signal?: AbortSignal
  ): Promise<TResult> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Capability timeout must be a positive integer.");
    const registration = this.ensureHostCapability(input.capabilityName, input.schema);
    const invocationInput: CapabilityInvocationInput = {
      registrationId: registration.registrationId,
      offerId: input.offerId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      request: input.request
    };
    const { invocation, created } = this.createOrGetInvocation(
      invocationInput,
      input.offerId === undefined ? randomUUID() : invocationIdForOffer(registration.registrationId, input.offerId),
      input.dispatchBoundary === "reported"
    );
    if (!created) return this.readExistingHostInvocation<TResult>(invocation, input.offerId);
    this.accept(invocation.invocationId);
    this.start(invocation.invocationId);

    const controller = new AbortController();
    const executionSignal = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
    let dispatched = false;
    const markDispatched = (): void => {
      executionSignal.throwIfAborted();
      this.markDispatched(invocation.invocationId);
      dispatched = true;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let abortListener: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new CapabilityOutcomeUnknownError(invocation.offerId ?? invocation.invocationId, "timeout");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });
    const aborted = signal === undefined ? undefined : new Promise<never>((_, reject) => {
      abortListener = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      if (input.dispatchBoundary !== "reported") markDispatched();
      const pending = [execute(executionSignal, markDispatched), timeout];
      if (aborted) pending.push(aborted);
      const result = await Promise.race(pending);
      try {
        const persisted = this.result(invocation.invocationId, result);
        return persisted.result as TResult;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw this.markUnknownForCaller(invocation.invocationId, invocation.offerId, "result_persistence_failed", detail);
      }
    } catch (error) {
      const current = this.getInvocation(invocation.invocationId);
      if (current?.status === "unknown") {
        throw error instanceof CapabilityOutcomeUnknownError
          ? error
          : new CapabilityOutcomeUnknownError(
            invocation.offerId ?? invocation.invocationId,
            current.outcomeUnknownReason ?? "unsettled_previous_invocation",
            current.error
          );
      }
      if (current === undefined || isTerminalInvocationStatus(current.status)) throw error;
      if (input.dispatchBoundary === "reported" && !dispatched && signal?.aborted) {
        const reason = abortUnknownReason(signal);
        try {
          this.cancel(invocation.invocationId, reason);
        } catch {
          // 确认未派发时，即使取消状态无法落盘，也不能升级成未知副作用。
        }
        throw new CapabilityInvocationCancelledError(invocation.offerId ?? invocation.invocationId, reason);
      }
      if (input.dispatchBoundary === "reported" && !dispatched && timedOut) {
        const detail = "Capability timed out before the external request was dispatched.";
        this.fail(invocation.invocationId, detail);
        throw new Error(detail);
      }
      const uncertain = timedOut || signal?.aborted === true || isAbortError(error);
      if (uncertain) {
        const reason = timedOut ? "timeout" : abortUnknownReason(signal);
        const detail = error instanceof Error ? error.message : String(error);
        throw this.markUnknownForCaller(invocation.invocationId, invocation.offerId, reason, detail);
      }
      if (error instanceof ToolOutcomeUnknownError) {
        const detail = error.message;
        throw this.markUnknownForCaller(invocation.invocationId, invocation.offerId, error.reason, detail);
      }
      this.fail(invocation.invocationId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  replace(registrationId: string, schema: unknown, expiresAt?: string): CapabilityRegistration {
    const current = this.requireRegistration(registrationId);
    validateSchema(schema);
    if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) throw new Error("Capability expiry must be an ISO timestamp.");
    const now = new Date().toISOString();
    const status: CapabilityRegistrationStatus = current.ownerType === "host" ? "admitted" : "registered";
    return this.withEvent({
      eventId: "capability-registration:" + registrationId + ":capability.replaced:" + String(current.revision + 1),
      sessionId: "capability:" + registrationId,
      invocationId: registrationId,
      runId: "capability:" + registrationId,
      turnId: "capability:" + registrationId,
      eventType: "capability.replaced",
      payload: { ownerId: current.ownerId, schema: redact(schema), revision: current.revision + 1 },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE capability_registrations SET schema_json = ?, status = ?, expires_at = ?, revision = revision + 1, updated_at = ? WHERE registration_id = ?").run(
        encode(schema, maxPayloadBytes), status, expiresAt ?? null, now, registrationId
      );
      return this.requireRegistration(registrationId);
    });
  }

  admit(registrationId: string): CapabilityRegistration {
    return this.updateRegistrationStatus(registrationId, "admitted", "capability.admitted");
  }

  reject(registrationId: string, reason: string): CapabilityRegistration {
    return this.updateRegistrationStatus(registrationId, "rejected", "capability.rejected", { reason: redactText(reason) });
  }

  release(registrationId: string, reason = "released"): CapabilityRegistration {
    const registration = this.updateRegistrationStatus(registrationId, "released", "capability.released", { reason: redactText(reason) });
    const rows = this.database.prepare("SELECT invocation_id FROM capability_invocations WHERE registration_id = ? AND status IN ('admitted', 'accepted', 'running')").all(registrationId) as Array<Record<string, unknown>>;
    for (const row of rows) this.cancel(stringValue(row.invocation_id), reason);
    return registration;
  }

  releaseOwner(ownerId: string, reason = "client disconnected"): void {
    const rows = this.database.prepare("SELECT registration_id FROM capability_registrations WHERE workspace_id = ? AND owner_id = ? AND status <> 'released'").all(this.authority.workspaceId, ownerId) as Array<Record<string, unknown>>;
    for (const row of rows) this.release(stringValue(row.registration_id), reason);
  }

  list(ownerId?: string): CapabilityRegistration[] {
    const query = ownerId === undefined
      ? "SELECT registration_id, workspace_id, owner_type, owner_id, capability_name, revision, schema_json, status, expires_at, created_at, updated_at FROM capability_registrations WHERE workspace_id = ? ORDER BY created_at ASC"
      : "SELECT registration_id, workspace_id, owner_type, owner_id, capability_name, revision, schema_json, status, expires_at, created_at, updated_at FROM capability_registrations WHERE workspace_id = ? AND owner_id = ? ORDER BY created_at ASC";
    const rows = this.database.prepare(query).all(...(ownerId === undefined ? [this.authority.workspaceId] : [this.authority.workspaceId, ownerId])) as unknown as RegistrationRow[];
    return rows.map(toRegistration);
  }

  get(registrationId: string): CapabilityRegistration | undefined {
    const row = this.database.prepare("SELECT registration_id, workspace_id, owner_type, owner_id, capability_name, revision, schema_json, status, expires_at, created_at, updated_at FROM capability_registrations WHERE registration_id = ? AND workspace_id = ?").get(registrationId, this.authority.workspaceId) as unknown as RegistrationRow | undefined;
    return row ? toRegistration(row) : undefined;
  }

  invoke(input: CapabilityInvocationInput, invocationId: string = randomUUID()): CapabilityInvocation {
    return this.createOrGetInvocation(input, invocationId).invocation;
  }

  /** Owner startup calls this after acquiring the workspace lock and before accepting work. */
  recoverUnsettledInvocations(reason: ToolOutcomeUnknownReason = "host_restarted"): number {
    this.assertOpen();
    const rows = this.database.prepare(
      "SELECT invocation_id, dispatch_state FROM capability_invocations WHERE status IN ('admitted', 'accepted', 'running') ORDER BY created_at ASC"
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const invocationId = stringValue(row.invocation_id);
      if (dispatchState(row.dispatch_state) === "not_dispatched") {
        this.cancel(invocationId, "host_restarted_before_dispatch");
      } else {
        this.unknown(invocationId, reason, "The previous Runtime Host ended before this capability invocation settled.");
      }
    }
    return rows.length;
  }

  accept(invocationId: string): CapabilityInvocation {
    return this.updateInvocationStatus(invocationId, "accepted", "capability.invocation.accepted");
  }

  start(invocationId: string): CapabilityInvocation {
    return this.updateInvocationStatus(invocationId, "running", "capability.invocation.running");
  }

  result(invocationId: string, result: unknown): CapabilityInvocation {
    const invocation = this.requireInvocation(invocationId);
    if (invocation.status === "result") return invocation;
    assertInvocationCanFinish(invocation.status, invocationId);
    const now = new Date().toISOString();
    const encoded = encode(redact(result), maxPayloadBytes);
    return this.withEvent({
      eventId: "capability:" + invocationId + ":result",
      sessionId: invocation.sessionId ?? "capability:" + invocation.registrationId,
      invocationId,
      runId: invocationId,
      turnId: invocation.turnId ?? invocationId,
      eventType: "capability.invocation.result",
      payload: { result: redact(result) },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE capability_invocations SET status = 'result', result_json = ?, updated_at = ? WHERE invocation_id = ?").run(encoded, now, invocationId);
      return this.requireInvocation(invocationId);
    });
  }

  chunk(invocationId: string, chunkIndex: number, data: unknown, final = false): CapabilityInvocation {
    const invocation = this.requireInvocation(invocationId);
    if (invocation.status === "result") return invocation;
    assertInvocationCanFinish(invocation.status, invocationId);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new Error("Capability chunk index must be a non-negative integer.");
    const now = new Date().toISOString();
    const encoded = encode(redact(data), maxChunkBytes);
    const existing = this.database.prepare("SELECT data_json, final FROM capability_invocation_chunks WHERE invocation_id = ? AND chunk_index = ?").get(invocationId, chunkIndex) as { data_json?: unknown; final?: unknown } | undefined;
    if (existing) {
      if (existing.data_json !== encoded || (existing.final === 1) !== final) throw new Error(`Capability chunk ${String(chunkIndex)} is already bound to another result.`);
      return invocation;
    }
    return this.withEvent({
      eventId: "capability:" + invocationId + ":chunk:" + String(chunkIndex),
      sessionId: invocation.sessionId ?? "capability:" + invocation.registrationId,
      invocationId,
      runId: invocationId,
      turnId: invocation.turnId ?? invocationId,
      eventType: "capability.invocation.chunk",
      payload: { chunkIndex, final, data: redact(data) },
      createdAt: now
    }, () => {
      this.database.prepare("INSERT INTO capability_invocation_chunks (invocation_id, chunk_index, data_json, final, created_at) VALUES (?, ?, ?, ?, ?)").run(invocationId, chunkIndex, encoded, final ? 1 : 0, now);
      if (final) this.database.prepare("UPDATE capability_invocations SET status = 'result', updated_at = ? WHERE invocation_id = ?").run(now, invocationId);
      return this.requireInvocation(invocationId);
    });
  }

  fail(invocationId: string, error: string): CapabilityInvocation {
    return this.updateInvocationStatus(invocationId, "failed", "capability.invocation.failed", { error: redactText(error) });
  }

  cancel(invocationId: string, reason = "cancelled"): CapabilityInvocation {
    return this.updateInvocationStatus(invocationId, "cancelled", "capability.invocation.cancelled", { reason: redactText(reason) });
  }

  unknown(
    invocationId: string,
    reason: ToolOutcomeUnknownReason = "unsettled_previous_invocation",
    detail = "The side-effect outcome is unknown."
  ): CapabilityInvocation {
    return this.updateInvocationStatus(invocationId, "unknown", "capability.invocation.unknown", {
      outcomeUnknownReason: reason,
      error: redactText(detail)
    });
  }

  private markUnknownForCaller(
    invocationId: string,
    offerId: string | undefined,
    reason: ToolOutcomeUnknownReason,
    detail: string
  ): CapabilityOutcomeUnknownError {
    try {
      this.unknown(invocationId, reason, detail);
    } catch {
      // Session 仍须 fail closed；下次 owner 启动会把未收敛的账本行恢复为 unknown。
    }
    return new CapabilityOutcomeUnknownError(offerId ?? invocationId, reason, detail);
  }

  getInvocation(invocationId: string): CapabilityInvocation | undefined {
    const row = this.database.prepare("SELECT invocation_id, registration_id, offer_id, session_id, turn_id, tool_call_id, status, request_json, request_hash, dispatch_state, result_json, error, outcome_unknown_reason, created_at, updated_at FROM capability_invocations WHERE invocation_id = ?").get(invocationId) as unknown as InvocationRow | undefined;
    return row ? this.toInvocation(row) : undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [key, execution] of activeHostCapabilityExecutions) {
      if (execution.store === this) activeHostCapabilityExecutions.delete(key);
    }
  }

  private createOrGetInvocation(
    input: CapabilityInvocationInput,
    requestedInvocationId: string,
    reportedDispatchBoundary = false
  ): { invocation: CapabilityInvocation; created: boolean } {
    this.assertOpen();
    const registration = this.requireRegistration(input.registrationId);
    if (registration.status !== "admitted") throw new Error(`Capability ${registration.capabilityName} is not admitted.`);
    if (registration.expiresAt !== undefined && Date.parse(registration.expiresAt) <= Date.now()) {
      this.updateRegistrationStatus(registration.registrationId, "released", "capability.expired");
      throw new Error(`Capability ${registration.capabilityName} has expired.`);
    }
    validateRequest(registration.schema, input.request);
    const requestHash = requestIdentityHash(input.request);
    if (input.offerId !== undefined) {
      const matches = this.findInvocationsByOffer(registration.registrationId, input.offerId);
      if (matches.length > 1) {
        throw new CapabilityOutcomeUnknownError(
          input.offerId,
          "operation_identity_ambiguous",
          "Multiple persisted invocations already use this operation id. No new side effect was started."
        );
      }
      const existing = matches[0];
      if (existing) {
        this.assertSameOperationIdentity(existing, input, requestHash);
        return { invocation: existing, created: false };
      }
    }

    const invocationId = input.offerId === undefined
      ? requestedInvocationId
      : invocationIdForOffer(registration.registrationId, input.offerId);
    const now = new Date().toISOString();
    try {
      const invocation = this.withEvent({
        eventId: "capability:" + invocationId + ":admitted",
        sessionId: input.sessionId ?? "capability:" + registration.registrationId,
        invocationId,
        runId: invocationId,
        turnId: input.turnId ?? invocationId,
        eventType: "capability.invocation.admitted",
        payload: { registrationId: input.registrationId, offerId: input.offerId, request: redact(input.request) },
        createdAt: now
      }, () => {
        this.database.prepare("INSERT INTO capability_invocations (invocation_id, registration_id, offer_id, session_id, turn_id, tool_call_id, status, request_json, request_hash, dispatch_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?, ?)").run(
          invocationId,
          input.registrationId,
          input.offerId ?? null,
          input.sessionId ?? null,
          input.turnId ?? null,
          input.toolCallId ?? null,
          encode(redact(input.request), maxPayloadBytes),
          input.offerId === undefined ? null : requestHash,
          reportedDispatchBoundary ? "not_dispatched" : "dispatched",
          now,
          now
        );
        return this.requireInvocation(invocationId);
      });
      return { invocation, created: true };
    } catch (error) {
      if (input.offerId !== undefined) {
        const existing = this.findInvocationsByOffer(registration.registrationId, input.offerId);
        if (existing.length === 1) {
          this.assertSameOperationIdentity(existing[0]!, input, requestHash);
          return { invocation: existing[0]!, created: false };
        }
      }
      throw error;
    }
  }

  private findInvocationsByOffer(registrationId: string, offerId: string): CapabilityInvocationRecord[] {
    const rows = this.database.prepare("SELECT invocation_id, registration_id, offer_id, session_id, turn_id, tool_call_id, status, request_json, request_hash, dispatch_state, result_json, error, outcome_unknown_reason, created_at, updated_at FROM capability_invocations WHERE registration_id = ? AND offer_id = ? ORDER BY created_at ASC").all(registrationId, offerId) as unknown as InvocationRow[];
    return rows.map((row) => this.toInvocationRecord(row));
  }

  private assertSameOperationIdentity(
    existing: CapabilityInvocationRecord,
    input: CapabilityInvocationInput,
    requestHash: string
  ): void {
    if (existing.sessionId !== input.sessionId
      || existing.turnId !== input.turnId
      || existing.toolCallId !== input.toolCallId) {
      throw new CapabilityIdempotencyConflictError(input.offerId ?? existing.invocationId, "The operation id is already bound to another session, turn, or tool call.");
    }
    if (existing.requestHash !== undefined) {
      if (existing.requestHash !== requestHash) throw new CapabilityIdempotencyConflictError(input.offerId ?? existing.invocationId);
      return;
    }
    const redactedRequest = redact(input.request);
    if (containsRedactedValue(existing.request) || containsRedactedValue(redactedRequest)
      || canonicalJson(existing.request) !== canonicalJson(redactedRequest)) {
      throw new CapabilityIdempotencyConflictError(input.offerId ?? existing.invocationId, "This legacy operation cannot be safely matched to the new request.");
    }
  }

  private readExistingHostInvocation<TResult>(invocation: CapabilityInvocation, offerId: string | undefined): TResult {
    const operationId = offerId ?? invocation.invocationId;
    if (invocation.status === "result") return invocation.result as TResult;
    if (invocation.status === "unknown") {
      throw new CapabilityOutcomeUnknownError(
        operationId,
        invocation.outcomeUnknownReason ?? "unsettled_previous_invocation",
        invocation.error
      );
    }
    if (invocation.status === "admitted" || invocation.status === "accepted" || invocation.status === "running") {
      const recovered = this.unknown(
        invocation.invocationId,
        "unsettled_previous_invocation",
        "A previous invocation with this operation id has no active executor in this Runtime Host."
      );
      throw new CapabilityOutcomeUnknownError(operationId, recovered.outcomeUnknownReason!, recovered.error);
    }
    throw new CapabilityInvocationAlreadySettledError(operationId, invocation.status);
  }

  private markDispatched(invocationId: string): void {
    const invocation = this.requireInvocation(invocationId);
    if (invocation.dispatchState === "dispatched") return;
    if (invocation.status !== "running") throw new Error(`Capability invocation ${invocationId} cannot dispatch from status ${invocation.status}.`);
    const now = new Date().toISOString();
    this.withEvent({
      eventId: `capability:${invocationId}:dispatched`,
      sessionId: invocation.sessionId ?? `capability:${invocation.registrationId}`,
      invocationId,
      runId: invocationId,
      turnId: invocation.turnId ?? invocationId,
      eventType: "capability.invocation.dispatched",
      payload: { dispatchState: "dispatched" },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE capability_invocations SET dispatch_state = 'dispatched', updated_at = ? WHERE invocation_id = ? AND dispatch_state = 'not_dispatched'").run(now, invocationId);
      return this.requireInvocation(invocationId);
    });
  }

  private updateRegistrationStatus(registrationId: string, status: CapabilityRegistrationStatus, eventType: string, payload: Record<string, unknown> = {}): CapabilityRegistration {
    const registration = this.requireRegistration(registrationId);
    if (registration.status === status) return registration;
    const now = new Date().toISOString();
    return this.withEvent({
      eventId: "capability-registration:" + registrationId + ":" + eventType + ":" + String(registration.revision + 1),
      sessionId: "capability:" + registrationId,
      invocationId: registrationId,
      runId: "capability:" + registrationId,
      turnId: "capability:" + registrationId,
      eventType,
      payload: { ownerId: registration.ownerId, ...payload, status },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE capability_registrations SET status = ?, revision = revision + 1, updated_at = ? WHERE registration_id = ?").run(status, now, registrationId);
      return this.requireRegistration(registrationId);
    });
  }

  private updateInvocationStatus(invocationId: string, status: CapabilityInvocationStatus, eventType: string, payload: Record<string, unknown> = {}): CapabilityInvocation {
    const invocation = this.requireInvocation(invocationId);
    if (invocation.status === status) return invocation;
    if (!isAllowedInvocationTransition(invocation.status, status)) {
      if (isTerminalInvocationStatus(invocation.status)) throw new Error(`Capability invocation ${invocationId} is already terminal (${invocation.status}).`);
      throw new Error(`Capability invocation ${invocationId} cannot transition from ${invocation.status} to ${status}.`);
    }
    const now = new Date().toISOString();
    return this.withEvent({
      eventId: "capability:" + invocationId + ":" + status,
      sessionId: invocation.sessionId ?? "capability:" + invocation.registrationId,
      invocationId,
      runId: invocationId,
      turnId: invocation.turnId ?? invocationId,
      eventType,
      payload: { ...payload, status },
      createdAt: now
    }, () => {
      this.database.prepare("UPDATE capability_invocations SET status = ?, error = ?, outcome_unknown_reason = ?, updated_at = ? WHERE invocation_id = ?").run(
        status,
        typeof payload.error === "string" ? payload.error : typeof payload.reason === "string" ? payload.reason : null,
        status === "unknown" && isToolOutcomeUnknownReason(payload.outcomeUnknownReason) ? payload.outcomeUnknownReason : null,
        now,
        invocationId
      );
      return this.requireInvocation(invocationId);
    });
  }

  private withEvent<T>(input: {
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

  private requireRegistration(registrationId: string): CapabilityRegistration {
    const registration = this.get(registrationId);
    if (!registration) throw new Error("Capability registration " + registrationId + " does not exist.");
    return registration;
  }

  private requireInvocation(invocationId: string): CapabilityInvocation {
    const invocation = this.getInvocation(invocationId);
    if (!invocation) throw new Error("Capability invocation " + invocationId + " does not exist.");
    return invocation;
  }

  private toInvocation(row: InvocationRow): CapabilityInvocation {
    const invocation = this.toInvocationRecord(row);
    delete invocation.requestHash;
    return invocation;
  }

  private toInvocationRecord(row: InvocationRow): CapabilityInvocationRecord {
    const chunks = this.database.prepare("SELECT invocation_id, chunk_index, data_json, final, created_at FROM capability_invocation_chunks WHERE invocation_id = ? ORDER BY chunk_index ASC").all(stringValue(row.invocation_id)) as unknown as ChunkRow[];
    return {
      invocationId: stringValue(row.invocation_id),
      registrationId: stringValue(row.registration_id),
      offerId: optionalString(row.offer_id),
      sessionId: optionalString(row.session_id),
      turnId: optionalString(row.turn_id),
      toolCallId: optionalString(row.tool_call_id),
      status: invocationStatus(row.status),
      dispatchState: dispatchState(row.dispatch_state),
      request: parse(row.request_json),
      requestHash: optionalString(row.request_hash),
      result: parseOptional(row.result_json),
      error: optionalString(row.error),
      outcomeUnknownReason: optionalToolOutcomeUnknownReason(row.outcome_unknown_reason),
      chunks: chunks.map(toChunk),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at)
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Capability store is closed.");
  }
}

function validateRegistrationInput(input: CapabilityRegistrationInput): void {
  if (input.ownerType !== "host" && input.ownerType !== "client") throw new Error("Capability ownerType must be host or client.");
  if (!input.ownerId.trim() || !input.capabilityName.trim()) throw new Error("Capability ownerId and capabilityName cannot be empty.");
  validateSchema(input.schema);
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) throw new Error("Capability expiry must be an ISO timestamp.");
}

function validateSchema(schema: unknown): void {
  const object = asObject(schema);
  if (Object.keys(object).length === 0) throw new Error("Capability schema cannot be empty.");
  if (object.type !== undefined && typeof object.type !== "string") throw new Error("Capability schema type must be a string.");
}

function validateRequest(schema: unknown, request: unknown): void {
  const object = asObject(schema);
  const type = typeof object.type === "string" ? object.type : undefined;
  if (type !== undefined && !matchesType(request, type)) throw new Error(`Capability request does not match schema type ${type}.`);
  const required = Array.isArray(object.required) ? object.required.filter((value): value is string => typeof value === "string") : [];
  if (required.length) {
    const requestObject = asObject(request);
    for (const key of required) if (!(key in requestObject)) throw new Error(`Capability request is missing required field ${key}.`);
  }
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = /(api.?key|token|secret|password|authorization|cookie)/iu.test(key) ? "[REDACTED]" : redact(child);
  }
  return output;
}

function encode(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value === undefined ? null : value);
  if (typeof json !== "string") throw new Error("Capability payload cannot be serialized as JSON.");
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error("Capability payload exceeds the result size limit.");
  return json;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Capability value must be a JSON object.");
  return value as Record<string, unknown>;
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function parseOptional(value: unknown): unknown {
  return value === null || value === undefined ? undefined : parse(value);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Capability database value is not a string.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value);
}

function integerValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Capability database value is not an integer.");
  return value;
}

function toRegistration(row: RegistrationRow): CapabilityRegistration {
  return {
    registrationId: stringValue(row.registration_id),
    workspaceId: stringValue(row.workspace_id),
    ownerType: ownerType(row.owner_type),
    ownerId: stringValue(row.owner_id),
    capabilityName: stringValue(row.capability_name),
    revision: integerValue(row.revision),
    schema: parse(row.schema_json),
    status: registrationStatus(row.status),
    expiresAt: optionalString(row.expires_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  };
}

function toChunk(row: ChunkRow): CapabilityResultChunk {
  return {
    invocationId: stringValue(row.invocation_id),
    chunkIndex: integerValue(row.chunk_index),
    data: parse(row.data_json),
    final: row.final === 1,
    createdAt: stringValue(row.created_at)
  };
}

function ownerType(value: unknown): CapabilityOwnerType {
  if (value === "host" || value === "client") return value;
  throw new Error("Invalid capability owner type: " + String(value));
}

function registrationStatus(value: unknown): CapabilityRegistrationStatus {
  if (value === "registered" || value === "replaced" || value === "admitted" || value === "rejected" || value === "released") return value;
  throw new Error("Invalid capability registration status: " + String(value));
}

function invocationStatus(value: unknown): CapabilityInvocationStatus {
  if (value === "admitted" || value === "accepted" || value === "running" || value === "result" || value === "failed" || value === "cancelled" || value === "unknown") return value;
  throw new Error("Invalid capability invocation status: " + String(value));
}

function dispatchState(value: unknown): CapabilityDispatchState {
  if (value === "not_dispatched" || value === "dispatched") return value;
  throw new Error("Invalid capability dispatch state: " + String(value));
}

function assertInvocationCanFinish(status: CapabilityInvocationStatus, invocationId: string): void {
  if (status !== "running") throw new Error(`Capability invocation ${invocationId} cannot finish from status ${status}.`);
}

function isTerminalInvocationStatus(status: CapabilityInvocationStatus): boolean {
  return status === "result" || status === "failed" || status === "cancelled" || status === "unknown";
}

function isAllowedInvocationTransition(from: CapabilityInvocationStatus, to: CapabilityInvocationStatus): boolean {
  if (isTerminalInvocationStatus(from)) return false;
  if (from === "admitted") return to === "accepted" || to === "failed" || to === "cancelled" || to === "unknown";
  if (from === "accepted") return to === "running" || to === "failed" || to === "cancelled" || to === "unknown";
  return from === "running" && (to === "failed" || to === "cancelled" || to === "unknown");
}

function redactText(value: string): string {
  return value.replace(/(api.?key|token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
}

function requestIdentityHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Capability request cannot be serialized as JSON.");
  return serialized;
}

function containsRedactedValue(value: unknown): boolean {
  if (value === "[REDACTED]") return true;
  if (Array.isArray(value)) return value.some(containsRedactedValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(containsRedactedValue);
}

function invocationIdForOffer(registrationId: string, offerId: string): string {
  const identity = createHash("sha256").update(registrationId).update("\0").update(offerId).digest("hex");
  return `capability-invocation:${identity}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortUnknownReason(signal: AbortSignal | undefined): ToolOutcomeUnknownReason {
  const abortReason = signal?.reason;
  const reason = typeof abortReason === "object" && abortReason !== null && "reason" in abortReason
    ? (abortReason as { reason?: unknown }).reason
    : abortReason;
  if (reason === "paused" || reason === "interrupted" || reason === "replaced" || reason === "cancelled" || reason === "host_shutdown") return reason;
  return "cancelled";
}

function isToolOutcomeUnknownReason(value: unknown): value is ToolOutcomeUnknownReason {
  return value === "host_restarted"
    || value === "host_shutdown"
    || value === "timeout"
    || value === "interrupted"
    || value === "replaced"
    || value === "cancelled"
    || value === "paused"
    || value === "result_persistence_failed"
    || value === "unsettled_previous_invocation"
    || value === "operation_identity_ambiguous"
    || value === "transport_error";
}

function optionalToolOutcomeUnknownReason(value: unknown): ToolOutcomeUnknownReason | undefined {
  return isToolOutcomeUnknownReason(value) ? value : undefined;
}
