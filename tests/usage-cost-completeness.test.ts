/** Missing provider totals must not become a fully priced partial request. */
import assert from "node:assert/strict";
import test from "node:test";
import { streamText } from "ai";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { fromVercelUsage } from "../src/agent/core/vercelModelAdapter.js";
import { calculateUsageCost, createSessionUsage, formatUsageSummary, summarizeUsage, sumSessionUsage } from "../src/observability/usage.js";

const pricing = { inputPerMillionTokens: 1, outputPerMillionTokens: 2, cacheReadPerMillionTokens: 0.5, cacheWritePerMillionTokens: 1.5 };
const identity = { modelAlias: "fixture", provider: "synthetic", model: "usage-completeness", pricing };

async function measured(input: number | undefined, output: number | undefined) {
  let calls = 0;
  const model: LanguageModelV4 = {
    specificationVersion: "v4", provider: identity.provider, modelId: identity.model, supportedUrls: {},
    doGenerate: async () => { throw new Error("Unexpected non-streaming request"); },
    doStream: async () => {
      calls++;
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        const parts: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Completed fixture answer." },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
            inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: output, text: output, reasoning: 0 }
          } }
        ];
        for (const part of parts) controller.enqueue(part);
        controller.close();
      } }) };
    }
  };
  const result = streamText({ model, prompt: "Answer the synthetic fixture." });
  assert.equal(await result.text, "Completed fixture answer.");
  assert.equal(await result.finishReason, "stop");
  assert.equal(calls, 1);
  const usage = fromVercelUsage(await result.usage);
  assert.equal(usage.inputTokens, input);
  assert.equal(usage.outputTokens, output);
  const record = createSessionUsage(usage, "agent", identity);
  // Persisted JSON retains the completeness decision, not just in-memory fields.
  return { usage, record: JSON.parse(JSON.stringify(record)) as typeof record };
}

for (const [name, input, output] of [
  ["input only", 100, undefined], ["output only", undefined, 10],
  ["neither total despite explicit cache zeros", undefined, undefined],
  ["input zero without output total", 0, undefined], ["output zero without input total", undefined, 0]
] as const) {
  test(`real SDK ${name} has unknown complete cost`, async () => {
    const { usage, record } = await measured(input, output);
    assert.equal(usage.totalTokens, undefined);
    assert.equal(record.pricingKnown, false);
    assert.equal(record.costUsd, undefined);
    const summary = summarizeUsage([record]);
    assert.equal(summary.pricingKnown, false);
    assert.equal(summary.costUsd, undefined);
    assert.equal(summary.pricedCalls, 0);
    assert.equal(summary.unpricedCalls, 1);
    assert.match(formatUsageSummary(summary), /Cost: unknown/u);
    assert.doesNotMatch(formatUsageSummary(summary), /Cost: \$/u);
  });
}

for (const [input, output, expected] of [[100, 10, 0.00012], [0, 0, 0], [100, 0, 0.0001], [0, 10, 0.00002]] as const) {
  test(`real SDK explicit totals ${input}/${output} preserve known cost`, async () => {
    const { record } = await measured(input, output);
    assert.equal(record.pricingKnown, true);
    assert.equal(record.costUsd, expected);
    const summary = summarizeUsage([record]);
    assert.equal(summary.costUsd, expected);
    assert.equal(summary.pricedCalls, 1);
  });
}

test("one incomplete request keeps turn and session cost unknown beside a complete request", async () => {
  const complete = (await measured(100, 10)).record;
  const incomplete = (await measured(100, undefined)).record;
  const turn = sumSessionUsage([complete, incomplete]);
  assert.equal(turn.pricingKnown, false);
  assert.equal(turn.costUsd, undefined);
  assert.equal(summarizeUsage([complete, incomplete]).costUsd, undefined);
  assert.equal(summarizeUsage([JSON.parse(JSON.stringify(turn))]).pricingKnown, false);
});

test("complete cache pricing and omitted optional cache detail retain their existing contract", () => {
  const cached = calculateUsageCost({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 20 }, pricing);
  assert.equal(cached.known, true);
  assert.ok(cached.costUsd !== undefined && Math.abs(cached.costUsd - 0.00011) < 1e-15);
  assert.deepEqual(calculateUsageCost({ inputTokens: 100, outputTokens: 10 }, pricing), { known: true, costUsd: 0.00012 });
});

test("missing prices remain unknown while explicit zero categories require no unit price", () => {
  assert.deepEqual(calculateUsageCost({ inputTokens: 100, outputTokens: 10 }, { inputPerMillionTokens: 1 }), { known: false, costUsd: undefined });
  assert.deepEqual(calculateUsageCost({ inputTokens: 0, outputTokens: 0 }, {}), { known: true, costUsd: 0 });
  assert.deepEqual(calculateUsageCost({ inputTokens: 0, outputTokens: 0 }, undefined), { known: false, costUsd: undefined });
});
