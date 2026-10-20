import { Cron } from "croner";

// A repeated wall-clock period can yield stale candidates; the cap allows a full day of per-second advancement.
const maximumCronAdvancements = 100_000;

export function nextCron(expression: string, after: Date, timezone?: string): Date {
  const cron = new Cron(expression, { timezone, paused: true });
  const reference = new Date(after);
  let cursor = reference;
  for (let attempt = 0; attempt < maximumCronAdvancements; attempt += 1) {
    const next = cron.nextRun(cursor);
    if (!next) throw new Error("Cron expression has no upcoming occurrence.");
    if (next.getTime() > reference.getTime()) return next;
    cursor = next;
  }
  throw new Error("Cron expression did not advance to a future occurrence.");
}
