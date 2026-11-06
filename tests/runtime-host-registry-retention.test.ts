import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { SessionRuntimeRegistry } from "../src/runtime/host/registry.js";

function gate(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function runtimeHost(sessionId: string, hooks: { snapshot?(): void; close?(): Promise<void> } = {}) {
  const calls = { close: 0 };
  // These tests exercise registry ownership only, not prompt execution.
  const runtime = {
    getSnapshot() {
      hooks.snapshot?.();
      return { info: { sessionId }, state: { kind: "idle" }, queuedMessages: [] };
    },
    subscribe() { return () => undefined; },
    async close() {
      calls.close += 1;
      await hooks.close?.();
    }
  } as unknown as InteractiveAgentRuntime;
  return { runtime, commands: {} as CommandRuntime, calls };
}

function registry(createRuntime: (sessionId: string) => Promise<ReturnType<typeof runtimeHost>> = async (sessionId) => runtimeHost(sessionId)) {
  return new SessionRuntimeRegistry(runtimeHost("primary"), {
    createRuntime: async (sessionId) => {
      assert.ok(sessionId, "registry creation must supply its reserved session ID");
      return await createRuntime(sessionId);
    },
    sessionRuntimeCacheTarget: 8,
    onUpdate: () => undefined
  });
}

test("retention is reference counted and duplicate release cannot expose another user's runtime", async () => {
  let snapshotReads = 0;
  const sessions = registry(async (id) => runtimeHost(id, { snapshot: () => { snapshotReads += 1; } }));
  try {
    await sessions.ensure("target");
    const releaseFirst = sessions.retainSession("target");
    const releaseSecond = sessions.retainSession("target");
    snapshotReads = 0;
    assert.deepEqual(await sessions.evictIdle(), []);
    assert.equal(snapshotReads, 0, "the initial candidate filter must skip retained sessions");
    releaseFirst();
    releaseFirst();
    assert.deepEqual(await sessions.evictIdle(), [], "one holder must not release another holder's protection");
    releaseSecond();
    releaseSecond();
    assert.deepEqual(await sessions.evictIdle(), ["target"], "the final release must restore normal LRU eviction");
  } finally { await sessions.closeAll(); }
});

test("eviction rechecks retention acquired while an earlier candidate is closing", { timeout: 2_000 }, async () => {
  const closing = gate();
  const resumeClose = gate();
  const sessions = registry(async (id) => runtimeHost(id, id === "first" ? {
    close: async () => { closing.resolve(); await resumeClose.promise; }
  } : {}));
  let eviction: Promise<string[]> | undefined;
  try {
    const first = await sessions.ensure("first");
    const target = await sessions.ensure("target");
    first.lastActiveAt = 1;
    target.lastActiveAt = 2;
    eviction = sessions.evictIdle(2);
    await closing.promise;
    const release = sessions.retainSession("target");
    resumeClose.resolve();
    assert.deepEqual(await eviction, ["first"], "a stale candidate list must not override a new holder");
    assert.equal(sessions.get("target"), target);
    release();
    assert.deepEqual(await sessions.evictIdle(), ["target"]);
  } finally {
    resumeClose.resolve();
    await eviction;
    await sessions.closeAll();
  }
});

test("retention does not turn explicit session close into an implicit refusal", async () => {
  const target = runtimeHost("target");
  const sessions = registry(async () => target);
  try {
    await sessions.ensure("target");
    const release = sessions.retainSession("target");
    await sessions.closeSession("target");
    assert.equal(target.calls.close, 1);
    assert.equal(sessions.get("target"), undefined);
    release();
    release();
  } finally { await sessions.closeAll(); }
});

test("explicit replacement remains allowed and the same session retains its LRU protection", async () => {
  const previous = runtimeHost("target");
  const replacement = runtimeHost("target");
  const sessions = registry(async () => previous);
  try {
    await sessions.ensure("target");
    const release = sessions.retainSession("target");
    await sessions.replace("target", replacement);
    assert.equal(previous.calls.close, 1);
    assert.equal(sessions.get("target")?.runtime, replacement.runtime);
    assert.deepEqual(await sessions.evictIdle(), [], "replacement must not silently lose a session-scoped holder");
    release();
    assert.deepEqual(await sessions.evictIdle(), ["target"]);
    assert.equal(replacement.calls.close, 1);
  } finally { await sessions.closeAll(); }
});

test("shutdown closes retained sessions without waiting for holders and late release remains safe", async () => {
  const target = runtimeHost("target");
  const sessions = registry(async () => target);
  try {
    await sessions.ensure("target");
    const release = sessions.retainSession("target");
    await sessions.closeAll();
    assert.equal(target.calls.close, 1);
    assert.deepEqual(sessions.list(), []);
    assert.doesNotThrow(() => { release(); release(); });
    assert.throws(() => sessions.retainSession("later"), /registry is closed/);
  } finally { await sessions.closeAll(); }
});
