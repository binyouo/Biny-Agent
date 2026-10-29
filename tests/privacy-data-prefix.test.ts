import assert from "node:assert/strict";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { maskJson } from "../src/privacy/json.js";

const secret = "sk-proj-0123456789abcdefghijklmnop";
const text = `data: {"api_key":"${secret}","escaped":"quote\\""}\n\nPlease debug this SSE log.`;
const settings = { enabled: true };

test("data-prefixed user text survives timestamp projection but not privacy masking", async () => {
  const config = configSchema.parse({ ...defaultConfig, redaction: settings, defaultModel: "fixture", providers: {
    fixture: { type: "openai-compatible", apiKey: "fixture-auth", baseUrl: "https://privacy.invalid/v1" }
  }, models: { fixture: { provider: "fixture", model: "fixture" } } });
  const bodies: string[] = [];
  const registry = new ProviderRegistry(config, [], undefined, undefined, async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  await generateNativeText(registry.createModelSettings().model, [{ role: "user", sentAt: "2026-10-29T12:00:00.000Z", content: [
    { type: "text", text }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }
  ] }], { requestContext: { sessionId: "privacy-data-prefix", operation: "agent" } });
  const body = JSON.parse(bodies[0]!);
  assert.ok(bodies[0]!.includes("Message sent-at:"));
  assert.ok(!bodies[0]!.includes(secret));
  const parts = body.messages[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.ok(parts.some(part => part.text?.startsWith("data: ")));
  assert.equal(parts.find(part => part.type === "image_url")?.image_url?.url, "data:image/png;base64,iVBORw0KGgo=");
});

test("data-prefixed tool text and nested arguments remain maskable user data", () => {
  for (const input of [
    { messages: [{ role: "tool", content: text }] },
    { messages: [{ role: "assistant", tool_calls: [{ function: { name: "write_file", arguments: JSON.stringify({ content: text, nested: { password: "data:ordinary-password" } }) } }] }] },
    { messages: [{ content: [{ type: "tool_use", input: { content: text, file: { type: "input_file", file_data: text }, password: "data:ordinary-password" } }] }] },
    { contents: [{ parts: [{ functionCall: { name: "write_file", args: { content: text, type: "input_file", file_data: text } } }] }] }
  ]) {
    const result = maskJson(JSON.stringify(input), settings);
    assert.ok(!result.text.includes(secret));
    assert.ok(!result.text.includes("data:ordinary-password"));
    assert.doesNotThrow(() => JSON.parse(result.text));
  }
});

test("typed media retains opaque bytes while text resembling media is still inspected", () => {
  // Include a detectable sequence so unchanged payloads prove the media boundary.
  const payload = `data:application/pdf;base64,${secret}`;
  const input = { messages: [{ content: [
    { type: "image_url", image_url: { url: payload } },
    { type: "input_audio", input_audio: { data: payload, format: "wav" } },
    { type: "file", file: { filename: "sample.pdf", file_data: payload } },
    { type: "text", text: payload }
  ] }], input: [{ content: [{ type: "input_file", file_data: payload }] }], contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: payload } }] }] };
  const result = JSON.parse(maskJson(JSON.stringify(input), settings).text);
  assert.deepEqual(result.messages[0].content.slice(0, 3), input.messages[0]!.content.slice(0, 3));
  assert.deepEqual(result.input, input.input);
  assert.deepEqual(result.contents, input.contents);
  assert.ok(!result.messages[0].content[3].text.includes(secret));
  for (const value of [`data: ${secret}`, `data:image/png;base64,${secret}`, `data:application/pdf;base64,${secret}`]) {
    assert.ok(!maskJson(JSON.stringify({ messages: [{ content: value }] }), settings).text.includes(secret));
  }
});

test("escaped prefixes are inspected and output media and disabled requests retain exact bytes", () => {
  const source = JSON.stringify({ messages: [{ content: text }] }).replace('data:', '\\u0064ata:');
  assert.ok(!maskJson(source, settings).text.includes(secret));
  assert.equal(maskJson(source, { enabled: false }).text, source);
  const payload = `data:application/pdf;base64,${secret}`;
  const media = { input: [{ type: "function_call_output", output: [{ type: "input_file", file_data: payload }] }] };
  assert.equal(maskJson(JSON.stringify(media), settings).text, JSON.stringify(media));
  const mimics = { metadata: { type: "input_file", file_data: payload }, messages: [{ content: [{ type: "text", text: `data:text/plain,${secret}%20end` }] }] };
  assert.ok(!maskJson(JSON.stringify(mimics), settings).text.includes(secret));
});
