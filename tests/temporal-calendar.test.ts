/** 本机日历只在显式请求时读取；错误边界不能被当作空日程。 */
import assert from "node:assert/strict";
import { readNativeCalendar } from "../src/session/nativeCalendar.js";

const range = { startDate: "2026-10-03", endDate: "2026-10-06", timeZone: "Asia/Shanghai" };
const event = { title: "开会", startDate: "2026-10-03T02:00:00.000Z", endDate: "2026-10-03T03:00:00.000Z", calendar: "工作", isAllDay: false };
let calls = 0;
const run = async (command: string, args: string[], options: { env: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> => {
  calls += 1;
  assert.match(command, /calendar-reader$/u);
  assert.deepEqual(args, []);
  assert.equal(options.env.BINY_CALENDAR_FROM, range.startDate);
  return { stdout: JSON.stringify({ status: "ok", events: [event], hasMore: false }), stderr: "" };
};
await assert.rejects(readNativeCalendar(range, { authorized: false, platform: "darwin", run }), /authorization|授权/iu);
assert.equal(calls, 0);
const result = await readNativeCalendar(range, { authorized: true, platform: "darwin", run });
assert.equal(result.events[0]?.title, "开会");
assert.equal(result.coverage, "host-eventkit-calendars");
assert.equal(calls, 1);
await assert.rejects(readNativeCalendar({ ...range, endDate: "2026-09-01" }, { authorized: true, platform: "darwin", run }), /range|日期/iu);
await assert.rejects(readNativeCalendar(range, { authorized: true, platform: "linux", run }), /macOS|unavailable/iu);
await assert.rejects(readNativeCalendar(range, { authorized: true, platform: "darwin", run: async () => ({ stdout: '{"status":"denied"}', stderr: "" }) }), /denied|拒绝/iu);
await assert.rejects(readNativeCalendar(range, { authorized: true, platform: "darwin", run: async () => ({ stdout: '{"status":"timeout"}', stderr: "" }) }), /timed out/iu);
await assert.rejects(readNativeCalendar(range, { authorized: true, platform: "darwin", run: async () => { throw Object.assign(new Error("timed out"), { killed: true }); } }), /timeout|timed out/iu);
await assert.rejects(readNativeCalendar(range, { authorized: true, platform: "darwin", run: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } }), /unavailable|ENOENT/iu);
await assert.rejects(readNativeCalendar(range, { authorized: true, platform: "darwin", run: async () => ({ stdout: '{"status":"ok","events":[{"title":"made up"}]}', stderr: "" }) }), /invalid|event/iu);
await assert.rejects(readNativeCalendar(range, { authorized: true, platform: "darwin", run: async () => ({
  stdout: JSON.stringify({ status: "ok", events: [{ ...event, startDate: "2026-11-03T02:00:00.000Z", endDate: "2026-11-03T03:00:00.000Z" }], hasMore: false }), stderr: ""
}) }), /outside|range|invalid/iu);
const dst = await readNativeCalendar({ startDate: "2026-03-08", endDate: "2026-03-09", timeZone: "America/New_York" }, {
  authorized: true, platform: "darwin", run: async () => ({ stdout: JSON.stringify({ status: "ok", hasMore: false, events: [{
    ...event, startDate: "2026-03-09T03:30:00.000Z", endDate: "2026-03-09T04:30:00.000Z"
  }] }), stderr: "" })
});
assert.equal(dst.events.length, 1, "DST transition uses local midnight, not a fixed UTC offset");
console.log("temporal calendar tests passed");
