import assert from "node:assert/strict";
import test from "node:test";
import { streamText, tool } from "ai";
import { z } from "zod";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { maskingOverview, maskingDetail, resetMaskRecordsForTest } from "../src/privacy/record.js";

for (const enabled of [true, false]) test(`ProviderRegistry wires privacy through native SDK requests (${enabled})`, { timeout: 5000 }, async () => {
  resetMaskRecordsForTest();
  const secret = "sk-proj-0123456789abcdefghijklmnop";
  const config = configSchema.parse({ ...defaultConfig, redaction: { enabled }, defaultModel: "fixture", providers: {
    fixture: { type: "openai-compatible", apiKey: "fixture-auth", baseUrl: "https://privacy.invalid/v1" }
  }, models: { fixture: { provider: "fixture", model: "fixture" } } });
  const bodies: string[] = [];
  const registry = new ProviderRegistry(config, [], undefined, undefined, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-auth");
    const body = String(init?.body); bodies.push(body);
    const text = (JSON.parse(body).messages as Array<{ content: string }>).at(-1)!.content;
    const frames = [text.slice(0, 6), text.slice(6)].map((content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  const result = await generateNativeText(registry.createModelSettings().model, [{ role: "user", content: secret }], { requestContext: { sessionId: "privacy-sdk", operation: "memory" } });
  assert.equal(result.text, secret);
  assert.equal(bodies[0]!.includes(secret), !enabled);
  const overview = maskingOverview(["privacy-sdk"]);
  assert.equal(overview.records.length, enabled ? 1 : 0);
  assert.ok(!JSON.stringify(overview).includes(secret));
  if (enabled) {
    assert.equal(overview.records[0]!.operation, "memory");
    assert.ok(JSON.stringify(maskingDetail(overview.records[0]!.id, ["privacy-sdk"])).includes(secret));
  }
});

test("a compacted SDK conversation delivers the restored credential to a local tool", { timeout: 5000 }, async () => {
  const secret = "synthetic-login-password-2026";
  const config = configSchema.parse({ ...defaultConfig, redaction: { enabled: true }, defaultModel: "fixture", providers: {
    fixture: { type: "openai-compatible", apiKey: "fixture-auth", baseUrl: "https://privacy.invalid/v1" }
  }, models: { fixture: { provider: "fixture", model: "fixture" } } });
  let tag = "", calls = 0;
  const registry = new ProviderRegistry(config, [], undefined, undefined, async (_url, init) => {
    const body = String(init?.body);
    assert.ok(!body.includes(secret));
    assert.equal(new Headers(init?.headers).get("x-session-id"), "privacy-sdk-compacted");
    const frames = [];
    if (++calls === 1) {
      tag = JSON.parse(body).messages[0].content.slice("password=".length);
      assert.match(tag, /^\{\{/u);
      frames.push({ choices: [{ index: 0, delta: { content: "ready" }, finish_reason: "stop" }] });
    } else {
      const rewritten = tag.slice(2, -2).toLowerCase();
      frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "fill-1", type: "function", function: { name: "browser_fill", arguments: '{"password":"' + rewritten.slice(0, 3) } }] }, finish_reason: null }] });
      frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: rewritten.slice(3) + '"}' } }] }, finish_reason: null }] });
      frames.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    }
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const model = registry.createModelSettings().model;
  await generateNativeText(model, [{ role: "user", content: `password=${secret}` }], { requestContext: { sessionId: "privacy-sdk-compacted", operation: "agent" } });
  const received: string[] = [];
  const response = streamText({ model: model.vercelModel!, headers: { "x-session-id": "privacy-sdk-compacted" },
    messages: [{ role: "user", content: "Compacted: continue filling the login form." }],
    tools: { browser_fill: tool({ inputSchema: z.object({ password: z.string() }), execute: async ({ password }) => { received.push(password); return "filled"; } }) }
  });
  await response.text;
  assert.deepEqual(received, [secret]);
  assert.equal(calls, 2);
});
