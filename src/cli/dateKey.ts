/** Resolve CLI date labels in the current local calendar, without reading domain data. */
export function resolveDateKey(value: string, now: Date = new Date()): string {
  if (value === "today") return formatDate(now.getFullYear(), now.getMonth(), now.getDate());
  if (value === "yesterday") {
    // This is a date label, not an instant: carry the local components in UTC so
    // DST and even a wholly skipped local day cannot normalize it back to today.
    const yesterday = new Date(0);
    yesterday.setUTCFullYear(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return formatDate(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate());
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`日期必须是 today、yesterday 或 YYYY-MM-DD：${value}`);
  return value;
}

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
