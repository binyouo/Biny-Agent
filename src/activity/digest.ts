/**
 * Activity digest 的业务实现：把最近 N 分钟内的 session（含进行中）渲染成一条浅的时间线。
 *
 * 设计上刻意「浅」：与 report 不同，digest 不补分析（不烧模型），已分析的 session 用
 * project+summary+topics 一行带过，还没分析的 session 直接退化展示脱敏事件摘要并标注
 * 「未分析」。这样「我刚才在干嘛」在 session 刚结束、分析还在途时也能立刻回答。
 */
import type { ActivityRecentSessionRow, ActivityStore } from "./store.js";

export const ACTIVITY_DIGEST_DEFAULT_LOOKBACK_MIN = 120;
export const ACTIVITY_DIGEST_MAX_LOOKBACK_MIN = 24 * 60;
/** 未分析 session 退化展示时最多列出的去重事件行数。 */
const UNANALYZED_EVENT_LINES = 4;

export interface ActivityDigestResult {
  markdown: string;
  lookbackMin: number;
  /** 窗口起点 ISO（本地 now - lookbackMin）。 */
  sinceIso: string;
  sessions: number;
  analyzed: number;
}

export interface ActivityDigestDeps {
  store: ActivityStore;
  lookbackMin?: number;
  limit?: number;
  maxAnalyzed?: number;
  now?: () => Date;
}

export function resolveDigestWindow(lookbackMin: number, now: Date = new Date()): string {
  const clamped = Math.max(1, Math.min(ACTIVITY_DIGEST_MAX_LOOKBACK_MIN, Math.trunc(lookbackMin)));
  return new Date(now.getTime() - clamped * 60_000).toISOString();
}

/** 读取窗口内 session 并渲染成 旧→新 的时间线。未分析 session 补读少量事件摘要。 */
export async function buildActivityDigest(deps: ActivityDigestDeps, lookbackMin = ACTIVITY_DIGEST_DEFAULT_LOOKBACK_MIN): Promise<ActivityDigestResult> {
  const now = deps.now?.() ?? new Date();
  const sinceIso = resolveDigestWindow(lookbackMin, now);
  const recent = deps.store.listRecentSessionsWithAnalysis(sinceIso, deps.limit ?? 50);
  let analyzedCount = 0;
  const rows = recent.filter((row) => {
    if (!row.analysis) return true;
    analyzedCount += 1;
    return analyzedCount <= (deps.maxAnalyzed ?? Number.POSITIVE_INFINITY);
  });
  const eventsBySession = new Map<string, string[]>();
  const ocrBySession = new Map<string, string[]>();
  for (const row of rows) {
    const excerpts = deps.store.listSessionOcrExcerpts(row.id)
      .map((value) => value.replace(/\s+/gu, " ").trim().slice(0, 180))
      .filter(Boolean);
    if (excerpts.length) ocrBySession.set(row.id, dedupeOrdered(excerpts));
    if (row.analysis) continue;
    const summaries = deps.store.listSessionEventSummaries(row.id)
      .map((event) => event.summary.trim())
      .filter(Boolean);
    eventsBySession.set(row.id, dedupeOrdered(summaries).slice(0, UNANALYZED_EVENT_LINES));
  }
  return {
    markdown: renderActivityDigest(rows, eventsBySession, now, ocrBySession),
    lookbackMin,
    sinceIso,
    sessions: rows.length,
    analyzed: rows.filter((row) => row.analysis !== undefined).length
  };
}

/** 时间线渲染：session 由旧到新；行首带本地时间范围，项目名用 [project] 前缀。 */
export function renderActivityDigest(
  rows: readonly ActivityRecentSessionRow[],
  eventsBySession: ReadonlyMap<string, readonly string[]> = new Map(),
  now: Date = new Date(),
  ocrBySession: ReadonlyMap<string, readonly string[]> = new Map()
): string {
  const ordered = [...rows].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const title = `## 近期活动摘要（${digestWindowLabel(rows, now)}）`;
  if (!ordered.length) return `${title}\n\n（这段时间没有录到的活动。）`;
  const lines = ordered.map((row) => renderRecentRow(row, eventsBySession.get(row.id), ocrBySession.get(row.id)));
  return [title, ...lines].join("\n\n");
}

function renderRecentRow(row: ActivityRecentSessionRow, eventLines: readonly string[] | undefined, ocrLines: readonly string[] | undefined): string {
  const range = sessionTimeRange(row);
  const ongoing = row.endedAt === undefined ? "（进行中）" : "";
  const ocr = ocrLines?.length ? `\n  OCR：${ocrLines.join("；")}` : "";
  if (row.analysis) {
    const project = row.analysis.project?.trim() ? ` [${row.analysis.project.trim()}]` : "";
    const lead = row.analysis.topics.length
      ? row.analysis.topics.join("；")
      : row.analysis.summary.trim();
    const meeting = row.analysis.isMeeting ? " 📅" : "";
    return `- ${range}${ongoing}${project}${meeting}：${lead}${ocr}`;
  }
  const events = eventLines?.length
    ? eventLines.map((line) => `- ${line}`).join(" · ")
    : `共 ${String(row.eventCount)} 个事件`;
  return `- ${range}${ongoing}（未分析）：${events}${ocr}`;
}

/** 窗口标签按最早一条已录 session 距 now 的跨度给出人话。 */
function digestWindowLabel(rows: readonly ActivityRecentSessionRow[], now: Date): string {
  if (!rows.length) return "最近一段时间";
  const newest = rows.reduce((max, row) => (row.startedAt > max ? row.startedAt : max), rows[0]!.startedAt);
  const minutes = Math.max(0, Math.round((Date.parse(now.toISOString()) - Date.parse(newest)) / 60_000));
  if (minutes < 60) return `最近 ${String(Math.max(1, minutes))} 分钟`;
  return `最近 ${String(Math.max(1, Math.round(minutes / 60)))} 小时`;
}

function sessionTimeRange(row: ActivityRecentSessionRow): string {
  const start = formatLocalTime(row.startedAt);
  if (!row.endedAt) return `${start}–`;
  return `${start}–${formatLocalTime(row.endedAt)}`;
}

/** UTC ISO → 本地 HH:MM。 */
function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function dedupeOrdered(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}
