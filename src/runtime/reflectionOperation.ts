import { readDailyMemoryNote, readDailyMemorySection } from "../activity/dailyNotes.js";
import { hasReflectionDate, markReflectionDate, readReflectionDiary, reflectionDiaryPath } from "../agent/context/reflectionDates.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import type { InteractiveRuntimeHandle, RuntimeRequestIds, SubmittedAgentRun } from "./InteractiveAgentRuntime.js";

export interface ReflectionResult { dateKey: string; path: string; written: boolean; reason?: string; runId?: string; }

export async function runReflection(
  runtime: InteractiveRuntimeHandle,
  commands: CommandRuntime,
  dateKey: string,
  force: boolean,
  requestIds: RuntimeRequestIds,
  beforeSubmit: () => Promise<void>,
  trackCompletion: (submitted: SubmittedAgentRun) => void
): Promise<ReflectionResult | { completion: Promise<ReflectionResult> }> {
  const diaryPath = reflectionDiaryPath(dateKey);
  const existing = await readReflectionDiary(dateKey);
  const legacy = readDailyMemorySection(await readDailyMemoryNote(dateKey) ?? "", "自我反思");
  if (!force && (existing || legacy || await hasReflectionDate(dateKey))) {
    return { dateKey, path: diaryPath, written: false, reason: "up_to_date" };
  }
  await beforeSubmit();
  const submitted = runtime.submitPrompt(
    `Use the self-reflection skill to write your diary for ${dateKey}. Read the day's conversations and your emotions yourself, then write the diary with the normal tools.\n` +
    `Write the complete diary to ${diaryPath}. Keep it separate from memory/${dateKey}.md, which contains daily notes and activity records.\n` +
    `${force ? "Rewrite the existing reflection for this date." : "If this date already has a diary, do not duplicate it."}\n` +
    `Complete this in the current turn; do not call biny reflection run or biny diary refresh.`,
    [], requestIds, undefined,
    { tools: commands.config.chat.defaultToolSelection, skills: ["self-reflection"] }
  );
  trackCompletion(submitted);
  return { completion: submitted.completion.then(async outcome => {
    if (outcome.status !== "completed") throw new Error(outcome.error ?? "Self-reflection did not complete.");
    const reflection = await readReflectionDiary(dateKey);
    if (reflection && reflection !== existing) await markReflectionDate(dateKey);
    return { dateKey, path: diaryPath, runId: submitted.runId, written: Boolean(reflection) && reflection !== existing };
  }) };
}
