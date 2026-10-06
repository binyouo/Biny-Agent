/** Deterministic adapter lifecycle tests; no model downloads or native inference. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalEmbeddingManager, type LocalEmbeddingManagerOptions } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

type TransformersModule = Awaited<ReturnType<NonNullable<LocalEmbeddingManagerOptions["moduleLoader"]>>>;
type FeatureExtractor = Awaited<ReturnType<TransformersModule["pipeline"]>>;
type TensorOutput = Awaited<ReturnType<FeatureExtractor>>;
const modelId = "multilingual-e5-small";

await test("close preserves an embedding admitted during extractor initialization", async () => {
  await withFixture(async ({ manager, runtime, hooks, calls }) => {
    const starting = deferred<void>();
    const startup = deferred<FeatureExtractor>();
    const adapter = fakeExtractor();
    hooks.pipeline = async () => { starting.resolve(); return await startup.promise; };
    const embedding = runtime.embed({ texts: ["pending startup"], inputType: "query" });
    const settled = Promise.allSettled([embedding]);
    await starting.promise;
    const closing = manager.close();
    assert.equal(manager.isReady(), false);
    startup.resolve(adapter.extractor);
    await closing;
    const [result] = await settled;
    await nextTurn();
    assert.equal(result?.status, "fulfilled", "admitted requests cannot run on a disposed extractor");
    assert.deepEqual(adapter.events, ["embed:start", "embed:end", "dispose"]);
    assert.equal(adapter.disposals, 1);
    assert.equal(calls.pipelines, 1);
    assert.equal(manager.isReady(), false, "retired initialization cannot restore readiness");
  });
});

await test("close returns while inference is pending and defers extractor disposal", async () => {
  await withFixture(async ({ manager, runtime, hooks }) => {
    const running = deferred<void>();
    const inference = deferred<void>();
    const adapter = fakeExtractor(async () => { running.resolve(); await inference.promise; });
    hooks.pipeline = async () => adapter.extractor;
    const embedding = runtime.embed({ texts: ["in flight"], inputType: "query" });
    const settled = Promise.allSettled([embedding]);
    await running.promise;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await nextTurn();
    const closedWhilePending = closed;
    const earlyDisposals = adapter.disposals;
    inference.resolve();
    await closing;
    assert.equal((await settled)[0]?.status, "fulfilled");
    await nextTurn();
    assert.equal(closedWhilePending, true, "an unbounded inference must not hold shutdown open");
    assert.equal(earlyDisposals, 0, "close must not free an active inference resource");
    assert.deepEqual(adapter.events, ["embed:start", "embed:end", "dispose"]);
  });
});

await test("retirement covers all batches of an admitted request", async () => {
  await withFixture(async ({ manager, runtime, hooks }) => {
    let closing: Promise<void> | undefined;
    const adapter = fakeExtractor(async () => { closing ??= manager.close(); });
    hooks.pipeline = async () => adapter.extractor;
    const result = await runtime.embed({ texts: Array.from({ length: 65 }, (_, index) => `text ${index}`), inputType: "passage" });
    await closing;
    await nextTurn();
    assert.equal(result.embeddings.length, 65);
    assert.deepEqual(adapter.batchSizes, [32, 32, 1]);
    assert.equal(adapter.disposals, 1);
    assert.equal(adapter.events.at(-1), "dispose");
  });
});

await test("close drains every concurrent borrower of a shared extractor", async () => {
  await withFixture(async ({ manager, runtime, hooks, calls }) => {
    const bothRunning = deferred<void>();
    const first = deferred<void>();
    const second = deferred<void>();
    let active = 0;
    const adapter = fakeExtractor(async (texts) => {
      active += 1;
      if (active === 2) bothRunning.resolve();
      await (texts[0] === "first" ? first.promise : second.promise);
    });
    hooks.pipeline = async () => adapter.extractor;
    const embeddings = [
      runtime.embed({ texts: ["first"], inputType: "query" }),
      runtime.embed({ texts: ["second"], inputType: "passage" })
    ];
    const settled = Promise.allSettled(embeddings);
    await bothRunning.promise;
    const closing = manager.close();
    first.resolve();
    await nextTurn();
    const earlyDisposals = adapter.disposals;
    second.resolve();
    await closing;
    assert.equal(earlyDisposals, 0, "the second borrower still owns the extractor");
    assert.ok((await settled).every((result) => result.status === "fulfilled"));
    await nextTurn();
    assert.equal(calls.pipelines, 1, "initialization remains coalesced");
    assert.equal(adapter.disposals, 1);
  });
});

await test("failed inference releases ownership without hiding the request error", async () => {
  await withFixture(async ({ manager, runtime, hooks }) => {
    const running = deferred<void>();
    const inference = deferred<void>();
    const failure = new Error("fixture inference failed");
    const adapter = fakeExtractor(async () => { running.resolve(); await inference.promise; });
    hooks.pipeline = async () => adapter.extractor;
    const embedding = runtime.embed({ texts: ["fails"], inputType: "query" });
    const rejected = assert.rejects(embedding, (error) => error === failure);
    await running.promise;
    const closing = manager.close();
    inference.reject(failure);
    await rejected;
    await closing;
    await nextTurn();
    assert.equal(adapter.disposals, 1);
    assert.equal(adapter.events.at(-1), "dispose");
  });
});

await test("cancellation while inference is running drains it and skips later batches", async () => {
  await withFixture(async ({ manager, runtime, hooks }) => {
    const running = deferred<void>();
    const inference = deferred<void>();
    const controller = new AbortController();
    const reason = new DOMException("fixture cancellation", "AbortError");
    const adapter = fakeExtractor(async () => { running.resolve(); await inference.promise; });
    hooks.pipeline = async () => adapter.extractor;
    const embedding = runtime.embed({ texts: Array.from({ length: 33 }, (_, index) => `text ${index}`), inputType: "passage", signal: controller.signal });
    const rejected = assert.rejects(embedding, (error) => error === reason);
    await running.promise;
    controller.abort(reason);
    const closing = manager.close();
    await nextTurn();
    const earlyDisposals = adapter.disposals;
    inference.resolve();
    await rejected;
    await closing;
    await nextTurn();
    assert.equal(earlyDisposals, 0);
    assert.deepEqual(adapter.batchSizes, [32]);
    assert.equal(adapter.disposals, 1);
  });
});

await test("cancellation while initialization is pending frees the extractor without invoking it", async () => {
  await withFixture(async ({ manager, runtime, hooks }) => {
    const starting = deferred<void>();
    const startup = deferred<FeatureExtractor>();
    const controller = new AbortController();
    const reason = new DOMException("fixture startup cancelled", "AbortError");
    const adapter = fakeExtractor();
    hooks.pipeline = async () => { starting.resolve(); return await startup.promise; };
    const embedding = runtime.embed({ texts: ["cancelled startup"], inputType: "query", signal: controller.signal });
    const rejected = assert.rejects(embedding, (error) => error === reason);
    await starting.promise;
    controller.abort(reason);
    const closing = manager.close();
    startup.resolve(adapter.extractor);
    await rejected;
    await closing;
    await nextTurn();
    assert.deepEqual(adapter.events, ["dispose"]);
    assert.equal(manager.isReady(), false);
  });
});

await test("malformed output releases a retired extractor", async () => {
  await withFixture(async ({ manager, runtime, hooks }) => {
    let closing: Promise<void> | undefined;
    const adapter = fakeExtractor(async () => {
      closing = manager.close();
      return { data: new Float32Array(384), dims: [1, 383] };
    });
    hooks.pipeline = async () => adapter.extractor;
    await assert.rejects(runtime.embed({ texts: ["bad dimensions"], inputType: "query" }), /unexpected dimensions/u);
    await closing;
    await nextTurn();
    assert.equal(adapter.disposals, 1);
  });
});

await test("retired initialization failure cannot evict a replacement extractor", async () => {
  await withFixture(async ({ manager, runtime, hooks, calls }) => {
    const starting = deferred<void>();
    const startup = deferred<FeatureExtractor>();
    const failure = new Error("fixture startup failed");
    const replacement = fakeExtractor();
    hooks.pipeline = async () => {
      if (calls.pipelines === 1) { starting.resolve(); return await startup.promise; }
      return replacement.extractor;
    };
    const embedding = runtime.embed({ texts: ["old startup"], inputType: "query" });
    const rejected = assert.rejects(embedding, (error) => error === failure);
    await starting.promise;
    const closing = manager.close();
    await runtime.embed({ texts: ["replacement"], inputType: "query" });
    startup.reject(failure);
    await rejected;
    await closing;
    assert.equal(manager.isReady(), true, "the replacement generation retains readiness");
    await runtime.embed({ texts: ["reuse replacement"], inputType: "query" });
    assert.equal(calls.pipelines, 2, "stale failure must not remove the replacement cache entry");
    await manager.close();
    assert.equal(replacement.disposals, 1);
    assert.equal(manager.isReady(), false);
  });
});

await test("duplicate close and replacement requests retain independent disposal ownership", async () => {
  await withFixture(async ({ manager, runtime, hooks, calls }) => {
    const running = deferred<void>();
    const inference = deferred<void>();
    const retired = fakeExtractor(async () => { running.resolve(); await inference.promise; });
    const replacement = fakeExtractor();
    hooks.pipeline = async () => calls.pipelines === 1 ? retired.extractor : replacement.extractor;
    const embedding = runtime.embed({ texts: ["retiring inference"], inputType: "query" });
    const settled = Promise.allSettled([embedding]);
    await running.promise;
    let closed = false;
    const closing = Promise.all([manager.close(), manager.close()]).then(() => { closed = true; });
    await nextTurn();
    const closedWhilePending = closed;
    const earlyDisposals = retired.disposals;
    try {
      await runtime.embed({ texts: ["new generation"], inputType: "query" });
      assert.equal(calls.pipelines, 2, "existing post-close admission semantics are preserved");
      assert.equal(manager.isReady(), true);
      await manager.close();
      assert.equal(replacement.disposals, 1);
    } finally {
      inference.resolve();
      await settled;
      await closing;
    }
    assert.equal(closedWhilePending, true, "duplicate close must not wait for unbounded inference");
    assert.equal(earlyDisposals, 0, "duplicate close must not dispose a busy resource");
    assert.equal((await settled)[0]?.status, "fulfilled");
    await nextTurn();
    assert.equal(retired.disposals, 1, "late settlement disposes the retired generation exactly once");
    assert.equal(replacement.disposals, 1);
    assert.equal(manager.isReady(), false, "late retirement cannot resurrect readiness");
  });
});

await test("close still awaits disposal when there are no admitted embeddings", async () => {
  await withFixture(async ({ manager, runtime, hooks }) => {
    const disposal = deferred<void>();
    const adapter = fakeExtractor();
    const dispose = adapter.extractor.dispose;
    adapter.extractor.dispose = async () => { await disposal.promise; await dispose(); };
    hooks.pipeline = async () => adapter.extractor;
    await runtime.embed({ texts: ["complete before close"], inputType: "query" });
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await nextTurn();
    const closedBeforeDisposal = closed;
    disposal.resolve();
    await closing;
    assert.equal(closedBeforeDisposal, false, "idle disposal retains the existing awaited close contract");
    assert.equal(adapter.disposals, 1);
  });
});

await test("late disposal failure remains best effort without an unhandled rejection", async () => {
  await withFixture(async ({ manager, runtime, hooks }) => {
    const running = deferred<void>();
    const inference = deferred<void>();
    const adapter = fakeExtractor(async () => { running.resolve(); await inference.promise; });
    const dispose = adapter.extractor.dispose;
    adapter.extractor.dispose = async () => { await dispose(); throw new Error("fixture disposal failed"); };
    hooks.pipeline = async () => adapter.extractor;
    const embedding = runtime.embed({ texts: ["late disposal failure"], inputType: "query" });
    const settled = Promise.allSettled([embedding]);
    await running.promise;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await nextTurn();
    const closedWhilePending = closed;
    inference.resolve();
    await closing;
    assert.equal(closedWhilePending, true);
    assert.equal((await settled)[0]?.status, "fulfilled");
    await nextTurn();
    assert.equal(adapter.disposals, 1);
  });
});

await test("remove waits for an admitted embedding before disposal and cache deletion", async () => {
  await withFixture(async ({ manager, runtime, hooks, calls }) => {
    const running = deferred<void>();
    const inference = deferred<void>();
    const adapter = fakeExtractor(async () => { running.resolve(); await inference.promise; });
    hooks.pipeline = async () => adapter.extractor;
    const embedding = runtime.embed({ texts: ["removing inactive model"], inputType: "query" });
    const settled = Promise.allSettled([embedding]);
    await running.promise;
    const removing = manager.remove(modelId);
    const removed = Promise.allSettled([removing]);
    await nextTurn();
    const earlyDisposals = adapter.disposals;
    const earlyClears = calls.clears;
    inference.resolve();
    const [removal] = await removed;
    assert.equal(removal?.status, "fulfilled");
    if (removal?.status !== "fulfilled") throw new Error("Expected completed model removal");
    assert.deepEqual(removal.value, { filesDeleted: 0, bytesFreed: 0 });
    assert.equal(earlyDisposals, 0);
    assert.equal(earlyClears, 0);
    assert.equal((await settled)[0]?.status, "fulfilled");
    assert.equal(adapter.disposals, 1);
    assert.equal(calls.clears, 1);
    assert.equal(manager.isReady(), false);
    await assert.rejects(manager.createRuntime(modelId), /has not been downloaded/u);
  });
});

await test("ordinary cache reuse, request validation and active-model protection are preserved", async () => {
  await withFixture(async ({ manager, runtime, calls }) => {
    await assert.rejects(runtime.embed({ texts: [], inputType: "query" }), /between 1 and 256/u);
    await assert.rejects(runtime.embed({ texts: [" "], inputType: "query" }), /cannot be empty/u);
    assert.equal(calls.pipelines, 0);
    const first = await runtime.embed({ texts: ["first"], inputType: "query" });
    const second = await runtime.embed({ texts: ["second"], inputType: "passage" });
    assert.equal(calls.pipelines, 1);
    assert.equal(manager.isReady(), true);
    assert.equal(first.fingerprint, runtime.fingerprint);
    assert.equal(second.dimensions, 384);
    assert.equal(second.embeddings[0]?.[0], 1);
    await assert.rejects(manager.remove(modelId, { activeModel: modelId }), /active embedding model/u);
    assert.equal(calls.clears, 0);
    await manager.close();
    await manager.close();
    assert.equal(manager.isReady(), false);
  });
});

interface Fixture {
  manager: LocalEmbeddingManager;
  runtime: EmbeddingModelRuntime;
  hooks: { pipeline: () => Promise<FeatureExtractor> };
  calls: { pipelines: number; clears: number };
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-local-retirement-"));
  const calls = { pipelines: 0, clears: 0 };
  let installed = true;
  const hooks = { pipeline: async () => fakeExtractor().extractor };
  const manager = new LocalEmbeddingManager(root, {
    moduleLoader: async () => ({
      pipeline: async (_task, _model, options) => {
        assert.equal(options.local_files_only, true, "fixtures must use the offline inference path");
        calls.pipelines += 1;
        return await hooks.pipeline();
      },
      ModelRegistry: {
        is_pipeline_cached: async () => installed,
        clear_pipeline_cache: async () => { calls.clears += 1; installed = false; return { filesDeleted: 0 }; }
      }
    })
  });
  try {
    const runtime = await manager.createRuntime(modelId);
    await body({ manager, runtime, hooks, calls });
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
}

function fakeExtractor(onEmbed?: (texts: string[]) => Promise<TensorOutput | void>): {
  extractor: FeatureExtractor;
  events: string[];
  batchSizes: number[];
  readonly disposals: number;
} {
  const events: string[] = [];
  const batchSizes: number[] = [];
  let disposals = 0;
  let active = 0;
  const extractor: FeatureExtractor = Object.assign(async (texts: string[]) => {
    assert.equal(disposals, 0, "extractor must be live when inference starts");
    events.push("embed:start");
    batchSizes.push(texts.length);
    active += 1;
    try {
      const output = await onEmbed?.(texts);
      assert.equal(disposals, 0, "extractor must stay live until inference finishes");
      if (output) return output;
      const data = new Float32Array(texts.length * 384);
      for (let row = 0; row < texts.length; row += 1) data[row * 384] = 1;
      return { data, dims: [texts.length, 384] };
    } finally {
      active -= 1;
      events.push("embed:end");
    }
  }, {
    dispose: async () => {
      disposals += 1;
      events.push("dispose");
      assert.equal(active, 0, "extractor must have no active borrowers at disposal");
      assert.equal(disposals, 1, "extractor is disposed exactly once");
    }
  });
  return { extractor, events, batchSizes, get disposals() { return disposals; } };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
