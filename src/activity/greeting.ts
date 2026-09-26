/** 纯问候的近期活动参考，只从已经分析的会话抽取短摘要。 */
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
  if (active) {
    const apps = active.appNames.slice(0, 3).join(", ") || "未知应用";
    const minutes = Math.max(0, Math.round((now.getTime() - active.startedAt) / 60_000));
    lines.push(`当前活动：${apps}（${minutes} 分钟，${active.eventCount} 个事件，${active.snapshotCount} 张截图）`);
  }
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const today = buildActivitySummary(store, "daily", dateKey, now, 500).stats;
  if (today.sessionCount) {
    const topApps = today.apps
      .slice(0, 3)
      .map(({ app, durationMs }) => `${app}（${Math.round(durationMs / 60_000)} 分钟）`)
      .join("、");
    lines.push(`今天：${Math.round(today.totalActiveMs / 60_000)} 分钟，共 ${today.sessionCount} 个会话${topApps ? `；主要应用：${topApps}` : ""}`);
  }
  for (const session of sessions) {
    const analysis = session.analysis!;
    lines.push([analysis.project, analysis.title, analysis.description ?? analysis.summary]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" · "));
  }
  if (!lines.length) return undefined;
  return redactSecrets(lines.join("\n")).slice(0, 900);
}
