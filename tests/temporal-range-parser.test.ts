/** Range composition uses the right period's inclusive end without opening the date index. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseTemporalClues } from "../src/session/temporalMemory.js";

const root = process.env.BINY_AGENT_DIR;
assert.ok(root, "Set an isolated BINY_AGENT_DIR when running this test directly.");
const october = "2026-10-10T03:00:00.000Z";
const shanghai = "Asia/Shanghai";
const parse = (text: string, sentAt?: string, timeZone?: string) => parseTemporalClues(text, sentAt, timeZone, root);
const dates = (text: string, sentAt?: string, timeZone?: string) => parse(text, sentAt, timeZone).map(({ date, endDate }) => [date, endDate]);

const ranges = [
  { name: "two complete weeks", text: "本周至下周，两个整周都在出差", sentAt: october, zone: shanghai,
    start: "2026-10-05", end: "2026-10-18" },
  { name: "months across a year boundary", text: "本月到下个月", sentAt: "2026-12-10T03:00:00.000Z", zone: shanghai,
    start: "2026-12-01", end: "2027-01-31" },
  { name: "complete years", text: "🧭计划：今年至明年，两个整年都在外地。", sentAt: october, zone: shanghai,
    start: "2026-01-01", end: "2027-12-31" },
  { name: "weeks across a year boundary", text: "本周到下周", sentAt: "2026-12-31T03:00:00.000Z", zone: shanghai,
    start: "2026-12-28", end: "2027-01-10" },
  { name: "a point at the right period's start", text: "2026-10-12至下周", sentAt: october, zone: shanghai,
    start: "2026-10-12", end: "2026-10-18" },
  { name: "spring DST", text: "本周至下周", sentAt: "2026-03-07T23:30:00-05:00", zone: "America/New_York",
    start: "2026-03-02", end: "2026-03-15" },
  { name: "fall DST", text: "本周至下周", sentAt: "2026-10-31T23:30:00-04:00", zone: "America/New_York",
    start: "2026-10-26", end: "2026-11-08" },
  { name: "an explicit offset already on local Monday", text: "本周至下周", sentAt: "2026-10-11T23:30:00-07:00", zone: shanghai,
    start: "2026-10-12", end: "2026-10-25" }
];

for (const fixture of ranges) {
  test(`composed range retains ${fixture.name}`, () => {
    assert.deepEqual(dates(fixture.text, fixture.sentAt, fixture.zone), [[fixture.start, fixture.end]]);
  });
}

test("single periods remain inclusive", () => {
  for (const [text, sentAt, start, end] of [
    ["下周", october, "2026-10-12", "2026-10-18"],
    ["下个月", "2026-12-10T03:00:00.000Z", "2027-01-01", "2027-01-31"],
    ["明年", october, "2027-01-01", "2027-12-31"]
  ] as const) {
    assert.deepEqual(dates(text, sentAt, shanghai), [[start, end]]);
  }
});

test("ISO endpoints preserve expression, UTF-16 offset, quote and the left time", () => {
  const text = "🧭约定：2026-10-12下午3点 至 2026-10-14下午4点。";
  assert.deepEqual(parse(text), [{ expression: "2026-10-12下午3点 至 2026-10-14下午4点",
    date: "2026-10-12", endDate: "2026-10-14", time: "15:00", offset: 5, quote: text }]);
  assert.deepEqual(dates("2026-10-12 至 2026-10-12"), [["2026-10-12", null]]);
});

test("composed periods preserve metadata and equivalent instant anchors", () => {
  const text = "🧭计划：今年至明年，两个整年都在外地。";
  assert.deepEqual(parse(text, october, shanghai).map(({ expression, time, offset, quote }) => ({ expression, time, offset, quote })),
    [{ expression: "今年至明年", time: null, offset: 5, quote: text }]);
  assert.deepEqual(parse("本周至下周", "2026-10-11T23:30:00-07:00", shanghai),
    parse("本周至下周", "2026-10-12T06:30:00Z", shanghai));
});

test("missing time zone leaves relative endpoints unresolved", () => {
  assert.deepEqual(parse("本周至下周", october), [
    { expression: "本周", date: null, endDate: null, time: null, offset: 0, quote: "本周至下周" },
    { expression: "下周", date: null, endDate: null, time: null, offset: 3, quote: "本周至下周" }
  ]);
});

test("range quote retains the bounded surrounding text", () => {
  const expression = "2026-10-12至2026-10-14";
  assert.deepEqual(parse("甲".repeat(125) + expression + "乙".repeat(170)), [{ expression,
    date: "2026-10-12", endDate: "2026-10-14", time: null, offset: 125,
    quote: "甲".repeat(120) + expression + "乙".repeat(160) }]);
});

test("reversed endpoints retain the existing separate-clue behavior", () => {
  assert.deepEqual(dates("2026-10-14至2026-10-12"), [["2026-10-14", null], ["2026-10-12", null]]);
  assert.deepEqual(dates("下周至本周", october, shanghai), [["2026-10-12", "2026-10-18"], ["2026-10-05", "2026-10-11"]]);
});
