/** 活动分析候选转换为记忆条目；写入由调用方负责。 */
import type { MemoryEntryInput } from "../agent/context/memoryTypes.js";
import type { ActivityMemoryCandidate, ActivityMemoryWriteContext } from "./analyzer.js";

export function activityMemoryInput(candidate: ActivityMemoryCandidate, context: ActivityMemoryWriteContext): MemoryEntryInput {
  const project = context.project?.trim();
  const tags = project ? [candidate.type, `project:${project}`] : [candidate.type];
  return {
    content: candidate.content,
    source: "auto",
    activitySource: "activity_session",
    activitySessionId: context.sessionId,
    tags,
    rationale: candidate.why.trim() || undefined,
    importance: candidate.type === "feedback" || candidate.type === "user" ? 0.8 : 0.7,
    durability: "permanent"
  };
}
