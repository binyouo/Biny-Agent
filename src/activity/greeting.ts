/** 纯问候的近期活动参考，明确区分焦点记录、会话范围和历史分析。 */
import { redactSecrets } from "../utils/secrets.js";
import { ACTIVITY_ANALYSIS_FAILED_SUMMARY, ACTIVITY_TRIVIAL_SUMMARY } from "./analyzer.js";
import type { ActivityStore } from "./store.js";
import { buildActivitySummary } from "./summary.js";

const greetingPatterns = [
  /^(hi+|hello+|hey+|yo+|sup|hola|halo|howdy|aloha)[\s!.,~?]*$/iu,
  /^(good\s+(morning|afternoon|evening|night)|morning|afternoon|evening)[\s!.,~?]*$/iu,
  /^(你好|您好|嗨|哈喽|哈罗|早|早啊|早安|早上好|中午好|下午好|晚上好|晚安|喂|喵|在吗|在不|hi呀|hi啊)[\s!！?？。，~～]*$/iu,
  /^(おはよう|こんにちは|こんばんは|やあ|もしもし|ハロー)[\s!?。、~]*$/iu,
  /^(안녕|안녕하세요)[\s!?~]*$/iu
];
const greetingLookbackMs = 48 * 60 * 60 * 1_000;

export function isBareGreeting(input: string): boolean {
  const text = input.trim();
  return text.length > 0 && text.length <= 30 && greetingPatterns.some((pattern) => pattern.test(text));
}

export function recentActivityForGreeting(store: ActivityStore, input: string, now = new Date()): string | undefined {
  if (!isBareGreeting(input)) return undefined;
  const since = new Date(now.getTime() - greetingLookbackMs).toISOString();
  const sessions = store.listRecentSessionsWithAnalysis(since, 200)
    .filter((session) => session.startedAt >= since && session.startedAt <= now.toISOString() &&
      session.analysis?.summary &&
      session.analysis.summary !== ACTIVITY_TRIVIAL_SUMMARY &&
      session.analysis.summary !== ACTIVITY_ANALYSIS_FAILED_SUMMARY)
    .slice(0, 5);
  const lines: string[] = [];
  const active = store.listOpenHttpSessions(1)[0];
  if (active && active.startedAt <= now.getTime()) {
    const focus = store.getLatestApplicationFocus(active.id, now.toISOString());
    if (focus && (focus.application || focus.bundleId)) {
      const identity = [focus.application, focus.bundleId ? `[${focus.bundleId}]` : undefined].filter(Boolean).join(" ");
      lines.push(`最近焦点记录：${identity}（${activityAge(focus.occurredAt, now)}，${focus.occurredAt}）`);
    }
    const apps = active.appNames.slice(0, 3).join(", ") || "未知应用";
    const minutes = Math.max(0, Math.round((now.getTime() - active.startedAt) / 60_000));
    lines.push(`本次会话涉及应用：${apps}（会话已开始 ${minutes} 分钟，${active.eventCount} 个事件，${active.snapshotCount} 张截图）`);
  }
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const today = buildActivitySummary(store, "daily", dateKey, now, 500).stats;
  if (today.sessionCount) {
    const topApps = today.apps
      .slice(0, 3)
      .map(({ app, durationMs }) => `${app}（${Math.round(durationMs / 60_000)} 分钟）`)
      .join("、");
    lines.push(`今天：${Math.round(today.totalActiveMs / 60_000)} 分钟，共 ${today.sessionCount} 个会话${topApps ? `；主要应用：${topApps}（按系统应用名汇总的前台时长估算）` : ""}`);
  }
  for (const session of sessions) {
    const analysis = session.analysis!;
    const durationMinutes = Math.max(0, Math.round(((session.endedAt ? Date.parse(session.endedAt) : now.getTime()) - Date.parse(session.startedAt)) / 60_000));
    const description = (analysis.description ?? analysis.summary).replace(/\s+/gu, " ").slice(0, 140);
    lines.push(`- ${activityAge(session.startedAt, now)}，约 ${durationMinutes} 分钟（${session.startedAt}）：` + [analysis.project, analysis.title, description]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" · "));
  }
  if (!lines.length) return undefined;
  return redactSecrets(lines.join("\n")).slice(0, 900);
}

function activityAge(occurredAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(occurredAt)) / 60_000));
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
}
