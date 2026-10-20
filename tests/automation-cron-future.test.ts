import assert from "node:assert/strict";
import { nextCron } from "../src/runtime/AutomationCron.js";

const cases = [
  { name: "repeated hour remains strictly future", zone: "America/New_York", after: "2025-11-02T06:30:30.000Z", cron: "* * * * *", expected: "2025-11-02T07:00:00.000Z" },
  { name: "per-second schedule advances through the repeated hour", zone: "America/New_York", after: "2025-11-02T06:30:30.000Z", cron: "* * * * * *", expected: "2025-11-02T07:00:00.000Z" },
  { name: "daily schedule skips the second repeated hour", zone: "America/New_York", after: "2025-11-02T06:30:30.000Z", cron: "45 1 * * *", expected: "2025-11-03T06:45:00.000Z" },
  { name: "equal minute is not returned", zone: "America/New_York", after: "2025-11-02T06:30:00.000Z", cron: "* * * * *", expected: "2025-11-02T07:00:00.000Z" },
  { name: "first repeated hour keeps its remaining minutes", zone: "America/New_York", after: "2025-11-02T05:30:30.000Z", cron: "45 1 * * *", expected: "2025-11-02T05:45:00.000Z" },
  { name: "spring jump returns a future minute", zone: "America/New_York", after: "2025-03-09T06:59:30.000Z", cron: "* * * * *", expected: "2025-03-09T07:00:00.000Z" },
  { name: "spring jump normalizes a missing local time", zone: "America/New_York", after: "2025-03-09T06:59:30.000Z", cron: "30 2 * * *", expected: "2025-03-09T07:30:00.000Z" },
  { name: "half-hour rollback uses the timezone parser's next minute", zone: "Australia/Lord_Howe", after: "2025-04-05T15:15:30.000Z", cron: "* * * * *", expected: "2025-04-05T15:16:00.000Z" },
  { name: "cron lists, ranges, and steps", zone: "UTC", after: "2025-11-01T06:30:30.000Z", cron: "5,10-20/5 6 2 11 0", expected: "2025-11-02T06:05:00.000Z" }
] as const;

for (const fixture of cases) {
  const after = new Date(fixture.after);
  const result = nextCron(fixture.cron, after, fixture.zone);
  assert.ok(result.getTime() > after.getTime(), `${fixture.name}: result must be strictly future`);
  assert.equal(result.toISOString(), fixture.expected, fixture.name);
  assert.equal(result.getSeconds(), 0, `${fixture.name}: minute schedule has no seconds`);
  assert.equal(result.getMilliseconds(), 0, `${fixture.name}: result has no milliseconds`);
  assert.equal(after.toISOString(), fixture.after, `${fixture.name}: reference date is not mutated`);
}

assert.equal(
  nextCron("0 9 * * *", new Date("2035-06-12T00:00:00.000Z"), "Asia/Kolkata").toISOString(),
  "2035-06-12T03:30:00.000Z",
  "a per-schedule IANA timezone determines the occurrence"
);
assert.equal(
  nextCron("0 9 1 * MON", new Date("2035-06-12T08:07:00.000Z"), "UTC").toISOString(),
  "2035-06-18T09:00:00.000Z",
  "day-of-month and day-of-week use the cron default OR rule"
);
assert.equal(
  nextCron("0 0 9 L * *", new Date("2035-06-12T10:00:00.000Z"), "UTC").toISOString(),
  "2035-06-30T09:00:00.000Z",
  "last-day and no-specific-weekday syntax is accepted"
);
assert.equal(
  nextCron("0 0 9 * * MON#2", new Date("2035-06-12T08:07:00.000Z"), "UTC").toISOString(),
  "2035-07-09T09:00:00.000Z",
  "nth-weekday syntax is accepted"
);
assert.equal(
  nextCron("15 * * * * *", new Date("2035-06-12T08:07:10.000Z"), "UTC").toISOString(),
  "2035-06-12T08:07:15.000Z",
  "six-field schedules can target seconds"
);
assert.equal(
  nextCron("0 0 29 2 *", new Date("2024-02-29T00:00:00.000Z"), "UTC").toISOString(),
  "2028-02-29T00:00:00.000Z",
  "a schedule with no occurrence in the next year advances to its next leap day"
);
assert.throws(() => nextCron("* * * *", new Date("2024-02-29T00:00:00.000Z")), /five, six, or seven/u);
console.log("automation cron future, syntax, and timezone behavior passed");
