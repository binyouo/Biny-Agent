/** 把用户设备时区中的自然日和自然周换成索引使用的半开日期范围。 */
export interface TemporalDateRange { startDate: string; endDate: string }

export function shiftTemporalDay(day: string, amount: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) throw new Error("日期无效。");
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, date! + amount));
  return next.toISOString().slice(0, 10);
}

/** 日历选择的结束日含当天；索引查询使用半开区间，最多读取一年。 */
export function customTemporalRange(firstDay: string, lastDay: string): TemporalDateRange {
  const endDate = shiftTemporalDay(lastDay, 1);
  shiftTemporalDay(firstDay, 0);
  const span = (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${firstDay}T00:00:00.000Z`)) / 86_400_000;
  if (span < 1 || span > 366) throw new Error("自选范围须为最多一年的有效日期。");
  return { startDate: firstDay, endDate };
}

export function naturalTemporalRanges(now: Date, timeZone: string): {
  today: TemporalDateRange;
  thisWeek: TemporalDateRange;
  nextWeek: TemporalDateRange;
} {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, date!)).getUTCDay();
  const monday = shiftTemporalDay(day, -(weekday + 6) % 7);
  const nextMonday = shiftTemporalDay(monday, 7);
  return {
    today: { startDate: day, endDate: shiftTemporalDay(day, 1) },
    thisWeek: { startDate: monday, endDate: nextMonday },
    nextWeek: { startDate: nextMonday, endDate: shiftTemporalDay(nextMonday, 7) }
  };
}
