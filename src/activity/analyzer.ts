/**
 * Activity 分析层：把单个已结束 session 的脱敏事件与 OCR 投影归纳成结构化 SessionAnalysis 落库，
 * 并把指定日期的分析结果聚合成可追溯的工作日记骨架。
 *
 * 模型输入边界：
 * - 送给分析模型的只有 store.listSessionEventSummaries 提供的时间、应用、事件摘要和已脱敏
 *   OCR。它们在写入 SQLite 前已经过了 redactActivityText；原始截图和 snapshot 路径从查询层
 *   就不在这条链路上。选到云工具模型时，脱敏文字会发送给对应 Provider。
 * - 只有同时满足“时长小于 30 秒、事件少于 20 条、截图少于 3 张”的 session 才直接落一条低
 *   置信度占位记录；短 session 中有足够事件或截图时仍允许分析。
 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AgentModel } from "../agent/core/types.js";
import { generateNativeText, nativeJsonMessages } from "../llm/nativeJson.js";
import type {
  ActivityAnalysisCommit,
  ActivityAnalysisReference,
  ActivityAnalysisEntityDetails,
  ActivityAnalysisReportRow,
  ActivityEventSummary,
  ActivityPendingAnalysisSession,
  ActivitySessionAnalysis,
  ActivityStore
} from "./store.js";

/** 零星 session 判定：三个条件同时成立才跳过模型。 */
export const ACTIVITY_ANALYSIS_MIN_SESSION_DURATION_MS = 30_000;
export const ACTIVITY_ANALYSIS_MIN_EVENTS = 20;
export const ACTIVITY_ANALYSIS_MIN_SNAPSHOTS = 3;
/** 单个 session 放进分析 prompt 的 OCR 字符预算。 */
export const ACTIVITY_ANALYSIS_MAX_OCR_CHARS = 18_000;
/** 单个 session 放进分析 prompt 的事件上限。 */
export const ACTIVITY_ANALYSIS_MAX_EVENTS_IN_PROMPT = 80;
/** 心跳/零星 session 的占位摘要；报告渲染会把这类占位过滤掉。 */
export const ACTIVITY_TRIVIAL_SUMMARY = "零星活动";
/** 模型两次输出都无法解析时落库的占位摘要；同样不进报告。 */
export const ACTIVITY_ANALYSIS_FAILED_SUMMARY = "活动分析失败";

const KNOWN_PROJECT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_PROJECT_LIMIT = 20;
/** 进入 inputHash 的 prompt/解析版本；改动它会让已分析 session 因 hash 变化而重跑。 */
const ACTIVITY_ANALYSIS_VERSION = "activity-session-analysis/v4";

const analysisReferenceSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  ref: z.string().trim().min(1).max(160).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  number: z.number().int().positive().optional(),
  url: z.string().trim().min(1).max(500).optional(),
  title: z.string().trim().min(1).max(300).optional()
});

const analysisCommitSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  ref: z.string().trim().min(1).max(160).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  hash: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(500).optional(),
  url: z.string().trim().min(1).max(500).optional()
});

const analysisPersonSchema = z.union([
  z.string().trim().min(1).max(120),
  z.object({
    handle: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(160).optional()
  })
]);

const memoryCandidateSchema = z.object({
  type: z.enum(["project", "feedback", "reference", "user"]),
  content: z.string().trim().min(1).max(240),
  why: z.string().trim().max(200).default("")
});

const analysisEntityDetailsSchema = z.object({
  prs: z.array(analysisReferenceSchema).max(32).default([]),
  issues: z.array(analysisReferenceSchema).max(32).default([]),
  commits: z.array(analysisCommitSchema).max(64).default([]),
  people: z.array(analysisPersonSchema).max(32).default([]),
  identifiers: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
  repos: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  versions: z.array(z.string().trim().min(1).max(60)).max(32).default([]),
  events: z.array(z.string().trim().min(1).max(300)).max(32).default([]),
  decisions: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  urls: z.array(z.string().trim().min(1).max(500)).max(64).default([])
});

/** 模型输出的结构契约；解析前先做宽松归一化，避免格式噪声把有效 session 丢回未知状态。 */
const analysisOutputSchema = z.object({
  project: z.string().trim().min(1).max(120).nullish(),
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().min(1).max(800).optional(),
  summary: z.string().trim().min(1).max(1_000).optional(),
  topics: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
  prs: z.array(analysisReferenceSchema).max(32).default([]),
  issues: z.array(analysisReferenceSchema).max(32).default([]),
  people: z.array(analysisPersonSchema).max(32).default([]),
  versions: z.array(z.string().trim().min(1).max(60)).max(32).default([]),
  decisions: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  // 使用分组对象；旧版本 Biny 曾使用 string[]，两种形态都接受并在落库前归一化。
  entities: z.union([
    z.array(z.string().trim().min(1).max(200)).max(64),
    analysisEntityDetailsSchema
  ]).default([]),
  highlights: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
  commits: z.array(analysisCommitSchema).max(64).default([]),
  identifiers: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
  repos: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  events: z.array(z.string().trim().min(1).max(300)).max(32).default([]),
  urls: z.array(z.string().trim().min(1).max(500)).max(64).default([]),
  memoryCandidates: z.array(memoryCandidateSchema).max(16).default([]),
  worth: z.boolean().default(false),
  worthMemory: z.boolean().default(false),
  worthKnowledge: z.boolean().default(false),
  isMeeting: z.boolean().default(false),
  storageTier: z.enum(["ephemeral", "standard", "important"]).default("standard"),
  confidence: z.number().min(0).max(1).default(0)
});

type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

export type ActivityAnalysisOutcome =
  | { status: "analyzed"; analysis: ActivitySessionAnalysis; cached: boolean }
  | { status: "trivial"; analysis: ActivitySessionAnalysis }
  | { status: "skipped"; reason: "session_not_ended" | "no_model" }
  | { status: "error"; error: string };

export interface ActivityMemoryCandidate {
  type: "project" | "feedback" | "reference" | "user";
  content: string;
  why: string;
}

export interface ActivityMemoryWriteContext {
  sessionId: string;
  analyzedAt: string;
  project?: string;
  /** Activity 分析和记忆写入共用同一个模型实例，避免模型漂移和重复创建。 */
  model: AgentModel;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
}

export interface ActivityAnalyzerDeps {
  store: ActivityStore;
  /**
   * 分析所用模型。省略时需要模型的 session 标记为 skipped，不生成伪分析内容；
   * 配置工具模型后可显式重分析。
   */
  model?: AgentModel;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  /** 可注入时钟，便于测试固定 analyzedAt 与「今天」。 */
  now?: () => Date;
  /** false 时只消费已落库的分析行；用于每日摘要，避免在日结阶段临时调用模型。 */
  analyzePending?: boolean;
  /** 分析完成后把模型挑出的稳定事实写入统一记忆库；失败不能影响 Activity 分析结果。 */
  writeMemories?: (
    candidates: readonly ActivityMemoryCandidate[],
    context: ActivityMemoryWriteContext
  ) => Promise<void>;
  /** 分析完成后的统一主题投影；重复调用必须由下游锚点去重。 */
  onAnalyzed?: (analysis: ActivitySessionAnalysis, session: ActivityPendingAnalysisSession, signal?: AbortSignal) => Promise<void>;
}

export interface ActivitySweepResult {
  evaluated: number;
  analyzed: number;
  trivial: number;
  blocked: number;
  errors: number;
}

export interface ActivityReportRange {
  startIso: string;
  endIso: string;
  label: string;
}

export interface ActivityReportResult {
  date: string;
  startIso: string;
  endIso: string;
  markdown: string;
  /** 有模型叙事时记录来源；缺失表示确定性的结构化骨架。 */
  narrativeModel?: string;
  /** 范围内可入报告的分析行数（已过滤零星/失败占位）。 */
  sessionCount: number;
  /** 本次调用新分析（含零星占位）的 session 数。 */
  analyzedNow: number;
  /** 范围内仍需模型但本次未分析的 session 数。 */
  pendingModel: number;
  /** 是否有 session 因未请求补分析或无模型而未分析。 */
  blocked: boolean;
  /** blocked 时携带的原因说明。 */
  message?: string;
}

const ANALYSIS_SYSTEM_PROMPT = String.raw`
You analyze one session of a user's on-screen activity and extract rich, citable structure for a later work-journal generator.

Respond ONLY with a single JSON object — no prose, no markdown fence, no commentary.

Schema:
{
  "worth": boolean,
  "title": string,                     // <=80 chars, concrete, names things ("Review PR #282 screen-capture service")
  "description": string,               // 2-4 sentences; WHAT got done and WHY; avoid filler like "browsed", "looked at"
  "project": string | null,            // canonical project/codebase/workspace this belongs to (e.g. "example-app", "tokenspeed", "littlebird"). null if unclear/mixed.
  "topics": string[],                  // 1-5 short tags for clustering ("grpc", "activity-recorder", "onboarding-flow")
  "highlights": string[],              // 1-3 ultra-short bullets of accomplishments/decisions ("Shipped PR #282 activity recorder", "Decided to self-host grpc proto"). Empty if nothing concrete.
  "entities": {
    "prs":         [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],  // e.g. {"label":"PR #282","ref":"282","repo":"example-org/example-repo","url":"https://..."}
    "issues":      [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],
    "commits":     [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],
    "people":      [{"handle": string, "name"?: string}], // people other than the user themselves. Include @mentions from Slack/GitHub/Twitter.
    "identifiers": string[],           // file names, function names, type names, proto names, config keys, CLI subcommands worth quoting verbatim
    "repos":       string[],           // "org/repo" slugs
    "versions":    string[],           // "v0.0.760", "1.24.1"
    "events":      string[],           // meeting/event names ("refactor standup")
    "decisions":   string[],           // short phrases describing decisions reached
    "urls":        string[]            // full URLs visible in this session (browser or OCR)
  },
  "memoryCandidates": [                // ZERO OR MORE durable facts worth long-term recall. Default is []. See rules below.
    {
      "type": "project" | "feedback" | "reference" | "user",
      "content": string,               // ONE clean, self-contained fact (<= 200 chars). See "content style" rules. This is stored verbatim and shown to the user — make it elegant.
      "why": string                    // <= 160 chars. INTERNAL gate only — never stored in the fact. Justify why this survives 6+ months. If you cannot, set content to "" and drop it.
    }
  ],
  "worthKnowledge": boolean,           // reusable knowledge (docs, APIs, code techniques)
  "isMeeting": boolean                 // true if this session was a sync meeting (Zoom/Meet/Teams/Feishu call)
}

Rules:
- "worth" must be false for idle scrolling, random browsing, system idle, transient app switches, or empty OCR.
- Be specific. Prefer "Merged PR #282 (activity-recorder service) into main" over "Worked on a project".
- Every entity you list MUST appear verbatim in the OCR/events/visits. Never invent a PR number, person, version, or URL.
- Identifiers: only things a technical reader would recognize as named code/config (e.g. "spec_verify_ct", "tokenspeed-grpc-proto"). Skip common English words.
- If you can't attribute a project, set "project" to null. Do not guess.
- Return arrays even when empty — never omit keys in "entities".

memoryCandidates rules (CRITICAL — the bar is HIGH; the great majority of sessions must produce []):
- Default is the empty array. Emitting [] is the correct, expected outcome for normal work sessions. Only emit a candidate when a fact would still earn its place in a hand-curated memory list 6+ months from now, WITHOUT replaying the timeline.
- Each candidate is ONE durable fact / preference / decision / reference — never a recap of what happened this session.
- The "why" field is your INTERNAL precision gate. Write it first, honestly. If the strongest "why" you can muster is "it happened" or "might be useful", that is a fail → drop the candidate (do not emit it). The "why" is NOT stored anywhere; it only forces you to justify durability.
- Types:
  - "project"   = a standing fact/decision/constraint about ongoing work. (e.g. "The project defaults to disabling MCPHub because auto-loaded MCP servers confused users.")
  - "feedback"  = the user's stated, reusable preference about how they work or want to be helped. (e.g. "User prefers Linode over Hetzner for EU regions due to past billing reliability.")
  - "reference" = a pointer to an external system/dashboard/doc the user returns to repeatedly. (e.g. "Zeabur billing dashboard (zeabur.com/billing) is where saved cards and invoice history live.")
  - "user"      = stable info about the user's role/expertise/responsibilities.

CONTENT STYLE (this is stored verbatim and shown to the user — it must read as a clean, elegant knowledge-base entry):
- Write it as a STANDALONE third-person fact about the world/project/user. Not a diary entry, not a task, not a sentence about "this session".
- NO narration verbs about the user's clicks: never start with or contain "User browsed / checked / looked at / opened / reviewed / triaged / investigated / spent time on".
- NO timeline or session framing: no timestamps, durations, "today", "this session", "while working", "was seen".
- NO first person ("I", "we"). Present tense. Name concrete things (projects, services, URLs, decisions) so the fact is self-explanatory with zero context.
- Self-contained: a reader who never saw the session must fully understand it. Resolve pronouns and vague referents.
- Examples:
  - ❌ "User opened Zeabur to investigate a $6 payment failure."   ✅ "Zeabur billing dashboard (zeabur.com/billing) holds saved cards and invoice history."
  - ❌ "Spent 20 minutes reviewing PR #282."                        ✅ (usually emit [] — a single review pass is not durable)
  - ❌ "User decided to use grpc."                                  ✅ "The project self-hosts the tokenspeed grpc proto rather than pulling it from the upstream registry."
  - ❌ "Was looking at the activity-recorder code."                 ✅ (emit [] — code details are derivable from the repo)

DO NOT emit candidates for any of the following — emit [] instead:
- Timeline facts: "User browsed/checked/looked-at/triaged X". The activity log already captures this.
- One-time operational tasks: a failed payment retry, a single PR review pass, an email triage round.
- Code patterns, file paths, function names, architecture details — derivable from the code.
- Commit/PR summaries, who-changed-what — git history is authoritative.
- Debugging steps or fix recipes — the fix lives in the diff/commit message.
- Anything that would feel embarrassing, obvious, or noisy to find in a curated memory list 6 months later.

When in doubt, emit []. One clean durable fact is worth more than ten plausible ones; a noisy memory store is far worse than a sparse one.
`;

/**
 * 分析单个已结束 session。幂等：输入 hash 未变时直接返回已落库结果，不重复调用模型。
 * 除 store 读取本身的故障外不向调用方抛错；模型/网络的瞬时失败返回 error 且不落库，
 * 让 session 保持待分析，等下一个周期重试。
 */
export async function analyzeActivitySession(
  deps: ActivityAnalyzerDeps,
  sessionId: string,
  force = false
): Promise<ActivityAnalysisOutcome> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  const { store } = deps;
  const session = store.getEndedSession(sessionId);
  if (!session) return { status: "skipped", reason: "session_not_ended" };
  const events = store.listSessionEventSummaries(sessionId);
  const semanticEventCount = events.filter((event) => event.eventType !== "screenshot_ocr").length;
  const inputHash = activityAnalysisInputHash(events);
  const existing = store.getAnalysis(sessionId);
  if (!force && existing && existing.inputHash === inputHash) {
    if (existing.analysisStatus === "skipped" && existing.summary === ACTIVITY_TRIVIAL_SUMMARY) {
      return { status: "trivial", analysis: existing };
    }
    if (existing.analysisStatus === "failed") {
      return { status: "error", error: "LLM did not return parseable JSON" };
    }
    return { status: "analyzed", analysis: existing, cached: true };
  }
  const now = deps.now?.() ?? new Date();
  const analyzedAt = now.toISOString();

  if (
    session.durationMs < ACTIVITY_ANALYSIS_MIN_SESSION_DURATION_MS
    && semanticEventCount < ACTIVITY_ANALYSIS_MIN_EVENTS
    && session.snapshotCount < ACTIVITY_ANALYSIS_MIN_SNAPSHOTS
  ) {
    const analysis = buildTrivialAnalysis(session, semanticEventCount, analyzedAt, inputHash);
    store.recordAnalysis(analysis);
    return { status: "trivial", analysis };
  }
  if (!deps.model) {
    store.recordAnalysisStatus(session.id, "skipped", { description: "No tool model configured." });
    return { status: "skipped", reason: "no_model" };
  }
  const model = deps.model;
  const knownProjects = store.listRecentProjects(
    new Date(now.getTime() - KNOWN_PROJECT_LOOKBACK_MS).toISOString(),
    KNOWN_PROJECT_LIMIT
  );

  let parsed: AnalysisOutput;
  try {
    const value = await requestSessionAnalysis(
      model,
      session,
      events,
      deps.signal,
      deps.checkpoint
    );
    deps.signal?.throwIfAborted();
    if (!value) {
      store.recordAnalysisStatus(session.id, "failed", {
        model: model.modelId,
        error: "LLM did not return parseable JSON",
        analyzedAt
      });
      return { status: "error", error: "LLM did not return parseable JSON" };
    }
    parsed = value;
  } catch (error) {
    // 取消不是分析失败，保留 pending 以便恢复，不保存迟到的状态或结果。
    await deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    store.recordAnalysisStatus(session.id, "failed", {
      model: model.modelId,
      error: errorMessage(error),
      analyzedAt
    });
    return { status: "error", error: errorMessage(error) };
  }

  const entityDetails = normalizeEntityDetails(parsed);
  const genericEntities = Array.isArray(parsed.entities)
    ? parsed.entities
    : uniqueStrings([
      ...entityDetails.repos,
      ...entityDetails.identifiers,
      ...entityDetails.events,
      ...entityDetails.prs.flatMap(referenceEntityLabels),
      ...entityDetails.issues.flatMap(referenceEntityLabels),
      ...entityDetails.commits.flatMap(commitEntityLabels)
    ]);
  const summary = parsed.summary?.trim() || parsed.description?.trim() || parsed.title?.trim() || ACTIVITY_ANALYSIS_FAILED_SUMMARY;
  const memoryCandidates = parsed.memoryCandidates;
  const project = normalizeProject(parsed.project, knownProjects);
  const analysis: ActivitySessionAnalysis = {
    sessionId: session.id,
    analyzedAt,
    analyzerModel: model.modelId,
    analysisStatus: parsed.worth ? "analyzed" : "not_worth",
    project,
    title: parsed.title?.trim() || deriveTitle(summary),
    description: parsed.description?.trim() || summary,
    summary,
    topics: parsed.topics,
    prs: entityDetails.prs,
    issues: entityDetails.issues,
    people: entityDetails.people,
    versions: entityDetails.versions,
    decisions: entityDetails.decisions,
    entities: genericEntities,
    highlights: parsed.highlights,
    commits: entityDetails.commits,
    identifiers: entityDetails.identifiers,
    repos: entityDetails.repos,
    events: entityDetails.events,
    urls: entityDetails.urls,
    entityDetails,
    // 只有通过 session worth 门控的分析才允许进入长期记忆或知识标记。
    worthMemory: parsed.worth && memoryCandidates.length > 0,
    worthKnowledge: parsed.worth && parsed.worthKnowledge,
    isMeeting: parsed.isMeeting,
    storageTier: parsed.storageTier,
    confidence: parsed.confidence,
    sourceEventCount: semanticEventCount,
    inputHash
  };
  store.recordAnalysis(analysis);
  if (parsed.worth) await projectActivityAnalysis(deps, analysis, session, memoryCandidates);
  deps.signal?.throwIfAborted();
  return { status: "analyzed", analysis, cached: false };
}

/** 分析提交后直接通知消费者；写入失败记录日志，不保存重放队列。 */
async function projectActivityAnalysis(deps: ActivityAnalyzerDeps, analysis: ActivitySessionAnalysis,
  session: ActivityPendingAnalysisSession, memoryCandidates: ActivityMemoryCandidate[]): Promise<void> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  if (memoryCandidates.length && deps.writeMemories && deps.model) {
    try {
      await deps.writeMemories(memoryCandidates, {
        sessionId: session.id, analyzedAt: analysis.analyzedAt, project: analysis.project,
        model: deps.model, signal: deps.signal, checkpoint: deps.checkpoint
      });
    } catch {
      console.error("[ActivityAnalyzer] memory write failed", session.id);
    }
  }
  deps.signal?.throwIfAborted();
  if (deps.onAnalyzed) {
    try {
      await deps.onAnalyzed(analysis, session, deps.signal);
    } catch {
      console.error("[ActivityAnalyzer] Crystal write failed", session.id);
    }
  }
  deps.signal?.throwIfAborted();
}

/** 兜底 sweep：分析所有「已结束但还没分析行」的 session，按结束时间升序逐个处理。 */
export async function analyzePendingActivitySessions(
  deps: ActivityAnalyzerDeps,
  limit = 10
): Promise<ActivitySweepResult> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  deps.store.mergePendingAdjacent();
  const pending = deps.store.listSessionsPendingAnalysis(limit);
  const result: ActivitySweepResult = { evaluated: pending.length, analyzed: 0, trivial: 0, blocked: 0, errors: 0 };
  for (const session of pending) {
    deps.signal?.throwIfAborted();
    try {
      const outcome = await analyzeActivitySession(deps, session.id);
      if (outcome.status === "analyzed") result.analyzed += 1;
      else if (outcome.status === "trivial") result.trivial += 1;
      else if (outcome.status === "skipped") result.blocked += 1;
      else if (outcome.status === "error") result.errors += 1;
    } catch {
      deps.signal?.throwIfAborted();
      result.errors += 1;
    }
    // 积压会话逐条处理，给前台交互与模型服务留出间隔；停止时直接取消等待。
    if (session !== pending.at(-1)) await delay(3_000, undefined, { signal: deps.signal });
  }
  return result;
}

/**
 * 生成指定日期的工作日记。先补分析该日期内已结束但还没分析的 session（范围外的积压由
 * 周期 sweep 处理），再从分析表读取并按项目分组渲染成确定性骨架；叙事由 reportNarrative 单独负责。
 */
export async function buildActivityReport(
  deps: ActivityAnalyzerDeps,
  date: string,
  options: { force?: boolean } = {}
): Promise<ActivityReportResult> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  const now = deps.now?.() ?? new Date();
  const range = resolveActivityReportRange(date, now);
  const pendingIds = options.force
    ? deps.store.listEndedSessionIdsForDateRange(range.startIso, range.endIso, 200)
    : deps.store.listSessionsPendingAnalysisForDateRange(range.startIso, range.endIso, 200).map((session) => session.id);

  let analyzedNow = 0;
  let pendingModel = 0;
  let blocked = false;
  let message: string | undefined;
  if (deps.analyzePending !== false) {
    for (const sessionId of pendingIds) {
      deps.signal?.throwIfAborted();
      const outcome = await analyzeActivitySession(deps, sessionId, options.force === true);
      if (outcome.status === "analyzed" || outcome.status === "trivial") analyzedNow += 1;
      else if (outcome.status === "skipped" && outcome.reason === "no_model") {
        blocked = true;
        pendingModel += 1;
        message ??= "未配置可用的分析模型。";
      }
    }
  }

  deps.signal?.throwIfAborted();
  const remaining = deps.store.listSessionsPendingAnalysisForDateRange(range.startIso, range.endIso, 200);
  if (remaining.length > 0) {
    blocked = true;
    pendingModel = Math.max(pendingModel, remaining.length);
    message ??= `还有 ${String(remaining.length)} 个已结束会话尚未完成分析。`;
  }
  const rows = deps.store.listAnalysisForDateRange(range.startIso, range.endIso);
  return {
    date: range.label,
    startIso: range.startIso,
    endIso: range.endIso,
    markdown: renderActivityReport(rows, range.label),
    sessionCount: rows.filter(isReportableAnalysis).length,
    analyzedNow,
    pendingModel,
    blocked,
    message
  };
}

/**
 * 把日报结果和未完成原因渲染成工具/CLI 都能直接输出的文本。
 * 这里仅输出已经选定的骨架或叙事，避免不同入口再改写一次。
 */
export function formatActivityReportResult(result: ActivityReportResult): string {
  const notes: string[] = [];
  if (result.blocked && result.message) notes.push(result.message);
  if (result.pendingModel > 0) {
    notes.push(`还有 ${String(result.pendingModel)} 个已结束会话尚未分析，上面的日记只覆盖已分析的部分。`);
  }
  return [result.markdown, ...notes].join("\n\n");
}

/**
 * 生成写入 `memory/YYYY-MM-DD.md` 的每日摘要。
 * 文件是按日的可重建投影；session 仍保留在 ActivityStore 中作为可追溯来源。
 */
export function formatActivityDailyNote(result: ActivityReportResult): string {
  const report = formatActivityReportResult(result)
    .replace(/^## [^\n]+\n*/u, "")
    .trim();
  return [`# ${result.date} 每日摘要`, "", report].join("\n");
}

/**
 * 把一天的分析行渲染成可读的工作日记：按项目分组、组内按时间排，条目去重。
 * 确定性模板渲染——分析已是结构化数据，聚合不需要再过模型，也避免二次编造。
 */
export function renderActivityReport(rows: readonly ActivityAnalysisReportRow[], label: string): string {
  const title = `## ${label} 工作日记`;
  const reportable = rows.filter(isReportableAnalysis);
  if (!reportable.length) return `${title}\n\n（这一天没有已分析的活动记录。）`;

  const groups = new Map<string, ActivityAnalysisReportRow[]>();
  for (const row of reportable) {
    const key = row.project?.trim() || "未归类";
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  // 项目按当天最早一个 session 的开始时间排序，让日记读起来是时间推进的。
  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const a = left[1][0]?.sessionStartedAt ?? "";
    const b = right[1][0]?.sessionStartedAt ?? "";
    return a.localeCompare(b);
  });
  const sections = orderedGroups.map(([project, group]) => `### ${project}\n${renderProjectBullets(group)}`);
  return [title, "", ...sections].join("\n\n");
}

/**
 * 解析 activity report 的日期参数。`today`/`yesterday` 相对当前本地时间，`YYYY-MM-DD`
 * 按本地日界解析；start/end 转为 UTC ISO，存储层会将其转换为 epoch-ms 查询参数。
 */
export function resolveActivityReportRange(date: string, now: Date = new Date()): ActivityReportRange {
  const trimmed = date.trim().toLowerCase();
  let base: Date;
  if (trimmed === "today") {
    base = now;
  } else if (trimmed === "yesterday") {
    base = new Date(now.getTime());
    base.setDate(base.getDate() - 1);
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
    if (!match) {
      throw new Error(`无法识别的日期“${date}”。支持 today、yesterday 或 YYYY-MM-DD。`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    base = new Date(year, month - 1, day);
    // Date 构造对越界日期（如 2026-02-31）会进位成另一天而非得到 NaN，必须回读组件校验。
    if (base.getFullYear() !== year || base.getMonth() !== month - 1 || base.getDate() !== day) {
      throw new Error(`无效日期：${date}。`);
    }
  }
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString(), label: formatLocalDate(start) };
}

/** 输入指纹：版本 + 每条事件的时间、类型、应用、窗口、URL、摘要和已脱敏 OCR。 */
function activityAnalysisInputHash(events: readonly ActivityEventSummary[]): string {
  const hash = createHash("sha256");
  hash.update(ACTIVITY_ANALYSIS_VERSION);
  for (const event of events) {
    hash.update("\0");
    hash.update(event.occurredAt);
    hash.update(" ");
    hash.update(event.eventType ?? "");
    hash.update(" ");
    hash.update(event.application ?? "");
    hash.update(" ");
    hash.update(event.windowTitle ?? "");
    hash.update(" ");
    hash.update(event.url ?? "");
    hash.update(" ");
    hash.update(event.ocrText ?? "");
    hash.update(" ");
    hash.update(event.summary);
  }
  return hash.digest("hex");
}

function buildTrivialAnalysis(
  session: ActivityPendingAnalysisSession,
  sourceEventCount: number,
  analyzedAt: string,
  inputHash: string
): ActivitySessionAnalysis {
  return {
    sessionId: session.id,
    analyzedAt,
    analyzerModel: "none",
    analysisStatus: "skipped",
    title: "零星活动",
    description: ACTIVITY_TRIVIAL_SUMMARY,
    summary: ACTIVITY_TRIVIAL_SUMMARY,
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "ephemeral",
    confidence: 0,
    sourceEventCount,
    inputHash
  };
}

function parseActivityAnalysisOutput(text: string): AnalysisOutput | undefined {
  const normalized = text.replace(/```(?:json)?/giu, "").replace(/```/gu, "").trim();
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(normalized.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const entityValue = isRecord(value.entities) ? value.entities : undefined;
  const entityArray = Array.isArray(value.entities) ? normalizeStrings(value.entities, 64, 200) : undefined;
  const result = analysisOutputSchema.safeParse({
    project: typeof value.project === "string" ? value.project.slice(0, 120) : null,
    title: optionalString(value.title, 160),
    description: optionalString(value.description, 800),
    summary: optionalString(value.summary, 1_000),
    topics: normalizeStrings(value.topics, 5, 40),
    prs: normalizeReferences(value.prs, 32),
    issues: normalizeReferences(value.issues, 32),
    people: normalizePeopleValues(value.people, 32),
    versions: normalizeStrings(value.versions, 32, 60),
    decisions: normalizeStrings(value.decisions, 32, 500),
    entities: entityValue ? normalizeEntityGroup(entityValue) : entityArray ?? [],
    highlights: normalizeStrings(value.highlights, 3, 200),
    commits: normalizeCommits(value.commits, 64),
    identifiers: normalizeStrings(value.identifiers, 64, 200),
    repos: normalizeStrings(value.repos, 32, 200),
    events: normalizeStrings(value.events, 32, 300),
    urls: normalizeStrings(value.urls, 64, 500),
    memoryCandidates: normalizeMemoryCandidates(value.memoryCandidates),
    worth: Boolean(value.worth),
    worthMemory: Boolean(value.worthMemory),
    worthKnowledge: Boolean(value.worthKnowledge),
    isMeeting: Boolean(value.isMeeting),
    storageTier: value.storageTier === "ephemeral" || value.storageTier === "important"
      ? value.storageTier
      : "standard",
    confidence: typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? Math.min(1, Math.max(0, value.confidence))
      : 0
  });
  return result.success ? result.data : undefined;
}

function normalizeEntityGroup(value: Record<string, unknown>): ActivityAnalysisEntityDetails {
  return {
    prs: normalizeReferences(value.prs, 20),
    issues: normalizeReferences(value.issues, 20),
    commits: normalizeCommits(value.commits, 20),
    people: normalizePeople(normalizePeopleValues(value.people, 20)),
    identifiers: normalizeStrings(value.identifiers, 30, 120),
    repos: normalizeStrings(value.repos, 10, 120),
    versions: normalizeStrings(value.versions, 10, 40),
    events: normalizeStrings(value.events, 10, 80),
    decisions: normalizeStrings(value.decisions, 10, 200),
    urls: normalizeStrings(value.urls, 30, 500).filter((url) => /^https?:\/\//iu.test(url))
  };
}

function normalizeReferences(value: unknown, limit: number): ActivityAnalysisReference[] {
  if (!Array.isArray(value)) return [];
  const result: ActivityAnalysisReference[] = [];
  for (const item of value) {
    const parsed = analysisReferenceSchema.safeParse(item);
    if (!parsed.success) continue;
    result.push(parsed.data);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeCommits(value: unknown, limit: number): ActivityAnalysisCommit[] {
  if (!Array.isArray(value)) return [];
  const result: ActivityAnalysisCommit[] = [];
  for (const item of value) {
    const parsed = analysisCommitSchema.safeParse(item);
    if (!parsed.success) continue;
    result.push(parsed.data);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizePeopleValues(value: unknown, limit: number): Array<string | { handle: string; name?: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<string | { handle: string; name?: string }> = [];
  for (const item of value) {
    const parsed = analysisPersonSchema.safeParse(item);
    if (!parsed.success) continue;
    result.push(parsed.data);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeStrings(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().slice(0, maxLength);
    if (!normalized) continue;
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeMemoryCandidates(value: unknown): Array<{ type: "project" | "feedback" | "reference" | "user"; content: string; why: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ type: "project" | "feedback" | "reference" | "user"; content: string; why: string }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string" || !isMemoryCandidateType(item.type)) continue;
    const content = typeof item.content === "string" ? item.content.trim().slice(0, 240) : "";
    if (!content) continue;
    const why = typeof item.why === "string" ? item.why.trim().slice(0, 200) : "";
    result.push({ type: item.type, content, why });
    if (result.length >= 5) break;
  }
  return result;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || undefined;
}

function isMemoryCandidateType(value: string): value is "project" | "feedback" | "reference" | "user" {
  return value === "project" || value === "feedback" || value === "reference" || value === "user";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 调用分析模型并校验输出；解析失败重试一次，再失败交给调用方记录 failed 状态。
 * 网络错误、中止等不在此兜底，直接抛给调用方保持「待分析」。
 */
async function requestSessionAnalysis(
  model: AgentModel,
  session: ActivityPendingAnalysisSession,
  events: readonly ActivityEventSummary[],
  signal: AbortSignal | undefined,
  checkpoint: (() => Promise<void>) | undefined
): Promise<AnalysisOutput | undefined> {
  const prompt = buildAnalysisPrompt(session, events);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await checkpoint?.();
    const result = await generateNativeText(model, nativeJsonMessages(ANALYSIS_SYSTEM_PROMPT, prompt), { signal });
    await checkpoint?.();
    try {
      const parsed = parseActivityAnalysisOutput(result.text);
      if (!parsed) throw new Error("analysis output is not parseable");
      return parsed;
    } catch {
      // 解析失败重试一次；第二次仍失败由调用方记录 failed 状态。
    }
  }
  return undefined;
}

/** 按四段结构组装事件、窗口标题、浏览器访问和已脱敏 OCR。 */
function buildAnalysisPrompt(
  session: ActivityPendingAnalysisSession,
  events: readonly ActivityEventSummary[]
): string {
  const semanticEvents = events.filter((event) => event.eventType !== "screenshot_ocr");
  const applications = uniqueStrings(
    semanticEvents
      .map((event) => event.application)
      .filter((value): value is string => Boolean(value))
  );
  const promptEvents = semanticEvents.slice(0, ACTIVITY_ANALYSIS_MAX_EVENTS_IN_PROMPT);
  const eventSample = formatEventSample(promptEvents);
  const windowTitleSample = formatWindowTitleSample(promptEvents);
  const browserVisitSample = formatBrowserVisitSample(promptEvents);
  const ocrTexts = dedupeOcrTexts(
    events
      .filter((event) => event.eventType === "screenshot_ocr")
      .map((event) => event.ocrText?.trim())
      .filter((value): value is string => Boolean(value))
  );
  const ocrPrompt = truncateOcrText(ocrTexts.join("\n---\n"), ACTIVITY_ANALYSIS_MAX_OCR_CHARS);
  return [
    `Session ${session.id}`,
    `Started: ${isoTimestamp(session.startedAt)}`,
    `Duration: ${String(Math.round(session.durationMs / 1_000))}s`,
    `Apps: ${applications.join(", ") || "(unknown)"}`,
    `Events: ${String(session.eventCount)}  Snapshots: ${String(session.snapshotCount)}`,
    "",
    "Event sample:",
    eventSample,
    "",
    ...(windowTitleSample ? ["Window titles (frontmost app state):", windowTitleSample, ""] : []),
    ...(browserVisitSample ? ["Browser visits (URL + tab title):", browserVisitSample, ""] : []),
    "OCR text (deduped across frames):",
    ocrPrompt || "(no OCR text)"
  ].join("\n");
}

function formatEventSample(events: readonly ActivityEventSummary[]): string {
  const lines: string[] = [];
  for (const event of events) {
    const eventType = event.eventType ?? "activity";
    if (eventType === "browser_visit" || eventType === "window_title") continue;
    const time = formatEventTime(event.occurredAt, 19);
    const application = event.application ? `[${event.application}]` : "";
    const kind = eventType === "click"
      ? "click"
      : eventType === "keypress"
        ? "key"
        : eventType === "app_focus"
          ? "focus"
          : eventType;
    lines.push([time, application, kind].filter(Boolean).join(" "));
  }
  return lines.slice(0, 40).join("\n");
}

function formatBrowserVisitSample(events: readonly ActivityEventSummary[]): string {
  const lines: string[] = [];
  let previousUrl: string | undefined;
  for (const event of events) {
    if (event.eventType !== "browser_visit" || !event.url || event.url === previousUrl) continue;
    previousUrl = event.url;
    const title = browserVisitTitle(event, events);
    const titleSuffix = title ? `  —  ${title.slice(0, 140)}` : "";
    lines.push(`${formatEventTime(event.occurredAt, 16)} ${event.url}${titleSuffix}`);
    if (lines.length >= 30) break;
  }
  return lines.join("\n");
}

function formatWindowTitleSample(events: readonly ActivityEventSummary[]): string {
  const lines: string[] = [];
  let previousKey: string | undefined;
  for (const event of events) {
    if (event.eventType !== "window_title") continue;
    const title = event.windowTitle?.trim();
    if (!title) continue;
    const key = `${event.application ?? ""}||${title}`;
    if (key === previousKey) continue;
    previousKey = key;
    lines.push(`${formatEventTime(event.occurredAt, 16)} [${event.application ?? "?"}] ${title.slice(0, 180)}`);
    if (lines.length >= 40) break;
  }
  return lines.join("\n");
}

function browserVisitTitle(event: ActivityEventSummary, events: readonly ActivityEventSummary[]): string | undefined {
  const directTitle = event.windowTitle?.trim();
  if (directTitle) return directTitle;
  return events.find((candidate) => candidate.eventType === "window_title"
    && candidate.occurredAt === event.occurredAt
    && candidate.application === event.application)?.windowTitle?.trim();
}

function formatEventTime(value: string, end: number): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(11, end) : value;
}

function isoTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

/** OCR 相邻帧高度重复；只和上一帧比较，保持既定的时序去重语义。 */
function dedupeOcrTexts(texts: readonly string[]): string[] {
  const result: string[] = [];
  let previous: string | undefined;
  for (const text of texts) {
    if (previous !== undefined && textSimilarity(previous, text) > 0.9) continue;
    result.push(text);
    previous = text;
  }
  return result;
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = new Set(left.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(Boolean));
  const rightTokens = new Set(right.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function truncateOcrText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… [truncated]`;
}

function normalizeProject(project: string | null | undefined, knownProjects: readonly string[]): string | undefined {
  const trimmed = project?.trim();
  if (!trimmed) return undefined;
  // 归一化：模型若写出了已知项目的大小写/空格变体，归一到已存储的写法，避免同一项目多个名字。
  const known = knownProjects.find((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  return known ?? trimmed;
}

function normalizeEntityDetails(output: AnalysisOutput): ActivityAnalysisEntityDetails {
  const grouped = Array.isArray(output.entities) ? undefined : output.entities;
  const prs = output.prs.length ? output.prs : grouped?.prs ?? [];
  const issues = output.issues.length ? output.issues : grouped?.issues ?? [];
  const commits = output.commits.length ? output.commits : grouped?.commits ?? [];
  const people = output.people.length ? output.people : grouped?.people ?? [];
  return {
    prs,
    issues,
    commits,
    people: normalizePeople(people),
    identifiers: output.identifiers.length ? output.identifiers : grouped?.identifiers ?? [],
    repos: output.repos.length ? output.repos : grouped?.repos ?? [],
    versions: output.versions.length ? output.versions : grouped?.versions ?? [],
    events: output.events.length ? output.events : grouped?.events ?? [],
    decisions: output.decisions.length ? output.decisions : grouped?.decisions ?? [],
    urls: output.urls.length ? output.urls : grouped?.urls ?? []
  };
}

type AnalysisPerson = z.infer<typeof analysisPersonSchema>;

function normalizePeople(values: readonly AnalysisPerson[]): string[] {
  return uniqueStrings(values.map((value) => {
    if (typeof value === "string") return value;
    const name = value.name?.trim();
    return name ? `${value.handle} (${name})` : value.handle;
  }));
}

function referenceEntityLabels(reference: ActivityAnalysisReference): string[] {
  return [reference.label, reference.ref, reference.repo, reference.title, reference.url]
    .filter((value): value is string => Boolean(value));
}

function commitEntityLabels(commit: ActivityAnalysisCommit): string[] {
  return [commit.label, commit.ref, commit.repo, commit.hash, commit.message, commit.url]
    .filter((value): value is string => Boolean(value));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function deriveTitle(summary: string): string {
  const firstSentence = summary.split(/[。.!?！？]/u, 1)[0]?.trim() || summary.trim();
  return firstSentence.slice(0, 240);
}

const PLACEHOLDER_SUMMARIES = new Set([ACTIVITY_TRIVIAL_SUMMARY, ACTIVITY_ANALYSIS_FAILED_SUMMARY]);

function isReportableAnalysis(row: ActivityAnalysisReportRow): boolean {
  if (row.analysisStatus !== "analyzed") return false;
  const itemCount = row.topics.length + row.prs.length + row.issues.length + row.decisions.length
    + row.people.length + row.versions.length + row.highlights.length + row.entities.length;
  if (itemCount > 0) return true;
  if (row.title?.trim() && !PLACEHOLDER_SUMMARIES.has(row.title.trim())) return true;
  return row.summary.trim().length > 0 && !PLACEHOLDER_SUMMARIES.has(row.summary);
}

function renderProjectBullets(group: readonly ActivityAnalysisReportRow[]): string {
  const bullets: string[] = [];
  const seen = new Set<string>();
  const push = (text: string): void => {
    const normalized = text.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    bullets.push(`- ${normalized}`);
  };
  // group 已按 session 开始时间升序；条目按时间顺序去重合并。
  for (const row of group) {
    const marker = row.isMeeting ? " 📅" : "";
    const titleLead = row.title?.trim() && !PLACEHOLDER_SUMMARIES.has(row.title.trim())
      ? `${row.title.trim()}${row.description?.trim() && row.description.trim() !== row.title.trim() ? `：${row.description.trim()}` : ""}`
      : undefined;
    const leads = row.topics.length
      ? row.topics
      : titleLead ? [titleLead] : row.summary.trim() && !PLACEHOLDER_SUMMARIES.has(row.summary) ? [row.summary] : [];
    for (const topic of leads) push(`${topic}${marker}`);
    for (const pr of row.prs) push(formatReference("PR", pr));
    for (const issue of row.issues) push(formatReference("Issue", issue));
    for (const decision of row.decisions) push(`决策：${decision}`);
    for (const highlight of row.highlights) push(`亮点：${highlight}`);
    if (row.worthKnowledge) push("知识沉淀：值得记录");
    if (row.people.length) push(`涉及：${row.people.join("、")}`);
    if (row.versions.length) push(`版本：${row.versions.join("、")}`);
  }
  return bullets.join("\n");
}

function formatReference(kind: "PR" | "Issue", reference: ActivityAnalysisReference): string {
  const parts: string[] = [kind];
  if (reference.repo && reference.ref) parts.push(`${reference.repo}#${reference.ref}`);
  else if (reference.repo && reference.number !== undefined) parts.push(`${reference.repo}#${String(reference.number)}`);
  else if (reference.ref) parts.push(reference.ref);
  else if (reference.number !== undefined) parts.push(`#${String(reference.number)}`);
  else if (reference.repo) parts.push(reference.repo);
  else if (reference.label) parts.push(reference.label);
  const head = parts.join(" ");
  const detail = reference.title ?? (reference.label && parts.length > 1 ? "" : reference.url ?? "");
  return detail ? `${head} ${detail}` : head;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
