/**
 * Promote only the native, replay-admitted unfinished tool suffix before continuation.
 * This is an append plan, not another recovery/outcome inference or a legacy migration.
 * The caller must validate the full log and continuation safety under its operation lock.
 */
import { resolveRetryScope, retryProjectionEvents, type RetryOrigin } from "./retryOrigin.js";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "../agent/core/types.js";
import { activeSessionEventsForPath, activeSessionMessageIds } from "./messageTree.js";
import type { SessionEvent } from "./recorder.js";
import type { SessionReplay } from "./replay.js";

export interface RecoveryMaterializationPlan {
  /** False is a stale/unproven owner or branch, not a successful no-op. */
  eligible: boolean;
  parentMessageId?: string;
  messages: Array<Exclude<AgentMessage, { role: "user" }>>;
}

export function recoveryMaterializationPlan(
  recordedEvents: readonly SessionEvent[],
  replay: SessionReplay,
  turnId: string | undefined,
  retryOrigin?: RetryOrigin
): RecoveryMaterializationPlan {
  const retry = retryOrigin ? resolveRetryScope(recordedEvents, retryOrigin, { turnId }) : undefined;
  const projectedEvents = retry?.status === "active" && retryOrigin ? retryProjectionEvents(recordedEvents, retry, retryOrigin) : undefined;
  const activeIds = projectedEvents ? new Set(projectedEvents.flatMap(event =>
    (event.type === "agent_message" || event.type === "user_message" && !event.auditOnly) && event.messageId ? [event.messageId] : []))
    : activeSessionMessageIds(recordedEvents);
  const activeNodes = replay.messageTree.filter(node => activeIds.has(node.id));
  const parentMessageId = retry?.status === "active" ? retry.cursor : activeNodes.at(-1)?.id;
  const empty = { eligible: false, parentMessageId, messages: [] };
  if (!turnId || !parentMessageId || retry && retry.status !== "active") return empty;
  if (!retry) {
    const latestInput = [...recordedEvents].reverse().find(event => event.type === "user_message" && event.runtime?.turnId);
    if (latestInput?.runtime?.turnId !== turnId || latestInput.importSource !== undefined) return empty;
    if (latestInput.type === "user_message" && !latestInput.auditOnly && (!latestInput.messageId || !activeIds.has(latestInput.messageId))) return empty;
  }

  const activeEvents = new Set(projectedEvents ?? activeSessionEventsForPath(recordedEvents));
  const calls = new Map<string, Extract<SessionEvent, { type: "tool_call" }>>();
  const results = new Map<string, Extract<SessionEvent, { type: "tool_result" }>>();
  const operations = new Map<string, Extract<SessionEvent, { type: "tool_execution" }>>();
  const canonicalCalls = new Map<string, Extract<SessionEvent, { type: "agent_message" }>>();
  const canonicalResults = new Map<string, Extract<SessionEvent, { type: "agent_message" }>>();
  const duplicateCanonical = new Set<string>();
  for (const event of recordedEvents) {
    if (event.type === "agent_message") {
      const ids = event.message.role === "assistant"
        ? event.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : [])
        : [event.message.toolCallId];
      const target = event.message.role === "assistant" ? canonicalCalls : canonicalResults;
      for (const id of ids) {
        if (target.has(id)) duplicateCanonical.add(id);
        target.set(id, event);
      }
    }
    if (!activeEvents.has(event) || event.importSource !== undefined || !event.runtime) continue;
    if (event.type === "tool_call" && !event.auditOnly && event.toolCallId && event.runtime.turnId === turnId) calls.set(event.toolCallId, event);
    if (event.type === "tool_execution" && event.runtime.turnId === turnId) operations.set(event.toolCallId, event);
    // resume may persist a recovery result without a run context. Its native operation
    // identity below, not this optional writer identity, proves which call it closes.
    if (event.type === "tool_result" && !event.auditOnly && event.toolCallId
      && (event.runtime.turnId === turnId || event.recovered && event.runtime.turnId === undefined)) results.set(event.toolCallId, event);
  }
  const represented = (event: Extract<SessionEvent, { type: "agent_message" }> | undefined): boolean =>
    event !== undefined && event.messageId !== undefined && activeIds.has(event.messageId)
      && event.runtime?.turnId === turnId && event.importSource === undefined;
  const projectedCallCounts = new Map<string, number>();
  for (const message of replay.messages) if (message.role === "assistant") {
    for (const part of message.content) if (part.type === "toolCall") projectedCallCounts.set(part.id, (projectedCallCounts.get(part.id) ?? 0) + 1);
  }
  const messages: RecoveryMaterializationPlan["messages"] = [];
  for (let index = 0; index < replay.messages.length; index += 1) {
    const message = replay.messages[index]!;
    if (message.role !== "assistant") continue;
    const parts = message.content.filter(part => part.type === "toolCall");
    if (!parts.length) continue;
    const ids = new Set(parts.map(part => part.id));
    // A later canonical assistant/user is already a committed boundary. Never retrofit
    // old gaps behind it; only the unfinished suffix can be extended by new ancestors.
    if (replay.messages.slice(index + 1).some((later, offset) => replay.messageReferences[index + 1 + offset]?.id
      && (later.role === "assistant" || later.role === "user"))) continue;
    const pairedResults = replay.messages.slice(index + 1).filter((item): item is Extract<AgentMessage, { role: "toolResult" }> =>
      item.role === "toolResult" && ids.has(item.toolCallId));
    if (pairedResults.length !== parts.length || new Set(pairedResults.map(item => item.toolCallId)).size !== parts.length) continue;
    if (parts.every(part => calls.has(part.id)) && pairedResults.some(result => result.content.length !== 1
      || result.content[0]?.type !== "text" || typeof result.content[0].text !== "string")) {
      throw new Error("Native recovery tool result has no valid durable text body.");
    }
    if (!parts.every(part => {
      const call = calls.get(part.id);
      const result = results.get(part.id);
      const operation = operations.get(part.id);
      const projected = pairedResults.find(item => item.toolCallId === part.id);
      const callRuntime = call?.runtime;
      const operationRuntime = operation?.runtime;
      const resultRuntime = result?.runtime;
      return projectedCallCounts.get(part.id) === 1 && !duplicateCanonical.has(part.id) && call && result && operation && projected
        && callRuntime && operationRuntime && resultRuntime && callRuntime.runId
        && operationRuntime.runId === callRuntime.runId && (result.recovered || resultRuntime.runId === callRuntime.runId)
        && callRuntime.eventSeq < operationRuntime.eventSeq && operationRuntime.eventSeq < resultRuntime.eventSeq
        && Number.isSafeInteger(call.sequence) && (call.sequence ?? 0) > 0 && operation.operationId.length > 0
        && call.tool === part.name && result.tool === part.name && operation.tool === part.name
        && projected.toolName === part.name && isDeepStrictEqual(call.args, part.arguments)
        && isDeepStrictEqual(projected.details, result.result)
        && projected.content.length === 1 && projected.content[0]?.type === "text"
        && projected.content[0].text === (typeof result.result === "string" ? result.result : JSON.stringify(result.result))
        && result.executionStatus !== undefined && result.executionStatus !== "unknown"
        && result.operationId === operation.operationId
        && call.sequence === operation.sequence && result.sequence === operation.sequence
        && (!canonicalCalls.has(part.id) || represented(canonicalCalls.get(part.id)))
        && (!canonicalResults.has(part.id) || represented(canonicalResults.get(part.id)));
    })) continue;
    const existingCalls = parts.filter(part => canonicalCalls.has(part.id));
    // A native canonical assistant commits its entire call batch atomically. An
    // arbitrary mixture cannot be reconstructed by inventing another assistant.
    if (existingCalls.length !== 0 && existingCalls.length !== parts.length) continue;
    if (existingCalls.length && new Set(existingCalls.map(part => canonicalCalls.get(part.id))).size !== 1) continue;
    if (!existingCalls.length) messages.push(structuredClone(message));
    for (const result of pairedResults) {
      if (!canonicalResults.has(result.toolCallId)) messages.push(structuredClone(result));
    }
  }
  return { eligible: true, parentMessageId, messages };
}

/** Concurrent same-owner canonical additions must be exact copies of the proved suffix. */
export function assertRecoveryMaterializationSuffix(
  prefixEvents: readonly SessionEvent[],
  prefixPlan: RecoveryMaterializationPlan,
  laterEvents: readonly SessionEvent[]
): void {
  const expected = new Map(prefixPlan.messages.map(message => [materializationKey(message), message]));
  const ids = new Set(prefixEvents.flatMap(event => (event.type === "agent_message" || event.type === "user_message") && event.messageId ? [event.messageId] : []));
  const representedCalls = new Set(prefixEvents.flatMap(event => event.type === "agent_message" && event.message.role === "assistant"
    ? event.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []));
  let cursor = prefixPlan.parentMessageId;
  for (const event of laterEvents) {
    if (event.type !== "agent_message") continue;
    const key = materializationKey(event.message);
    const message = expected.get(key);
    const toolCallId = event.message.role === "toolResult" ? event.message.toolCallId : undefined;
    const audit = toolCallId === undefined ? undefined : prefixEvents.find(item => item.type === "tool_result" && item.toolCallId === toolCallId);
    const isErrorValid = event.message.role !== "toolResult" || event.message.isError === undefined
      || audit?.type === "tool_result" && event.message.isError === (audit.executionStatus !== "succeeded");
    if (!message || !isDeepStrictEqual(materializationBody(event.message), materializationBody(message)) || !isErrorValid
      || toolCallId !== undefined && !representedCalls.has(toolCallId)
      || !event.messageId || ids.has(event.messageId) || event.parentMessageId !== cursor
      || event.slotId !== event.messageId || event.importSource !== undefined || event.metadata !== undefined
      || event.replyToMessageId !== undefined || event.retryOfMessageId !== undefined) {
      throw new Error("Recovery canonical suffix is not an exact copy of its authenticated native facts.");
    }
    expected.delete(key);
    if (event.message.role === "assistant") for (const part of event.message.content) if (part.type === "toolCall") representedCalls.add(part.id);
    ids.add(event.messageId);
    cursor = event.messageId;
  }
}

function materializationKey(message: Exclude<AgentMessage, { role: "user" }>): string {
  return message.role === "toolResult" ? `result:${message.toolCallId}`
    : `calls:${JSON.stringify(message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []))}`;
}

function materializationBody(message: Exclude<AgentMessage, { role: "user" }>): unknown {
  if (message.role !== "toolResult") return message;
  // Existing replay adds this derived protocol flag when an assistant has already
  // become canonical. Its value is checked against the durable outcome above.
  const { isError: _isError, ...body } = message;
  return body;
}
