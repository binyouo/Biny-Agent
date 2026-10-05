/** Tracking provider settlement must preserve the source stream's terminal state. */
import assert from "node:assert/strict";
import test from "node:test";
import { JSONParseError, type LanguageModelV4, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelRequestMetrics } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";

for (const phase of ["before-response", "pending-read"] as const) {
  for (const awaitModelSettlementOnAbort of [false, true]) {
    test(`provider failure ${phase} is preserved with settlement tracking ${awaitModelSettlementOnAbort}`, async () => {
      const failure = new Error(`provider connection failed ${phase}`);
      const ready = deferred<void>();
      let wire!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      let cancels = 0;
      const source = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          wire = controller;
          if (phase === "before-response") controller.error(failure);
        },
        pull() { ready.resolve(); },
        cancel() { cancels++; }
      });
      const metrics: ModelRequestMetrics[] = [];
      const request = generateNativeText(modelFor(source), [{ role: "user", content: "fixture" }], {
        awaitModelSettlementOnAbort,
        onRequestMetrics: (value) => { metrics.push(value); }
      });
      const rejected = assert.rejects(request, (error: unknown) => error === failure,
        "local cleanup must not replace the provider's original error");
      if (phase === "pending-read") {
        await ready.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        wire.error(failure);
      }
      await rejected;
      assert.equal(source.locked, false, "terminal errors must release the real provider reader");
      assert.equal(cancels, 0, "an errored source does not need a second cancellation");
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0]?.error, failure.message);
    });
  }
}

for (const awaitModelSettlementOnAbort of [false, true]) {
  test(`provider error chunks are preserved with settlement tracking ${awaitModelSettlementOnAbort}`, async () => {
    const failure = new Error("provider returned a structured error");
    const source = new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
      controller.enqueue({ type: "error", error: failure });
      controller.close();
    } });
    await assert.rejects(generateNativeText(modelFor(source), [{ role: "user", content: "fixture" }], {
      awaitModelSettlementOnAbort
    }), (error: unknown) => error === failure);
    assert.equal(source.locked, false);
  });

  test(`malformed mocked SSE releases its response reader with settlement tracking ${awaitModelSettlementOnAbort}`, async () => {
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
      controller.close();
    } });
    const config = configSchema.parse({
      ...defaultConfig,
      defaultModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key" } },
      models: { fixture: { provider: "fixture", model: "fixture" } }
    });
    let calls = 0;
    const model = new ProviderRegistry(config, [], undefined, undefined, async () => {
      calls++;
      return new Response(source, { headers: { "content-type": "text/event-stream" } });
    }).createModelSettings().model;
    await assert.rejects(generateNativeText(model, [{ role: "user", content: "fixture" }], {
      awaitModelSettlementOnAbort
    }), (error: unknown) => JSONParseError.isInstance(error));
    assert.equal(calls, 1);
    assert.equal(source.locked, false);
  });
}

for (const phase of ["queued-close", "last-read-close"] as const) {
  test(`settlement tracking keeps final output and usage on ${phase}`, async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "fixture" },
      { type: "text-delta", id: "fixture", delta: "complete" },
      { type: "text-end", id: "fixture" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
        inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 }
      } }
    ];
    let cancels = 0;
    const source = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        if (phase !== "queued-close") return;
        parts.forEach((part) => controller.enqueue(part));
        controller.close();
      },
      pull(controller) {
        const part = parts.shift();
        if (part) controller.enqueue(part);
        if (parts.length === 0) controller.close();
      },
      cancel() { cancels++; }
    });
    const result = await generateNativeText(modelFor(source), [{ role: "user", content: "fixture" }], {
      awaitModelSettlementOnAbort: true
    });
    assert.equal(result.text, "complete");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.usage?.totalTokens, 5);
    assert.equal(source.locked, false);
    assert.equal(cancels, 0);
  });
}

function modelFor(source: ReadableStream<LanguageModelV4StreamPart>) {
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "stream-lifecycle", supportedUrls: {},
    doGenerate: async () => { throw new Error("Only streaming is allowed"); },
    doStream: async () => ({ stream: source })
  };
  return { provider: provider.provider, modelId: provider.modelId, vercelModel: provider };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
