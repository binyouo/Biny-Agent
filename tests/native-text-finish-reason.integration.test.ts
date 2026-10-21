/** CI-only SDK integration: auxiliary metrics preserve the existing finish-reason contract. */
import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelRequestMetrics } from "../src/agent/core/types.js";
import { generateNativeText } from "../src/llm/nativeJson.js";

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
};
const messages = [{ role: "user" as const, content: "fixture" }];
const reasons = ["stop", "length", "content-filter", "tool-calls", "error", "other"] as const;

for (const reason of reasons) {
  for (const strict of [false, true]) {
    test(`auxiliary SDK finish ${reason}, settlement tracking ${strict}`, async () => {
      const source = new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "fixture" });
        controller.enqueue({ type: "text-delta", id: "fixture", delta: "complete" });
        controller.enqueue({ type: "text-end", id: "fixture" });
        controller.enqueue({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
        controller.close();
      } });
      const provider: LanguageModelV4 = {
        specificationVersion: "v4", provider: "fixture", modelId: "finish-reason", supportedUrls: {},
        doGenerate: async () => { throw new Error("Only streaming is allowed"); },
        doStream: async () => ({ stream: source })
      };
      const metrics: ModelRequestMetrics[] = [];
      const result = await generateNativeText({ provider: provider.provider, modelId: provider.modelId, vercelModel: provider }, messages, {
        awaitModelSettlementOnAbort: strict, onRequestMetrics: value => { metrics.push(value); }
      });
      assert.equal(result.text, "complete");
      assert.equal(result.finishReason, reason, "metrics normalization must not change the raw result");
      assert.equal(result.usage?.totalTokens, 5);
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0]?.finishReason, reason === "content-filter" ? "other" : reason);
      assert.deepEqual(metrics[0]?.usage, result.usage);
      assert.equal(metrics[0]?.error, undefined);
      assert.equal(metrics[0]?.errorPhase, undefined);
      assert.equal(metrics[0]?.eventCount, 1);
      assert.equal(source.locked, false);
    });
  }
}
