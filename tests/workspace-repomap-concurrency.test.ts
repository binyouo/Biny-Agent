import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { mock, test } from "node:test";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";

async function fixture(count = 96): Promise<{ root: string; context: WorkspaceContext; cleanup: () => Promise<void> }> {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "biny-repomap-pool-"));
  const root = path.join(state, "workspace");
  await fs.mkdir(root);
  for (let index = 0; index < count; index++) {
    await fs.writeFile(path.join(root, fileName(index)), `import { helper } from './shared.js';\nexport function symbol${index}() { return helper; }\n`);
  }
  return { root, context: new WorkspaceContext(root, [], 32768, path.join(state, "missing-global.md")), cleanup: () => fs.rm(state, { recursive: true, force: true }) };
}

function fileName(index: number): string {
  return `unit-${String(index).padStart(3, "0")}.ts`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("controlled operation did not reach its checkpoint")), 5000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "controlled operation did not reach its checkpoint");
    await nextImmediate();
  }
}

await test("repo map bounds whole mapper work without dropping files or unchanged cache hits", async () => {
  const f = await fixture();
  const originalStat = fs.stat.bind(fs);
  const originalOpen = fs.open.bind(fs);
  let fingerprintPending = 0;
  let fingerprintPeak = 0;
  let fingerprintCalls = 0;
  let opened = 0;
  let activeHandles = 0;
  let peakHandles = 0;
  const statSpy = mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    if (args[1]?.bigint !== true) return await originalStat(...args);
    fingerprintCalls++;
    fingerprintPeak = Math.max(fingerprintPeak, ++fingerprintPending);
    try { return await originalStat(...args); } finally { fingerprintPending--; }
  });
  const openSpy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    opened++;
    peakHandles = Math.max(peakHandles, ++activeHandles);
    const close = handle.close.bind(handle);
    mock.method(handle, "close", async () => {
      try { await close(); } finally { activeHandles--; }
    });
    return handle;
  });
  try {
    await f.context.initialize();
    assert.equal(f.context.status().repoMapEntries, 96);
    assert.equal(fingerprintCalls, 96);
    assert.equal(opened, 96);
    assert.equal(fingerprintPending, 0);
    assert.equal(activeHandles, 0);
    assert.ok(fingerprintPeak <= 32, `fingerprint dispatch must be bounded, saw ${fingerprintPeak}`);
    assert.ok(peakHandles <= 32, `header handles must be bounded, saw ${peakHandles}`);
    const before = await f.context.prepareTurn(fileName(95));
    assert.equal(before.repoMapCandidates[0]?.path, fileName(95));
    assert.ok(before.repoMapCandidates[0]?.symbols.includes("symbol95"));
    assert.equal(fingerprintCalls, 96, "warm turn must not scan fingerprints again");
    f.context.invalidateSnapshot();
    const after = await f.context.prepareTurn(fileName(95));
    assert.equal(fingerprintCalls, 192, "dirty refresh must still check every fingerprint");
    assert.equal(opened, 96, "unchanged dirty refresh must reuse parsed entries");
    assert.equal(after.repoMapCandidates[0], before.repoMapCandidates[0], "cached entry identity must survive");
    assert.deepEqual(after.repoMapCandidates, before.repoMapCandidates);
  } finally {
    statSpy.mock.restore();
    openSpy.mock.restore();
    await f.cleanup();
  }
});

for (const stage of ["open", "fstat", "read", "close"] as const) {
  await test(`abort during ${stage} rejects before blocked peers drain, closes active handles and permits retry`, async () => {
    await assertCancelledPipeline(stage, false);
  });
}

await test("aborted dirty refresh preserves the published cache and retries every changed file", async () => {
  await assertCancelledPipeline("read", true);
});

async function assertCancelledPipeline(stage: "open" | "fstat" | "read" | "close", dirty: boolean): Promise<void> {
  const f = await fixture();
  const previous = dirty ? await f.context.prepareTurn(fileName(95)) : undefined;
  const previousStatus = f.context.status();
  if (dirty) {
    for (let index = 0; index < 96; index++) await fs.writeFile(path.join(f.root, fileName(index)), `export function changed${index}() { return 2; }\n`);
    f.context.invalidateSnapshot();
  }
  const originalOpen = fs.open.bind(fs);
  const ready = deferred();
  const drained = deferred();
  const gates: Array<ReturnType<typeof deferred>> = [];
  const controller = new AbortController();
  const reason = new Error("intentional queued mapper cancellation");
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  let gating = true;
  let opened = 0;
  let closed = 0;
  const pause = async (): Promise<void> => {
    if (!gating) return;
    const gate = deferred();
    gates.push(gate);
    if (gates.length === 32) ready.resolve();
    await gate.promise;
  };
  const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    opened++;
    const close = handle.close.bind(handle);
    mock.method(handle, "close", async () => {
      if (stage === "close") await pause();
      await close();
      closed++;
      if (closed === opened) drained.resolve();
    });
    const stat = handle.stat.bind(handle);
    mock.method(handle, "stat", async (...statArgs: Parameters<typeof handle.stat>) => {
      if (stage === "fstat") await pause();
      return await stat(...statArgs);
    });
    const read = handle.read.bind(handle);
    mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
      if (stage === "read") await pause();
      return await read(...readArgs);
    });
    if (stage === "open") await pause();
    return handle;
  });
  const run = dirty ? f.context.prepareTurn(fileName(95), controller.signal) : f.context.initialize(controller.signal);
  const running = run.then(() => ({ resolved: true as const }), (error: unknown) => ({ resolved: false as const, error }));
  try {
    await within(ready.promise);
    await waitFor(() => !f.context.status().snapshotDirty);
    assert.equal(opened, 32);
    controller.abort(reason);
    gates[0]?.resolve();
    const outcome = await within(running);
    assert.equal(outcome.resolved, false);
    if (outcome.resolved) assert.fail("cancelled initialization resolved");
    assert.equal(outcome.error, reason, "preserve the exact cancellation reason");
    assert.equal(closed, 1, "rejection cannot wait for blocked peers to close");
    assert.equal(opened, 32, "no queued mapper may be admitted after rejection");
    assert.equal(f.context.status().repoMapEntries, previousStatus.repoMapEntries);
    assert.equal(f.context.status().repoMapRefreshedAt, previousStatus.repoMapRefreshedAt);
    assert.equal(f.context.status().repoMapDirty, true);
    if (previous) assert.ok(previous.repoMapCandidates[0]?.symbols.includes("symbol95"));
    gating = false;
    for (const gate of gates) gate.resolve();
    await within(drained.promise);
    await nextImmediate();
    await nextImmediate();
    assert.equal(closed, 32);
    assert.equal(opened, 32);
    assert.deepEqual(unhandled, []);
    const retried = await f.context.prepareTurn(fileName(95));
    assert.equal(f.context.status().repoMapEntries, 96);
    assert.ok(retried.repoMapCandidates[0]?.symbols.includes(dirty ? "changed95" : "symbol95"));
    assert.equal(opened, closed);
    assert.equal(opened, 128, "cancelled initial refresh must not publish a partial cache");
  } finally {
    controller.abort(reason);
    gating = false;
    for (const gate of gates) gate.resolve();
    await within(running);
    if (opened !== closed) await within(drained.promise);
    spy.mock.restore();
    process.off("unhandledRejection", onUnhandled);
    await f.cleanup();
  }
}

for (const stage of ["stat", "open", "fstat", "read", "close"] as const) {
  await test(`${stage} failure remains an uncached fallback while other files complete`, async () => {
    const f = await fixture(3);
    const target = path.join(f.root, fileName(1));
    const failure = Object.assign(new Error(`injected ${stage} failure`), { code: "EIO" });
    const originalStat = fs.stat.bind(fs);
    const originalOpen = fs.open.bind(fs);
    let failing = true;
    let opens = 0;
    let closes = 0;
    let targetAttempts = 0;
    const statSpy = mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      if (failing && stage === "stat" && args[0] === target && args[1]?.bigint === true) throw failure;
      return await originalStat(...args);
    });
    const openSpy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const selected = args[0] === target;
      if (selected) targetAttempts++;
      if (failing && selected && stage === "open") throw failure;
      const handle = await originalOpen(...args);
      opens++;
      const close = handle.close.bind(handle);
      mock.method(handle, "close", async () => {
        await close(); closes++;
        if (failing && selected && stage === "close") throw failure;
      });
      const stat = handle.stat.bind(handle);
      mock.method(handle, "stat", async (...statArgs: Parameters<typeof handle.stat>) => {
        if (failing && selected && stage === "fstat") throw failure;
        return await stat(...statArgs);
      });
      const read = handle.read.bind(handle);
      mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
        if (failing && selected && stage === "read") throw failure;
        return await read(...readArgs);
      });
      return handle;
    });
    try {
      const first = await f.context.prepareTurn(fileName(1));
      assert.equal(f.context.status().repoMapEntries, 3);
      assert.deepEqual(first.repoMapCandidates[0], { path: fileName(1), role: "other", symbols: [], imports: [], exports: [] });
      assert.ok((await f.context.prepareTurn(fileName(2))).repoMapCandidates[0]?.symbols.includes("symbol2"));
      assert.equal(opens, closes);
      const attempts = targetAttempts;
      failing = false;
      f.context.invalidateSnapshot();
      const retried = await f.context.prepareTurn(fileName(1));
      assert.ok(retried.repoMapCandidates[0]?.symbols.includes("symbol1"));
      assert.equal(targetAttempts, attempts + 1, "fallback must not be cached as a valid extraction");
      assert.equal(opens, closes);
    } finally { statSpy.mock.restore(); openSpy.mock.restore(); await f.cleanup(); }
  });
}

await test("out-of-order completion does not publish a partial map and preserves candidate ordering", async () => {
  const f = await fixture();
  const originalOpen = fs.open.bind(fs);
  const firstGate = deferred();
  const firstReady = deferred();
  const othersClosed = deferred();
  const completionOrder: string[] = [];
  const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const relative = path.basename(String(args[0]));
    const read = handle.read.bind(handle);
    mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
      if (relative === fileName(0)) { firstReady.resolve(); await firstGate.promise; }
      return await read(...readArgs);
    });
    const close = handle.close.bind(handle);
    mock.method(handle, "close", async () => {
      await close(); completionOrder.push(relative);
      if (completionOrder.length === 95) othersClosed.resolve();
    });
    return handle;
  });
  const running = f.context.initialize();
  try {
    await within(firstReady.promise);
    await within(othersClosed.promise);
    assert.equal(f.context.status().repoMapEntries, 0);
    assert.equal(f.context.status().repoMapRefreshedAt, undefined);
    firstGate.resolve();
    await within(running);
    assert.equal(completionOrder.at(-1), fileName(0));
    const turn = await f.context.prepareTurn("");
    assert.equal(f.context.status().repoMapEntries, 96);
    assert.deepEqual(turn.repoMapCandidates.map((entry) => entry.path), Array.from({ length: 12 }, (_, index) => fileName(index)));
  } finally { firstGate.resolve(); await running; spy.mock.restore(); await f.cleanup(); }
});

await test("pre-abort and fingerprint-time abort preserve the reason without opening headers", async () => {
  for (const stage of ["before", "fingerprint"] as const) {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error(`cancel at ${stage}`);
    if (stage === "before") controller.abort(reason);
    const originalStat = fs.stat.bind(fs);
    const originalOpen = fs.open.bind(fs);
    let fingerprints = 0;
    let pending = 0;
    let opens = 0;
    const statSpy = mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      if (args[1]?.bigint !== true) return await originalStat(...args);
      fingerprints++; pending++;
      try { const value = await originalStat(...args); controller.abort(reason); return value; }
      finally { pending--; }
    });
    const openSpy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => { opens++; return await originalOpen(...args); });
    try {
      await assert.rejects(f.context.initialize(controller.signal), (error: unknown) => error === reason);
      await waitFor(() => pending === 0);
      await nextImmediate();
      assert.equal(opens, 0);
      assert.equal(fingerprints, stage === "before" ? 0 : 32);
      assert.equal(f.context.status().repoMapEntries, 0);
      assert.equal(f.context.status().repoMapDirty, true);
    } finally { statSpy.mock.restore(); openSpy.mock.restore(); await f.cleanup(); }
  }
});

await test("the second path check rejects a symlink substituted after the fingerprint", async () => {
  const f = await fixture(3);
  const outside = path.join(path.dirname(f.root), "outside.ts");
  await fs.writeFile(outside, "export const ExternalSecret = 1;\n");
  const target = path.join(f.root, fileName(1));
  const originalStat = fs.stat.bind(fs);
  const originalOpen = fs.open.bind(fs);
  let replaced = false;
  let targetOpens = 0;
  const statSpy = mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    const value = await originalStat(...args);
    if (!replaced && args[0] === target && args[1]?.bigint === true) {
      replaced = true;
      await fs.unlink(target);
      await fs.symlink(outside, target);
    }
    return value;
  });
  const openSpy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === target || args[0] === outside) targetOpens++;
    return await originalOpen(...args);
  });
  try {
    const result = await f.context.prepareTurn(fileName(1));
    assert.equal(replaced, true);
    assert.equal(targetOpens, 0);
    assert.deepEqual(result.repoMapCandidates[0]?.symbols, []);
    assert.equal(f.context.status().repoMapEntries, 3);
  } finally { statSpy.mock.restore(); openSpy.mock.restore(); await f.cleanup(); }
});
