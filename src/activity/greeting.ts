/** 纯问候的近期活动参考，只从已经分析的会话抽取短摘要。 */
import { redactSecrets } from "../utils/secrets.js";
import { ACTIVITY_ANALYSIS_FAILED_SUMMARY, ACTIVITY_TRIVIAL_SUMMARY } from "./analyzer.js";
import type { ActivityStore } from "./store.js";

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
  const recent = store.snapshot(50).recentSessions;
  const active = recent.find((session) => session.endedAt === undefined);
  if (active) {
    const apps = active.applications.slice(0, 3).join(", ") || "未知应用";
    const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(active.startedAt)) / 60_000));
    lines.push(`当前活动：${apps}（${minutes} 分钟，${active.eventCount} 个事件，${active.snapshotCount} 张截图）`);
  }
  const localMidnight = new Date(now);
  localMidnight.setHours(0, 0, 0, 0);
  const today = store.listRecentSessionsWithAnalysis(localMidnight.toISOString(), 500);
  if (today.length) {
    const appDurations = new Map<string, number>();
    const totalMinutes = Math.round(today.reduce((total, session) => {
      const start = Math.max(Date.parse(session.startedAt), localMidnight.getTime());
      const end = Math.min(session.endedAt ? Date.parse(session.endedAt) : now.getTime(), now.getTime());
      const events = store.listSessionEventSummaries(session.id)
        .filter((event) => event.application && Date.parse(event.occurredAt) >= start && Date.parse(event.occurredAt) <= end);
      let app: string | undefined;
      let appStartedAt = start;
      for (const event of events) {
        if (app === event.application) continue;
        if (app) appDurations.set(app, (appDurations.get(app) ?? 0) + Math.max(0, Date.parse(event.occurredAt) - appStartedAt));
        app = event.application;
        appStartedAt = Date.parse(event.occurredAt);
      }
      if (app) appDurations.set(app, (appDurations.get(app) ?? 0) + Math.max(0, end - appStartedAt));
      return total + Math.max(0, end - start);
    }, 0) / 60_000);
    const topApps = [...appDurations]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([app, duration]) => `${app}（${Math.round(duration / 60_000)} 分钟）`)
      .join("、");
    lines.push(`今天：${totalMinutes} 分钟，共 ${today.length} 个会话${topApps ? `；主要应用：${topApps}` : ""}`);
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
