import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { runShellCommand } from "../src/tools/shell/runCommand.js";
import type { ToolUpdate } from "../src/tools/types.js";

function fixture(context: TestContext, signal?: AbortSignal, timeoutMs?: number) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, killed: false,
    unref() { return this; }
  });
  const spawn = context.mock.method(childProcess, "spawn", () => child as unknown as ChildProcess);
  syncBuiltinESMExports();
  context.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const updates: ToolUpdate[] = [];
  const running = runShellCommand(process.cwd(), "synthetic-output", { signal, timeoutMs, onUpdate: update => updates.push(update) });
  const output = () => updates.filter(update => update.kind === "stdout" || update.kind === "stderr");
  return { child, updates, running, output };
}

test("shell output bursts coalesce within 50ms and preserve stream order", async context => {
  const { child, running, output } = fixture(context);
  for (let index = 0; index < 100; index++) child.stdout.emit("data", Buffer.from("你🙂"));
  child.stderr.emit("data", Buffer.from("warning"));
  child.stdout.emit("data", Buffer.from("tail"));
  assert.deepEqual(output(), []);
  context.mock.timers.tick(49);
  assert.deepEqual(output(), []);
  context.mock.timers.tick(1);
  assert.deepEqual(output(), [
    { kind: "stdout", text: "你🙂".repeat(100) },
    { kind: "stderr", text: "warning" },
    { kind: "stdout", text: "tail" }
  ]);
  child.emit("close", 0);
  const result = await running;
  assert.equal(result.stdout, `${"你🙂".repeat(100)}tail`);
  assert.equal(result.stderr, "warning");
});

test("shell output flushes bounded batches even when the timer does not advance", async context => {
  const { child, running, output } = fixture(context);
  for (let index = 0; index < 32; index++) child.stdout.emit("data", Buffer.from("x".repeat(8192)));
  assert.equal(output().length, 4);
  assert.ok(output().every(update => Buffer.byteLength(update.text) === 65536));
  for (let index = 0; index < 128; index++) (index % 2 ? child.stderr : child.stdout).emit("data", Buffer.from("a"));
  assert.equal(output().length, 132);
  child.emit("close", 0);
  const result = await running;
  assert.equal(result.stdout, `${"x".repeat(262144)}${"a".repeat(64)}`);
  assert.equal(result.stderr, "a".repeat(64));
});

for (const ending of ["success", "error", "abort", "timeout"] as const) {
  test(`shell ${ending} flushes the pending decoded tail and leaves no late updates`, async context => {
    const controller = new AbortController();
    const { child, running, updates, output } = fixture(context, controller.signal, ending === "timeout" ? 10 : undefined);
    const failure = new Error("fixture stopped");
    const outcome = ending === "success" || ending === "timeout" ? running : assert.rejects(running, failure);
    child.stdout.emit("data", Buffer.from([65, 0xe2]));
    if (ending === "error") child.emit("error", failure);
    else {
      if (ending === "abort") {
        child.killed = true;
        controller.abort(failure);
      }
      if (ending === "timeout") {
        child.killed = true;
        context.mock.timers.tick(10);
      }
      child.emit("close", 0);
    }
    const result = await outcome;
    if (ending === "timeout") {
      assert.equal(result?.status, "timed_out");
      assert.equal(result?.exitCode, 124);
    }
    assert.equal(output().filter(update => update.kind === "stdout").map(update => update.text).join(""), "A�");
    if (ending === "success") assert.equal(updates.at(-1)?.kind, "status");
    const count = updates.length;
    context.mock.timers.tick(200_000);
    child.stdout.emit("data", Buffer.from("late"));
    assert.equal(updates.length, count);
  });
}

test("real shell progress retains every decoded byte before the terminal status", { timeout: 10_000 }, async () => {
  const stdout = `${"你🙂 output\n".repeat(4_000)}stdout tail`;
  const stderr = "warning\nstderr tail";
  const script = `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const updates: ToolUpdate[] = [];
  const result = await runShellCommand(process.cwd(), `${quote(process.execPath)} -e ${quote(script)}`, {
    onUpdate: update => updates.push(update)
  });
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  for (const kind of ["stdout", "stderr"] as const) {
    assert.equal(updates.filter(update => update.kind === kind).map(update => update.text).join(""), result[kind]);
  }
  assert.deepEqual(updates.at(-1), { kind: "status", text: "Exited with 0" });
});
