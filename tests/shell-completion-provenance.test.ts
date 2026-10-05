import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { HookRunner, readHookCompletionEvidence } from "../src/tools/hooks.js";
import { runShellCommand, type ShellCompletionEvidence } from "../src/tools/shell/runCommand.js";

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: undefined, killed: false, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => false, unref: () => child });
  return child;
}

const shortStop = { timeoutMs: 1_000, terminationGraceMs: 0, killSettleMs: 0 };

for (const [code, signal, expected] of [
  [0, null, "normal_exit"], [1, null, "normal_exit"], [124, null, "normal_exit"],
  [null, "SIGTERM", "unconfirmed"], [0, "SIGTERM", "unconfirmed"], [1, "SIGKILL", "unconfirmed"],
  [null, null, "unconfirmed"], [Number.NaN, null, "unconfirmed"]
] as const) {
  await test(`shell close(${String(code)}, ${String(signal)}) reports ${expected} exactly once`, async (t) => {
    const evidence: ShellCompletionEvidence[] = [];
    let child!: ChildProcess;
    t.mock.method(childProcess, "spawn", () => {
      child = fakeChild();
      queueMicrotask(() => { child.emit("close", code, signal); child.emit("close", 0, null); });
      return child;
    });
    syncBuiltinESMExports();
    try {
      const result = await runShellCommand("/tmp", "fake shell", { ...shortStop, onCompletionEvidence: (value) => evidence.push(value) });
      assert.deepEqual(evidence, [expected]);
      assert.equal(Object.hasOwn(result, "completionEvidence"), false);
      assert.equal(Object.hasOwn(result, "onCompletionEvidence"), false);
      assert.equal(JSON.stringify(result).includes("normal_exit"), false);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

for (const mode of ["sync-spawn-error", "async-spawn-error", "already-aborted", "timeout", "abort"] as const) {
  await test(`${mode} reports unconfirmed exactly once and preserves the public outcome`, async (t) => {
    const evidence: ShellCompletionEvidence[] = [];
    const controller = new AbortController();
    const failure = new Error(`Mock ${mode}`);
    let child: ChildProcess | undefined;
    const spawn = t.mock.method(childProcess, "spawn", () => {
      if (mode === "sync-spawn-error") throw failure;
      child = fakeChild();
      if (mode === "async-spawn-error") queueMicrotask(() => child?.emit("error", failure));
      if (mode === "abort") queueMicrotask(() => {
        Object.defineProperty(child!, "killed", { value: true });
        controller.abort(failure);
        child!.emit("close", 0, null);
      });
      return child;
    });
    syncBuiltinESMExports();
    if (mode === "already-aborted") controller.abort(failure);
    try {
      const pending = runShellCommand("/tmp", "fake shell", { ...shortStop, timeoutMs: mode === "timeout" ? 0 : 1_000,
        signal: controller.signal, onCompletionEvidence: (value) => evidence.push(value) });
      if (mode === "timeout") {
        const result = await pending;
        assert.equal(result.status, "timed_out");
        assert.equal(result.exitCode, 124);
      } else await assert.rejects(pending, (error) => error === failure);
      assert.deepEqual(evidence, ["unconfirmed"]);
      assert.equal(spawn.mock.callCount(), mode === "already-aborted" ? 0 : 1);
      // Cleanup must make a late normal close incapable of upgrading evidence.
      child?.emit("close", 0, null);
      assert.deepEqual(evidence, ["unconfirmed"]);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

await test("normal close followed by late abort preserves normal_exit and success", async (t) => {
  const controller = new AbortController();
  const evidence: ShellCompletionEvidence[] = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = fakeChild();
    queueMicrotask(() => { child.emit("close", 0, null); controller.abort(new Error("Mock late abort.")); });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const result = await runShellCommand("/tmp", "fake shell", { ...shortStop, signal: controller.signal, onCompletionEvidence: (value) => evidence.push(value) });
    assert.equal(result.status, "completed");
    assert.deepEqual(evidence, ["normal_exit"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

await test("numeric close after timeout starts cannot upgrade completion evidence", async (t) => {
  const evidence: ShellCompletionEvidence[] = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = fakeChild();
    setTimeout(() => { Object.defineProperty(child, "killed", { value: true }); child.emit("close", 0, null); }, 10);
    return child;
  });
  syncBuiltinESMExports();
  try {
    const result = await runShellCommand("/tmp", "fake shell", { timeoutMs: 0, terminationGraceMs: 100, killSettleMs: 0,
      onCompletionEvidence: (value) => evidence.push(value) });
    assert.equal(result.status, "timed_out");
    assert.deepEqual(evidence, ["unconfirmed"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

await test("invalid timeout rejects before spawn and reports unconfirmed once", async (t) => {
  const evidence: ShellCompletionEvidence[] = [];
  const spawn = t.mock.method(childProcess, "spawn", () => fakeChild());
  syncBuiltinESMExports();
  try {
    await assert.rejects(runShellCommand("/tmp", "fake shell", { timeoutMs: -1, onCompletionEvidence: (value) => evidence.push(value) }), /non-negative/u);
    assert.equal(spawn.mock.callCount(), 0);
    assert.deepEqual(evidence, ["unconfirmed"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const mode of ["success", "failure"] as const) {
  await test(`completion observer throws without changing ${mode}`, async (t) => {
    const evidence: ShellCompletionEvidence[] = [];
    const failure = new Error("Mock spawn failed.");
    t.mock.method(childProcess, "spawn", () => {
      if (mode === "failure") throw failure;
      const child = fakeChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });
    syncBuiltinESMExports();
    try {
      const pending = runShellCommand("/tmp", "fake shell", { ...shortStop, onCompletionEvidence: (value) => {
        evidence.push(value); throw new Error("Mock completion observer failed.");
      } });
      if (mode === "success") assert.equal((await pending).status, "completed");
      else await assert.rejects(pending, (error) => error === failure);
      assert.deepEqual(evidence, [mode === "success" ? "normal_exit" : "unconfirmed"]);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

await test("wrapper rejection after a normal-close observation cannot retain normal_exit proof", async (t) => {
  const evidence: ShellCompletionEvidence[] = [];
  const failure = new Error("Mock final status observer failed.");
  t.mock.method(childProcess, "spawn", () => {
    const child = fakeChild();
    const on = child.on.bind(child);
    child.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      const result = on(event, listener);
      // A synchronous fake boundary keeps the observer throw inside the Promise
      // executor, making this a rejected wrapper instead of an uncaught event.
      if (event === "close") child.emit("close", 0, null);
      return result;
    }) as typeof child.on;
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runShellCommand("/tmp", "fake shell", { ...shortStop,
      onUpdate: (update) => { if (update.text?.startsWith("Exited with")) throw failure; },
      onCompletionEvidence: (value) => evidence.push(value)
    }), (error) => error === failure);
    assert.deepEqual(evidence, ["unconfirmed"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

await test("hook authority stays private and cannot survive public cloning", async (t) => {
  t.mock.method(childProcess, "spawn", () => {
    const child = fakeChild();
    queueMicrotask(() => child.emit("close", 1, null));
    return child;
  });
  syncBuiltinESMExports();
  try {
    const runner = new HookRunner("/tmp", { beforeTool: [{ command: "fake hook", tools: [], extensions: [], timeoutMs: 1_000 }], afterTool: [] });
    const [outcome] = await runner.run("beforeTool", { tool: "fake target", path: "" });
    assert.ok(outcome);
    assert.equal(readHookCompletionEvidence(outcome), "normal_exit");
    assert.deepEqual(Object.keys(outcome), ["command", "exitCode", "output"]);
    assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { command: "fake hook", exitCode: 1, output: "" });
    assert.equal(readHookCompletionEvidence({ ...outcome }), "unconfirmed");
    assert.equal(readHookCompletionEvidence(Object.assign({ ...outcome }, { completionEvidence: "normal_exit" })), "unconfirmed");
    assert.equal(readHookCompletionEvidence(structuredClone(outcome)), "unconfirmed");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
