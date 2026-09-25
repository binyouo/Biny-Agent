/** Desktop 时间线索的自然日期范围按设备时区和周一边界计算。 */
import assert from "node:assert/strict";
import { naturalTemporalRanges } from "../src/desktop/renderer/src/temporalRanges.js";

const ranges = naturalTemporalRanges(new Date("2026-03-08T16:30:00.000Z"), "America/New_York");
assert.deepEqual(ranges.today, { startDate: "2026-03-08", endDate: "2026-03-09" });
assert.deepEqual(ranges.thisWeek, { startDate: "2026-03-02", endDate: "2026-03-09" });
assert.deepEqual(ranges.nextWeek, { startDate: "2026-03-09", endDate: "2026-03-16" });
assert.deepEqual(naturalTemporalRanges(new Date("2026-03-09T04:30:00.000Z"), "America/New_York").today,
  { startDate: "2026-03-09", endDate: "2026-03-10" });
console.log("temporal desktop range tests passed");
