import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentModel } from "../src/agent/core/types.js";
import { generateNativeText } from "../src/llm/nativeJson.js";

let nativeCalls = 0;
const vercelModel = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: "text", text: "from vercel" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 }
    },
    warnings: []
  })
});

const model: AgentModel = {
  provider: "test",
  modelId: "vercel-auxiliary",
  vercelModel,
  vercelOptions: { maxOutputTokens: 64, providerOptions: { test: { mode: "auxiliary" } } },
  stream: async () => {
    nativeCalls++;
    throw new Error("unexpected native auxiliary route");
  }
};

const metrics: Array<{ provider: string; finishReason?: string }> = [];
const result = await generateNativeText(model, [{ role: "user", content: "hello" }], {
  onRequestMetrics: (value) => metrics.push({ provider: value.provider, finishReason: value.finishReason })
});

assert.equal(result.text, "from vercel");
assert.equal(result.usage?.totalTokens, 4);
assert.equal(nativeCalls, 0);
assert.deepEqual(metrics, [{ provider: "test", finishReason: "stop" }]);
assert.equal(vercelModel.doGenerateCalls[0]?.maxOutputTokens, 64);
assert.deepEqual(vercelModel.doGenerateCalls[0]?.providerOptions, { test: { mode: "auxiliary" } });
console.log("vercel auxiliary tests passed");
