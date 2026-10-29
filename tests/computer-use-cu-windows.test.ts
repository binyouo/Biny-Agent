import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { registerCuCommands } from "../src/cli/commands/cu.js";

async function run(target: string, json = true) {
  const command = new Command().exitOverride(); registerCuCommands(command);
  await command.parseAsync(["node", "biny", "cu", "windows", target, ...(json ? ["--json"] : [])]);
}

test("cu windows resolves the named running application before requesting its windows", async context => {
  const calls: Array<{ pid: number | undefined; days: number | undefined }> = [], output: string[] = [];
  const windows = [{ window_id: 42, title: "Document", frame: { w: 640, h: 480 } }];
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "list", async (_session: string, pid: number | undefined, _signal?: AbortSignal, days?: number) => {
    calls.push({ pid, days });
    return { data: { apps: pid === undefined
      ? [{ pid: 7, bundleId: "other.app", windows: [{ window_id: 99, title: "Wrong app" }] }, { pid: 12, bundleId: "target.app" }]
      : [{ pid: 12, bundleId: "target.app", windows }] }, images: [] };
  });
  await run("target.app");
  assert.deepEqual(calls, [{ pid: undefined, days: 0 }, { pid: 12, days: undefined }]);
  assert.deepEqual(JSON.parse(output[0]!), windows);
});

for (const disappeared of [false, true]) test(`cu windows reports an unavailable application${disappeared ? " after discovery" : " without launching it"}`, async context => {
  let calls = 0;
  const output: string[] = [];
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "list", async () => {
    calls++;
    return { data: { apps: disappeared && calls === 1 ? [{ pid: 12, bundleId: "target.app" }] : [] }, images: [] };
  });
  context.mock.method(NativeProcessDriver.prototype, "launchApp", async () => assert.fail("listing windows must not launch the application"));
  await assert.rejects(run("target.app"), /app_not_running/u);
  assert.deepEqual(output, []);
  assert.equal(calls, disappeared ? 2 : 1);
});

test("cu windows lists a PID directly and can print an AX window with unknown geometry", async context => {
  const calls: unknown[] = [], output: string[] = [];
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "list", async (_session: string, pid: number | undefined) => {
    calls.push(pid); return { data: { apps: [{ pid: 12, windows: [{ window_id: 42, title: "Document" }] }] }, images: [] };
  });
  await run("12", false);
  assert.deepEqual(calls, [12]);
  assert.match(output[0]!, /42.*Document/u);
  assert.doesNotMatch(output[0]!, /undefined|NaN/u);
});

test("cu windows preserves discovery errors and rejects invalid PIDs without listing all apps", async context => {
  const failure = new Error("driver_process_disconnected");
  let calls = 0;
  context.mock.method(NativeProcessDriver.prototype, "list", async () => { calls++; throw failure; });
  for (const target of ["0", "2147483648"]) await assert.rejects(run(target), error => error !== failure);
  assert.equal(calls, 0);
  await assert.rejects(run("target.app"), error => error === failure);
  assert.equal(calls, 1);
});

test("cu windows exposes focus and minimized state in both text and JSON", async context => {
  const output: string[] = [];
  const windows = [{ window_id: 42, title: "Focused", focused: true, minimized: false }, { window_id: 43, title: "Hidden", focused: false, minimized: true }];
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "list", async () => ({ data: { apps: [{ pid: 12, windows }] }, images: [] }));
  await run("12", false);
  assert.match(output[0]!, /^\*\s+42.*Focused$/mu);
  assert.match(output[0]!, /^\s+43.*Hidden.*已最小化$/mu);
  await run("12");
  assert.deepEqual(JSON.parse(output[1]!), windows);
});

test("cu windows exposes native read failures without printing an empty list or retrying", async context => {
  const output: string[] = [];
  let reads = 0, detached = 0, failure: Error | undefined;
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "detach", () => { detached++; });
  context.mock.method(NativeProcessDriver.prototype, "list", async () => {
    reads++;
    if (failure) throw failure;
    return { data: { apps: [{ pid: 12, windows: [] }] }, images: [] };
  });
  for (const message of ["window_list_read_failed: AXError -25204", "ax_not_granted: grant access", "window_list_unavailable: no readable source"]) {
    failure = new Error(message);
    await assert.rejects(run("12"), error => error === failure);
  }
  assert.equal(reads, 3);
  assert.equal(detached, 3);
  assert.deepEqual(output, []);
  failure = undefined;
  await run("12");
  assert.deepEqual(JSON.parse(output[0]!), [], "a successfully read empty window list remains valid");
});
