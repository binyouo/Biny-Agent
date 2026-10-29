import type { DesktopMaskRecordSummary } from "../../../../protocol.js";

export function privacyDay(time: string | Date): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function privacyView(records: readonly DesktopMaskRecordSummary[], filter: {
  days: number; provider: string; session: string; kind: string; day: string;
}, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - filter.days + 1);
  const matching = records.filter(record => new Date(record.time) >= start && new Date(record.time) <= now
    && (!filter.provider || record.provider === filter.provider) && (!filter.session || record.sessionId === filter.session)
    && (!filter.kind || record.kinds[filter.kind]));
  const days = Array.from({ length: filter.days }, (_, index) => {
    const date = new Date(start); date.setDate(start.getDate() + index);
    return { day: privacyDay(date), count: 0 };
  });
  const counts = new Map(days.map(day => [day.day, day]));
  for (const record of matching) counts.get(privacyDay(record.time))!.count += record.count;
  const filtered = matching.filter(record => !filter.day || privacyDay(record.time) === filter.day);
  return { days, records: filtered, total: filtered.reduce((sum, record) => sum + record.count, 0) };
}
