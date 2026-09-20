/** Provider 在首个输出前失败时，用户和请求审计都必须保留原始错误。 */
import assert from "node:assert/strict";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentEvent, AgentModel, ModelRequestMetrics } from "../src/agent/core/types.js";

const provider: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "synthetic",
  modelId: "synthetic",
  supportedUrls: {},
  doGenerate: async () => { throw new Error("unexpected generate"); },
  doStream: async () => { throw new TypeError("synthetic network failure"); }
};
const fallbackModel: AgentModel = {
  provider: "synthetic",
  modelId: "synthetic",
  stream: async () => { throw new Error("unexpected legacy stream"); }
};
const events: AgentEvent[] = [];
const metrics: ModelRequestMetrics[] = [];

for await (const event of vercelAgentLoopContinue(
  { messages: [{ role: "user", content: "hello" }], tools: [] },
  {
    model: fallbackModel,
    vercelModel: provider,
    tools: [],
    maxSteps: 1,
    maxRetries: 0,
    modelOptions: { onRequestMetrics: (value) => { metrics.push(value); } }
  }
)) events.push(event);

const failure = events.find((event) => event.type === "error" && event.fatal);
assert.equal(failure?.type === "error" ? failure.error : undefined, "synthetic network failure");
assert.equal(metrics.length, 1);
assert.equal(metrics[0]?.error, "synthetic network failure");
assert.equal(metrics[0]?.errorCode, "network_error");
console.log("provider error surface tests passed");
