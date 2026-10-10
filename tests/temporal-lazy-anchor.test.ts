/** Ordinary-text parsing only; formatter work follows the first date grammar match. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseTemporalClues, type TemporalClue } from "../src/session/temporalMemory.js";

const root = process.env.BINY_AGENT_DIR;
assert.ok(root, "Set an isolated BINY_AGENT_DIR when running this test directly.");
const sentAt = "2026-10-10T16:00:00.000Z";
const multiple = "今天；10月12日；2026-10-14";
const capped = Array.from({ length: 129 }, () => "今天").join("；");
const fixtures: Array<{ name: string; text: string; zone?: string; calls: number; parts: number; expected: TemporalClue[] }> = [
  { name: "ordinary text skips the formatter despite valid metadata", text: "请核对文档并整理要点。 Review the report.", calls: 0, parts: 0, expected: [] },
  { name: "one date preserves the local anchor, time and UTF-16 offset", text: "😀明天下午3点半交报告", calls: 1, parts: 1,
    expected: [{ expression: "明天下午3点半", date: "2026-10-12", endDate: null, time: "15:30", offset: 2, quote: "😀明天下午3点半交报告" }] },
  { name: "multiple dates reuse one anchor", text: multiple, calls: 1, parts: 1,
    expected: [
      { expression: "今天", date: "2026-10-11", endDate: null, time: null, offset: 0, quote: multiple },
      { expression: "10月12日", date: "2026-10-12", endDate: null, time: null, offset: 3, quote: multiple },
      { expression: "2026-10-14", date: "2026-10-14", endDate: null, time: null, offset: 10, quote: multiple }
    ] },
  { name: "an unresolved anchor is also cached across dates", text: multiple, zone: "Invalid/Nowhere", calls: 1, parts: 0,
    expected: [
      { expression: "今天", date: null, endDate: null, time: null, offset: 0, quote: multiple },
      { expression: "10月12日", date: null, endDate: null, time: null, offset: 3, quote: multiple },
      { expression: "2026-10-14", date: "2026-10-14", endDate: null, time: null, offset: 10, quote: multiple }
    ] },
  { name: "a date after a long prefix is still found", text: "甲".repeat(6_000) + "明天", calls: 1, parts: 1,
    expected: [{ expression: "明天", date: "2026-10-12", endDate: null, time: null, offset: 6_000, quote: "甲".repeat(120) + "明天" }] },
  { name: "the 128-clue cap and quote windows remain intact", text: capped, calls: 1, parts: 1,
    expected: Array.from({ length: 128 }, (_, index) => ({ expression: "今天", date: "2026-10-11", endDate: null, time: null,
      offset: index * 3, quote: capped.slice(Math.max(0, index * 3 - 120), index * 3 + 2 + 160) })) }
];

// Each hook is synchronous and restored before assertions; these tests must stay serial.
for (const fixture of fixtures) {
  test(fixture.name, { concurrency: false }, () => {
    assert.equal(fixture.text.includes("biny://date/"), false, "This suite must not enter the signed-reference path.");
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat");
    const original = Intl.DateTimeFormat;
    const partsDescriptor = Object.getOwnPropertyDescriptor(original.prototype, "formatToParts");
    const originalParts = original.prototype.formatToParts;
    assert.ok(constructorDescriptor && partsDescriptor);
    let calls = 0;
    let parts = 0;
    let actual: TemporalClue[];
    try {
      const counted: typeof Intl.DateTimeFormat = new Proxy(original, { construct(target, args, newTarget): Intl.DateTimeFormat {
        calls += 1;
        return Reflect.construct(target, args, newTarget === counted ? target : newTarget);
      } });
      Object.defineProperty(Intl, "DateTimeFormat", { ...constructorDescriptor, value: counted });
      Object.defineProperty(original.prototype, "formatToParts", { ...partsDescriptor,
        value: function(this: Intl.DateTimeFormat, ...args: Parameters<Intl.DateTimeFormat["formatToParts"]>) {
          parts += 1;
          return Reflect.apply(originalParts, this, args);
        } });
      actual = parseTemporalClues(fixture.text, sentAt, fixture.zone ?? "Asia/Shanghai", root);
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", constructorDescriptor);
      Object.defineProperty(original.prototype, "formatToParts", partsDescriptor);
    }
    assert.deepEqual(Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat"), constructorDescriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(original.prototype, "formatToParts"), partsDescriptor);
    assert.deepEqual(actual, fixture.expected);
    assert.equal(calls, fixture.calls, "formatter constructor attempts");
    assert.equal(parts, fixture.parts, "formatter formatToParts calls");
  });
}
