/** Strict checkpoint-only identity for one reply budget window and its terminal commit. */
import { z } from "zod";
import type { SessionEvent } from "./recorder.js";
import type { RetryOrigin } from "./retryOrigin.js";
import type { AgentAssistantMessage, AgentStopReason } from "../agent/core/types.js";
import type { AgentTurnOutcome, AgentTurnStatus, AgentTurnStopReason } from "../agent/types.js";
import { sameRuntimeHighWater, type RuntimeHighWater } from "./runtimeEvent.js";
// Both unknown additions and omitted domain variants fail compilation.
const exhaustiveEnum = <T extends string>() => <const Values extends readonly [T, ...T[]]>(
  values: Values & ([T] extends [Values[number]] ? unknown : never)
): Values => values;
const messageStopReasons = exhaustiveEnum<AgentStopReason>()(["stop", "tool-calls", "length", "error", "aborted", "other"]);
const outcomeStatuses = exhaustiveEnum<AgentTurnStatus>()(["completed", "incomplete", "blocked", "cancelled", "failed", "aborted"]);
const outcomeStopReasons = exhaustiveEnum<AgentTurnStopReason>()(["model_stop", "step_limit", "hard_step_limit", "tool_call_limit", "repeated_action_limit", "timeout",
  "model_length", "content_filter", "provider_error", "missing_terminal_event", "blocked", "interrupted", "replaced",
  "cancelled", "paused", "host_shutdown", "aborted", "budget_exhausted"]);
const witness = z.object({ eventId: z.string().min(1), eventSeq: z.number().int().positive(),
  runId: z.string().min(1).optional(), turnId: z.string().min(1).optional() }).strict();
const windowSchema = z.object({ version: z.literal(1), replyMessageId: z.string().min(1), admissionHighWater: witness }).strict();
const outcomeSchema = z.object({
  status: z.enum(outcomeStatuses),
  stopReason: z.enum(outcomeStopReasons),
  finishReason: z.string().optional(), steps: z.number().int().nonnegative(), output: z.string(),
  usage: z.record(z.unknown()).optional(), error: z.string().optional(), resumable: z.boolean().optional(),
  blockedReason: z.string().optional(), requiredAction: z.string().optional(), affectedTodoIds: z.array(z.string()).optional(),
  notification: z.string().optional()
}).strict();
const messageSchema = z.object({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("reasoning"), text: z.string(), providerMetadata: z.record(z.unknown()).optional() }).strict()
])), stopReason: z.enum(messageStopReasons).optional(),
usage: z.object({ inputTokens: z.number().finite().nonnegative().optional(), outputTokens: z.number().finite().nonnegative().optional(),
  totalTokens: z.number().finite().nonnegative().optional(), reasoningTokens: z.number().finite().nonnegative().optional(),
  cacheReadTokens: z.number().finite().nonnegative().optional(), cacheWriteTokens: z.number().finite().nonnegative().optional(),
  cacheMissTokens: z.number().finite().nonnegative().optional() }).strict().optional(), errorMessage: z.string().optional(), timestamp: z.number().finite().optional() }).strict();
const commitSchema = z.object({ version: z.literal(1), replyMessageId: z.string().min(1), runId: z.string().min(1),
  parentMessageId: z.string().min(1), runtimeHighWater: witness, message: messageSchema, outcome: outcomeSchema }).strict();
export interface RetryWindow { version: 1; replyMessageId: string; admissionHighWater: RuntimeHighWater }
export interface RetryCommit {
  version: 1;
  replyMessageId: string;
  runId: string;
  parentMessageId: string;
  runtimeHighWater: RuntimeHighWater;
  message: AgentAssistantMessage;
  outcome: AgentTurnOutcome;
}
export function isRetryWindow(value: unknown): value is RetryWindow { return windowSchema.safeParse(value).success; }
export function isRetryCommit(value: unknown): value is RetryCommit {
  const parsed = commitSchema.safeParse(value);
  if (!parsed.success) return false;
  const { message, outcome } = parsed.data;
  const text = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
  return text === outcome.output && message.stopReason === outcome.finishReason
    && (outcome.status !== "completed" || outcome.stopReason === "model_stop" && outcome.finishReason === "stop");
}

export function assertRetryWindow(
  events: readonly SessionEvent[],
  origin: RetryOrigin,
  window: RetryWindow | undefined
): asserts window is RetryWindow {
  if (!isRetryWindow(window)) throw new Error("Retry checkpoint has no valid reply window.");
  const index = events.findIndex(event => sameRuntimeHighWater(event.runtime, window.admissionHighWater));
  if (index < 0 || window.admissionHighWater.eventSeq < origin.admissionHighWater.eventSeq) throw new Error("Retry window admission witness is invalid.");
  if (window.admissionHighWater.eventSeq === origin.admissionHighWater.eventSeq && window.replyMessageId !== origin.finalMessageId) {
    throw new Error("Initial retry window changed its reserved reply identity.");
  }
  if (events.some(event => (event.type === "user_message" && !event.auditOnly || event.type === "agent_message")
    && event.messageId === window.replyMessageId && (event.type === "user_message" || event.runtime?.turnId !== origin.ownerTurnId
      || event.retryOfMessageId !== origin.targetMessageId || event.slotId !== origin.targetSlotId
      || event.replyToMessageId !== origin.replyToMessageId))) throw new Error("Retry reply ID collides with another canonical identity.");
  if (events.slice(0, index + 1).some(event => (event.type === "agent_message" || event.type === "user_message" && !event.auditOnly)
    && event.messageId === window.replyMessageId)) throw new Error("Retry reply ID was already used before this window.");
}
