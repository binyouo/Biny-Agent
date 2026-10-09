import { randomUUID } from "node:crypto";

/**
 * Session JSONL 中所有新写入事件共用的运行身份。
 *
 * eventSeq 是 session 级单调高水位；runId 标识一次实际执行，turnId 标识
 * 一个用户任务及其所有 continuation。旧 session 可以没有这段 metadata，
 * 但新的 runtime 写入必须带齐身份，才能在恢复时判断事实属于哪次运行。
 */
export interface RuntimeEventIdentity {
  eventId: string;
  eventSeq: number;
  runId?: string;
  turnId?: string;
}

export interface RuntimeEventContext {
  runId: string;
  turnId: string;
}

export type RuntimeEventRecord = { runtime?: RuntimeEventIdentity };

export interface RuntimeHighWater {
  eventId: string;
  eventSeq: number;
  runId?: string;
  turnId?: string;
}

/**
 * SessionRecorder 写入 JSONL 后调用的 authority sink。
 *
 * JSONL 是 session 事实来源，SQLite 只保存可重建的运行投影。sink 保持同步，
 * 让调用方可以把 authority 投影失败当作当前运行不可安全继续的信号；下一次
 * authority 启动时会重新扫描 JSONL，补齐这次已经落盘但尚未投影的事实。
 */
export interface RuntimeEventSink {
  appendSessionEvent(input: {
    sessionId: string;
    runtime: RuntimeEventIdentity;
    event: unknown;
    createdAt: string;
  }): void;
}

export function createRuntimeEventIdentity(
  eventSeq: number,
  context?: RuntimeEventContext,
  eventId = randomUUID()
): RuntimeEventIdentity {
  assertRuntimeEventSequence(eventSeq);
  assertRuntimeEventId(eventId);
  return {
    eventId,
    eventSeq,
    ...(context ? { runId: context.runId, turnId: context.turnId } : {})
  };
}

export function validateRuntimeEventRecord(value: unknown): value is RuntimeEventIdentity | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.eventId !== "string" || !candidate.eventId) return false;
  if (!Number.isSafeInteger(candidate.eventSeq) || (candidate.eventSeq as number) < 1) return false;
  if (candidate.runId !== undefined && (typeof candidate.runId !== "string" || !candidate.runId)) return false;
  if (candidate.turnId !== undefined && (typeof candidate.turnId !== "string" || !candidate.turnId)) return false;
  return true;
}

/** Compare only valid witness records; JSON omits optional own-undefined fields. */
export function sameRuntimeHighWater(left: RuntimeHighWater | undefined, right: RuntimeHighWater | undefined): boolean {
  const valid = (value: RuntimeHighWater | undefined): value is RuntimeHighWater => value !== undefined
    && validateRuntimeEventRecord(value)
    && Object.hasOwn(value, "eventId") && Object.hasOwn(value, "eventSeq")
    && Reflect.ownKeys(value).every(key => key === "eventId" || key === "eventSeq" || key === "runId" || key === "turnId");
  return valid(left) && valid(right)
    && Object.getPrototypeOf(left) === Object.getPrototypeOf(right)
    && left.eventId === right.eventId && left.eventSeq === right.eventSeq
    && left.runId === right.runId && left.turnId === right.turnId;
}

export function assertRuntimeEventSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Runtime event sequence must be a positive safe integer.");
  }
}

function assertRuntimeEventId(value: string): void {
  if (!value) throw new Error("Runtime event id cannot be empty.");
}

/**
 * 校验带 runtime metadata 的事实流。旧事件允许缺少 metadata；一旦事件带有
 * metadata，后续 metadata 的 eventSeq 必须严格递增且 eventId 不得重复。
 */
export function validateRuntimeEventStream(
  events: readonly RuntimeEventRecord[],
  expected?: { runId?: string; turnId?: string; upToEventSeq?: number }
): RuntimeHighWater | undefined {
  const eventIds = new Set<string>();
  let previousSequence = 0;
  let highWater: RuntimeHighWater | undefined;
  for (const event of events) {
    const runtime = event.runtime;
    if (!runtime) continue;
    if (!validateRuntimeEventRecord(runtime)) throw new Error("Invalid runtime event metadata.");
    if (eventIds.has(runtime.eventId)) throw new Error(`Duplicate runtime event id: ${runtime.eventId}`);
    if (runtime.eventSeq <= previousSequence) {
      throw new Error(`Runtime event sequence is not increasing at ${String(runtime.eventSeq)}.`);
    }
    if (highWater && runtime.eventSeq !== previousSequence + 1) {
      throw new Error(`Runtime event sequence is not continuous at ${String(runtime.eventSeq)}.`);
    }
    if (expected?.runId !== undefined && runtime.runId === expected.runId && expected.turnId !== undefined && runtime.turnId !== expected.turnId) {
      throw new Error(`Runtime event ${runtime.eventId} belongs to another turn.`);
    }
    if (expected?.upToEventSeq !== undefined && runtime.eventSeq > expected.upToEventSeq) break;
    eventIds.add(runtime.eventId);
    previousSequence = runtime.eventSeq;
    highWater = { ...runtime };
  }
  return highWater;
}

export function runtimeEventsForRun<T extends RuntimeEventRecord>(
  events: readonly T[],
  runId: string
): T[] {
  return events.filter((event) => event.runtime?.runId === runId);
}
