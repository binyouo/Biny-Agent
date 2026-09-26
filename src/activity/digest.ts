/** 近期 Activity 摘要：当前会话、今日统计和已分析会话，共用日报的时长计算。 */
import type { ActivityHttpSessionRecord, ActivityStore } from "./store.js";
import { buildActivitySummary } from "./summary.js";

export const ACTIVITY_DIGEST_DEFAULT_LOOKBACK_MIN = 120;
export const ACTIVITY_DIGEST_MAX_LOOKBACK_MIN = 24 * 60;

export interface ActivityDigestResult {
  markdown: string;
  lookbackMin: number;
  sinceIso: string;
  sessions: number;
  analyzed: number;
}

export interface ActivityDigestDeps {
  store: ActivityStore;
  limit?: number;
  maxAnalyzed?: number;
  now?: () => Date;
}

export function resolveDigestWindow(lookbackMin: number, now: Date = new Date()): string {
  const clamped = Math.max(5, Math.min(ACTIVITY_DIGEST_MAX_LOOKBACK_MIN, Math.trunc(lookbackMin)));
  return new Date(now.getTime() - clamped * 60_000).toISOString();
}

export async function buildActivityDigest(deps: ActivityDigestDeps, lookbackMin = ACTIVITY_DIGEST_DEFAULT_LOOKBACK_MIN): Promise<ActivityDigestResult> {
  const now = deps.now?.() ?? new Date();
  const sinceIso = resolveDigestWindow(lookbackMin, now);
  const recent = deps.store.listHttpSessions({
    since: Date.parse(sinceIso), limit: deps.limit ?? 200
  }).filter((row) => row.analysisStatus === "analyzed" && row.analysisTitle?.trim()).slice(0, deps.maxAnalyzed ?? 8);
  const active = deps.store.listOpenHttpSessions(1)[0];
  const dateKey = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const today = buildActivitySummary(deps.store, "daily", dateKey, now, 500).stats;
  const markdown = renderActivityDigest(deps.store, active, recent, today, lookbackMin, now);
  return { markdown, lookbackMin, sinceIso, sessions: recent.length, analyzed: recent.length };
}

function renderActivityDigest(
  store: ActivityStore,
  active: ActivityHttpSessionRecord | undefined,
  recent: readonly ActivityHttpSessionRecord[],
  today: ReturnType<typeof buildActivitySummary>["stats"],
  lookbackMin: number,
  now: Date
): string {
  const lines = ["# Recent activity digest", ""];
  if (active) {
    const minutes = Math.round((now.getTime() - active.startedAt) / 60_000);
    lines.push(`**Active session** (${active.id}) — ${active.appNames.join(", ") || "?"}, started ${String(minutes)} min ago, ${String(active.eventCount)} events / ${String(active.snapshotCount)} snapshots.`, "");
  }
  if (today.totalActiveMs > 0) {
    const minutes = Math.round(today.totalActiveMs / 60_000);
    const topApps = today.apps.slice(0, 5).map((app) => `${app.app} (${String(Math.round(app.durationMs / 60_000))}m)`).join(", ");
    lines.push(`**Today**: ${String(minutes)} min active across ${String(today.sessionCount)} sessions. Top apps: ${topApps}.`, "");
  }
  if (recent.length > 0) {
    lines.push(`**Recent sessions (last ${String(lookbackMin)} min):**`);
    for (const row of recent) {
      const startedAt = new Date(row.startedAt).toISOString().slice(11, 16);
      const minutes = Math.round((row.durationMs ?? 0) / 60_000);
      lines.push(`- \`${row.id}\` — ${startedAt} (${String(minutes)}m) **${row.analysisTitle}**`);
      if (row.analysisDescription) lines.push(`  - ${row.analysisDescription.replace(/\s+/gu, " ")}`);
      const excerpts = store.listSessionOcrExcerpts(row.id, 4)
        .map((text) => text.replace(/\s+/gu, " ").slice(0, 200))
        .filter(Boolean)
        .slice(0, 3);
      for (const excerpt of excerpts) lines.push(`  - OCR: ${excerpt}${excerpt.length >= 200 ? "…" : ""}`);
    }
  }
  return lines.length <= 2 ? "_No recent activity recorded._" : lines.join("\n");
}
