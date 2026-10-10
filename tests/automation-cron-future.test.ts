import assert from "node:assert/strict";
import { nextCron } from "../src/runtime/AutomationCron.js";

interface CronCase {
  name: string;
  zone: string;
  after: string;
  localHour: number;
  offset: number;
  cron: string;
  expected: string;
}

const cases: CronCase[] = [
  { name: "second repeated hour: every minute stays future", zone: "America/New_York", after: "2025-11-02T06:30:30.000Z", localHour: 1, offset: 300, cron: "* * * * *", expected: "2025-11-02T07:00:00.000Z" },
  { name: "second repeated hour: daily field match stays future", zone: "America/New_York", after: "2025-11-02T06:30:30.000Z", localHour: 1, offset: 300, cron: "45 1 * * *", expected: "2025-11-03T06:45:00.000Z" },
  { name: "second repeated hour: exact minute stays strictly future", zone: "America/New_York", after: "2025-11-02T06:30:00.000Z", localHour: 1, offset: 300, cron: "* * * * *", expected: "2025-11-02T07:00:00.000Z" },
  // Preserve the existing local-setter policy; do not introduce a second fire
  // in the repeated hour or promise to enumerate all its remaining minutes.
  { name: "first repeated hour: keep skipping the second hour", zone: "America/New_York", after: "2025-11-02T05:59:00.000Z", localHour: 1, offset: 240, cron: "* * * * *", expected: "2025-11-02T07:00:00.000Z" },
  { name: "first repeated hour: daily schedule keeps its next-day policy", zone: "America/New_York", after: "2025-11-02T05:59:00.000Z", localHour: 1, offset: 240, cron: "45 1 * * *", expected: "2025-11-03T06:45:00.000Z" },
  { name: "first repeated hour still uses remaining first-hour minutes", zone: "America/New_York", after: "2025-11-02T05:30:30.000Z", localHour: 1, offset: 240, cron: "45 1 * * *", expected: "2025-11-02T05:45:00.000Z" },
  { name: "UTC fractional minute", zone: "UTC", after: "2025-11-02T06:30:30.123Z", localHour: 6, offset: 0, cron: "* * * * *", expected: "2025-11-02T06:31:00.000Z" },
  { name: "UTC exact minute excludes equality", zone: "UTC", after: "2025-11-02T06:30:00.000Z", localHour: 6, offset: 0, cron: "30 6 * * *", expected: "2025-11-03T06:30:00.000Z" },
  { name: "ordinary local time", zone: "America/New_York", after: "2025-11-04T06:30:30.000Z", localHour: 1, offset: 300, cron: "45 1 * * *", expected: "2025-11-04T06:45:00.000Z" },
  { name: "spring jump keeps first valid local minute", zone: "America/New_York", after: "2025-03-09T06:59:30.000Z", localHour: 1, offset: 300, cron: "* * * * *", expected: "2025-03-09T07:00:00.000Z" },
  { name: "spring missing hour remains skipped", zone: "America/New_York", after: "2025-03-09T06:59:30.000Z", localHour: 1, offset: 300, cron: "30 2 * * *", expected: "2025-03-10T06:30:00.000Z" },
  { name: "half-hour rollback stays future", zone: "Australia/Lord_Howe", after: "2025-04-05T15:15:30.000Z", localHour: 1, offset: -630, cron: "* * * * *", expected: "2025-04-05T15:30:00.000Z" },
  { name: "all five fields retain AND and list/range/step matching", zone: "UTC", after: "2025-11-01T06:30:30.000Z", localHour: 6, offset: 0, cron: "5,10-20/5 6 2 11 0", expected: "2025-11-02T06:05:00.000Z" }
];

let failures = 0;
for (const fixture of cases) {
  const previousZone = process.env.TZ;
  try {
    process.env.TZ = fixture.zone;
    const after = new Date(fixture.after);
    assert.equal(after.getHours(), fixture.localHour, "timezone must be active");
    assert.equal(after.getTimezoneOffset(), fixture.offset, "expected fold offset must be active");
    const result = nextCron(fixture.cron, after);
    console.log(`${fixture.name}: ${result.toISOString()}`);
    assert.ok(result.getTime() > after.getTime(), "cron must return a strictly future instant");
    assert.equal(result.toISOString(), fixture.expected);
    assert.equal(result.getSeconds(), 0);
    assert.equal(result.getMilliseconds(), 0);
    assert.equal(after.toISOString(), fixture.after, "caller date must not be mutated");
  } catch (error) {
    failures += 1;
    console.error(fixture.name, error);
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
}

const previousZone = process.env.TZ;
try {
  process.env.TZ = "UTC";
  assert.equal(new Date("2024-02-29T00:00:00Z").getTimezoneOffset(), 0);
  assert.throws(() => nextCron("* * * *", new Date("2024-02-29T00:00:00Z")), { message: "Cron expression must have five fields." });
  assert.throws(() => nextCron("0 0 29 2 *", new Date("2024-02-29T00:00:00Z")), { message: "Cron expression has no occurrence within one year." });
} finally {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
}
assert.equal(failures, 0, "all cron future/control fixtures must pass");
console.log("automation cron future invariant: 13 cases and 2 error controls passed");
