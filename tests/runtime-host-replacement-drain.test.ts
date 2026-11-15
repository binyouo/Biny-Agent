/** Registry lifecycle races only: no sockets, native services or model requests. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeHostExecution } from "../src/runtime/host/composition.js";
import { SessionRuntimeRegistry } from "../src/runtime/host/registry.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";

const commands = {} as CommandRuntime;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function runtime(sessionId: string, cleanup = async () => undefined) {
  let closes = 0;
  let unsubscribes = 0;
  let closePromise: Promise<void> | undefined;
  const handle = {
    getSnapshot: () => ({ revision: 0, info: { sessionId }, state: { kind: "idle" } }),
    subscribe: () => () => { unsubscribes++; },
    close: async () => {
      closePromise ??= Promise.resolve().then(async () => { closes++; await cleanup(); });
      await closePromise;
    }
  } as unknown as InteractiveRuntimeHandle;
  return { handle, get closes() { return closes; }, get unsubscribes() { return unsubscribes; } };
}
async function fixture(primary: boolean, oldCleanup?: () => Promise<void>, nextCleanup?: () => Promise<void>) {
  const id = primary ? "primary" : "secondary";
  const old = runtime(id, oldCleanup);
  const next = runtime(id, nextCleanup);
  const registry = new SessionRuntimeRegistry({ runtime: primary ? old.handle : runtime("primary").handle, commands }, {
    createRuntime: async () => ({ runtime: old.handle, commands }), onUpdate: () => undefined
  });
  if (!primary) await registry.ensure(id);
  return { id, old, next, registry, replace: () => registry.replace(id, { runtime: next.handle, commands }) };
}

for (const primary of [false, true]) {
  test(`${primary ? "primary" : "secondary"} replacement cannot escape shutdown after an already-settled close`, async () => {
    const f = await fixture(primary);
    await f.old.handle.close(); // The normal performRuntimeRestart order.
    const replacing = f.replace();
    const rejected = assert.rejects(replacing, /registry is closed/);
    await f.registry.closeAll();
    await rejected;
    assert.equal(f.next.closes, 1);
    assert.equal(f.old.closes, 1);
    assert.equal(f.old.unsubscribes, 1);
    assert.equal(f.next.unsubscribes, 1);
    assert.deepEqual(f.registry.list(), []);
  });

  test(`${primary ? "primary" : "secondary"} shutdown waits for both new cleanup and retiring runtime`, async () => {
    const oldGate = Promise.withResolvers<void>();
    const newGate = Promise.withResolvers<void>();
    const f = await fixture(primary, () => oldGate.promise, () => newGate.promise);
    const replacing = f.replace();
    const rejected = assert.rejects(replacing, /registry is closed/);
    let closed = false;
    const closing = f.registry.closeAll().then(() => { closed = true; });
    try {
      await turn();
      assert.equal(f.next.closes, 1, "shutdown owns the replacement even while the previous close is pending");
      newGate.resolve();
      await turn();
      assert.equal(closed, false, "retiring runtime still owns resources");
    } finally {
      oldGate.resolve(); newGate.resolve();
      await Promise.all([closing, rejected]);
    }
    assert.deepEqual(f.registry.list(), []);
  });

  test(`${primary ? "primary" : "secondary"} ordinary replacement stays registered and preserves its primary flag`, async () => {
    const f = await fixture(primary);
    const managed = await f.replace();
    assert.equal(managed.primary, primary);
    assert.equal(f.registry.get(f.id)?.runtime, f.next.handle);
    assert.equal(f.old.closes, 1);
    assert.equal(f.next.closes, 0);
    await f.registry.closeAll();
    assert.equal(f.next.closes, 1);
  });
}

for (const failing of ["old", "new"] as const) {
  test(`shutdown reports ${failing} cleanup failure rather than silently releasing ownership`, async () => {
    const gate = Promise.withResolvers<void>();
    const fail = async () => { await gate.promise; throw new Error(`${failing} cleanup fixture`); };
    const f = await fixture(false, failing === "old" ? fail : undefined, failing === "new" ? fail : undefined);
    const replacement = f.replace();
    const rejected = assert.rejects(replacement, failing === "old" ? /old cleanup fixture/ : /registry is closed/);
    const closing = f.registry.closeAll();
    const failedClose = assert.rejects(closing, error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors.map(String).join("\n"), new RegExp(`${failing} cleanup fixture`));
      return true;
    });
    gate.resolve();
    await Promise.all([rejected, failedClose]);
    assert.equal(f.next.closes, 1);
    assert.equal(f.old.closes, 1);
    assert.deepEqual(f.registry.list(), []);
  });
}


test("normal secondary restart cannot publish or leak its replacement when shutdown begins at handoff", async () => {
  const f = await fixture(false);
  const closed = Promise.withResolvers<void>();
  let published = 0;
  // Exercise the real restart orchestration with inert factory/Host boundaries.
  // No constructor, listener, model or native service is started.
  const execution = Object.assign(Object.create(RuntimeHostExecution.prototype) as RuntimeHostExecution, {
    registry: f.registry,
    runtimeRestartPromises: new Map(),
    factoryOptionsForSession: async () => undefined,
    createRuntime: async () => {
      queueMicrotask(() => queueMicrotask(() => {
        void f.registry.closeAll().then(closed.resolve, closed.reject);
      }));
      return { runtime: f.next.handle, commands };
    },
    host: { hasSessionWriter: () => false, publishSnapshot: () => { published++; }, sequence: 0 },
    businessComposition: { recoverGraphs: () => undefined, scheduleGoals: () => undefined }
  });
  const result = await execution.restartRuntime(f.id).then(() => "returned", error => String(error));
  await closed.promise;
  assert.equal(f.next.closes, 1, "the real restart handoff must not abandon its new runtime");
  assert.equal(published, 0, "a closed replacement must not be reported as a successful restart");
  assert.match(result, /registry is closed/);
  assert.deepEqual(f.registry.list(), []);
});
