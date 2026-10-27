import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCron, nextCronOccurrence } from "../src/runtime/AutomationCron.js";

const reference = "2035-06-12T08:07:00.000Z";
const helpers = [nextCron, nextCronOccurrence] as const;

// Only pure date lookups: AutomationCron constructs an unnamed, paused Cron
// with two arguments and no callback, so these cases do not schedule jobs.
for (const helper of helpers) {
  for (const [label, expression] of [
    ["future UTC", "2035-06-13T08:07:00.000Z"],
    ["future offset", "2035-06-13T10:07:00+02:00"],
    ["future local", "2035-06-13T08:07:00"],
    ["equal UTC", reference],
    ["past UTC", "2035-06-11T08:07:00.000Z"]
  ] as const) {
    test(`${helper.name} rejects ${label} one-shot input as a cron expression`, () => {
      const after = new Date(reference);
      assert.throws(() => helper(expression, after, "UTC"), /Cron expression.*one-shot/u);
      assert.equal(after.toISOString(), reference);
    });
  }

  for (const [label, expression, expected] of [
    ["five fields", "* * * * *", "2035-06-12T08:08:00.000Z"],
    ["six fields", "15 * * * * *", "2035-06-12T08:07:15.000Z"],
    ["seven fields", "0 0 9 12 6 * 2035", "2035-06-12T09:00:00.000Z"],
    ["hourly macro", "@hourly", "2035-06-12T09:00:00.000Z"],
    ["daily macro", "@daily", "2035-06-13T00:00:00.000Z"]
  ] as const) {
    test(`${helper.name} preserves ${label} recurrence`, () => {
      const after = new Date(reference);
      const next = helper(expression, after, "UTC");
      assert.equal(next?.toISOString(), expected);
      assert.ok(next !== undefined && next.getTime() > after.getTime());
      assert.equal(after.toISOString(), reference);
    });
  }

  for (const [label, expression, timezone, error] of [
    ["malformed expression", "* * * *", "UTC", /five, six, or seven/u],
    ["impossible finite calendar", "0 0 0 31 2 * 2034", "UTC", /no .*occurrence/iu],
    ["invalid timezone", "* * * * *", "Mars/Base", /timezone/iu]
  ] as const) {
    test(`${helper.name} still rejects ${label}`, () => {
      const after = new Date(reference);
      assert.throws(() => helper(expression, after, timezone), error);
      assert.equal(after.toISOString(), reference);
    });
  }
}

test("exhausted finite cron stays optional for advancement and strict for creation", () => {
  const after = new Date(reference);
  const expression = "0 0 9 12 6 * 2034";
  assert.equal(nextCronOccurrence(expression, after, "UTC"), undefined);
  assert.throws(() => nextCron(expression, after, "UTC"), /no upcoming occurrence/u);
  assert.equal(after.toISOString(), reference);
});
