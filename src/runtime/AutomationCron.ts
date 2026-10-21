import { Cron } from "croner";

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
    if (next === null) return undefined;
    if (next.getTime() > reference.getTime()) return next;
    cursor = next;
  }
  throw new Error("Cron expression did not advance to a future occurrence.");
}
