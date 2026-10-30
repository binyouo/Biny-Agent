/** A message fork exports one witnessed, closed canonical ancestry, not an event prefix. */
import { activeSessionMessageIds, sessionMessageTree, type SessionMessageNode } from "./messageTree.js";
import { publicAssistantMessage } from "./publicMessage.js";
import type { SessionEvent } from "./recorder.js";
import { validateRuntimeEventStream } from "./runtimeEvent.js";

function unsupported(): never { throw new Error("这条消息的历史尚未完整提交，或无法安全确定分支边界；未创建分支。"); }
const sameOwner = (left: SessionEvent, right: SessionEvent): boolean =>
  !!left.runtime?.runId && !!left.runtime.turnId
  && left.runtime.runId === right.runtime?.runId && left.runtime.turnId === right.runtime?.turnId;

export interface MessageBranchProjection {
  events: SessionEvent[];
  messageIds: string[];
  sourceEventIndex: number;
  role: "user" | "assistant";
}

/** Inclusive boundary, evaluated against this single immutable persisted snapshot. */
export function projectMessageBranch(events: readonly SessionEvent[], messageId: string): MessageBranchProjection {
  validateRuntimeEventStream(events);
  const nodes = sessionMessageTree(events);
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (nodes.length !== byId.size) unsupported();
  for (const event of events) {
    if (event.type !== "message_version_selected") continue;
    const selected = byId.get(event.messageId);
    if (!selected || (selected.slotId ?? selected.id) !== event.slotId) unsupported();
  }
  const target = byId.get(messageId);
  if (!target || target.message.role === "toolResult" || !activeSessionMessageIds(events, nodes).has(messageId)) {
    throw new Error("要分支的消息不在当前活动对话中，请刷新后重试。");
  }
  const chain: SessionMessageNode[] = [];
  const ids = new Set<string>();
  let current: SessionMessageNode | undefined = target;
  while (current) {
    if (ids.has(current.id)) unsupported();
    ids.add(current.id);
    chain.push(current);
    if (current.parentId === undefined) break;
    const parent = byId.get(current.parentId);
    if (!parent || parent.eventIndex >= current.eventIndex) unsupported();
    current = parent;
  }
  chain.reverse();
  if (chain[0]?.message.role !== "user") unsupported();
  // Anonymous legacy messages cannot be silently dropped from a canonical export.
  if (events.slice(0, target.eventIndex + 1).some(event =>
    (event.type === "agent_message" || event.type === "user_message" && !event.auditOnly) && !event.messageId)) unsupported();
  // Mixed legacy/audit-only model history has no provable canonical ancestry.
  // Reject it rather than silently discard an answer, interruption or tool context.
  const canonicalCallIds = new Set(nodes.flatMap(node => node.message.role === "assistant"
    ? node.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []));
  for (const event of events.slice(0, target.eventIndex + 1)) {
    if (event.type === "turn_interrupted") unsupported();
    if (event.type === "assistant_message" && !event.auditOnly
      && (event.content || event.reasoningContent || event.reasoningBlocks?.length)
      && (!event.messageId || byId.get(event.messageId)?.message.role !== "assistant")) unsupported();
    if ((event.type === "tool_call" || event.type === "tool_result") && !event.auditOnly
      && (!event.toolCallId || !canonicalCallIds.has(event.toolCallId))) unsupported();
  }
  const indexes = new Map(events.map((event, index) => [event, index]));
  const auditsById = new Map<string, Array<Extract<SessionEvent, { type: "assistant_message" }>>>();
  const terminalsByRun = new Map<string, Array<Extract<SessionEvent, { type: "turn_status" }>>>();
  const toolsById = new Map<string, Array<Extract<SessionEvent, { type: "tool_call" | "tool_result" }>>>();
  const canonicalByRun = new Map<string, number[]>();
  for (const [index, event] of events.entries()) {
    if (event.type === "assistant_message" && !event.auditOnly && event.messageId) {
      const bucket = auditsById.get(event.messageId) ?? [];
      bucket.push(event); auditsById.set(event.messageId, bucket);
    }
    if (event.type === "turn_status" && event.runtime?.runId) {
      const bucket = terminalsByRun.get(event.runtime.runId) ?? [];
      bucket.push(event); terminalsByRun.set(event.runtime.runId, bucket);
    }
    if ((event.type === "tool_call" || event.type === "tool_result") && !event.auditOnly && event.toolCallId) {
      const bucket = toolsById.get(event.toolCallId) ?? [];
      bucket.push(event); toolsById.set(event.toolCallId, bucket);
    }
    if ((event.type === "agent_message" || event.type === "user_message" && !event.auditOnly) && event.runtime?.runId) {
      const bucket = canonicalByRun.get(event.runtime.runId) ?? [];
      bucket.push(index); canonicalByRun.set(event.runtime.runId, bucket);
    }
  }
  const calls = new Map<string, { name: string; event: SessionEvent; result?: SessionEvent }>();
  const open = new Set<string>();
  const display = new Map<SessionEvent, SessionEvent[]>();
  const retained = new Set<SessionEvent>();
  for (const node of chain) {
    const event = events[node.eventIndex]!;
    retained.add(event);
    if (node.message.role === "user") {
      if (open.size) unsupported();
      continue;
    }
    if (node.message.role === "toolResult") {
      const call = calls.get(node.message.toolCallId);
      if (!call || !open.delete(node.message.toolCallId) || call.name !== node.message.toolName
        || !sameOwner(call.event, event)) unsupported();
      call.result = event;
      continue;
    }
    if (open.size || node.message.stopReason === "error" || node.message.stopReason === "aborted") unsupported();
    const toolCalls = node.message.content.filter(part => part.type === "toolCall");
    for (const part of toolCalls) {
      if (!part.id || calls.has(part.id)) unsupported();
      calls.set(part.id, { name: part.name, event });
      open.add(part.id);
    }
    if (toolCalls.length) {
      if (node === target) unsupported();
      continue;
    }
    // The UI audit is not a commit witness by itself. Require a matching terminal run.
    const audits = auditsById.get(node.id) ?? [];
    if (audits.length !== 1 || !sameOwner(event, audits[0]!)) unsupported();
    const audit = audits[0]!;
    const auditIndex = indexes.get(audit)!;
    const terminals = (terminalsByRun.get(event.runtime?.runId ?? "") ?? []).filter(item => sameOwner(event, item));
    if (auditIndex <= node.eventIndex || terminals.length !== 1 || terminals[0]!.status !== "completed"
      || indexes.get(terminals[0]!)! <= auditIndex) unsupported();
    const terminalIndex = indexes.get(terminals[0]!)!;
    if ((canonicalByRun.get(event.runtime?.runId ?? "") ?? []).some(index => index > node.eventIndex
      && index < terminalIndex && sameOwner(event, events[index]!))) unsupported();
    // Construct display-only data from this canonical answer; never inherit contextState,
    // memory summaries, version choices or a later anonymous assistant audit.
    display.set(event, [{
      type: "assistant_message", messageId: node.id, parentMessageId: node.parentId,
      slotId: node.slotId, replyToMessageId: event.type === "agent_message" ? event.replyToMessageId : undefined,
      content: publicAssistantMessage(node.message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("")),
      reasoningContent: node.message.content.flatMap(part => part.type === "reasoning" ? [part.text] : []).join("") || undefined,
      usage: audit.usage, time: audit.time, runtime: event.runtime
    }, { ...terminals[0]!, runtime: event.runtime }]);
  }
  if (open.size) unsupported();
  // Preserve existing UI tool facts only when both belong to retained canonical facts.
  // Missing/ambiguous audit pairing is unsupported; never fabricate tool execution evidence.
  for (const [id, call] of calls) {
    if (!call.result) unsupported();
    const audits = toolsById.get(id) ?? [];
    const callAudits = audits.filter(event => event.type === "tool_call");
    const resultAudits = audits.filter(event => event.type === "tool_result");
    if (callAudits.length !== 1 || resultAudits.length !== 1) unsupported();
    const start = callAudits[0]!, end = resultAudits[0]!;
    if (start.type !== "tool_call" || end.type !== "tool_result" || start.tool !== call.name || end.tool !== call.name
      || !sameOwner(call.event, start) || !sameOwner(call.result, end)
      || indexes.get(start)! >= indexes.get(end)! || indexes.get(end)! > indexes.get(call.result)!) unsupported();
    retained.add(start);
    retained.add(end);
  }
  const projected = events.flatMap((event): SessionEvent[] => {
    if (!retained.has(event)) return [];
    if (event.type === "user_message") {
      const { contextState: _contextState, ...user } = event;
      return [user];
    }
    return [event, ...(display.get(event) ?? [])];
  });
  return { events: projected, messageIds: chain.map(node => node.id), sourceEventIndex: target.eventIndex,
    role: target.message.role as "user" | "assistant" };
}
