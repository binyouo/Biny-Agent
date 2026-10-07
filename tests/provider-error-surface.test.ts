/** Provider 在首个输出前失败时，用户和请求审计都必须保留原始错误。 */
import assert from "node:assert/strict";
import { APICallError, type LanguageModelV4 } from "@ai-sdk/provider";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentEvent, AgentModel, ModelRequestMetrics } from "../src/agent/core/types.js";

const fallbackModel: AgentModel = {
  provider: "synthetic",
  modelId: "synthetic",
  stream: async () => { throw new Error("unexpected legacy stream"); }
};
const apiError = (message: string, statusCode?: number): APICallError => new APICallError({
  message, statusCode, url: "https://example.test/private-url-sentinel", requestBodyValues: { prompt: "private-request-sentinel" },
  responseBody: "private-response-sentinel", responseHeaders: { authorization: "private-header-sentinel" }
});

// Missing provider text must still produce a fatal event; raw request/response fields are not diagnostics.
for (const scenario of [
  { error: new TypeError("synthetic network failure"), expected: "synthetic network failure", status: undefined, code: "network_error" },
  { error: apiError("", 500), expected: "Provider request failed (500).", status: 500, code: "http_error" },
  { error: apiError(" \t\n"), expected: "Provider request failed.", status: undefined, code: "provider_error" },
  { error: apiError("  Provider quota unavailable.  ", 429), expected: "  Provider quota unavailable.  ", status: 429, code: "http_error" }
]) {
  let requests = 0;
  const provider: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "synthetic",
    modelId: "synthetic",
    supportedUrls: {},
    doGenerate: async () => { throw new Error("unexpected generate"); },
    doStream: async () => { requests += 1; throw scenario.error; }
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

  const failures = events.filter((event) => event.type === "error" && event.fatal);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.type === "error" ? failures[0].error : undefined, scenario.expected);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.error, scenario.expected);
  assert.equal(metrics[0]?.errorCode, scenario.code);
  assert.equal(metrics[0]?.status, scenario.status);
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify({ events, metrics }), /private-(?:url|request|response|header)-sentinel/);
}
console.log("provider error surface tests passed");
