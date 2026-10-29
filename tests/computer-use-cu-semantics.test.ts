import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerCuCommands } from "../src/cli/commands/cu.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

async function run(args: string[]) {
  const command = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerCuCommands(command); await command.parseAsync(["node", "biny", "cu", ...args]);
}

test("snap reads only the AX tree and reports the native window identity without capturing an image", async context => {
  const calls: unknown[] = [], output: string[] = [];
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    return { data: { pid: 12, windowId: 42, elements: [{ ref: "e1", role: "AXButton", title: "Play" }] }, images: [] };
  });
  await run(["snap", "test.app", "--window", "42", "--depth", "4", "--all", "--json"]);
  assert.deepEqual(calls, [{ command: "get_app_state", args: { bundle: "test.app", window_id: 42, max_depth: 4, interactive_only: false, no_shot: true } }]);
  const body = JSON.parse(output[0]!);
  assert.equal(body.window_id, 42);
  assert.match(body.tree, /\(e1\).*Play/u);
  assert.equal(body.screenshot, undefined);
  await run(["snap", "12"]);
  assert.match(output[1]!, /窗口 42/u);
});

test("snap rejects screenshot-only options before dispatch", async context => {
  let calls = 0;
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async () => { calls++; return { data: {}, images: [] }; });
  for (const option of ["--out", "--shot-out", "--shot-max-width"]) {
    await assert.rejects(run(["snap", "12", option, "unused", "--json"]), { code: "commander.unknownOption" });
  }
  assert.equal(calls, 0);
});

for (const button of ["left", "right", "middle"]) test(`cu drag dispatches the requested ${button} button to the exact window`, async context => {
  context.mock.method(console, "log", () => undefined);
  const calls: unknown[] = [];
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, args: Record<string, unknown>) => { calls.push({ command, args }); return { data: {}, images: [] }; });
  await run(["drag", "1.5", "2", "3", "4", "--pid", "12", "--window", "42", "--button", button, "--no-cursor", "--json"]);
  assert.deepEqual(calls, [{ command: "drag", args: { x1: 1.5, y1: 2, x2: 3, y2: 4, pid: 12, window_id: 42, button, show_cursor: false } }]);
});

test("invalid mouse buttons and non-finite drag coordinates are refused before native input", async context => {
  let calls = 0;
  context.mock.method(console, "log", () => undefined);
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async () => { calls++; return { data: {}, images: [] }; });
  for (const args of [["click", "e1", "--button", "typo"], ["drag", "1", "2", "3", "4", "--button", "typo"], ["drag", "bad", "2", "3", "4"], ["drag", "1", "2", "Infinity", "4"], ["drag", "", "2", "3", "4"]]) {
    await assert.rejects(run([...args, "--json"]));
  }
  assert.equal(calls, 0);
});

for (const spelling of ["--input-method", "--input_method"]) test(`type_text accepts a bundle target with ${spelling}`, async context => {
  context.mock.method(console, "log", () => undefined);
  const calls: unknown[] = [];
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, args: Record<string, unknown>) => { calls.push({ command, args }); return { data: {}, images: [] }; });
  await run(["type_text", "文字", "--bundle", "test.app", "--ref", "e1", spelling, "ax", "--json"]);
  assert.deepEqual(calls, [{ command: "type_text", args: { text: "文字", bundle: "test.app", ref: "e1", input_method: "ax" } }]);
});

test("set_value preserves empty text and whitespace while retaining numeric and boolean values", async context => {
  context.mock.method(console, "log", () => undefined);
  const values: unknown[] = [];
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (_command: string, args: Record<string, unknown>) => { values.push(args.value); return { data: {}, images: [] }; });
  for (const value of ["", "  ", "0", " 1.5 ", "false", "true", "hello"]) await run(["set_value", "e1", value, "--json"]);
  assert.deepEqual(values, ["", "  ", 0, 1.5, false, true, "hello"]);
});

for (const [args, expected] of [
  [["e1", "down"], { ref: "e1", direction: "down", pages: 1 }],
  [["e1", "left", "--pages", "2"], { ref: "e1", direction: "left", pages: 2 }],
  [["e1", "up", "--amount", "3"], { ref: "e1", direction: "up", amount: 3 }],
  [["e1", "down", "--pages", "2", "--amount", "3"], { ref: "e1", direction: "down", pages: 2 }],
  [["down", "--pid", "12"], { pid: 12, direction: "down", amount: 1 }],
  [["right", "--pid", "12", "--pages", "2"], { pid: 12, direction: "right", pages: 2 }]
] as const) test(`cu scroll uses pages for a reference and preserves explicit units: ${args.join(" ")}`, async context => {
  context.mock.method(console, "log", () => undefined);
  const calls: unknown[] = [];
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, fields: Record<string, unknown>) => {
    calls.push({ command, args: fields }); return { data: {}, images: [] };
  });
  await run(["scroll", ...args, "--no-cursor", "--json"]);
  assert.deepEqual(calls, [{ command: "scroll", args: { ...expected, show_cursor: false } }]);
});

test("cu lens rejects unknown modes before dispatch instead of toggling the indicator", async context => {
  context.mock.method(console, "log", () => undefined);
  const calls: unknown[] = [];
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args }); return { data: { enabled: false }, images: [] };
  });
  await assert.rejects(run(["lens", "typo", "--json"]));
  assert.equal(calls.length, 0);
  await run(["lens", "--json"]);
  await run(["lens", "off", "--json"]);
  await run(["lens", "status", "--json"]);
  assert.deepEqual(calls, [
    { command: "lens", args: { mode: "toggle" } },
    { command: "lens", args: { mode: "off" } },
    { command: "lens", args: { mode: "status" } }
  ]);
});
