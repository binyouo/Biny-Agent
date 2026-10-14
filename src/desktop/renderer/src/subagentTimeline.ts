import type { TaskInspection, WorkerActivity } from "../../../runtime/TaskCommunication.js";
import { publicAssistantMessage } from "../../../session/publicMessage.js";
import { createSessionTimelineProjector, type TimelineActivityEvent, type TimelineRunStatus, type TimelineTurn } from "./sessionTimeline.js";
import { subagentFailurePresentation } from "./subagentPresentation.js";

const statuses: Record<string, TimelineRunStatus> = { created: "running", queued: "running", running: "running", verifying: "running", needs_approval: "blocked", blocked: "blocked", completed: "completed", failed: "failed", incomplete: "incomplete", aborted: "aborted", cancelled: "cancelled", policy_denied: "blocked", budget_exhausted: "incomplete" };

export function createSubagentTimelineProjector(): { update(inspection: TaskInspection, activity: WorkerActivity[], recordedOutput?: string): TimelineTurn[] } {
  let identity: string | undefined;
  let processed = 0;
  let tail: WorkerActivity | undefined;
  let projector = createSessionTimelineProjector();
  let hasAssistant = false;
  let published: TimelineTurn[] = [];
  let publishedBase: TimelineTurn | undefined;
  let publishedOutput: string | undefined;
  return {
    update(inspection, activity, recordedOutput) {
      const nextIdentity = JSON.stringify([inspection.sessionId, inspection.taskRunId, inspection.attemptId, inspection.title, inspection.createdAt]);
      const events: TimelineActivityEvent[] = [];
      if (identity !== nextIdentity || activity.length < processed || activity[processed - 1] !== tail) {
        identity = nextIdentity;
        processed = 0;
        tail = undefined;
        hasAssistant = false;
        projector = createSessionTimelineProjector();
        events.push({ type: "user_message", content: inspection.title, time: inspection.createdAt });
      }
      for (let index = processed; index < activity.length; index += 1) {
        const entry = activity[index]!;
        const time = entry.createdAt;
        if (entry.kind === "tool_call" && entry.tool) events.push({ type: "tool_call", tool: entry.tool, toolCallId: entry.toolCallId ?? entry.id, args: entry.args, time });
        if (entry.kind === "tool_result" && entry.tool) events.push({ type: "tool_result", tool: entry.tool, toolCallId: entry.toolCallId, result: entry.result,
          executionStatus: entry.status === "succeeded" || entry.status === "failed" || entry.status === "cancelled" || entry.status === "unknown" ? entry.status : undefined, time });
        if (entry.kind === "assistant") {
          hasAssistant = true;
          if (entry.content) events.push({ type: "assistant_message", content: entry.content, time });
        }
        if (entry.kind === "reasoning" && entry.content) events.push({ type: "assistant_message", content: "", reasoningContent: entry.content, time });
      }
      processed = activity.length;
      tail = activity.at(-1);
      const base = projector.appendHistory(events).at(-1);
      const failure = subagentFailurePresentation(inspection.reason);
      const selected = inspection.attempts.find(attempt => attempt.attemptId === inspection.attemptId);
      const status = statuses[selected?.status ?? inspection.status] ?? "incomplete";
      const output = !inspection.hasMore && !hasAssistant ? publicAssistantMessage((inspection.output ?? recordedOutput ?? failure.output ?? "").slice(0, 16000)).trimEnd() : "";
      if (base !== publishedBase || output !== publishedOutput || status !== published[0]?.status || failure.reason !== published[0]?.error) {
        published = base ? [{ ...base, status, error: failure.reason,
          assistant: output || base.assistant,
          steps: output ? [...base.steps, { kind: "assistant", id: `${base.id}:output`, content: output }] : base.steps }] : [];
        publishedBase = base;
        publishedOutput = output;
      }
      return published;
    }
  };
}
