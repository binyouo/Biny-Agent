import type { SessionEvent } from "../../../session/recorder.js";
import type { TimelineTool, TimelineTurn } from "./sessionTimeline.js";

type SkillLoadCall = Pick<TimelineTool, "tool" | "args" | "result" | "status" | "executionStatus">;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function loadedSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))];
}

const skillFooter = "Follow the instructions above for your response. Remember to use absolute paths when accessing files in the skill directory.";

function canonicalName(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) ? value : undefined;
}

/** Accept only the real host's primitive-result wrappers, never arbitrary nested content. */
function skillBody(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const result = record(value);
  if (!result || !Object.keys(result).every(key => ["result", "durationMs", "hooks"].includes(key))) return undefined;
  if (result.durationMs !== undefined && (typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs))) return undefined;
  if (result.hooks !== undefined && !Array.isArray(result.hooks)) return undefined;
  if (result.durationMs === undefined && !Array.isArray(result.hooks)) return undefined;
  return typeof result.result === "string" ? result.result : undefined;
}

function canonicalBodyName(body: string | undefined): string | undefined {
  if (!body?.trimEnd().endsWith(skillFooter)) return undefined;
  const match = /^# Skill: ([^\r\n]+)\r?\n\r?\n\*\*Skill Directory:\*\* `[^`\r\n]+`/u.exec(body);
  return canonicalName(match?.[1]);
}

function legacyArchivedSkill(result: Record<string, unknown>): string | undefined {
  if (result.archived !== true || typeof result.resultBytes !== "number" || !Number.isFinite(result.resultBytes) || result.resultBytes <= 0) return undefined;
  if (typeof result.archiveError === "string") return canonicalBodyName(skillBody(result.result));
  if (typeof result.archivePath !== "string" || !/^\.biny\/tool-results\/tool-result-[0-9a-f]{64}\.json$/u.test(result.archivePath) || typeof result.preview !== "string") return undefined;
  const rawName = canonicalBodyName(result.preview);
  if (rawName) return rawName;
  // The old host serialized its summary wrapper before retaining head/tail. Only decode that exact wrapper.
  if (!result.preview.startsWith('{"result":"# Skill: ')) return undefined;
  try {
    const restored = JSON.parse(result.preview.replace(/\n… \[\d+ bytes omitted\] …\n/u, "")) as unknown;
    return canonicalBodyName(skillBody(restored));
  } catch {
    // A truncation through a JSON escape cannot be proven; do not invent a loaded skill.
    return undefined;
  }
}

/** Only completed body reads count; availability, selections and generic file paths are not evidence. */
export function confirmedLoadedSkill(call: SkillLoadCall): string | undefined {
  if (call.status !== "success" || call.executionStatus !== undefined && call.executionStatus !== "succeeded") return undefined;
  if (call.tool !== "Skill" && call.tool !== "skill_call" && call.tool !== "read_skill_resource") return undefined;
  const result = record(call.result);
  if (result && (typeof result.error === "string" || ["failed", "denied", "aborted", "cancelled", "skipped", "unknown", "blocked_by_hook", "timed_out"].includes(String(result.status)))) return undefined;
  const marker = canonicalName(result?.loadedSkill);
  if (call.executionStatus === "succeeded" && marker && (result?.archived === true
    || call.tool === "read_skill_resource" && result?.skill === marker && typeof result.content === "string" && Boolean(result.content.trim()))) return marker;
  if (call.tool === "read_skill_resource") return undefined;
  if (call.executionStatus === "succeeded" && result?.archived === true) return legacyArchivedSkill(result);
  const body = skillBody(call.result);
  if (!body?.trim()) return undefined;
  if (call.executionStatus === "succeeded") {
    const requested = record(call.args)?.skill;
    return canonicalBodyName(body) ?? (typeof requested === "string" ? requested.trim() || undefined : undefined);
  }
  // Older records lack executionStatus. Recognize the actual Skill template, not arbitrary error strings.
  return canonicalBodyName(body);
}

interface SkillMetadataEvidence { runId?: string; names: string[] }

/** Project only loaded-skill facts by answer run; leave general metadata and tool history untouched. */
export function scopeHistoricalLoadedSkills(events: readonly SessionEvent[], turns: TimelineTurn[]): TimelineTurn[] {
  const users = new Set(turns.flatMap(turn => turn.userMessageId ? [turn.userMessageId] : []));
  const userRuns = new Map<string, string>();
  const seenUsers = new Set<string>();
  const answerRuns = new Map<string, string>();
  const versions = new Map<string, Set<string>>();
  const metadata = new Map<string, SkillMetadataEvidence[]>();
  const addMetadata = (messageId: string, runId: string | undefined, value: unknown): void => {
    if (!Array.isArray(value)) return;
    const entries = metadata.get(messageId) ?? [];
    entries.push({ runId, names: loadedSkillNames(value) });
    metadata.set(messageId, entries);
  };
  for (const event of events) {
    if (event.type === "user_message" && !event.auditOnly && event.messageId && users.has(event.messageId)) {
      if (seenUsers.has(event.messageId)) continue;
      seenUsers.add(event.messageId);
      if (event.runtime?.runId) userRuns.set(event.messageId, event.runtime.runId);
      addMetadata(event.messageId, event.runtime?.runId, event.metadata?.loadedSkills);
    } else if (event.type === "message_metadata" && seenUsers.has(event.messageId)) {
      addMetadata(event.messageId, event.runtime?.runId, event.metadata.loadedSkills);
    } else if ((event.type === "assistant_message" && !event.auditOnly || event.type === "agent_message" && event.message.role === "assistant") && event.messageId) {
      if (event.runtime?.runId) answerRuns.set(event.messageId, event.runtime.runId);
      // An assistant tool-call step is not another answer version. Its parent can also be the user.
      if (event.type === "agent_message" && event.message.content.some(part => part.type === "toolCall")) continue;
      const userId = [event.replyToMessageId, event.slotId, event.parentMessageId].find(id => id !== undefined && users.has(id));
      if (userId) {
        const ids = versions.get(userId) ?? new Set<string>();
        ids.add(event.messageId);
        versions.set(userId, ids);
      }
    }
  }
  return turns.map(turn => {
    if (!turn.userMessageId) return turn;
    const evidence = metadata.get(turn.userMessageId) ?? [];
    const runs = new Set(evidence.flatMap(item => item.runId ? [item.runId] : []));
    for (const tool of turn.tools) if (tool.runId) runs.add(tool.runId);
    const userRun = userRuns.get(turn.userMessageId);
    if (userRun) runs.add(userRun);
    const selectedRun = turn.assistantMessageId ? answerRuns.get(turn.assistantMessageId) : undefined;
    if (selectedRun) runs.add(selectedRun);
    for (const answer of versions.get(turn.userMessageId) ?? []) {
      const answerRun = answerRuns.get(answer);
      if (answerRun) runs.add(answerRun);
    }
    const ambiguous = runs.size > 1 || (versions.get(turn.userMessageId)?.size ?? 0) > 1;
    const runId = selectedRun ?? (!ambiguous && runs.size === 1 ? [...runs][0] : undefined);
    const belongs = (sourceRun: string | undefined): boolean => sourceRun !== undefined
      ? runId !== undefined && sourceRun === runId
      : !ambiguous;
    const names = evidence.filter(item => belongs(item.runId)).flatMap(item => item.names);
    for (const tool of turn.tools) {
      if (!belongs(tool.runId)) continue;
      const name = confirmedLoadedSkill(tool);
      if (name) names.push(name);
    }
    return { ...turn, skills: [...new Set(names)] };
  });
}
