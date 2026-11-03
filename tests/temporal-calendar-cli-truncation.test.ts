/** Actual CLI function/helper source; actual native-result parser; synthetic native process boundary. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { readNativeCalendar, type NativeCalendarEvent } from "../src/session/nativeCalendar.js";

const source = readFileSync(new URL("../src/cli/commands/localCapabilities.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("localCapabilities.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["temporalCalendarCommand", "printResult", "isRejected"];
const declarations = names.map(name => {
  const matches = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `Expected exactly one actual ${name} declaration`);
  return matches[0]!.getText(ast).replace(/^export\s+/u, "");
}).join("\n");
const javascript = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
type CommandOptions = { from: string; to: string; timeZone: string; allowCalendar?: boolean; json?: boolean };
type Command = (options: CommandOptions) => Promise<void>;
const options = { from: "2026-10-30", to: "2026-10-31", timeZone: "UTC", allowCalendar: true };

const events: NativeCalendarEvent[] = Array.from({ length: 200 }, (_, index) => ({
  title: `Meeting ${String(index + 1)}`, startDate: "2026-10-30T12:00:00.000Z", endDate: "2026-10-30T13:00:00.000Z",
  calendar: index % 2 ? undefined : "Work", isAllDay: false, identifier: `event-${String(index)}`
}));

function fixture(payload: unknown, processFailure = false): { command: Command; logs: string[]; calls(): number } {
  const logs: string[] = [];
  let calls = 0;
  const reader: typeof readNativeCalendar = async (range, authorization) => {
    assert.deepEqual(range, { startDate: options.from, endDate: options.to, timeZone: options.timeZone });
    return await readNativeCalendar(range, {
      ...authorization, platform: "darwin", run: async (_command, args, runOptions) => {
        calls++;
        assert.deepEqual(args, []);
        assert.equal(runOptions.env.BINY_CALENDAR_FROM, options.from);
        assert.equal(runOptions.env.BINY_CALENDAR_TO, options.to);
        assert.equal(runOptions.env.BINY_CALENDAR_ZONE, options.timeZone);
        if (processFailure) throw new Error("synthetic native process failure");
        return { stdout: JSON.stringify(payload), stderr: "" };
      }
    });
  };
  const command = new Function("readNativeCalendar", "console", `${javascript}\nreturn temporalCalendarCommand;`)(reader, {
    log(value: string): void { logs.push(value); }
  }) as Command;
  return { command, logs, calls: () => calls };
}

test("plain calendar output reports an incomplete native result and suggests narrowing the date range", async () => {
  const f = fixture({ status: "ok", events, hasMore: true });
  await f.command(options);
  assert.equal(f.calls(), 1);
  assert.equal(f.logs.length, 1);
  const output = f.logs[0]!;
  const listing = events.map(event => `${event.startDate} · ${event.title}${event.calendar ? ` · ${event.calendar}` : ""}`).join("\n");
  assert.ok(output.startsWith(`${listing}\n\n`), "Preserve every original event line and its order before the warning");
  assert.match(output, /结果不完整/u);
  assert.match(output, /200 条日历事件/u);
  assert.match(output, /仍有更多结果/u);
  assert.match(output, /缩小日期范围/u);
});

test("exactly 200 complete events do not imply truncation", async () => {
  const f = fixture({ status: "ok", events, hasMore: false });
  await f.command(options);
  assert.equal(f.logs[0], events.map(event => `${event.startDate} · ${event.title}${event.calendar ? ` · ${event.calendar}` : ""}`).join("\n"));
});

test("JSON preserves the structured native result without a prose warning", async () => {
  const f = fixture({ status: "ok", events, hasMore: true });
  await f.command({ ...options, json: true });
  assert.equal(f.logs.length, 1);
  assert.deepEqual(JSON.parse(f.logs[0]!), { events: JSON.parse(JSON.stringify(events)), hasMore: true, coverage: "host-eventkit-calendars" });
});

test("complete empty calendars retain the existing no-events text", async () => {
  const f = fixture({ status: "ok", events: [], hasMore: false });
  await f.command(options);
  assert.deepEqual(f.logs, ["此日期范围没有日历事件。"]);
});

test("an incomplete empty response does not falsely claim the range has no events", async () => {
  const f = fixture({ status: "ok", events: [], hasMore: true });
  await f.command(options);
  assert.match(f.logs[0]!, /结果不完整/u);
  assert.doesNotMatch(f.logs[0]!, /此日期范围没有日历事件/u);
});

test("missing authorization does not call the native boundary or publish output", async () => {
  const f = fixture({ status: "ok", events, hasMore: true });
  await assert.rejects(f.command({ ...options, allowCalendar: false }), /explicit authorization/u);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.logs, []);
});

for (const [name, payload, failure, pattern] of [
  ["denied", { status: "denied" }, false, /access denied/u],
  ["native process error", undefined, true, /service unavailable/u],
  ["invalid native result", { status: "ok", events: [...events, events[0]], hasMore: true }, false, /invalid data/u]
] as const) test(`${name} does not publish a successful calendar listing`, async () => {
  const f = fixture(payload, failure);
  await assert.rejects(f.command(options), pattern);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.logs, []);
});
