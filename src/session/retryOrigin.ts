/** Checkpoint-owned retry intent. It never changes the JSONL event protocol. */
import { activeSessionEventsForPath, activeSessionMessageIds, sessionMessageTree } from "./messageTree.js";
import type { SessionEvent } from "./recorder.js";
import { sameRuntimeHighWater, validateRuntimeEventRecord, validateRuntimeEventStream, type RuntimeHighWater } from "./runtimeEvent.js";

export interface RetryOrigin {
  version: 1;
  source: "agent-session-retry";
  sessionId: string;
  ownerTurnId: string;
  initialRunId: string;
  sourceUserMessageId: string;
  targetMessageId: string;
  targetRole: "user" | "assistant";
  targetRuntime: RuntimeHighWater;
  baseParentMessageId: string;
  targetSlotId: string;
  replyToMessageId: string;
  finalMessageId: string;
  /** Immutable intent boundary, independent of the advancing execution checkpoint. */
  admissionHighWater: RuntimeHighWater;
}

const fields = new Set(["version", "source", "sessionId", "ownerTurnId", "initialRunId", "sourceUserMessageId",
  "targetMessageId", "targetRole", "targetRuntime", "baseParentMessageId", "targetSlotId", "replyToMessageId",
  "finalMessageId", "admissionHighWater"]);

export function isRetryOrigin(value: unknown): value is RetryOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  return Object.keys(origin).length === fields.size && Object.keys(origin).every(key => fields.has(key))
    && origin.version === 1 && origin.source === "agent-session-retry"
    && (origin.targetRole === "user" || origin.targetRole === "assistant")
    && [...fields].filter(key => !["version", "source", "targetRole", "targetRuntime", "admissionHighWater"].includes(key))
      .every(key => typeof origin[key] === "string" && origin[key].length > 0)
    && isWitness(origin.targetRuntime) && isWitness(origin.admissionHighWater);
}

function isWitness(value: unknown): value is RuntimeHighWater {
  return value !== undefined && validateRuntimeEventRecord(value)
    && Object.keys(value).every(key => ["eventId", "eventSeq", "runId", "turnId"].includes(key));
}

export interface RetryScope {
  status: "active" | "superseded" | "finished";
  /** Actual persisted cursor on the owned replacement chain, never the selected old answer. */
  cursor: string;
  final?: Extract<SessionEvent, { type: "agent_message" }>;
  selectedFinal: boolean;
  prefixEvents: SessionEvent[];
  ownedEvents: SessionEvent[];
}

/** Full physical log validation precedes all scoped projections and recovery decisions. */
export function resolveRetryScope(
  events: readonly SessionEvent[], origin: RetryOrigin,
  expected?: { sessionId?: string; turnId?: string; runtimeHighWater?: RuntimeHighWater }
): RetryScope {
  if (!isRetryOrigin(origin)) throw new Error("Invalid retry origin version or source.");
  validateRuntimeEventStream(events);
  if (expected?.sessionId !== undefined && expected.sessionId !== origin.sessionId
    || expected?.turnId !== undefined && expected.turnId !== origin.ownerTurnId) throw new Error("Retry origin owner or session mismatch.");
  const admission = events.findIndex(event => sameRuntimeHighWater(event.runtime, origin.admissionHighWater));
  if (admission < 0) throw new Error("Retry admission high-water is absent from the session.");
  if (expected?.runtimeHighWater) {
    const execution = events.findIndex(event => sameRuntimeHighWater(event.runtime, expected.runtimeHighWater));
    if (execution < admission) throw new Error("Retry execution high-water predates its admission.");
  }
  const historical = events.slice(0, admission + 1);
  if (historical.some(event => event.runtime?.turnId === origin.ownerTurnId || event.runtime?.runId === origin.initialRunId)) {
    throw new Error("Retry admission must own a new execution identity.");
  }
  const nodes = sessionMessageTree(historical);
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error("Retry target prefix has duplicate canonical identities.");
  const target = byId.get(origin.targetMessageId);
  const source = byId.get(origin.sourceUserMessageId);
  const active = activeSessionMessageIds(historical, nodes);
  if (!target || target.message.role !== origin.targetRole || !source || source.message.role !== "user"
    || !active.has(target.id) || !active.has(source.id)
    || !sameRuntimeHighWater(historical[target.eventIndex]?.runtime, origin.targetRuntime)) {
    throw new Error("Retry target/source is not the witnessed active conversation.");
  }
  let ancestor = target;
  const visited = new Set<string>();
  while (ancestor.message.role !== "user") {
    if (visited.has(ancestor.id) || !ancestor.parentId) throw new Error("Retry target has no valid source user.");
    visited.add(ancestor.id);
    const parent = byId.get(ancestor.parentId);
    if (!parent) throw new Error("Retry target prefix has a missing parent.");
    ancestor = parent;
  }
  const base = origin.targetRole === "assistant" ? target.parentId : source.id;
  const slot = origin.targetRole === "assistant" ? target.slotId ?? source.id
    : nodes.find(node => active.has(node.id) && node.message.role === "assistant" && (node.slotId ?? node.id) === (source.slotId ?? source.id))?.slotId
      ?? source.slotId ?? source.id;
  if (ancestor.id !== source.id || base !== origin.baseParentMessageId || slot !== origin.targetSlotId
    || origin.replyToMessageId !== source.id || byId.has(origin.finalMessageId)) {
    throw new Error("Retry origin changed the target base, slot, reply or reserved output identity.");
  }
  const baseNode = byId.get(origin.baseParentMessageId);
  if (!baseNode) throw new Error("Retry base is not a persisted canonical message.");
  // Preserve the exact historical selected prefix. The replaced answer and all
  // sibling/future events are excluded, without changing generic branch rules.
  const throughBase = new Set(historical.slice(0, baseNode.eventIndex + 1));
  const prefixEvents = activeSessionEventsForPath(historical).filter(event =>
    throughBase.has(event) && event.type !== "message_version_selected");
  let cursor = origin.baseParentMessageId;
  let final: RetryScope["final"];
  let selectedFinal = false;
  const replies = new Set<string>();
  const selections = new Set<string>();
  const queued = new Map<string, { content: string; attachments: unknown; runId?: string; removed: boolean }>();
  let status: RetryScope["status"] = "active";
  const ownedEvents: SessionEvent[] = [];
  const ownedCalls = new Set<string>();
  const ids = new Set(nodes.map(node => node.id));
  for (const event of events.slice(admission + 1)) {
    if (event.runtime?.runId === origin.initialRunId && event.runtime.turnId !== origin.ownerTurnId) throw new Error("Retry execution owner changed.");
    const owned = event.runtime?.turnId === origin.ownerTurnId;
    if (owned && event.type === "user_message" && event.auditOnly && event.messageId
      && (event.metadata?.queuedDelivery === "queue" || event.metadata?.queuedDelivery === "steer")) {
      if (queued.has(event.messageId)) throw new Error("Retry queued admission identity was reused.");
      queued.set(event.messageId, { content: event.content, attachments: event.attachments, runId: event.runtime?.runId, removed: false });
    }
    if (owned && event.type === "message_metadata") {
      const receipt = queued.get(event.messageId);
      if (receipt) {
        if (typeof event.metadata.queuedContent === "string") receipt.content = event.metadata.queuedContent;
        if (event.metadata.queuedState === "removed") receipt.removed = true;
      }
    }
    if (event.type === "user_message" && !event.auditOnly) {
      const receipt = event.messageId ? queued.get(event.messageId) : undefined;
      const delivered = owned && event.importSource === undefined && (receipt && !receipt.removed
        && receipt.runId === event.runtime?.runId && receipt.content === event.content
        && JSON.stringify(receipt.attachments) === JSON.stringify(event.attachments)
        || event.metadata?.source === "subagent" && typeof event.metadata.taskRunId === "string" && typeof event.metadata.attemptId === "string");
      if (!delivered) status = "superseded";
      else if (status === "active") {
        if (!event.messageId || ids.has(event.messageId) || event.parentMessageId !== cursor || event.slotId !== event.messageId) {
          throw new Error("Retry delivered input is not on the owned canonical chain.");
        }
        ids.add(event.messageId); cursor = event.messageId;
      }
    } else if (event.type === "user_message" && !owned) status = "superseded";
    if (event.type === "message_version_selected") {
      if (owned && replies.has(event.messageId) && event.slotId === origin.targetSlotId) {
        if (selections.has(event.messageId)) throw new Error("Retry reply selection was committed more than once.");
        selections.add(event.messageId);
        selectedFinal = final?.messageId === event.messageId;
      } else status = "superseded";
    }
    if (owned && event.importSource !== undefined) throw new Error("Retry execution cannot be imported evidence.");
    if (owned && event.type === "agent_message" && status === "active") {
      if (!event.messageId || ids.has(event.messageId) || event.parentMessageId !== cursor) throw new Error("Retry canonical execution chain is inconsistent.");
      ids.add(event.messageId);
      cursor = event.messageId;
      if (event.retryOfMessageId !== undefined) {
        if (event.message.role !== "assistant" || event.retryOfMessageId !== origin.targetMessageId
          || event.message.content.some(part => part.type === "toolCall") || event.slotId !== origin.targetSlotId
          || event.replyToMessageId !== origin.replyToMessageId) throw new Error("Retry final identity does not match admitted intent.");
        final = event; replies.add(event.messageId); selectedFinal = false;
      } else if (event.messageId === origin.finalMessageId || event.slotId !== event.messageId
        || event.replyToMessageId !== undefined) throw new Error("Retry intermediate identity does not match its owned chain.");
    }
    if (owned && event.type === "tool_call" && event.toolCallId) ownedCalls.add(event.toolCallId);
    if (owned || event.type === "tool_result" && event.recovered && event.runtime?.turnId === undefined && event.toolCallId && ownedCalls.has(event.toolCallId)) {
      ownedEvents.push(event);
    }
    if (owned && event.type === "turn_status" && (event.status === "completed" || event.status === "cancelled" && event.stopReason !== "paused") && status === "active") status = "finished";
  }
  return { status, cursor, final, selectedFinal, prefixEvents, ownedEvents };
}

/** Recovered results are reordered by replay; membership remains grounded in native call identity. */
export function retryProjectionEvents(events: readonly SessionEvent[], scope: RetryScope, origin: RetryOrigin): SessionEvent[] {
  const prefix = new Set(scope.prefixEvents);
  const calls = new Set(scope.ownedEvents.flatMap(event => event.type === "tool_call" && event.toolCallId ? [event.toolCallId] : []));
  return events.filter(event => prefix.has(event) || event.runtime?.turnId === origin.ownerTurnId
    || event.type === "tool_result" && event.recovered && event.toolCallId !== undefined && calls.has(event.toolCallId));
}
