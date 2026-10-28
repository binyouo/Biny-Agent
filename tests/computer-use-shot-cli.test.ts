import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerCuCommands } from "../src/cli/commands/cu.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

for (const [input, identity] of [["123", { pid: 123 }], ["test.app", { bundle: "test.app" }]] as const) {
  test(`cu shot preserves the requested ${input} target, window and image options`, async context => {
    const output: string[] = [], calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    context.mock.method(console, "log", (value: string) => { output.push(value); });
    context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      return { data: { path: "/private/target.jpg", width: 640, height: 480, windowId: 456 }, images: [] };
    });
    const program = new Command().exitOverride(); registerCuCommands(program);
    await program.parseAsync(["node", "biny", "cu", "shot", input, "--window", "456", "--out", "/private/target.jpg", "--max-width", "640", "--json"]);
    assert.deepEqual(calls, [{ command: "capture_screen", args: { ...identity, window_id: 456, out: "/private/target.jpg", max_width: 640 } }]);
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]!), { path: "/private/target.jpg", width: 640, height: 480, windowId: 456 });
  });
}

test("cu shot propagates a missing target instead of printing a successful output path", async context => {
  const output: string[] = [];
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  const failure = new Error("capture_window_not_found");
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async () => { throw failure; });
  const program = new Command().exitOverride(); registerCuCommands(program);
  await assert.rejects(program.parseAsync(["node", "biny", "cu", "shot", "123", "--window", "456", "--json"]), error => error === failure);
  assert.deepEqual(output, []);
});
