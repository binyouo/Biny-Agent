import { Cron, CronDate, CronPattern } from "croner";

// A repeated wall-clock period can yield stale candidates; the cap allows a full day of per-second advancement.
const maximumCronAdvancements = 100_000;

export function nextCron(expression: string, after: Date, timezone?: string): Date {
  const next = nextCronOccurrence(expression, after, timezone);
  if (next === undefined) throw new Error("Cron expression has no upcoming occurrence.");
  return next;
}

/** A valid finite schedule may end; invalid expressions and failed advancement still throw. */
export function nextCronOccurrence(expression: string, after: Date, timezone?: string): Date | undefined {
  const cron = new Cron(expression, { timezone, paused: true });
  const reference = new Date(after);
  let cursor = reference;
  for (let attempt = 0; attempt < maximumCronAdvancements; attempt += 1) {
    const next = cron.nextRun(cursor);
    if (next === null) {
      // A missing successor alone does not prove exhaustion: an impossible
      // calendar expression (for example February 31) also returns null.
      const pattern = new CronPattern(expression, timezone);
      const firstYear = pattern.year.findIndex((enabled, year) => year >= 1 && enabled === 1);
      if (pattern.starYear || firstYear < 1) throw new Error("Cron expression has no upcoming occurrence.");
      // Probe forward from the earliest permitted year, using the same timezone
      // and calendar semantics. This is bounded by Croner's supported year range.
      const start = new CronDate(`${String(firstYear).padStart(4, "0")}-01-01T00:00:00`, timezone).getDate();
      // Include normalized midnight occurrences in timezone clock gaps.
      if (!cron.match(start) && cron.nextRun(new Date(start.getTime() - 1_000)) === null) {
        throw new Error("Cron expression has no valid occurrence.");
      }
      return undefined;
    }
    if (next.getTime() > reference.getTime()) return next;
    cursor = next;
  }
  throw new Error("Cron expression did not advance to a future occurrence.");
}
