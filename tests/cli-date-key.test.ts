import assert from "node:assert/strict";
import { resolveDateKey } from "../src/cli/dateKey.js";

// The test runner gives this file its own process. Restore its timezone afterward.
const originalTimeZone = process.env.TZ;
const cases: Record<string, Array<[string, string]>> = {
  "America/New_York": [
    ["2026-03-09T00:30:00-04:00", "2026-03-08"],
    ["2026-11-01T23:30:00-05:00", "2026-10-31"],
    ["2026-07-15T12:00:00-04:00", "2026-07-14"]
  ],
  "America/Nuuk": [["2026-03-29T23:30:00-01:00", "2026-03-28"]],
  UTC: [
    ["2024-03-01T00:30:00Z", "2024-02-29"],
    ["2026-03-01T23:30:00Z", "2026-02-28"],
    ["2026-01-01T12:00:00Z", "2025-12-31"],
    ["0099-01-01T12:00:00Z", "98-12-31"]
  ],
  // Date labels retain the preceding civil day even when no local instant exists.
  "America/Sao_Paulo": [["2018-11-05T00:30:00-02:00", "2018-11-04"]],
  "Pacific/Apia": [["2011-12-31T12:00:00+14:00", "2011-12-30"]]
};
let failures = 0;
function check(label: string, action: () => void): void {
  try {
    action();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}`, error);
  }
}
try {
  for (const [zone, fixtures] of Object.entries(cases)) {
    process.env.TZ = zone;
    for (const [instant, expected] of fixtures) {
      check(`yesterday ${zone} ${instant}`, () => {
        const now = new Date(instant);
        assert.equal(now.getFullYear(), Number(instant.slice(0, 4)), "fixture local year");
        assert.equal(now.getMonth() + 1, Number(instant.slice(5, 7)), "fixture local month");
        assert.equal(now.getDate(), Number(instant.slice(8, 10)), "fixture local day");
        assert.equal(now.getHours(), Number(instant.slice(11, 13)), "fixture local hour");
        const original = now.getTime();
        assert.equal(resolveDateKey("yesterday", now), expected);
        assert.equal(now.getTime(), original, "does not mutate the supplied clock");
      });
    }
    const now = new Date(2026, 6, 15, 12);
    check("today uses local calendar", () => assert.equal(resolveDateKey("today", now), "2026-07-15"));
    check("default clock uses current local date", () => {
      const before = new Date();
      const actual = resolveDateKey("today");
      const after = new Date();
      const localKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      assert.ok([localKey(before), localKey(after)].includes(actual));
    });
  }
  process.env.TZ = "UTC";
  const now = new Date("2026-07-15T12:00:00Z");
  for (const value of ["2024-02-29", "2026-02-31", "0001-01-01", "2026-99-99"]) {
    check(`explicit input preserved ${value}`, () => assert.equal(resolveDateKey(value, now), value));
  }
  for (const value of ["", "Today", " yesterday", "today ", "2026-2-03", "2026/02/03", "2026-02-03T00:00:00Z"]) {
    check(`invalid format ${JSON.stringify(value)}`, () => assert.throws(
      () => resolveDateKey(value, now),
      { message: `日期必须是 today、yesterday 或 YYYY-MM-DD：${value}` }
    ));
  }
} finally {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
}
assert.equal(process.env.TZ, originalTimeZone, "restores the test process timezone");
assert.equal(failures, 0, `${failures} date-key checks failed`);
