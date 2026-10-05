/** Provider-reported cache misses must survive SDK usage normalization unchanged. */
import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { AgentAssistantMessage, AgentEvent, ModelRequestMetrics } from "../src/agent/core/types.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import { fromVercelUsage } from "../src/agent/core/vercelModelAdapter.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { createSessionUsage, summarizeUsage, sumSessionUsage } from "../src/observability/usage.js";

const wireUsage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 80 },
  prompt_cache_hit_tokens: 80,
  prompt_cache_miss_tokens: 20
};
const normalizedUsage = {
  inputTokens: 100,
  inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: undefined },
  outputTokens: 20,
  outputTokenDetails: { reasoningTokens: 0 }
};
const expectedUsage = {
  inputTokens: 100, outputTokens: 20, totalTokens: 120,
  reasoningTokens: 0, cacheReadTokens: 80, cacheWriteTokens: undefined,
  cacheMissTokens: 20
};

function sse(usage: Record<string, unknown> | undefined, tool = false): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] },
    // A preceding cumulative snapshot must not be added to the final usage.
    { choices: [], usage: usage && { ...usage, prompt_cache_miss_tokens: 7 } },
    ...(tool ? [{ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: "inspect-1", type: "function", function: { name: "inspect", arguments: "{}" }
    }] }, finish_reason: null }] }] : []),
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage }
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" }
  });
}

function provider(fetcher: typeof fetch): LanguageModelV4 {
  return createVercelLanguageModel({
    providerAlias: "deepseek-fixture", providerType: "deepseek", authMode: "api-key", api: "chat_completions",
    modelId: "deepseek-v4-flash", supportsReasoning: true,
    baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", headers: {}, fetcher
  });
}

test("normalization preserves explicit cache misses without deriving or changing other counts", () => {
  for (const value of [0, 20]) {
    assert.deepEqual(fromVercelUsage({ ...normalizedUsage, raw: { prompt_cache_miss_tokens: value } }), {
      ...expectedUsage, cacheMissTokens: value
    });
  }
  for (const raw of [undefined, null, [], {}, { prompt_cache_miss_tokens: undefined },
    { prompt_cache_miss_tokens: null }, { prompt_cache_miss_tokens: -1 },
    { prompt_cache_miss_tokens: NaN }, { prompt_cache_miss_tokens: Infinity },
    { prompt_cache_miss_tokens: "20" }, { prompt_cache_miss_tokens: true }]) {
    const result = fromVercelUsage({ ...normalizedUsage, raw });
    const { cacheMissTokens: _cacheMissTokens, ...withoutCacheMisses } = expectedUsage;
    assert.deepEqual(result, withoutCacheMisses);
    assert.equal(Object.hasOwn(result, "cacheMissTokens"), false);
  }
  const partial = fromVercelUsage({
    inputTokens: undefined,
    inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokens: 0,
    outputTokenDetails: { reasoningTokens: undefined },
    raw: { prompt_tokens: 100, prompt_cache_miss_tokens: 20 }
  });
  assert.equal(partial.inputTokens, undefined, "raw metadata must not rewrite SDK token totals");
  assert.equal(partial.outputTokens, 0);
  assert.equal(partial.totalTokens, undefined);
  assert.equal(partial.cacheReadTokens, undefined);
  assert.equal(partial.cacheMissTokens, 20);
});

test("real compatible SSE preserves final cache misses in agent metrics, messages and session records", async () => {
  let calls = 0;
  const model = provider(async () => sse(wireUsage, ++calls === 1));
  const messages: AgentAssistantMessage[] = [];
  const metrics: ModelRequestMetrics[] = [];
  const events: AgentEvent[] = [];
  const tool = {
    name: "inspect", description: "Inspect a fixture", parameters: { type: "object" as const, properties: {} },
    execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] })
  };
  for await (const event of vercelAgentLoopContinue(
    { messages: [{ role: "user", content: "Inspect." }], tools: [tool] },
    {
      model: { provider: "deepseek", modelId: model.modelId, vercelModel: model },
      vercelModel: model, tools: [tool], maxSteps: 2, maxRetries: 0,
      modelOptions: { onRequestMetrics: value => { metrics.push(value); } },
      persistStep: async ({ message }) => { messages.push(message); }
    }
  )) events.push(event);
  assert.deepEqual(events.filter(event => event.type === "error"), []);
  assert.equal(calls, 2);
  assert.equal(messages.length, 2);
  assert.equal(metrics.length, 2);
  for (const usage of [...messages.map(message => message.usage), ...metrics.map(metric => metric.usage)]) {
    assert.deepEqual(usage, expectedUsage, "one final measurement per request, without adding cumulative snapshots");
  }
  const records = messages.map(message => createSessionUsage(message.usage!, "agent", {
    modelAlias: "fixture", provider: "deepseek", model: model.modelId,
    pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 4, cacheReadPerMillionTokens: 0.5 }
  }));
  assert.equal(records[0]?.costUsd, 0.00016, "cache misses are diagnostic metadata, not another priced token category");
  const restored = JSON.parse(JSON.stringify(sumSessionUsage(records)));
  assert.equal(restored.cacheMissTokens, 40);
  const summary = summarizeUsage([restored]);
  assert.equal(summary.cacheMissTokens, 40);
  assert.equal(summary.inputTokens, 200);
  assert.equal(summary.cacheReadTokens, 160);
  assert.equal(summary.sessionCacheHitRate, 0.8);
});

test("auxiliary text retains raw final-step cache misses through SDK aggregate usage", async () => {
  for (const [wire, expected] of [
    [wireUsage, 20],
    [{ ...wireUsage, prompt_cache_miss_tokens: 0 }, 0],
    [{ ...wireUsage, prompt_cache_miss_tokens: undefined }, undefined],
    [{ ...wireUsage, prompt_cache_miss_tokens: -1 }, undefined],
    [{ ...wireUsage, prompt_cache_miss_tokens: "20" }, undefined],
    [undefined, undefined]
  ] as const) {
    let calls = 0;
    const model = provider(async () => { calls++; return sse(wire); });
    const metrics: ModelRequestMetrics[] = [];
    const result = await generateNativeText({ provider: "deepseek", modelId: model.modelId, vercelModel: model },
      [{ role: "user", content: "Summarize the fixture." }],
      { onRequestMetrics: value => { metrics.push(value); } });
    assert.equal(calls, 1);
    assert.equal(result.text, "Done.");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.usage?.cacheMissTokens, expected);
    assert.equal(Object.hasOwn(result.usage ?? {}, "cacheMissTokens"), expected !== undefined);
    assert.equal(metrics.length, 1);
    assert.deepEqual(metrics[0]?.usage, result.usage);
    assert.equal(result.usage?.inputTokens, wire ? 100 : undefined);
    assert.equal(result.usage?.outputTokens, wire ? 20 : undefined);
    assert.equal(result.usage?.cacheReadTokens, wire ? 80 : undefined);
  }
});

test("a retried auxiliary request reports only the successful request's final cache misses", async () => {
  let calls = 0;
  const model = provider(async () => ++calls === 1
    ? new Response(JSON.stringify({ error: { message: "Fixture temporarily unavailable", type: "server_error" } }), {
      status: 503, headers: { "content-type": "application/json" }
    })
    : sse(wireUsage));
  const metrics: ModelRequestMetrics[] = [];
  const result = await generateNativeText({ provider: "deepseek", modelId: model.modelId, vercelModel: model },
    [{ role: "user", content: "Summarize the fixture." }],
    { maxRetries: 1, onRequestMetrics: value => { metrics.push(value); } });
  assert.equal(calls, 2);
  assert.deepEqual(result.usage, expectedUsage);
  assert.equal(metrics.length, 1);
  assert.deepEqual(metrics[0]?.usage, expectedUsage);
});
