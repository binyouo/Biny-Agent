/**
 * Session 事件读取模块。
 *
 * Session 文件是一行一个 JSON 事件。这里负责把 JSONL 解析成事件数组，并从中提取首条用户消息、
 * 最后一条 assistant 消息、事件数量和时间信息，供 `sessions` 列表与历史恢复界面使用。
 */
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { z } from "zod";
import { committedFileChangeSchema } from "../tools/file/fileChange.js";
import {
  maxSessionEventLineBytes,
  maxSessionEvents,
  maxSessionFileBytes,
  readBoundedSessionHandle
} from "./limits.js";
import { cachedSessionEvents, sessionFileFingerprint } from "./parseCache.js";
import { listSessionFiles, readSessionSnapshot } from "./store.js";
import type { SessionEvent, SessionTurnStatusEvent } from "./recorder.js";
export type { SessionEvent } from "./recorder.js";
import { publicAssistantMessage, publicUserMessage } from "./publicMessage.js";
import { validateRuntimeEventRecord, type RuntimeEventIdentity } from "./runtimeEvent.js";
import { contextCheckpointSchema, contextStateSchema, contextUsageSchema } from "./contextSchema.js";

const sessionListReadConcurrency = 8;
const sessionUsageSchema = z.record(z.unknown());
const reasoningBlockSchema = z.object({
  text: z.string(),
  providerOptions: z.record(z.unknown()).optional()
});
const attachmentReferenceSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative().optional()
});
const modelRequestAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  durationMs: z.number().finite().nonnegative(),
  status: z.number().int().optional(),
  error: z.string().optional(),
  willRetry: z.boolean(),
  retryDelayMs: z.number().finite().nonnegative().optional()
}).passthrough();
const modelRequestContextSchema = z.object({
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  turnId: z.string().optional(),
  step: z.number().int().nonnegative().optional(),
  operation: z.enum(["agent", "plan", "compaction", "memory", "subagent"]).optional(),
  promptEpoch: z.number().int().nonnegative().optional(),
  promptEpochReason: z.enum(["initial", "compaction", "rewind", "fork", "provider_changed", "model_changed", "tool_schema_changed"]).optional(),
  promptEpochCreatedAt: z.string().optional(),
  relatedToolCallIds: z.array(z.string()).optional()
}).passthrough();
const modelRequestMetricsSchema = z.object({
  requestId: z.string(),
  provider: z.string(),
  modelId: z.string(),
  startedAt: z.string(),
  durationMs: z.number().finite().nonnegative(),
  timeToFirstEventMs: z.number().finite().nonnegative().optional(),
  timeToFirstOutputMs: z.number().finite().nonnegative().optional(),
  attempts: z.array(modelRequestAttemptSchema),
  status: z.number().int().optional(),
  finishReason: z.enum(["stop", "tool-calls", "length", "error", "aborted", "other"]).optional(),
  usage: sessionUsageSchema.optional(),
  error: z.string().optional(),
  errorCode: z.enum([
    "aborted",
    "timeout",
    "context_overflow",
    "http_error",
    "network_error",
    "protocol_error",
    "provider_error",
    "unknown"
  ]).optional(),
  errorPhase: z.enum(["request", "stream"]).optional(),
  eventCount: z.number().int().nonnegative(),
  requestContext: modelRequestContextSchema.optional(),
  promptShapeDurationMs: z.number().finite().nonnegative().optional(),
  promptShapeStatus: z.enum(["full", "skipped_due_to_budget"]).optional(),
  promptShapeBudgetExceeded: z.boolean().optional()
}).passthrough();
const agentTextContentSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const agentImageContentSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).passthrough();
const agentReasoningContentSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  providerMetadata: z.record(z.unknown()).optional()
}).passthrough();
const agentToolCallContentSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
  invalid: z.boolean().optional()
}).passthrough();
const persistedAgentMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("assistant"),
    content: z.array(z.discriminatedUnion("type", [agentTextContentSchema, agentReasoningContentSchema, agentToolCallContentSchema])),
    stopReason: z.enum(["stop", "tool-calls", "length", "error", "aborted", "other"]).optional(),
    usage: sessionUsageSchema.optional(),
    errorMessage: z.string().optional(),
    timestamp: z.number().finite().optional()
  }).passthrough(),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.discriminatedUnion("type", [agentTextContentSchema, agentImageContentSchema])),
    details: z.unknown().optional(),
    isError: z.boolean().optional(),
    timestamp: z.number().finite().optional()
  }).passthrough()
]);
const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    metadata: z.record(z.unknown()).optional(),
    content: z.string(),
    attachments: z.array(attachmentReferenceSchema).optional(),
    skills: z.array(z.string()).optional(),
    contextUsage: contextUsageSchema.optional(),
    contextState: contextStateSchema.optional(),
    preparationUsage: z.array(sessionUsageSchema).optional(),
    messageId: z.string().optional(),
    parentMessageId: z.string().optional(),
    slotId: z.string().optional(),
    auditOnly: z.boolean().optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("assistant_message"),
    metadata: z.record(z.unknown()).optional(),
    content: z.string(),
    reasoningContent: z.string().optional(),
    reasoningProviderOptions: z.record(z.unknown()).optional(),
    reasoningBlocks: z.array(reasoningBlockSchema).optional(),
    usage: sessionUsageSchema.optional(),
    relatedUsage: z.array(sessionUsageSchema).optional(),
    contextState: contextStateSchema.optional(),
    messageId: z.string().optional(),
    parentMessageId: z.string().optional(),
    slotId: z.string().optional(),
    replyToMessageId: z.string().optional(),
    retryOfMessageId: z.string().optional(),
    auditOnly: z.boolean().optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("tool_call"),
    tool: z.string(),
    args: z.unknown().optional(),
    toolCallId: z.string().optional(),
    sequence: z.number().finite().optional(),
    assistantContent: z.string().optional(),
    reasoningContent: z.string().optional(),
    reasoningProviderOptions: z.record(z.unknown()).optional(),
    reasoningBlocks: z.array(reasoningBlockSchema).optional(),
    auditOnly: z.boolean().optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("tool_execution"),
    tool: z.string(),
    toolCallId: z.string(),
    sequence: z.number().finite(),
    operationId: z.string(),
    state: z.enum(["not_started", "running", "admitted", "side_effect_committed", "cancel_requested", "cancelled", "succeeded", "failed", "unknown"]),
    change: committedFileChangeSchema.optional(),
    fileChangeIsResult: z.boolean().optional(),
    evidence: z.string().optional(),
    outcomeUnknownReason: z.enum(["host_restarted", "host_shutdown", "timeout", "interrupted", "replaced", "cancelled", "paused", "result_persistence_failed", "unsettled_previous_invocation", "operation_identity_ambiguous", "transport_error"]).optional(),
    retrySafety: z.enum(["safe", "idempotent", "unsafe", "unknown"]).optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("tool_result"),
    tool: z.string(),
    result: z.unknown().optional(),
    toolCallId: z.string().optional(),
    sequence: z.number().finite().optional(),
    relatedUsage: z.array(sessionUsageSchema).optional(),
    executionStatus: z.enum(["cancelled", "succeeded", "failed", "unknown"]).optional(),
    outcomeUnknownReason: z.enum(["host_restarted", "host_shutdown", "timeout", "interrupted", "replaced", "cancelled", "paused", "result_persistence_failed", "unsettled_previous_invocation", "operation_identity_ambiguous", "transport_error"]).optional(),
    recovered: z.boolean().optional(),
    operationId: z.string().optional(),
    evidence: z.string().optional(),
    auditOnly: z.boolean().optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("agent_message"),
    metadata: z.record(z.unknown()).optional(),
    message: persistedAgentMessageSchema,
    messageId: z.string().optional(),
    parentMessageId: z.string().optional(),
    slotId: z.string().optional(),
    replyToMessageId: z.string().optional(),
    retryOfMessageId: z.string().optional(),
    time: z.string().optional()
  }).passthrough(),
  contextCheckpointSchema.extend({
    type: z.literal("context_checkpoint"),
    reason: z.enum(["threshold", "overflow", "manual"]),
    time: z.string().optional()
  }),
  z.object({
    type: z.literal("model_request"),
    metrics: modelRequestMetricsSchema,
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("message_version_selected"),
    messageId: z.string(),
    slotId: z.string(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("message_metadata"),
    messageId: z.string().min(1),
    metadata: z.record(z.unknown()),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("turn_interrupted"),
    reason: z.enum(["interrupted", "paused"]),
    content: z.string(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("turn_status"),
    status: z.enum(["completed", "incomplete", "blocked", "cancelled", "failed", "aborted"]),
    stopReason: z.string(),
    finishReason: z.string().optional(),
    steps: z.number().int().nonnegative(),
    summary: z.string().optional(),
    resumable: z.boolean().optional(),
    blockedReason: z.string().optional(),
    requiredAction: z.string().optional(),
    affectedTodoIds: z.array(z.string()).optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    detail: z.unknown().optional(),
    relatedUsage: z.array(sessionUsageSchema).optional(),
    time: z.string().optional()
  }).passthrough()
]);

export interface SessionSummary {
  fileName: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  lastTurnStatus?: SessionTurnStatusEvent;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function readSessionEvents(filePath: string): Promise<SessionEvent[]> {
  // session 文件采用 JSONL，一行一个事件；空行忽略，坏行带行号报错。
  const handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
  try {
    await assertStandaloneSessionBinding(filePath, handle);
    const raw = (await readBoundedSessionHandle(handle, filePath)).toString("utf8");
    await assertStandaloneSessionBinding(filePath, handle);
    return parseSessionEvents(raw);
  } finally {
    await handle.close();
  }
}

export async function readStoredSessionEvents(
  workspaceRoot: string,
  session: string | undefined
): Promise<{ filePath: string; events: SessionEvent[]; truncated: boolean; sizeBytes: number; summary?: SessionSummary }> {
  const snapshot = await readSessionSnapshot(workspaceRoot, session);
  // 与 resume 共用同一份解析缓存：只有完整读到文件且没丢事件时才进缓存（超限截断的结果
  // 不能复用，否则会把"只看到尾部"的视角发给需要完整事件的读取方）。
  // 缓存命中的一定是完整解析（截断结果从不进缓存），所以命中时 eventsTruncated 保持 false 是对的。
  let eventsTruncated = false;
  const events = cachedSessionEvents(snapshot.filePath, sessionFileFingerprint(snapshot.stat), () => {
    const parsed = parseSessionEventsDetailed(snapshot.bytes.toString("utf8"), { overflow: "truncate" });
    eventsTruncated = parsed.truncated;
    return { events: parsed.events, complete: !snapshot.truncated && !parsed.truncated };
  });
  return {
    filePath: snapshot.filePath,
    events,
    truncated: snapshot.truncated || eventsTruncated,
    sizeBytes: snapshot.stat.size,
    summary: summarizeSessionEvents(snapshot.fileName, events, snapshot.stat)
  };
}

/** 只读取一个 session 的摘要，供打开会话和 catalog 缺失时的按需修复使用。 */
export async function readSessionSummary(
  workspaceRoot: string,
  session: string | undefined
): Promise<SessionSummary | undefined> {
  const snapshot = await readSessionSnapshot(workspaceRoot, session);
  // 与打开路径一致用 truncate 模式：事件数超限的会话按尾部降级，而不是在列表和改元数据
  // 路径上凭空消失。没看全文件的解析不进缓存，避免把截断视角发给需要完整事件的读取方。
  const events = cachedSessionEvents(snapshot.filePath, sessionFileFingerprint(snapshot.stat), () => {
    const parsed = parseSessionEventsDetailed(snapshot.bytes.toString("utf8"), { overflow: "truncate" });
    return { events: parsed.events, complete: !snapshot.truncated && !parsed.truncated };
  });
  return summarizeSessionEvents(snapshot.fileName, events, snapshot.stat);
}

export function summarizeSessionEvents(
  fileName: string,
  events: readonly SessionEvent[],
  stat: Pick<Stats, "birthtime" | "mtime">
): SessionSummary | undefined {
  const firstUser = events.find((event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message"
    && !(event.auditOnly && (event.metadata?.queuedDelivery === "steer" || event.metadata?.queuedDelivery === "queue")));
  if (!firstUser) return undefined;
  const firstUserMessage = publicUserMessage(firstUser.content);
  const lastAssistant = [...events].reverse().find((event): event is Extract<SessionEvent, { type: "assistant_message" }> => event.type === "assistant_message" && Boolean(event.content));
  const lastAssistantMessage = publicAssistantMessage(lastAssistant?.content ?? "");
  const lastTurnStatus = [...events].reverse().find((event): event is SessionTurnStatusEvent => event.type === "turn_status");
  const firstTime = events.find((event) => typeof event.time === "string")?.time;
  const lastTime = [...events].reverse().find((event) => typeof event.time === "string")?.time;
  return {
    fileName,
    firstUserMessage,
    lastAssistantMessage,
    lastTurnStatus,
    eventCount: events.length,
    createdAt: firstTime ?? stat.birthtime.toISOString(),
    updatedAt: lastTime ?? stat.mtime.toISOString()
  };
}

export interface ParseSessionEventsOptions {
  /**
   * `reject`（默认）超限即抛错，用于校验和写入路径。
   * `truncate` 保留最近的事件，用于"至少要能打开这条会话"的读取路径。
   */
  overflow?: "reject" | "truncate";
}

export interface ParsedSessionEvents {
  events: SessionEvent[];
  /** 事件数超过上限、头部事件被丢弃时为 true；只在 overflow: "truncate" 下可能发生。 */
  truncated: boolean;
}

export function parseSessionEvents(raw: string, options: ParseSessionEventsOptions = {}): SessionEvent[] {
  return parseSessionEventsDetailed(raw, options).events;
}

/** 与 parseSessionEvents 相同，但额外暴露是否发生了事件数截断，供读取路径如实上报。 */
export function parseSessionEventsDetailed(raw: string, options: ParseSessionEventsOptions = {}): ParsedSessionEvents {
  const overflow = options.overflow ?? "reject";
  const totalBytes = Buffer.byteLength(raw, "utf8");
  if (totalBytes > maxSessionFileBytes && overflow === "reject") {
    throw new Error(`Session exceeds the maximum size of ${String(maxSessionFileBytes)} bytes.`);
  }
  const events: SessionEvent[] = [];
  let truncated = false;
  let lineNumber = 0;
  let lineStart = 0;
  while (lineStart <= raw.length) {
    const newlineIndex = raw.indexOf("\n", lineStart);
    const terminated = newlineIndex !== -1;
    const lineEnd = terminated ? newlineIndex : raw.length;
    const line = raw.slice(lineStart, lineEnd);
    lineNumber += 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > maxSessionEventLineBytes) {
      throw new Error(`Session event line ${String(lineNumber)} exceeds the maximum size of ${String(maxSessionEventLineBytes)} bytes.`);
    }
    if (!line) {
      if (!terminated) break;
      lineStart = lineEnd + 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (!terminated) break;
      throw new Error(`Invalid JSONL event at line ${String(lineNumber)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (events.length >= maxSessionEvents) {
      if (overflow === "reject") {
        throw new Error(`Session cannot contain more than ${String(maxSessionEvents)} events.`);
      }
      // 保留最近的事件：恢复会话时有用的是尾部，不是开头。
      events.shift();
      truncated = true;
    }
    const event = validateSessionEvent(parsed, lineNumber);
    if (!validateRuntimeEventRecord(event.runtime)) {
      throw new Error(`Invalid runtime event metadata at line ${String(lineNumber)}.`);
    }
    events.push(event);
    if (!terminated) break;
    lineStart = lineEnd + 1;
  }
  return { events, truncated };
}

export function runtimeEventIdentity(event: SessionEvent): RuntimeEventIdentity | undefined {
  return event.runtime;
}

/**
 * Makes an existing JSONL session safe for append after an interrupted write.
 * A valid final event only needs a newline; an invalid unterminated fragment is
 * truncated back to the previous complete line.
 */
export async function repairSessionTailForAppend(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, constants.O_RDWR | noFollowFlag());
  try {
    await assertStandaloneSessionBinding(filePath, handle);
    const raw = await readBoundedSessionHandle(handle, filePath);
    await assertStandaloneSessionBinding(filePath, handle);
    if (raw.length === 0 || raw.at(-1) === 0x0a) return;

    const lastNewline = raw.lastIndexOf(0x0a);
    const tail = raw.subarray(lastNewline + 1).toString("utf8");
    try {
      JSON.parse(tail);
      await handle.write("\n", raw.length, "utf8");
    } catch {
      await handle.truncate(lastNewline + 1);
    }
    await assertStandaloneSessionBinding(filePath, handle);
  } finally {
    await handle.close();
  }
}

export async function listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
  const fileNames = await listSessionFiles(workspaceRoot);
  // Bound reads so a large history does not create an unbounded file-descriptor
  // burst. A corrupt JSONL file is isolated from the rest of the session list.
  const summaries: Array<SessionSummary | undefined> = new Array(fileNames.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(sessionListReadConcurrency, fileNames.length) }, async () => {
    while (nextIndex < fileNames.length) {
      const index = nextIndex;
      nextIndex += 1;
      const fileName = fileNames[index];
      if (!fileName) continue;
      try {
        const snapshot = await readSessionSnapshot(workspaceRoot, fileName);
        // 未变更的文件直接命中解析缓存，只对新增/变大的文件重新跑逐事件的 zod 校验。
        // 与打开路径一致用 truncate 模式：事件数超限的会话按尾部降级，仍应出现在列表里。
        const events = cachedSessionEvents(snapshot.filePath, sessionFileFingerprint(snapshot.stat), () => {
          const parsed = parseSessionEventsDetailed(snapshot.bytes.toString("utf8"), { overflow: "truncate" });
          return { events: parsed.events, complete: !snapshot.truncated && !parsed.truncated };
        });
        summaries[index] = summarizeSessionEvents(fileName, events, snapshot.stat);
      } catch {
        // Opening a corrupt session directly still reports the precise error;
        // listing healthy sessions remains available for recovery.
      }
    }
  });
  await Promise.all(workers);
  return summaries
    .filter((summary): summary is SessionSummary => summary !== undefined)
    .sort((a, b) => sessionTime(b.updatedAt) - sessionTime(a.updatedAt) || b.fileName.localeCompare(a.fileName));
}

function sessionTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function assertStandaloneSessionBinding(filePath: string, handle: FileHandle): Promise<void> {
  const descriptorStat = await handle.stat();
  const pathStat = await fs.lstat(filePath);
  if (
    !descriptorStat.isFile()
    || descriptorStat.nlink !== 1
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw new Error(`Session must be a single-link regular .jsonl file: ${filePath}`);
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function validateSessionEvent(value: unknown, lineNumber: number): SessionEvent {
  const parsed = sessionEventSchema.safeParse(value);
  if (parsed.success) return parsed.data as SessionEvent;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "event"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid session event at line ${String(lineNumber)}: ${detail}`);
}
