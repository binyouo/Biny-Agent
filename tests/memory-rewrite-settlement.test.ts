/** Lifecycle-sensitive memory rewrites opt into waiting; other auxiliary text calls retain their default. */
import assert from "node:assert/strict";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { generateNativeText } from "../src/llm/nativeJson.js";

for (const route of ["injected", "sdk-request", "sdk-stream"] as const) {
  for (const cancellation of ["abort", "timeout"] as const) {
    const started = deferred<AbortSignal>();
    const held = deferred<void>();
    let model: AgentModel;
    if (route === "injected") {
      model = {
        provider: "fixture", modelId: route,
        stream: async (_context, options) => {
          assert.ok(options?.signal);
          started.resolve(options.signal);
          await held.promise;
          return (async function* (): AsyncGenerator<ModelStreamEvent> {
            yield { type: "text-delta", text: "late result" };
          })();
        }
      };
    } else {
      const provider: LanguageModelV4 = {
        specificationVersion: "v4", provider: "fixture", modelId: route, supportedUrls: {},
        doGenerate: async () => { throw new Error("Only streaming is allowed in this test"); },
        doStream: async ({ abortSignal }) => {
          assert.ok(abortSignal);
          started.resolve(abortSignal);
          if (route === "sdk-request") await held.promise;
          return { stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              if (route === "sdk-request") controller.close();
            },
            cancel: async () => { await held.promise; }
          }) };
        }
      };
      model = { provider: "fixture", modelId: route, vercelModel: provider };
    }
    const controller = new AbortController();
    const reason = new Error(`cancelled ${route}`);
    let settled = false;
    const pending = generateNativeText(model, [{ role: "user", content: "fixture" }], {
      signal: controller.signal, awaitModelSettlementOnAbort: true,
      ...(cancellation === "timeout" ? { timeoutMs: 20 } : {})
    });
    const rejected = assert.rejects(pending, (error: unknown) => cancellation === "abort"
      ? error === reason : error instanceof DOMException && error.name === "TimeoutError").finally(() => { settled = true; });
    try {
      const modelSignal = await bounded(started.promise);
      if (cancellation === "abort") controller.abort(reason);
      else await bounded(aborted(modelSignal));
      assert.equal(modelSignal.aborted, true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, `${route} must stay pending until the gated model request/stream settles`);
      held.resolve();
      await bounded(rejected);
    } finally { controller.abort(reason); held.resolve(); await rejected; }
  }
}

await testSdkProviderCleanup();
await testSdkNaturalClosure();
await testSdkCleanupFailure();

const success: AgentModel = { provider: "fixture", modelId: "success", stream: async () =>
  (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "rewritten terms" }; })() };
assert.equal((await generateNativeText(success, [], { awaitModelSettlementOnAbort: true })).text, "rewritten terms");
console.log("memory rewrite settlement tests passed");

async function testSdkProviderCleanup(): Promise<void> {
  for (const phase of ["before-response", "blocked-read", "late-chunk"] as const) {
    for (const cancellation of ["abort", "timeout"] as const) {
      const started = deferred<AbortSignal>();
      const responseHeld = deferred<void>();
      const cleanupHeld = deferred<void>();
      const cancelStarted = deferred<unknown>();
      let source: ReadableStream<LanguageModelV4StreamPart> | undefined;
      let cancelFinished = false;
      let cancelCalls = 0;
      let lateChunks = 0;
      const provider: LanguageModelV4 = {
        specificationVersion: "v4", provider: "fixture", modelId: phase, supportedUrls: {},
        doGenerate: async () => { throw new Error("Only streaming is allowed"); },
        doStream: async ({ abortSignal }) => {
          assert.ok(abortSignal);
          started.resolve(abortSignal);
          if (phase === "before-response") await responseHeld.promise;
          source = new ReadableStream<LanguageModelV4StreamPart>({
            start(wire) {
              if (phase === "late-chunk") abortSignal.addEventListener("abort", () => {
                wire.enqueue({ type: "text-start", id: "late" });
                lateChunks++;
              }, { once: true });
            },
            async cancel(reason) {
              cancelCalls++;
              cancelStarted.resolve(reason);
              await cleanupHeld.promise;
              cancelFinished = true;
            }
          });
          return { stream: source };
        }
      };
      const controller = new AbortController();
      const reason = new Error(`cancel ${phase}`);
      let settled = false;
      const pending = generateNativeText({ provider: "fixture", modelId: phase, vercelModel: provider },
        [{ role: "user", content: "fixture" }], {
          signal: controller.signal, awaitModelSettlementOnAbort: true,
          ...(cancellation === "timeout" ? { timeoutMs: 20 } : {})
        });
      const rejected = assert.rejects(pending, (error: unknown) => cancellation === "abort" ? error === reason
        : error instanceof DOMException && error.name === "TimeoutError").finally(() => { settled = true; });
      try {
        const requestSignal = await bounded(started.promise);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (cancellation === "abort") controller.abort(reason);
        else await bounded(aborted(requestSignal));
        if (phase === "before-response") {
          assert.equal(source, undefined);
          assert.equal(settled, false, "a pending provider request cannot disappear on SDK abort");
          responseHeld.resolve();
        }
        assert.equal(await bounded(cancelStarted.promise), requestSignal.reason);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "SDK stream termination cannot skip an unfinished provider cancel hook");
        assert.equal(source?.locked, true, "the reader is owned until its asynchronous cleanup finishes");
        assert.equal(cancelFinished, false);
        assert.equal(cancelCalls, 1);
        assert.equal(lateChunks, phase === "late-chunk" ? 1 : 0);
        cleanupHeld.resolve();
        await bounded(rejected);
        assert.equal(cancelFinished, true);
        assert.equal(source?.locked, false);
        assert.equal(cancelCalls, 1);
      } finally { controller.abort(reason); responseHeld.resolve(); cleanupHeld.resolve(); await rejected; }
    }
  }
}

async function testSdkNaturalClosure(): Promise<void> {
  let cancels = 0;
  const source = new ReadableStream<LanguageModelV4StreamPart>({ start(wire) {
    wire.enqueue({ type: "text-start", id: "text" });
    wire.enqueue({ type: "text-delta", id: "text", delta: "complete rewrite" });
    wire.enqueue({ type: "text-end", id: "text" });
    wire.close();
  }, cancel() { cancels++; } });
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "normal", supportedUrls: {},
    doGenerate: async () => { throw new Error("Only streaming is allowed"); },
    doStream: async () => ({ stream: source })
  };
  const result = await bounded(generateNativeText({ provider: "fixture", modelId: "normal", vercelModel: provider },
    [{ role: "user", content: "fixture" }], { awaitModelSettlementOnAbort: true }));
  assert.equal(result.text, "complete rewrite", "normal closure must not drop the final queued chunk");
  assert.equal(cancels, 0);
  assert.equal(source.locked, false);
}

async function testSdkCleanupFailure(): Promise<void> {
  const started = deferred<void>();
  const cancelStarted = deferred<void>();
  const cleanupHeld = deferred<void>();
  const cleanupFailure = new Error("provider cancel cleanup failed");
  const source = new ReadableStream<LanguageModelV4StreamPart>({
    async cancel() { cancelStarted.resolve(); await cleanupHeld.promise; throw cleanupFailure; }
  });
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "cleanup-failure", supportedUrls: {},
    doGenerate: async () => { throw new Error("Only streaming is allowed"); },
    doStream: async () => { started.resolve(); return { stream: source }; }
  };
  const controller = new AbortController();
  const reason = new Error("requested cancellation");
  let settled = false;
  const pending = generateNativeText({ provider: "fixture", modelId: provider.modelId, vercelModel: provider },
    [{ role: "user", content: "fixture" }], { signal: controller.signal, awaitModelSettlementOnAbort: true });
  const rejected = assert.rejects(pending, (error: unknown) => error === reason).finally(() => { settled = true; });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    await bounded(started.promise);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await bounded(cancelStarted.promise);
    assert.equal(settled, false);
    cleanupHeld.resolve();
    await bounded(rejected);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(source.locked, false);
    assert.deepEqual(unhandled, [], "rejected local cleanup is observed; cancellation preserves its original reason");
  } finally { controller.abort(reason); cleanupHeld.resolve(); await rejected; process.removeListener("unhandledRejection", onUnhandled); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Expected model lifecycle event within 5 seconds")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
