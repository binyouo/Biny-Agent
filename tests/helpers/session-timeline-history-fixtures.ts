import type { SessionEvent } from "../../src/session/recorder.js";

/** Synthetic public history only: no provider, filesystem, or user data. */
export function summaryHistory(count: number, options: { versioned?: boolean; turns?: number; repeated?: boolean; toolsPerSummary?: number; canonical?: boolean } = {}): SessionEvent[] {
  const events: SessionEvent[] = [];
  let parent: string | undefined;
  const turns = options.turns ?? 1;
  for (let turn = 0; turn < turns; turn += 1) {
    const user = `user-${turn}`;
    const answer = `answer-${turn}`;
    const runtime = options.versioned ? { runId: `run-${turn}`, eventId: `event-${turn}`, eventSeq: turn + 1 } : undefined;
    events.push({ type: "user_message", messageId: user, parentMessageId: parent, content: `Inspect ${turn}`, runtime });
    let messageParent = user;
    let groupStart = 0;
    for (let index = 0; index < count; index += 1) {
      const id = `call-${turn}-${index}`;
      events.push({ type: "tool_call", tool: "Read", toolCallId: id, args: { path: `synthetic-${turn}-${index}.txt` },
        assistantContent: `Inspect section ${options.repeated ? index % 8 : Math.floor(index / (options.toolsPerSummary ?? 1))}`, runtime });
      events.push({ type: "tool_result", tool: "Read", toolCallId: id, result: { content: "Synthetic result" }, runtime });
      if (options.versioned && options.canonical && ((index + 1) % (options.toolsPerSummary ?? 1) === 0 || index === count - 1)) {
        const stepId = `step-${turn}-${index}`;
        const calls = Array.from({ length: index - groupStart + 1 }, (_, offset) => ({ type: "toolCall" as const,
          id: `call-${turn}-${groupStart + offset}`, name: "Read", arguments: { path: `synthetic-${turn}-${groupStart + offset}.txt` } }));
        events.push({ type: "agent_message", messageId: stepId, parentMessageId: messageParent, runtime,
          message: { role: "assistant", content: [{ type: "text", text: `Inspect section ${Math.floor(index / (options.toolsPerSummary ?? 1))}` }, ...calls] } });
        messageParent = stepId;
        for (const call of calls) {
          const resultId = `result-${call.id}`;
          events.push({ type: "agent_message", messageId: resultId, parentMessageId: messageParent, runtime,
            message: { role: "toolResult", toolCallId: call.id, toolName: "Read", content: [{ type: "text", text: "Synthetic result" }], isError: false } });
          messageParent = resultId;
        }
        groupStart = index + 1;
      }
    }
    if (options.versioned) events.push({ type: "agent_message", messageId: answer, parentMessageId: messageParent, slotId: user,
      replyToMessageId: user, runtime, message: { role: "assistant", content: [{ type: "text", text: "Done" }] } });
    events.push({ type: "assistant_message", content: "Done", runtime,
      ...(options.versioned ? { messageId: answer, parentMessageId: messageParent, slotId: user, replyToMessageId: user } : {}) });
    parent = answer;
  }
  return events.map((event, index) => event.runtime ? { ...event, runtime: { ...event.runtime, eventId: `synthetic-event-${index}`, eventSeq: index + 1 } } : event);
}

/** Branches/retries, repeated IDs, late results, audit events and blank public summaries. */
export function adversarialHistory(count: number): SessionEvent[] {
  const events = summaryHistory(count, { versioned: true });
  const runtime = { runId: "retry", eventId: "retry-event", eventSeq: 2 };
  events.push(
    { type: "agent_message", messageId: "retry-answer", parentMessageId: "user-0", slotId: "user-0", replyToMessageId: "user-0", runtime,
      message: { role: "assistant", content: [{ type: "text", text: "Retried" }] } },
    { type: "tool_call", tool: "Read", toolCallId: "duplicate", args: {}, assistantContent: "Repeated", runtime },
    { type: "tool_call", tool: "Read", toolCallId: "duplicate", args: {}, assistantContent: "Other", runtime },
    { type: "tool_result", tool: "Read", toolCallId: "duplicate", result: undefined, runtime },
    { type: "tool_call", tool: "Read", args: {}, assistantContent: "Repeated", runtime },
    { type: "tool_result", tool: "Read", result: "late anonymous result", runtime },
    { type: "tool_result", tool: "Read", toolCallId: "duplicate", result: "late duplicate", runtime },
    { type: "tool_call", tool: "Read", args: {}, assistantContent: " \n\t ", runtime },
    { type: "tool_call", tool: "Read", args: {}, assistantContent: "Audit-only", auditOnly: true, runtime },
    { type: "assistant_message", content: "Repeated", messageId: "retry-answer", slotId: "user-0", replyToMessageId: "user-0", retryOfMessageId: "answer-0", runtime },
    { type: "message_version_selected", slotId: "user-0", messageId: "retry-answer" }
  );
  return events;
}
