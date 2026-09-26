/** 把可追溯的 Activity 报告骨架改写为第一人称日志，失败时保留骨架。 */
import type { AgentModel } from "../agent/core/types.js";
import { generateNativeText, nativeJsonMessages } from "../llm/nativeJson.js";
import { persistActivityReport, type ActivityReportResult } from "./analyzer.js";
import type { ActivityStore } from "./store.js";

export interface ActivityReportNarrativeOptions {
  model?: AgentModel;
  skeleton?: boolean;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  store?: ActivityStore;
}

const prompt = [
  "Write the user's first-person work journal from the supplied activity skeleton.",
  "Use the same language and keep one # title, ## theme headings, and artifact bullets.",
  "Every action, result, PR, person, version, link, identifier, and decision must be supported by the skeleton.",
  "A screen observation is not proof that work shipped or a decision was made. State uncertainty plainly.",
  "Do not add greetings, metadata, or invented connective facts. Preserve all Markdown links and code spans.",
  "Keep minor or vague activity short."
].join("\n");

export async function narrateActivityReport(
  report: ActivityReportResult,
  options: ActivityReportNarrativeOptions = {}
): Promise<ActivityReportResult> {
  await options.checkpoint?.();
  options.signal?.throwIfAborted();
  if (report.cached || options.skeleton || !options.model || report.sessionCount === 0) return report;
  const fallback = { ...report, narrativeModel: options.model.modelId };
  try {
    const generated = await generateNativeText(
      options.model,
      nativeJsonMessages(prompt, report.markdown),
      { signal: options.signal, maxOutputTokens: 2_400, reasoning: "off" }
    );
    await options.checkpoint?.();
    options.signal?.throwIfAborted();
    const markdown = generated.text.trim();
    if (!validNarrative(markdown, report.markdown)) return fallback;
    const narrated = { ...report, markdown, narrativeModel: options.model.modelId };
    if (options.store) persistActivityReport(options.store, narrated);
    return narrated;
  } catch {
    await options.checkpoint?.();
    options.signal?.throwIfAborted();
    return fallback;
  }
}

function validNarrative(output: string, skeleton: string): boolean {
  if (output.length <= 80 || output.length > 20_000 || !/^# [^\n]+/u.test(output) || !/^## [^\n]+/mu.test(output)) return false;
  for (const pattern of [/\bPR\s*#\d+\b/giu, /\bv\d+(?:\.\d+)+\b/giu, /https?:\/\/[^\s)]+/giu]) {
    const supported = new Set(skeleton.match(pattern) ?? []);
    if ((output.match(pattern) ?? []).some((value) => !supported.has(value))) return false;
  }
  for (const link of skeleton.match(/\[[^\]]+\]\([^)]+\)/gu) ?? []) {
    if (!output.includes(link)) return false;
  }
  return true;
}
