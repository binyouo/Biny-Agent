/** Existing public API regression. Freeze this file and its fixture for Red/Green. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeHostSpawnCircuitOpenError } from "../src/runtime/host/reconnect.js";
import { flush, ids, observe, outcome, terminalFixture, until } from "./fixtures/runtime-host-terminal.js";

for (const branch of ["entry", "queued"] as const) {
  test(`terminal reconnect ${branch} rejects existing completion and all idle observations`, async t => {
    const f = await terminalFixture(t);
    const submitted = f.client.submitPromptForSession("a", "once", [], ids);
    const completed = observe(submitted.completion);
    let editContinued = false;
    const idleA = observe(f.client.waitForIdle("a").then(() => { editContinued = true; }));
    const idleB = observe(f.client.waitForIdle("b"));
    const idleAll = observe(f.client.waitForIdle());
    await flush();
    const error = await f.terminal(branch);
    assert.ok(error instanceof RuntimeHostSpawnCircuitOpenError);
    for (const result of [completed(), idleA(), idleB(), idleAll()]) {
      assert.deepEqual(result, { error }, "terminal circuit must reject now, never remain pending or resolve idle");
      assert.equal(result && "error" in result ? result.error : undefined, error, "preserve original error identity");
    }
    assert.equal(editContinued, false);
    const local = f.client as unknown as { completions: Map<unknown, unknown>; idleWaiters: Set<unknown>; allListeners: Set<unknown> };
    assert.equal(local.completions.size, 0); assert.equal(local.idleWaiters.size, 0); assert.equal(local.allListeners.size, 0);
    for (const sessionId of ["a", "b", "idle", "missing", undefined]) {
      const future = observe(f.client.waitForIdle(sessionId)); await flush();
      assert.equal(future() && "error" in future()! ? (future() as { error: unknown }).error : undefined, error,
        "future idle must reject before trusting busy, idle or missing cache");
    }
    assert.throws(() => f.client.submitPromptForSession("a", "must not dispatch"), candidate => candidate === error);
    const interrupted = observe(f.client.startInterruptedTurnForSession("a")); await flush();
    assert.deepEqual(interrupted(), { error });
    assert.equal(f.requests.filter(frame => frame.operation === "run.submit").length, 1);
    assert.equal(f.requests.filter(frame => frame.operation === "start-interrupted").length, 0);
    await f.unchanged();
  });
}

test("transient disconnect keeps observations pending and resumes real JSONL completion/idle", async t => {
  const f = await terminalFixture(t);
  const completed = observe(f.client.submitPromptForSession("a", "once", [], ids).completion);
  const idle = observe(f.client.waitForIdle("a")); await flush();
  f.sockets[0]!.destroy(); await flush();
  assert.equal(completed(), undefined); assert.equal(idle(), undefined);
  await f.ownerAvailable();
  t.mock.timers.tick(300);
  await until(() => f.requests.some(frame => frame.operation === "run.inspect"), "automatic reconnect completion recovery");
  assert.equal(completed(), undefined); assert.equal(idle(), undefined);
  f.sockets.at(-1)!.deliver({ kind: "completion", runId: ids.runId, outcome });
  f.idle("a"); await flush();
  assert.deepEqual(completed(), { value: outcome }); assert.deepEqual(idle(), { value: undefined });
  assert.equal(f.requests.filter(frame => frame.operation === "run.submit").length, 1);
  await f.unchanged();
});

test("terminal state is client-local, and already settled completions stay settled", async t => {
  const f = await terminalFixture(t);
  const healthy = await f.connect();
  const completed = observe(f.client.submitPromptForSession("a", "once", [], ids).completion);
  await flush(); f.sockets[0]!.deliver({ kind: "completion", runId: ids.runId, outcome }); await flush();
  const healthyIdle = observe(healthy.waitForIdle("a"));
  await f.terminal("entry");
  assert.equal(healthyIdle(), undefined);
  f.idle("a", f.sockets[1]!); await flush();
  assert.deepEqual(healthyIdle(), { value: undefined });
  await healthy.waitForIdle("idle");
  assert.deepEqual(completed(), { value: outcome });
  await f.unchanged();
});

test("explicit close preserves completion rejection and idle resolution", async t => {
  const f = await terminalFixture(t);
  const completed = observe(f.client.submitPromptForSession("a", "once", [], ids).completion);
  const idle = observe(f.client.waitForIdle("a")); await flush();
  await f.client.close(); await flush();
  assert.match(String((completed() as { error: unknown }).error), /client closed/u);
  assert.deepEqual(idle(), { value: undefined });
  await f.client.waitForIdle("a");
  t.mock.timers.tick(60_000); await flush();
  assert.equal(f.sockets.length, 1);
  await f.unchanged();
});
