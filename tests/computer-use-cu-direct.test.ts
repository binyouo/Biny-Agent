import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { registerCuCommands } from "../src/cli/commands/cu.js";

const image = { mimeType: "image/jpeg", dataBase64: Buffer.from("fixture pixels").toString("base64") } as const;
const data = { pid: 12, window_id: 42, screenshot_width: 100, screenshot_height: 80, elements: [{ element_token: "e1", role: "AXButton", title: "Play" }] };
async function run(args: string[]) { const program = new Command().exitOverride(); registerCuCommands(program); await program.parseAsync(["node", "biny", "cu", ...args]); }

test("cu observation saves a readable screenshot and returns its path while using the direct native observation scope", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-cu-observe-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "snapshot.jpg"), output: string[] = [], requests: Array<{ command: string; args: Record<string, unknown> }> = [];
  await writeFile(file, "previous pixels");
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "observeRaw", async () => ({ data, images: [image] }));
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, args: Record<string, unknown>) => { requests.push({ command, args }); return { data, images: [image] }; });
  await run(["get_app_state", "12", "--window", "42", "--out", file, "--json"]);
  assert.deepEqual(requests, [{ command: "get_app_state", args: { pid: 12, window_id: 42 } }], "human CLI observations must populate the daemon's direct scope without a model lease");
  assert.equal(await readFile(file, "utf8"), "fixture pixels");
  assert.equal(output.length, 1);
  const body = JSON.parse(output[0]!);
  assert.equal(body.screenshot, file);
  assert.match(body.tree, /\(e1\).*Play/u);
  assert.deepEqual(await readdir(directory), ["snapshot.jpg"]);
});

test("cu observation reports an output write failure and removes only its own staging file", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-cu-write-failure-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "existing"), output: string[] = [];
  await mkdir(destination);
  await writeFile(path.join(destination, "keep.txt"), "keep");
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async () => ({ data, images: [image] }));
  await assert.rejects(run(["get_app_state", "12", "--out", destination, "--json"]), { code: "EISDIR" });
  assert.equal(await readFile(path.join(destination, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(await readdir(directory), ["existing"]);
  assert.deepEqual(output, [], "a failed write must not print a success receipt");
});

test("cu shot-out resolves relative to the invoking CLI and the default returns a readable unique file", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-cu-shot-out-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "snapshot.jpg"), output: string[] = [];
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async () => ({ data, images: [image] }));
  await run(["get_app_state", "12", "--shot-out", path.relative(process.cwd(), file), "--json"]);
  assert.equal(JSON.parse(output[0]!).screenshot, file);
  assert.equal(await readFile(file, "utf8"), "fixture pixels");
  for (let index = 0; index < 2; index++) {
    await run(["get_app_state", "12", "--json"]);
    const returned: string = JSON.parse(output[index + 1]!).screenshot;
    context.after(async () => rm(returned, { force: true }));
    assert.equal(await readFile(returned, "utf8"), "fixture pixels");
    assert.notEqual(returned, JSON.parse(output[index]!).screenshot);
  }
});

for (const scenario of [
  { args: ["click", "e1"], command: "click" },
  { args: ["type_text", "hello", "--pid", "12"], command: "type_text" },
  { args: ["press_key", "Return", "--pid", "12"], command: "press_key" },
  { args: ["scroll", "e1", "down"], command: "scroll" },
  { args: ["drag", "1", "2", "3", "4", "--pid", "12", "--window", "42"], command: "drag" },
  { args: ["perform_secondary_action", "e1"], command: "perform_secondary_action" },
  { args: ["set_value", "e1", "hello"], command: "set_value" }
]) test(`human CLI ${scenario.command} uses the direct scope across separate invocations`, async context => {
  context.mock.method(console, "log", () => undefined);
  let calls = 0;
  context.mock.method(NativeProcessDriver.prototype, "actRaw", async () => ({ data: { effect: "confirmed" }, images: [] }));
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, args: Record<string, unknown>) => {
    calls++; assert.equal(command, scenario.command);
    assert.equal(args.client_id, undefined); assert.equal(args.capture_id, undefined);
    return { data: { performed: true }, images: [] };
  });
  await run([...scenario.args, "--json"]);
  assert.equal(calls, 1, "a new CLI process cannot satisfy a model client's one-use capture lease");
});

for (const args of [
  ["click", "e1"], ["type_text", "hello", "--pid", "12"], ["press_key", "Return", "--pid", "12"],
  ["scroll", "e1", "down"], ["drag", "1", "2", "3", "4", "--pid", "12", "--window", "42"],
  ["perform_secondary_action", "e1"], ["set_value", "e1", "hello"], ["type", "e1", "hello"], ["press", "e1", "Enter"]
]) test(`cu ${args[0]} can hide its action indicator for one invocation`, async context => {
  context.mock.method(console, "log", () => undefined);
  const requests: Record<string, unknown>[] = [];
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (_command: string, fields: Record<string, unknown>) => {
    requests.push(fields); return { data: { performed: true }, images: [] };
  });
  await run([...args, "--no-cursor", "--json"]);
  assert.equal(requests[0]?.show_cursor, false);
  await run([...args, "--json"]);
  assert.equal(requests[1]?.show_cursor, undefined, "hiding one action must not disable the following action's indicator");
});

test("cu no-shot observation preserves an existing output file and exposes capture failures", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-cu-no-shot-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "existing.jpg"), output: string[] = [];
  await writeFile(file, "keep");
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  const reply = { data: { ...data, screenshot_error: "screen_recording_not_granted" }, images: [] };
  context.mock.method(NativeProcessDriver.prototype, "observeRaw", async () => reply);
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async () => reply);
  await run(["get_app_state", "12", "--no-shot", "--out", file, "--json"]);
  assert.equal(await readFile(file, "utf8"), "keep");
  const body = JSON.parse(output[0]!);
  assert.equal(body.screenshot, undefined);
  assert.equal(body.screenshot_error, "screen_recording_not_granted");
});
