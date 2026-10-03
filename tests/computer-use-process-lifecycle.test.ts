import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { CuaProcessDriver, type CuaProcessDriverOptions } from "../src/computer/cuaDriver.js";
import type { ComputerAction } from "../src/computer/protocol.js";

const entry = new URL("./fixtures/cua-process-fixture.mjs", import.meta.url);
const action: ComputerAction = { pid: 42, windowId: "900", action: "press_key", captureId: "c1", delivery: "background", key: "Enter" };
const signal = () => new AbortController().signal;
const gone = (pid: number) => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
function idleClock() {
  let fire: (() => void) | undefined;
  return {
    clock: {
      setTimeout(callback: () => void) { fire = callback; return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout() { fire = undefined; }
    },
    tick() { const callback = fire; fire = undefined; callback?.(); }
  };
}
async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`fixture child ${pid} did not exit within the process-scheduling bound`);
}

test("single-flight start uses one isolated PID; stop waits for exit and restart replaces it", async () => {
  let crashes = 0;
  const driver = new CuaProcessDriver(() => { crashes++; }, entry);
  try {
    await Promise.all([driver.start(), driver.start(), driver.start()]);
    const data = (await driver.list("fixture", undefined, signal())).data;
    const pid = data.hostInstance as number;
    assert.notEqual(pid, process.pid);
    assert.equal(data.parentPid, process.pid);
    assert.equal(data.runAsNode, "1");
    process.kill(pid, 0);
    await driver.stop(); gone(pid);
    await assert.rejects(driver.list("fixture", undefined, signal()), /driver_not_connected/);
    await driver.start();
    const next = (await driver.diagnostics()).data.hostInstance as number;
    assert.notEqual(next, pid);
    console.log(`PID evidence: ${pid} exited; fresh child ${next}`);
  } finally { await driver.dispose(); }
  assert.equal(crashes, 0);
});

test("cold diagnostics closes its PID; concurrent start retains the enabled host", async () => {
  const driver = new CuaProcessDriver(() => undefined, entry);
  try {
    const cold = await driver.diagnostics(); gone(cold.data.hostInstance as number);
    await assert.rejects(driver.list("fixture", undefined, signal()), /driver_not_connected/);
    const [diagnostic] = await Promise.all([driver.diagnostics(), driver.start()]);
    const active = (await driver.list("fixture", undefined, signal())).data.hostInstance as number;
    assert.equal(active, diagnostic.data.hostInstance);
    process.kill(active, 0);
  } finally { await driver.dispose(); }
});

test("idle retirement releases the PID but enabled intent lazily starts a fresh host", async () => {
  const idle = idleClock();
  let crashes = 0;
  const driver = new CuaProcessDriver(() => { crashes++; }, entry, { idleTimeoutMs: 900_000, idleClock: idle.clock });
  try {
    await driver.start();
    const pid = (await driver.diagnostics()).data.hostInstance as number;
    idle.tick(); await waitGone(pid);
    const next = (await driver.list("fixture", undefined, signal())).data.hostInstance as number;
    assert.notEqual(next, pid);
    assert.equal(crashes, 0, "intentional retirement is not a crash");
    await driver.stop(); gone(next);
    await assert.rejects(driver.list("fixture", undefined, signal()), /driver_not_connected/);
  } finally { await driver.dispose(); }
});

test("cold diagnostics after idle retirement also exits without clearing enabled intent", async () => {
  const idle = idleClock();
  const driver = new CuaProcessDriver(() => undefined, entry, { idleClock: idle.clock });
  try {
    await driver.start();
    const original = (await driver.diagnostics()).data.hostInstance as number;
    idle.tick(); await waitGone(original);
    const diagnostic = (await driver.diagnostics()).data.hostInstance as number;
    gone(diagnostic);
    const active = (await driver.list("fixture", undefined, signal())).data.hostInstance as number;
    assert.notEqual(active, diagnostic);
  } finally { await driver.dispose(); }
});

test("busy calls cannot be retired by the idle clock", async () => {
  const idle = idleClock();
  const driver = new CuaProcessDriver(() => undefined, entry, { idleClock: idle.clock });
  try {
    await driver.start();
    const pid = (await driver.diagnostics()).data.hostInstance as number;
    const busy = driver.list("fixture", 104, signal());
    await driver.diagnostics();
    idle.tick(); process.kill(pid, 0);
    await driver.list("fixture", 106, signal());
    assert.equal((await busy).data.released, true);
    idle.tick(); await waitGone(pid);
  } finally { await driver.dispose(); }
});

test("diagnostics waiting for retirement cannot spawn a host after disposal", async () => {
  const idle = idleClock();
  const driver = new CuaProcessDriver(() => undefined, entry, { idleClock: idle.clock });
  await driver.start();
  const pid = (await driver.diagnostics()).data.hostInstance as number;
  idle.tick();
  const diagnostic = driver.diagnostics();
  const rejected = assert.rejects(diagnostic, /driver_disposed/);
  await driver.dispose();
  await rejected; gone(pid);
});

test("dispose rejects unresolved actions and force-kills a shutdown-resistant host", async () => {
  const driver = new CuaProcessDriver(() => undefined, entry, { shutdownTimeoutMs: 50, killTimeoutMs: 50 });
  await driver.start();
  const pid = (await driver.diagnostics()).data.hostInstance as number;
  const pending = driver.act("fixture", { ...action, key: "HangStop" }, signal());
  const rejected = assert.rejects(pending, /stopped|disposed|unknown/);
  await driver.diagnostics();
  await driver.dispose(); await rejected; gone(pid);
  await assert.rejects(driver.start(), /driver_disposed/);
  await assert.rejects(driver.diagnostics(), /driver_disposed/);
});

test("default shutdown completes before the desktop cleanup deadline", async () => {
  const driver = new CuaProcessDriver(() => undefined, entry);
  try {
    await driver.start();
    const pid = (await driver.diagnostics()).data.hostInstance as number;
    const busy = driver.act("fixture", { ...action, key: "HangStop" }, signal());
    const rejected = assert.rejects(busy, /stopped|unknown/);
    await driver.diagnostics();
    const started = Date.now();
    await driver.stop(); await rejected; gone(pid);
    // The contract depends on real OS signal delivery and child exit, bounded below the 5 s desktop gate.
    assert.ok(Date.now() - started < 4_500, "shutdown must leave margin within the desktop cleanup deadline");
  } finally { await driver.dispose(); }
});

test("failed idle termination clears enabled intent and reports the resource failure", async (t) => {
  const idle = idleClock();
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send(request: { id: string }, callback: (error: Error | null) => void) {
      queueMicrotask(() => {
        child.emit("message", { id: request.id, result: { data: {}, images: [] } });
        callback(null);
      });
      return true;
    },
    kill() { return false; }
  }) as unknown as ChildProcess;
  t.mock.method(childProcess, "fork", () => child);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let reported!: () => void;
  const crashed = new Promise<void>(resolve => { reported = resolve; });
  const driver = new CuaProcessDriver(reported, entry, { idleClock: idle.clock, shutdownTimeoutMs: 10, killTimeoutMs: 10 });
  await driver.start();
  idle.tick();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([crashed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("idle failure was not reported")), 1_000); })]);
    await assert.rejects(driver.list("fixture", undefined, signal()), /driver_not_connected/);
  } finally {
    if (timer) clearTimeout(timer);
    await assert.rejects(driver.dispose(), /driver_process_did_not_exit/);
  }
});

test("cancelled and crashed actions are not replayed in a replacement host", async () => {
  let crashes = 0;
  const driver = new CuaProcessDriver(() => { crashes++; }, entry);
  try {
    await driver.start();
    const before = (await driver.diagnostics()).data.hostInstance as number;
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(driver.act("fixture", action, abort.signal), { name: "AbortError" });
    assert.equal((await driver.diagnostics()).data.hostInstance, before);
    const pending = driver.act("fixture", action, signal());
    const rejected = assert.rejects(pending, /exited|unknown/);
    await assert.rejects(driver.list("fixture", 101, signal()), /exited|unknown/);
    await rejected; await waitGone(before);
    assert.equal(crashes, 1);
    await assert.rejects(driver.list("fixture", undefined, signal()), /driver_not_connected/);
    await driver.start();
    assert.notEqual((await driver.diagnostics()).data.hostInstance, before);
  } finally { await driver.dispose(); }
});

test("malformed and oversized replies terminate the host and clear pending work", async () => {
  for (const pid of [102, 103]) {
    let crashes = 0;
    const driver = new CuaProcessDriver(() => { crashes++; }, entry);
    try {
      await driver.start();
      const child = (await driver.diagnostics()).data.hostInstance as number;
      await assert.rejects(driver.list("fixture", pid, signal()), /invalid|too large|budget/);
      await waitGone(child);
      assert.equal(crashes, 1);
      await assert.rejects(driver.list("fixture", undefined, signal()), /driver_not_connected/);
    } finally { await driver.dispose(); }
  }
});

test("IPC admission is bounded and cleanup permits shutdown without lingering requests", async () => {
  const driver = new CuaProcessDriver(() => undefined, entry);
  try {
    await driver.start();
    const requests = Array.from({ length: 32 }, () => driver.list("fixture", 104, signal()));
    const cancelled = Promise.all(requests.map((request) => assert.rejects(request, /stopped/)));
    await assert.rejects(driver.list("fixture", 104, signal()), /driver_busy/);
    await driver.stop(); await cancelled;
  } finally { await driver.dispose(); }
});

test("request timeout terminates an unresponsive host rather than replaying work", async () => {
  const options: CuaProcessDriverOptions = { requestTimeoutMs: 2_000, shutdownTimeoutMs: 50, killTimeoutMs: 50 };
  let crashes = 0;
  const driver = new CuaProcessDriver(() => { crashes++; }, entry, options);
  try {
    await driver.start();
    const pid = (await driver.diagnostics()).data.hostInstance as number;
    options.requestTimeoutMs = 50;
    await assert.rejects(driver.list("fixture", 104, signal()), /timed out.*unknown/);
    await waitGone(pid);
    assert.equal(crashes, 1);
    await assert.rejects(driver.list("fixture", undefined, signal()), /driver_not_connected/);
  } finally { await driver.dispose(); }
});
