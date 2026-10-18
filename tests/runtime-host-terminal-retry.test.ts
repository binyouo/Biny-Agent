/** New explicit retry API controls; added with product fix, not part of Red. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import type { HostFrame, HostRequestFrame } from "../src/runtime/host/protocol.js";
import { flush, ids, MemorySocket, observe, outcome, terminalFixture, until } from "./fixtures/runtime-host-terminal.js";

/** Extend only the Green transport controls; keep the accepted Red fixture frozen. */
function browserLeaseTransport(t: TestContext) {
  const state = { hold: false };
  const requests: Array<{ socket: MemorySocket; frame: HostRequestFrame; resolve(): void; reject(): void }> = [];
  const originalWrite = MemorySocket.prototype.write;
  t.mock.method(MemorySocket.prototype, "write", function (this: MemorySocket, data: string): boolean {
    const frame = JSON.parse(data) as HostFrame;
    if (frame.kind !== "request" || frame.operation !== "browser.automation.set") return originalWrite.call(this, data);
    const socket = this;
    const request = {
      socket,
      frame,
      resolve: () => socket.deliver({ kind: "response", requestId: frame.requestId, ok: true, result: undefined }),
      reject: () => socket.deliver({ kind: "response", requestId: frame.requestId, ok: false, error: "fixture browser lease rejected" })
    };
    requests.push(request);
    if (!state.hold) queueMicrotask(request.resolve);
    return true;
  });
  return { state, requests };
}

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

test("explicit retry waits for the required browser lease and keeps failed observations terminal after lease rejection", async t => {
  const f = await terminalFixture(t);
  const lease = browserLeaseTransport(t);
  f.state.capabilities = ["browser.automation.lease"];
  const client = await f.connect();
  const endpoint = { endpoint: "/fixture/browser.sock", token: "synthetic-browser-token", projectId: "project" };
  assert.equal(await client.setBrowserAutomation(endpoint), true);
  assert.equal(lease.requests.length, 1);
  const completion = observe(client.submitPromptForSession("a", "once", [], ids).completion);
  const idle = observe(client.waitForIdle("a"));
  await flush();
  const original = await f.terminal("entry", f.sockets[1]!);
  assert.deepEqual(completion(), { error: original }); assert.deepEqual(idle(), { error: original });
  await f.ownerAvailable();
  lease.state.hold = true;
  const current = f.snapshots.get("a")!;
  f.snapshots.set("a", { ...current, revision: 8 });
  const first = observe(client.retryConnection());
  const second = observe(client.retryConnection());
  await until(() => lease.requests.length === 2, "held recovery browser lease after subscription");
  assert.equal(f.requests.filter(frame => frame.operation === "subscribe").length, 3);
  assert.equal(first(), undefined); assert.equal(second(), undefined);
  assert.equal(client.getSnapshot("a").revision, 7, "subscribe data cannot commit before the lease");
  const beforeLease = observe(client.waitForIdle("idle")); await flush();
  assert.deepEqual(beforeLease(), { error: original });
  assert.throws(() => client.submitPromptForSession("a", "must not dispatch"), error => error === original);
  lease.requests[1]!.reject();
  await until(() => first() !== undefined && second() !== undefined, "browser lease failure fanout");
  const failure = first(); assert.ok(failure && "error" in failure);
  assert.match(String(failure.error), /fixture browser lease rejected/u);
  assert.deepEqual(second(), failure);
  assert.equal(client.getSnapshot("a").revision, 7);
  const afterFailure = observe(client.waitForIdle("idle")); await flush();
  assert.deepEqual(afterFailure(), { error: original });
  const recovered = observe(client.retryConnection());
  await until(() => lease.requests.length === 3, "next explicit recovery browser lease");
  assert.equal(recovered(), undefined);
  lease.requests[2]!.resolve();
  await until(() => recovered() !== undefined, "browser lease and snapshot recovery");
  assert.deepEqual(recovered(), { value: undefined });
  assert.equal(client.getSnapshot("a").revision, 8);
  await client.waitForIdle("idle");
  const freshIdle = observe(client.waitForIdle("a"));
  f.idle("a"); await flush();
  assert.deepEqual(freshIdle(), { value: undefined });
  assert.deepEqual(completion(), { error: original }); assert.deepEqual(idle(), { error: original });
  assert.equal(f.requests.filter(frame => frame.operation === "submit").length, 1, "lease recovery never replays the original run");
  assert.equal(f.requests.filter(frame => frame.operation === "start-interrupted").length, 0);
  assert.deepEqual(lease.requests.map(request => request.frame.payload), Array.from({ length: 3 }, () => ({ browserAutomation: endpoint })));
  await f.unchanged();
});

test("disconnect after a browser lease reply cannot commit stale recovery or complete the replacement owner's retry", async t => {
  const f = await terminalFixture(t);
  const lease = browserLeaseTransport(t);
  f.state.capabilities = ["browser.automation.lease"];
  const client = await f.connect();
  assert.equal(await client.setBrowserAutomation(undefined), true);
  const original = await f.terminal("entry", f.sockets[1]!);
  await f.ownerAvailable(); lease.state.hold = true;
  const current = f.snapshots.get("a")!;
  f.snapshots.set("a", { ...current, revision: 8 });
  const first = observe(client.retryConnection());
  await until(() => lease.requests.length === 2, "old owner held browser lease");
  assert.equal(first(), undefined);
  // Settle the actual lease request, then lose its socket in the same turn before
  // reconnect's continuation can commit the subscription snapshot or clear error.
  lease.requests[1]!.resolve();
  lease.requests[1]!.socket.destroy();
  await until(() => first() !== undefined, "old lease settlement loses connection ownership");
  const failure = first(); assert.ok(failure && "error" in failure);
  assert.equal(failure.error, original);
  assert.equal(client.getSnapshot("a").revision, 7, "old lease response cannot commit on a lost connection");
  const afterLoss = observe(client.waitForIdle("idle")); await flush();
  assert.deepEqual(afterLoss(), { error: original });
  f.state.epoch = "epoch-b"; await f.ownerAvailable();
  const next = observe(client.retryConnection());
  await until(() => lease.requests.length === 3, "replacement owner held browser lease");
  assert.equal(client.hostInfo?.hostEpoch, "epoch-b");
  assert.equal(next(), undefined);
  // Late old-owner response must neither revive its rejected attempt nor admit observers.
  lease.requests[1]!.resolve(); await flush();
  assert.deepEqual(first(), failure); assert.equal(next(), undefined);
  const beforeLease = observe(client.waitForIdle("idle")); await flush();
  assert.deepEqual(beforeLease(), { error: original });
  t.mock.timers.tick(1_000); await flush();
  assert.equal(lease.requests.length, 3, "explicit retry supersedes the old automatic timer");
  assert.equal(f.sockets.length, 4);
  lease.requests[2]!.resolve();
  await until(() => next() !== undefined, "replacement owner complete synchronization");
  assert.deepEqual(next(), { value: undefined });
  await client.waitForIdle("idle");
  assert.equal(client.getSnapshot("a").revision, 8);
  assert.deepEqual(lease.requests.map(request => request.frame.payload), Array.from({ length: 3 }, () => ({ browserAutomation: null })));
  assert.equal(f.requests.filter(frame => frame.operation === "submit" || frame.operation === "start-interrupted").length, 0);
  await f.unchanged();
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
