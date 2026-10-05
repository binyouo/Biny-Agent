/** Error presence is independent of payload. All provider streams are in-memory. */
import assert from "node:assert/strict";
import test from "node:test";
import { streamText } from "ai";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentModel, ModelRequestMetrics } from "../src/agent/core/types.js";
import { analyzeContextEmotion } from "../src/agent/context/emotionAnalysis.js";
import type { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { generateNativeText } from "../src/llm/nativeJson.js";

const failures: ReadonlyArray<readonly [string, unknown]> = [
  ["undefined", undefined], ["null", null], ["empty string", ""],
  ["string", "provider failed"], ["false", false], ["zero", 0], ["Error", new Error("provider failed")]
];
const messages = [{ role: "user" as const, content: "fixture" }];
const finish: LanguageModelV4StreamPart = {
  type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
    inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 }
  }
};
const textParts = (text: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "fixture" }, { type: "text-delta", id: "fixture", delta: text }, { type: "text-end", id: "fixture" }
];

for (const [kind, failure] of failures) {
  test(`SDK exposes ${kind} error to fullStream and onError`, async () => {
    const errors: unknown[] = [];
    const source = sourceFor([{ type: "error", error: failure }, finish]);
    const result = streamText({ model: modelFor(source).vercelModel!, messages, onError: ({ error }) => { errors.push(error); } });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    assert.deepEqual(errors, [failure]);
    assert.equal(parts.filter((part) => part.type === "error").length, 1);
    assert.equal(parts.find((part) => part.type === "error")?.error, failure);
    assert.equal(source.locked, false);
  });
  for (const strict of [false, true]) {
    for (const text of ["", '{"answer":"partial"}']) {
      for (const withFinish of [false, true]) {
        test(`${kind} error part rejects: strict=${strict}, text=${Boolean(text)}, finish=${withFinish}`, async () => {
          const source = sourceFor([...(text ? textParts(text) : []), { type: "error", error: failure }, ...(withFinish ? [finish] : [])]);
          const metrics: ModelRequestMetrics[] = [];
          await assert.rejects(generateNativeText(modelFor(source), messages, {
            awaitModelSettlementOnAbort: strict, onRequestMetrics: (value) => { metrics.push(value); }
          }), (error: unknown) => failure instanceof Error ? error === failure : error instanceof Error && error.message === String(failure));
          assertFailureMetrics(metrics, failure instanceof Error ? failure.message : String(failure));
          if (withFinish) assert.equal(metrics[0]?.usage?.totalTokens, 5, "finish preserves usage without clearing failure");
          assert.equal(source.locked, false);
        });
      }
    }
    for (const phase of ["before-response", "pending-read"] as const) {
      test(`raw ${kind} rejection stays exact and reports failure: strict=${strict}, ${phase}`, async () => {
        let wire!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
        const ready = deferred<void>();
        let cancels = 0;
        const source = new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) { wire = controller; if (phase === "before-response") controller.error(failure); },
          pull() { ready.resolve(); }, cancel() { cancels++; }
        });
        const metrics: ModelRequestMetrics[] = [];
        const request = generateNativeText(modelFor(source), messages, {
          awaitModelSettlementOnAbort: strict, onRequestMetrics: (value) => { metrics.push(value); }
        });
        const rejected = assert.rejects(request, (error: unknown) => Object.is(error, failure));
        if (phase === "pending-read") { await ready.promise; await turn(); wire.error(failure); }
        await rejected;
        assertFailureMetrics(metrics, failure instanceof Error ? failure.message : String(failure));
        assert.equal(source.locked, false);
        assert.equal(cancels, 0);
      });
    }
  }
}

for (const strict of [false, true]) {
  for (const firstFailure of [undefined, null]) {
    test(`first error survives later error: strict=${strict}, first=${String(firstFailure)}`, async () => {
      const source = sourceFor([{ type: "error", error: firstFailure }, { type: "error", error: new Error("later error") }, finish]);
      await assert.rejects(generateNativeText(modelFor(source), messages, { awaitModelSettlementOnAbort: strict }), { message: String(firstFailure) });
    });
  }
  test(`successful text and metrics stay successful: strict=${strict}`, async () => {
    const metrics: ModelRequestMetrics[] = [];
    const source = sourceFor([...textParts("complete"), finish]);
    const result = await generateNativeText(modelFor(source), messages, {
      awaitModelSettlementOnAbort: strict, onRequestMetrics: (value) => { metrics.push(value); }
    });
    assert.equal(result.text, "complete");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.usage?.totalTokens, 5);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.finishReason, "stop");
    assert.equal(metrics[0]?.errorPhase, undefined);
    assert.equal(metrics[0]?.error, undefined);
    assert.equal(metrics[0]?.eventCount, 1);
    assert.equal(source.locked, false);
  });
  for (const mode of ["abort", "timeout"] as const) {
    test(`${mode} still takes precedence and emits one error metric: strict=${strict}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const controller = new AbortController();
      const ready = deferred<void>();
      let wire!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      let cancels = 0;
      const source = new ReadableStream<LanguageModelV4StreamPart>({
        start(value) { wire = value; }, pull() { ready.resolve(); }, cancel() { cancels++; }
      });
      const metrics: ModelRequestMetrics[] = [];
      const reason = new Error("cancel fixture");
      const request = generateNativeText(modelFor(source), messages, {
        signal: controller.signal, timeoutMs: mode === "timeout" ? 100 : undefined,
        awaitModelSettlementOnAbort: strict, onRequestMetrics: (value) => { metrics.push(value); }
      });
      const rejected = assert.rejects(request, (error: unknown) => mode === "abort" ? error === reason
        : error instanceof DOMException && error.name === "TimeoutError");
      await ready.promise;
      await turn();
      if (mode === "abort") controller.abort(reason); else t.mock.timers.tick(100);
      await rejected;
      if (!strict) wire.close();
      await turn();
      assertFailureMetrics(metrics, mode === "abort" ? reason.message : "Auxiliary model request timed out.");
      assert.equal(source.locked, false);
      assert.equal(cancels, strict ? 1 : 0);
    });
  }
}
for (const route of ["prepare", "injected"] as const) {
  test(`raw undefined ${route} rejection reports error`, async () => {
    const metrics: ModelRequestMetrics[] = [];
    const model: AgentModel = {
      provider: "fixture", modelId: "raw-undefined",
      ...(route === "prepare" ? { prepareTextRequest: async () => { throw undefined; } } : {}),
      stream: async () => { throw undefined; }
    };
    await assert.rejects(generateNativeText(model, messages, { onRequestMetrics: (value) => { metrics.push(value); } }), (error: unknown) => error === undefined);
    assertFailureMetrics(metrics, "undefined");
  });
}

test("an error after valid JSON cannot reach the emotion-analysis write", async () => {
  let writes = 0;
  let usageCallbacks = 0;
  const storage = {
    readBase: async () => undefined, readContext: async () => undefined, writeContext: async () => { writes++; }
  } as unknown as EmotionStorage;
  const source = sourceFor([...textParts('{"mood":"calm","valence":5,"reason":"fixture"}'), { type: "error", error: undefined }, finish]);
  await assert.rejects(analyzeContextEmotion({
    sessionId: "fixture", storage, getModel: () => modelFor(source),
    getMessages: async () => [{ role: "user", text: "fixture" }], onUsage: () => { usageCallbacks++; }
  }), { message: "undefined" });
  assert.equal(writes, 0);
  assert.equal(usageCallbacks, 0);
});

test("SDK logging stays suppressed and observer failure cannot replace provider error", async (t) => {
  const logger = t.mock.method(console, "error", () => undefined);
  const source = sourceFor([{ type: "error", error: undefined }, finish]);
  let metrics = 0;
  await assert.rejects(generateNativeText(modelFor(source), messages, {
    onRequestMetrics: () => { metrics++; throw new Error("observer failed"); }
  }), { message: "undefined" });
  assert.equal(metrics, 1);
  assert.equal(logger.mock.callCount(), 0);
});

function assertFailureMetrics(metrics: ModelRequestMetrics[], message: string) {
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.finishReason, "error");
  assert.equal(metrics[0]?.errorPhase, "request");
  assert.equal(metrics[0]?.error, message);
  assert.equal(metrics[0]?.eventCount, 0);
  assert.equal(metrics[0]?.attempts.length, 1);
  assert.equal(metrics[0]?.attempts[0]?.willRetry, false);
}
function sourceFor(parts: LanguageModelV4StreamPart[]) {
  return new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
    parts.forEach((part) => controller.enqueue(part)); controller.close();
  } });
}
function modelFor(source: ReadableStream<LanguageModelV4StreamPart>): AgentModel {
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "error-presence", supportedUrls: {},
    doGenerate: async () => { throw new Error("Only streaming is allowed"); }, doStream: async () => ({ stream: source })
  };
  return { provider: provider.provider, modelId: provider.modelId, vercelModel: provider };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
