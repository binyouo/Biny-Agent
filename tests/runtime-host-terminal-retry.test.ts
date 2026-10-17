/** New explicit retry API controls; added with product fix, not part of Red. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { flush, ids, observe, outcome, terminalFixture, until } from "./fixtures/runtime-host-terminal.js";

test("healthy retry is a no-op even when another client opens the shared circuit", async t => {
  const f = await terminalFixture(t);
  for (let i = 0; i < 3; i++) f.circuit.recordFailure();
  const wire = f.requests.length;
  await Promise.all([f.client.retryConnection(), f.client.retryConnection()]);
  assert.equal(f.circuit.consecutiveFailures, 3, "client retry never resets the shared circuit itself");
  assert.equal(f.requests.length, wire); assert.equal(f.sockets.length, 1);
  await f.client.waitForIdle("idle");
  await f.unchanged();
});

test("stopped retry does not reset a circuit to spawn an unavailable owner", async t => {
  const f = await terminalFixture(t);
  await f.terminal("entry");
  const result = observe(f.client.retryConnection());
  await until(() => result() !== undefined, "explicit retry circuit rejection");
  assert.ok(result() && "error" in result()!);
  assert.equal(f.circuit.consecutiveFailures, 3); assert.equal(f.sockets.length, 1);
  await f.unchanged();
});

test("hello alone cannot clear terminal error; failed subscribe stays terminal; full retry is single-flight", async t => {
  const f = await terminalFixture(t);
  const oldCompletion = observe(f.client.submitPromptForSession("a", "once", [], ids).completion);
  const oldIdle = observe(f.client.waitForIdle("a")); await flush();
  const original = await f.terminal("entry");
  assert.deepEqual(oldCompletion(), { error: original }); assert.deepEqual(oldIdle(), { error: original });
  await f.ownerAvailable(); f.state.subscribe = "hold";
  const first = observe(f.client.retryConnection());
  const second = observe(f.client.retryConnection());
  await until(() => f.held.length === 1, "retry hello and held subscribe");
  assert.equal(f.sockets.length, 2); assert.equal(first(), undefined); assert.equal(second(), undefined);
  assert.equal(f.circuit.consecutiveFailures, 0, "hello may clear shared count without repairing this client's observations");
  const beforeSync = observe(f.client.waitForIdle("idle")); await flush();
  assert.deepEqual(beforeSync(), { error: original });
  // Fail the actual in-flight subscribe after a successful hello.
  const request = f.requests.at(-1)!; assert.equal(request.operation, "subscribe");
  f.sockets.at(-1)!.deliver({ kind: "response", requestId: request.requestId, ok: false, error: "fixture subscribe rejected" });
  await until(() => first() !== undefined && second() !== undefined, "failed retry fanout");
  assert.match(String((first() as { error: unknown }).error), /fixture subscribe rejected/u);
  assert.equal((first() as { error: unknown }).error, (second() as { error: unknown }).error);
  const afterFailure = observe(f.client.waitForIdle("idle")); await flush();
  assert.deepEqual(afterFailure(), { error: original });
  // Explicit retry must cancel the automatic timer queued by the failed socket.
  f.state.subscribe = "hold"; f.state.epoch = "epoch-b";
  await f.ownerAvailable();
  const third = observe(f.client.retryConnection());
  const fourth = observe(f.client.retryConnection());
  await until(() => f.held.length === 2, "second explicit retry held subscription");
  assert.equal(f.sockets.length, 3);
  t.mock.timers.tick(1_000); await flush();
  assert.equal(f.held.length, 2, "queued auto retry cannot supersede explicit retry");
  f.held[1]!();
  await until(() => third() !== undefined && fourth() !== undefined, "successful retry fanout");
  assert.deepEqual(third(), { value: undefined }); assert.deepEqual(fourth(), { value: undefined });
  assert.equal(f.client.hostInfo?.hostEpoch, "epoch-b");
  const idle = observe(f.client.waitForIdle("a"));
  const fresh = observe(f.client.submitPromptForSession("a", "explicit new work", [], ids).completion);
  await flush(); assert.equal(fresh(), undefined); assert.equal(idle(), undefined);
  // Stale response from the abandoned socket cannot undo the new synchronization.
  f.held[0]!(); await flush();
  f.sockets.at(-1)!.deliver({ kind: "completion", runId: ids.runId, outcome });
  f.idle("a"); await flush();
  assert.deepEqual(fresh(), { value: outcome }); assert.deepEqual(idle(), { value: undefined });
  assert.deepEqual(oldCompletion(), { error: original }); assert.deepEqual(oldIdle(), { error: original });
  assert.equal(f.requests.filter(frame => frame.operation === "submit").length, 2, "only original and explicitly requested new work");
  assert.equal(f.requests.filter(frame => frame.operation === "subscribe").length, 3, "one subscribe per retry flight");
  await f.unchanged();
});

test("closed client retry rejects without creating a new transport", async t => {
  const f = await terminalFixture(t);
  await f.client.close();
  await assert.rejects(f.client.retryConnection(), /closed/u);
  assert.equal(f.sockets.length, 1); await f.unchanged();
});

test("disconnect after synchronized snapshot but before retry return cannot report success", async t => {
  const f = await terminalFixture(t);
  await f.terminal("entry"); await f.ownerAvailable(); f.state.subscribe = "hold";
  const retry = observe(f.client.retryConnection());
  await until(() => f.held.length === 1, "held retry subscription");
  const current = f.snapshots.get("a")!;
  f.snapshots.set("a", { ...current, revision: 8 });
  f.held[0]!();
  // Public cached revision is the semantic gate. Advance individual microtasks,
  // rather than guessing a count or replacing private recovery methods.
  for (let i = 0; i < 40 && f.client.getSnapshot("a").revision !== 8; i++) await Promise.resolve();
  assert.equal(f.client.getSnapshot("a").revision, 8, "full subscribe applied the fresh snapshot");
  assert.equal(retry(), undefined, "disconnect is injected before the caller sees success");
  f.sockets.at(-1)!.destroy(); await flush();
  assert.ok(retry() && "error" in retry()!, "a lost synchronized connection must reject explicit retry");
  assert.match(String((retry() as { error: unknown }).error), /connection was lost before recovery finished/u);
  await f.unchanged();
});

test("retired client retry rejects without reviving an intentionally retired observer", async t => {
  const f = await terminalFixture(t);
  f.state.capabilities = ["host.idle-retirement"];
  const retired = await f.connect();
  f.sockets[1]!.deliver({ kind: "retired", hostEpoch: "epoch-a", reason: "idle" }); await flush();
  assert.equal(retired.isRetired, true);
  await assert.rejects(retired.retryConnection(), /retired/u);
  assert.equal(f.sockets.length, 2); await f.unchanged();
});

for (const explicitlyRetry of [false, true]) {
test(`stale automatic discovery stays superseded after ${explicitlyRetry ? "explicit retry" : "another client resets shared circuit"}`, async t => {
  const f = await terminalFixture(t);
  const registrationPath = runtimeHostPaths(f.root).registrationPath;
  const originalOpen = fs.open.bind(fs);
  let enter = false;
  let intercept = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (intercept && args[0] === registrationPath) {
      intercept = false; enter = true;
      await gate;
      throw Object.assign(new Error("stale discovery no longer has a registration"), { code: "ENOENT" });
    }
    return await originalOpen(...args);
  });
  try {
    f.sockets[0]!.destroy(); await flush(); t.mock.timers.tick(300);
    await until(() => enter, "old auto recovery held in real discovery boundary");
    // An existing public read reconnects transport, without full subscription.
    await f.client.focusSession("a");
    for (let i = 0; i < 3; i++) f.circuit.recordFailure();
    const errors = f.failures.length;
    f.sockets[1]!.destroy(); await flush();
    await until(() => f.failures.length > errors, "new disconnect terminal entry");
    const terminal = observe(f.client.waitForIdle("idle")); await flush();
    assert.ok(terminal() && "error" in terminal()!);
    await f.ownerAvailable();
    let healthy = f.client;
    if (explicitlyRetry) await f.client.retryConnection();
    else healthy = await f.connect();
    const idle = observe(healthy.waitForIdle("a"));
    release(); await flush();
    // Allow the released old read's catch/finally chain to finish before asserting.
    await until(() => f.sockets.length === 3, "new synchronized socket");
    assert.equal(f.circuit.consecutiveFailures, 0);
    await healthy.waitForIdle("idle");
    if (!explicitlyRetry) {
      const stillTerminal = observe(f.client.waitForIdle("idle")); await flush();
      assert.deepEqual(stillTerminal(), terminal(), "another client's hello cannot revive this stopped observer");
    }
    assert.equal(idle(), undefined);
    f.idle("a"); await flush(); assert.deepEqual(idle(), { value: undefined });
    assert.equal(f.requests.filter(frame => frame.operation === "submit" || frame.operation === "start-interrupted").length, 0);
    await f.unchanged();
  } finally { release(); await flush(); }
});
}
