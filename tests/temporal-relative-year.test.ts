/** Relative year scopes only its own adjacent numeric month/day, using the source zone. */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseTemporalClues, type TemporalClue } from "../src/session/temporalMemory.js";

const root = mkdtempSync(path.join(os.tmpdir(), "biny-relative-year-"));
after(() => {
  try { assert.deepEqual(readdirSync(root), [], "pure parser must not create an index or signing key"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
type Expected = [expression: string, date: string | null, endDate?: string | null, time?: string | null];
interface Case { name: string; text: string; expected: Expected[]; sentAt?: string; zone?: string }
const cases: Case[] = [
  { name: "next year date", text: "明年1月5日交报告", expected: [["明年1月5日", "2027-01-05"]] },
  { name: "this year date", text: "今年1月5日", expected: [["今年1月5日", "2026-01-05"]] },
  { name: "horizontal space and suffix", text: "明年 \t1月5号下午3点半", expected: [["明年 \t1月5号下午3点半", "2027-01-05", null, "15:30"]] },
  { name: "unicode horizontal space", text: "今年\u30001月5", expected: [["今年\u30001月5", "2026-01-05"]] },
  { name: "leap target valid", text: "明年2月29日", sentAt: "2027-06-15T00:00:00Z", expected: [["明年2月29日", "2028-02-29"]] },
  { name: "leap target invalid", text: "明年2月29日", sentAt: "2028-06-15T00:00:00Z", expected: [["明年2月29日", null]] },
  { name: "this leap year", text: "今年2月29号", sentAt: "2028-06-15T00:00:00Z", expected: [["今年2月29号", "2028-02-29"]] },
  { name: "invalid month", text: "明年13月1日", expected: [["明年13月1日", null]] },
  { name: "invalid day", text: "今年4月31日", expected: [["今年4月31日", null]] },
  { name: "zero day", text: "明年1月0日", expected: [["明年1月0日", null]] },
  { name: "Shanghai next anchor year", text: "明年1月5日", sentAt: "2026-12-31T16:30:00Z", expected: [["明年1月5日", "2028-01-05"]] },
  { name: "Los Angeles previous anchor year", text: "明年1月5日", sentAt: "2026-12-31T16:30:00Z", zone: "America/Los_Angeles", expected: [["明年1月5日", "2027-01-05"]] },
  { name: "missing instant", text: "明年1月5日下午3点", sentAt: "", expected: [["明年1月5日下午3点", null, null, "15:00"]] },
  { name: "missing zone", text: "今年1月5日", zone: "", expected: [["今年1月5日", null]] },
  { name: "invalid zone", text: "明年1月5日", zone: "Invalid/Zone", expected: [["明年1月5日", null]] },
  { name: "invalid instant", text: "今年1月5日", sentAt: "invalid", expected: [["今年1月5日", null]] },
  { name: "standalone years", text: "今年复盘，明年再议", expected: [["今年", "2026-01-01", "2026-12-31"], ["明年", "2027-01-01", "2027-12-31"]] },
  { name: "punctuation boundary", text: "明年。1月5日", expected: [["明年", "2027-01-01", "2027-12-31"], ["1月5日", "2026-01-05"]] },
  { name: "word boundary", text: "明年再讨论。1月5日", expected: [["明年", "2027-01-01", "2027-12-31"], ["1月5日", "2026-01-05"]] },
  ...["\n", "\r\n", "\v", "\f", "\u2028", "\u2029"].map((separator): Case => ({ name: `vertical boundary ${JSON.stringify(separator)}`, text: `明年${separator}1月5日`, expected: [["明年", "2027-01-01", "2027-12-31"], ["1月5日", "2026-01-05"]] })),
  { name: "independent dates", text: "明年1月5日，1月6日，今年1月7日，明年1月8日", expected: [["明年1月5日", "2027-01-05"], ["1月6日", "2026-01-06"], ["今年1月7日", "2026-01-07"], ["明年1月8日", "2027-01-08"]] },
  { name: "explicit Chinese year", text: "2028年2月29日", zone: "", expected: [["2028年2月29日", "2028-02-29"]] },
  { name: "explicit ISO year", text: "2027-01-05", zone: "", expected: [["2027-01-05", "2027-01-05"]] },
  { name: "invalid ISO", text: "2027-02-29", expected: [["2027-02-29", null]] },
  { name: "unsupported year unchanged", text: "去年1月5日，后年1月6日", expected: [["1月5日", "2026-01-05"], ["1月6日", "2026-01-06"]] },
  { name: "range both explicit relative years", text: "今年12月31日至明年1月5日", expected: [["今年12月31日至明年1月5日", "2026-12-31", "2027-01-05"]] },
  { name: "range right compound", text: "2026-12-31到明年1月5日", expected: [["2026-12-31到明年1月5日", "2026-12-31", "2027-01-05"]] },
  { name: "range left compound", text: "明年1月5日~2027-01-07", expected: [["明年1月5日~2027-01-07", "2027-01-05", "2027-01-07"]] },
  { name: "reverse range stays separate", text: "明年1月5日到今年12月31日", expected: [["明年1月5日", "2027-01-05"], ["今年12月31日", "2026-12-31"]] },
  { name: "range no inherited year", text: "明年1月5日到1月6日", expected: [["明年1月5日", "2027-01-05"], ["1月6日", "2026-01-06"]] },
  { name: "equal endpoint", text: "明年1月5日到2027-01-05", expected: [["明年1月5日到2027-01-05", "2027-01-05"]] },
  { name: "invalid range endpoint", text: "明年2月28日到明年2月29日", expected: [["明年2月28日", "2027-02-28"], ["明年2月29日", null]] },
  { name: "time midnight", text: "今年1月5日上午12点", expected: [["今年1月5日上午12点", "2026-01-05", null, "00:00"]] },
  { name: "invalid time", text: "明年1月5日25:61", expected: [["明年1月5日25:61", "2027-01-05"]] },
  { name: "UTF16 offset and quote clipping", text: `${"前".repeat(130)}😀明年1月5日 09:30${"后".repeat(180)}`, expected: [["明年1月5日 09:30", "2027-01-05", null, "09:30"]] },
  { name: "day month week controls", text: "今天，明天，后天，昨天，本月，下个月，下周一", expected: [["今天", "2026-12-31"], ["明天", "2027-01-01"], ["后天", "2027-01-02"], ["昨天", "2026-12-30"], ["本月", "2026-12-01", "2026-12-31"], ["下个月", "2027-01-01", "2027-01-31"], ["下周一", "2027-01-04"]] },
  { name: "no date", text: "普通无日期文本", expected: [] },
  { name: "clue cap", text: Array.from({ length: 129 }, () => "明年1月5日").join("，"), expected: Array.from({ length: 128 }, (): Expected => ["明年1月5日", "2027-01-05"]) }
];
for (const item of cases) {
  test(item.name, () => {
    let cursor = 0;
    const expected: TemporalClue[] = item.expected.map(([expression, date, endDate = null, time = null]) => {
      const offset = item.text.indexOf(expression, cursor);
      assert.notEqual(offset, -1);
      cursor = offset + expression.length;
      return { expression, date, endDate, time, offset,
        quote: item.text.slice(Math.max(0, offset - 120), Math.min(item.text.length, offset + expression.length + 160)) };
    });
    const sentAt = item.sentAt ?? "2026-12-31T15:30:00Z";
    const zone = item.zone ?? "Asia/Shanghai";
    const actual = parseTemporalClues(item.text, sentAt || undefined, zone || undefined, root);
    assert.deepEqual(actual, expected);
  });
}
