import type { TaskInspection, WorkerActivity } from "../../../runtime/TaskCommunication.js";
import type { SessionEvent } from "../../../session/recorder.js";
import { buildSessionTimeline, type TimelineRunStatus, type TimelineTurn } from "./sessionTimeline.js";
import { subagentFailurePresentation } from "./subagentPresentation.js";

/** 将已限长的子执行记录交给主聊天投影；不会写入或扩充父会话。 */
export function buildSubagentTimeline(inspection: TaskInspection, activity: WorkerActivity[], recordedOutput?: string): TimelineTurn[] {
  const events: SessionEvent[] = [{ type: "user_message", content: inspection.title, time: inspection.createdAt }];
  for (const entry of activity) {
    const time = entry.createdAt;
    if (entry.kind === "tool_call" && entry.tool) events.push({ type: "tool_call", tool: entry.tool, toolCallId: entry.toolCallId ?? entry.id, args: entry.args, time });
    if (entry.kind === "tool_result" && entry.tool) events.push({ type: "tool_result", tool: entry.tool, toolCallId: entry.toolCallId, result: entry.result, executionStatus: entry.status === "succeeded" || entry.status === "failed" || entry.status === "cancelled" || entry.status === "unknown" ? entry.status : undefined, time });
    if (entry.kind === "assistant" && entry.content) events.push({ type: "assistant_message", content: entry.content, time });
    if (entry.kind === "reasoning" && entry.content) events.push({ type: "assistant_message", content: "", reasoningContent: entry.content, time });
  }
  const failure = subagentFailurePresentation(inspection.reason);
  if (!inspection.hasMore && !activity.some(entry => entry.kind === "assistant")) {
    const output = inspection.output ?? recordedOutput ?? failure.output;
    if (output) events.push({ type: "assistant_message", content: output.slice(0, 16000) });
  }
  const turns = buildSessionTimeline(events, []);
  const current = turns.at(-1);
  if (current) {
    const statuses: Record<string, TimelineRunStatus> = { created: "running", queued: "running", running: "running", verifying: "running", needs_approval: "blocked", blocked: "blocked", completed: "completed", failed: "failed", incomplete: "incomplete", aborted: "aborted", cancelled: "cancelled", policy_denied: "blocked", budget_exhausted: "incomplete" };
    const selected = inspection.attempts.find(attempt => attempt.attemptId === inspection.attemptId);
    current.status = statuses[selected?.status ?? inspection.status] ?? "incomplete";
    current.error = failure.reason;
  }
  return turns;
}
