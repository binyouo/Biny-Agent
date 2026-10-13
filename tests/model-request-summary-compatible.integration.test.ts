/** Real locked SDK + inert fetch response. Run in standard CI, never the local pure runner. */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, ModelRequestMetrics } from "../src/agent/core/types.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { summarizeModelRequests } from "../src/observability/modelRequests.js";

for (const scenario of ["no-text-error", "partial-text-error", "stop", "length"] as const) {
  test(`compatible request summary preserves terminal ${scenario}`, { timeout: 10_000 }, async () => {
    const failure = scenario.endsWith("error");
    const partial = scenario !== "no-text-error";
    const outputTokens = partial ? 2 : 0;
    const finalUsage = { prompt_tokens: 100, completion_tokens: outputTokens, total_tokens: 100 + outputTokens };
    const chunks: unknown[] = [
      ...(partial ? [{ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }] : []),
      // These are cumulative snapshots. The final measurement replaces the earlier one.
      { choices: [], usage: { prompt_tokens: 80, completion_tokens: 0, total_tokens: 80 } },
      { choices: [], usage: finalUsage },
      failure
        ? { error: { message: "Fixture stream unavailable", type: "server_error" } }
        : { choices: [{ index: 0, delta: {}, finish_reason: scenario }] }
    ];
    let fetchCalls = 0;
    const provider = createVercelLanguageModel({
      providerAlias: "fixture", providerType: "openai-compatible", authMode: "api-key", api: "chat_completions",
      modelId: "fixture", supportsReasoning: false, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", headers: {},
      fetcher: async () => {
        fetchCalls++;
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" }
        });
      }
    });
    const metrics: ModelRequestMetrics[] = [];
    const events: AgentEvent[] = [];
    for await (const event of vercelAgentLoopContinue(
      { messages: [{ role: "user", content: "Summarize a fixture." }], tools: [] },
      {
        model: { provider: "openai-compatible", modelId: "fixture", vercelModel: provider },
        vercelModel: provider, tools: [], maxSteps: 1, maxRetries: 0,
        // Deliberately omit recoverFromModelError: no-output failures cannot launch recovery requests.
        modelOptions: { onRequestMetrics: value => { metrics.push(value); } }
      }
    )) events.push(event);

    assert.equal(fetchCalls, 1);
    assert.equal(metrics.length, 1, "error plus finish must retain one request record");
    const record = metrics[0]!;
    assert.equal(record.attempts.length, 1);
    assert.equal(record.finishReason, failure ? "error" : scenario);
    assert.equal(record.error, undefined, "summary-only repair does not fabricate producer diagnostics");
    assert.equal(record.status, undefined, "HTTP 200 SSE errors are not assigned an invented HTTP failure code");
    assert.equal(record.usage?.inputTokens, 100);
    assert.equal(record.usage?.outputTokens, outputTokens);
    assert.equal(record.usage?.totalTokens, 100 + outputTokens);
    assert.equal(metrics.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0), 100,
      "neither an earlier cumulative snapshot nor a duplicate terminal record is added");
    const before = JSON.stringify(metrics);
    const summary = summarizeModelRequests(metrics);
    assert.equal(JSON.stringify(metrics), before, "summary must leave provider usage and terminal record untouched");
    const fatals = events.filter(event => event.type === "error" && event.fatal);
    assert.equal(fatals.length, failure ? 1 : 0);
    if (failure) {
      const fatal = fatals[0];
      assert.ok(fatal?.type === "error");
      assert.match(fatal.error, /Fixture stream unavailable/u);
    }
    assert.equal(events.some(event => event.type === "message_update" && event.event.type === "text-delta"), partial);
    assert.equal(summary.calls, 1);
    assert.equal(summary.totalAttempts, 1);
    assert.equal(summary.retries, 0);
    assert.equal(summary.failed, failure ? 1 : 0);
    assert.equal(summary.succeeded, failure ? 0 : 1);
  });
}
