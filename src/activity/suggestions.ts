/**
 * Activity 新对话建议。
 *
 * 建议只从最近三天的已分析 session 生成，输入是分析层的项目、标题、描述和部分主题、亮点，
 * 不把截图/OCR 原文直接送给模型，统一使用配置选出的工具模型。
 */
import type { AgentModel } from "../agent/core/types.js";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../llm/nativeJson.js";
import type { ActivityStore } from "./store.js";
import { ACTIVITY_ANALYSIS_FAILED_SUMMARY, ACTIVITY_TRIVIAL_SUMMARY } from "./analyzer.js";

const SUGGESTION_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1_000;
const SUGGESTION_SESSION_LIMIT = 12;
const SUGGESTION_CACHE_TTL_MS = 10 * 60 * 1_000;

export interface ActivitySuggestionCache {
  get(key: string): string[] | undefined;
  set(key: string, suggestions: string[]): void;
}

export interface ActivitySuggestionsDeps {
  store: ActivityStore;
  model?: AgentModel;
  now?: Date;
  force?: boolean;
  cache?: ActivitySuggestionCache;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
}

export interface ActivitySuggestionsResult {
  suggestions: string[];
  model?: string;
  cached: boolean;
  reason?: "no_model" | "no_activity" | "generation_failed";
}

export function createInMemoryActivitySuggestionCache(ttlMs = SUGGESTION_CACHE_TTL_MS): ActivitySuggestionCache {
  const entries = new Map<string, { at: number; suggestions: string[] }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return [...entry.suggestions];
    },
    set(key, suggestions) {
      entries.set(key, { at: Date.now(), suggestions: [...suggestions] });
    }
  };
}

const defaultSuggestionCache = createInMemoryActivitySuggestionCache();

export async function generateActivitySuggestions(
  deps: ActivitySuggestionsDeps
): Promise<ActivitySuggestionsResult> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  const model = deps.model;
  if (!model) return { suggestions: [], cached: false, reason: "no_model" };
  const now = deps.now ?? new Date();
  const sinceIso = new Date(now.getTime() - SUGGESTION_LOOKBACK_MS).toISOString();
  const sessions = deps.store.listSessionsWithAnalysis({ sinceIso, analysisStatus: "analyzed", startedAtOnly: true, limit: 30 })
    .slice(0, SUGGESTION_SESSION_LIMIT)
    .filter((session) => session.analysis !== undefined)
    .filter((session) => {
      const summary = session.analysis?.summary.trim();
      return summary !== ACTIVITY_TRIVIAL_SUMMARY && summary !== ACTIVITY_ANALYSIS_FAILED_SUMMARY;
    })
    .filter((session) => Boolean(session.analysis?.title?.trim() || session.analysis?.description?.trim()))
    .slice(0, 10);
  if (sessions.length === 0) return { suggestions: [], cached: false, reason: "no_activity" };

  const cache = deps.cache ?? defaultSuggestionCache;
  const cacheKey = [
    model.provider,
    model.modelId,
    model.runtime ?? "",
    model.dataResidency ?? "",
    deps.store.activityRevision()
  ].join("\u0000");
  if (!deps.force) {
    const cached = cache.get(cacheKey);
    if (cached) return { suggestions: cached, model: model.modelId, cached: true };
  }

  const prompt = buildSuggestionPrompt(sessions);
  try {
    const result = await generateNativeText(
      model,
      nativeJsonMessages(
        "You turn recent, analyzed computing activity into grounded new-chat suggestions.",
        prompt
      ),
      { maxOutputTokens: 500, reasoning: "off", signal: deps.signal }
    );
    const suggestions = parseSuggestions(result.text);
    await deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    cache.set(cacheKey, suggestions);
    return { suggestions, model: model.modelId, cached: false };
  } catch {
    await deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    return { suggestions: [], cached: false, reason: "generation_failed" };
  }
}

function buildSuggestionPrompt(
  sessions: ReturnType<ActivityStore["listSessionsWithAnalysis"]>
): string {
  const lines = [
    "Generate 4 or 5 short, actionable suggestions for a new chat.",
    "Write each suggestion as a first-person request the user could send next, using the same language as the activity.",
    "Ground every suggestion in the activity below: use real project names, files, PRs, or topics when present.",
    "Cover distinct useful next steps rather than paraphrasing the same request.",
    "Do not invent facts, do not mention that you are reading activity, and do not give generic productivity advice.",
    "Return ONLY a JSON array of 4 or 5 strings, each under 60 characters. Return [] if the activity lacks enough concrete context.",
    "Recent activity (most recent first):"
  ];
  for (const session of sessions) {
    const analysis = session.analysis;
    if (!analysis) continue;
    const project = analysis.project ? `[${analysis.project}]` : "";
    const topics = analysis.topics.length ? ` (${analysis.topics.slice(0, 4).join(", ")})` : "";
    const highlights = analysis.highlights.length ? ` — ${analysis.highlights.slice(0, 2).join("; ")}` : "";
    const description = analysis.description?.trim() ? `\n  ${analysis.description.trim().slice(0, 240)}` : "";
    lines.push(`- ${project} ${analysis.title?.trim() ?? ""}${topics}${highlights}${description}`.trim());
  }
  return lines.join("\n");
}

function parseSuggestions(text: string): string[] {
  const parsed = parseNativeJson(text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 120)
    .slice(0, 5);
}
