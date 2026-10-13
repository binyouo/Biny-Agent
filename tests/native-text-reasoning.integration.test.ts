/** CI-only product/SDK integration. Every transport is synthetic; no live endpoint is contacted. */
import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";

const messages = [{ role: "user" as const, content: "Give this synthetic conversation a short title." }];
const usage = { inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function config(): AgentConfig {
  return {
    ...structuredClone(defaultConfig),
    defaultModel: "auxiliary",
    toolModel: "auxiliary",
    thinking: { enabled: true, effort: "high" },
    providers: { "custom-claude-alias": { type: "anthropic", baseUrl: "https://reasoning-fixture.invalid/v1", apiKey: "synthetic-fixture-key", retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 } } },
    models: { auxiliary: { provider: "custom-claude-alias", model: "claude-sonnet-4-5", maxOutputTokens: 512, capabilities: { reasoning: true }, thinkingLevelMap: { off: "none", high: "high", max: "max" } } }
  };
}

function anthropicStream(): Response {
  const parts = [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture title" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" }
  ];
  return new Response(parts.map(part => `event: ${part.type}\ndata: ${JSON.stringify(part)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function setup(value = config()) {
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://reasoning-fixture.invalid/v1/messages");
    assert.equal(request.method, "POST");
    requests.push(await request.json() as Record<string, unknown>);
    return anthropicStream();
  };
  const settings = new ProviderRegistry(value, [], undefined, undefined, fetcher).createModelSettings();
  return { settings, requests, value };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("explicit auxiliary off replaces inherited Claude thinking without changing the shared model", async () => {
  const { settings, requests, value } = setup();
  const defaults = settings.model.vercelOptions;
  const original = structuredClone(defaults);
  const originalConfig = structuredClone(value);
  freeze(defaults);
  const result = await generateNativeText(settings.model, messages, { maxOutputTokens: 128, reasoning: "off" });
  assert.equal(result.text, "Fixture title");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage?.totalTokens, 3);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.thinking, { type: "disabled" });
  assert.equal(requests[0]!.max_tokens, 128);
  assert.deepEqual(defaults, original);
  assert.deepEqual(value, originalConfig);
  assert.strictEqual(settings.model.vercelOptions, defaults);
  assert.strictEqual(settings.model.vercelModel, settings.vercelModel);
  assert.equal(settings.reasoning, "high", "main settings are unaffected");
});

for (const supplied of [false, true]) {
  test(`absent auxiliary reasoning preserves defaults; own undefined ${supplied}`, async () => {
    const { settings, requests } = setup();
    settings.model.resolveTextReasoning = () => { throw new Error("An absent override must not resolve"); };
    await generateNativeText(settings.model, messages, { maxOutputTokens: 128, ...(supplied ? { reasoning: undefined } : {}) });
    assert.deepEqual(requests[0]!.thinking, { type: "enabled", budget_tokens: 4096 });
    // 4224 includes the SDK's thinking budget, not a proven visible-text cap violation or actual spend.
    assert.equal(requests[0]!.max_tokens, 4224);
  });
}

test("concurrent off/high requests do not contaminate one another", async () => {
  const { settings, requests } = setup();
  freeze(settings.model.vercelOptions);
  await Promise.all([
    generateNativeText(settings.model, messages, { reasoning: "off", maxOutputTokens: 128 }),
    generateNativeText(settings.model, messages, { reasoning: "high", maxOutputTokens: 128 })
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.max_tokens).sort((a, b) => Number(a) - Number(b)), [128, 4224]);
  assert.deepEqual(settings.providerOptions, { anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } } });
});

test("explicit provider options remain a whole-map escape hatch above standardized reasoning", async () => {
  const { settings, requests } = setup();
  const providerOptions = freeze({ anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } });
  await generateNativeText(settings.model, messages, { reasoning: "off", maxOutputTokens: 128, providerOptions });
  assert.deepEqual(requests[0]!.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.equal(requests[0]!.max_tokens, 1152);
  assert.deepEqual(providerOptions, { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } });
});

test("explicit undefined provider options clears inherited settings but keeps standardized off", async () => {
  const { settings, requests } = setup();
  await generateNativeText(settings.model, messages, { reasoning: "off", maxOutputTokens: 128, providerOptions: undefined });
  assert.deepEqual(requests[0]!.thinking, { type: "disabled" });
  assert.equal(requests[0]!.max_tokens, 128);
});

function captureModel(calls: LanguageModelV4CallOptions[]): AgentModel {
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "fixture", supportedUrls: {},
    doGenerate: async () => { throw new Error("Only streaming is allowed"); },
    doStream: async options => {
      calls.push(options);
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "fixture" });
        controller.enqueue({ type: "text-delta", id: "fixture", delta: "complete" });
        controller.enqueue({ type: "text-end", id: "fixture" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
        controller.close();
      } }) };
    }
  };
  return { provider: provider.provider, modelId: provider.modelId, vercelModel: provider };
}

test("reasoning uses the prepared model and retains unrelated defaults with no recursive merge", async () => {
  const calls: LanguageModelV4CallOptions[] = [];
  const { settings } = setup();
  const prepared = captureModel(calls);
  prepared.resolveTextReasoning = settings.model.resolveTextReasoning;
  prepared.vercelOptions = freeze({ maxOutputTokens: 128, providerOptions: {
    anthropic: { thinking: { type: "enabled", budgetTokens: 4096 }, unrelated: { marker: "preserved" } },
    another: { marker: "preserved" }
  } });
  const original = structuredClone(prepared.vercelOptions);
  const order: string[] = [];
  const resolver = prepared.resolveTextReasoning!;
  prepared.resolveTextReasoning = requested => { order.push("resolve"); return resolver(requested); };
  const before = captureModel([]);
  before.resolveTextReasoning = () => { throw new Error("Stale pre-preparation resolver used"); };
  before.prepareTextRequest = async () => { order.push("prepare"); return prepared; };
  await generateNativeText(before, messages, { reasoning: "off" });
  assert.deepEqual(order, ["prepare", "resolve"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.reasoning, "none");
  assert.deepEqual(calls[0]!.providerOptions, { anthropic: { thinking: { type: "disabled" }, unrelated: { marker: "preserved" } }, another: { marker: "preserved" } });
  assert.deepEqual(prepared.vercelOptions, original);
});

for (const gate of ["capability", "compatibility"] as const) {
  test(`a ${gate}-disabled model does not gain a reasoning parameter`, async () => {
    const value = config();
    const provider = value.providers["custom-claude-alias"]!;
    if (gate === "capability") provider.modelProfiles = { "claude-sonnet-4-5": { capabilities: { reasoning: false } } };
    else provider.compatibility = { supportsReasoning: false };
    const { settings } = setup(value);
    const calls: LanguageModelV4CallOptions[] = [];
    const model = captureModel(calls);
    model.resolveTextReasoning = settings.model.resolveTextReasoning;
    model.vercelOptions = settings.model.vercelOptions;
    await generateNativeText(model, messages, { reasoning: "off" });
    assert.equal(calls[0]!.reasoning, undefined);
    assert.equal(calls[0]!.providerOptions, undefined);
  });
}

test("unsupported off projects to the model's supported default", async () => {
  const value = config();
  value.providers["custom-claude-alias"]!.modelProfiles = { "claude-sonnet-4-5": { thinkingLevelMap: { off: null, high: "high" } } };
  const { settings } = setup(value);
  const calls: LanguageModelV4CallOptions[] = [];
  const model = captureModel(calls);
  model.resolveTextReasoning = settings.model.resolveTextReasoning;
  model.vercelOptions = settings.model.vercelOptions;
  await generateNativeText(model, messages, { reasoning: "off", maxOutputTokens: 128 });
  assert.equal(calls[0]!.reasoning, "high");
  assert.deepEqual(calls[0]!.providerOptions, { anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } } });
});

test("custom Vercel model without resolver receives standardized reasoning", async () => {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = captureModel(calls);
  await generateNativeText(model, messages, { reasoning: "off" });
  await generateNativeText(model, messages, { reasoning: "max" });
  assert.deepEqual(calls.map(call => call.reasoning), ["none", "xhigh"]);
  assert.ok(calls.every(call => call.providerOptions === undefined));
});

test("injected stream keeps raw reasoning and never uses the Vercel-only resolver", async () => {
  const calls: unknown[] = [];
  const model: AgentModel = {
    provider: "fixture", modelId: "injected",
    resolveTextReasoning: () => { throw new Error("Injected options must retain their existing contract"); },
    stream: async (_context, options) => {
      calls.push(options?.reasoning);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: "complete" };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  await generateNativeText(model, messages, { reasoning: "off" });
  assert.deepEqual(calls, ["off"]);
});
