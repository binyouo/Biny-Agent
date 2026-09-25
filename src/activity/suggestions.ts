/**
 * Activity 新对话建议。
 *
 * 建议只从最近三天的已分析 session 生成，输入是分析层的项目、标题、摘要和主题，
 * 不把截图/OCR 原文直接送给模型，统一使用配置选出的工具模型。
 */
import { z } from "zod";
import type { AgentModel } from "../agent/core/types.js";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../llm/nativeJson.js";
import type { ActivityStore } from "./store.js";
import { ACTIVITY_ANALYSIS_FAILED_SUMMARY, ACTIVITY_TRIVIAL_SUMMARY } from "./analyzer.js";

const SUGGESTION_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1_000;
const SUGGESTION_SESSION_LIMIT = 12;
const SUGGESTION_CACHE_TTL_MS = 10 * 60 * 1_000;
const suggestionArraySchema = z.array(z.string().trim().min(1).max(60)).min(4).max(5);

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
  const sessions = deps.store.listRecentSessionsWithAnalysis(sinceIso, 100)
    .filter((session) => session.analysis !== undefined)
    .filter((session) => {
      const summary = session.analysis?.summary.trim();
      return summary !== ACTIVITY_TRIVIAL_SUMMARY && summary !== ACTIVITY_ANALYSIS_FAILED_SUMMARY;
    })
    .slice(0, SUGGESTION_SESSION_LIMIT);
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

  const prompt = buildSuggestionPrompt(sessions, now);
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
    if (!suggestions.length) return { suggestions: [], cached: false, reason: "generation_failed" };
    cache.set(cacheKey, suggestions);
    return { suggestions, model: model.modelId, cached: false };
  } catch {
    await deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    return { suggestions: [], cached: false, reason: "generation_failed" };
  }
}

function buildSuggestionPrompt(
  sessions: ReturnType<ActivityStore["listRecentSessionsWithAnalysis"]>,
  now: Date
): string {
  const lines = [
    "Generate 4 or 5 short, actionable suggestions for a new chat.",
    "Write each suggestion as a first-person request the user could send next, using the same language as the activity.",
    "Ground every suggestion in the activity below: use real project names, files, PRs, topics, or decisions when present.",
    "Cover distinct useful next steps rather than paraphrasing the same request.",
    "Do not invent facts, do not mention that you are reading activity, and do not give generic productivity advice.",
    "Return ONLY a JSON array of 4 or 5 strings, each under 60 characters. Return [] if the activity lacks enough concrete context.",
    `Current date: ${now.toISOString().slice(0, 10)}`,
    "Analyzed activity:"
  ];
  for (const session of sessions) {
    const analysis = session.analysis;
    if (!analysis) continue;
    const details = [
      `date=${session.startedAt.slice(0, 10)}`,
      analysis.project ? `project=${analysis.project}` : undefined,
      analysis.title ? `title=${analysis.title}` : undefined,
      `summary=${analysis.summary}`,
      analysis.description ? `description=${analysis.description}` : undefined,
      analysis.topics.length ? `topics=${analysis.topics.join(", ")}` : undefined,
      analysis.highlights.length ? `highlights=${analysis.highlights.join("; ")}` : undefined,
      analysis.decisions.length ? `decisions=${analysis.decisions.join("; ")}` : undefined,
      analysis.repos?.length ? `repos=${analysis.repos.join(", ")}` : undefined,
      analysis.identifiers?.length ? `identifiers=${analysis.identifiers.join(", ")}` : undefined
    ].filter((value): value is string => value !== undefined);
    lines.push(`- ${details.join(" | ")}`);
  }
  return lines.join("\n");
}

function parseSuggestions(text: string): string[] {
  const parsed = suggestionArraySchema.parse(parseNativeJson(text));
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const value of parsed) {
    const normalized = value.replace(/\s+/gu, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push(normalized);
    if (suggestions.length === 5) break;
  }
  return suggestions.length >= 4 ? suggestions : [];
}
