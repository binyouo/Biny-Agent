import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText, streamText, tool, jsonSchema, type ModelMessage } from "ai";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { createVercelLanguageModel, type VercelModelInput } from "../src/llm/vercelModel.js";
import { projectCompatibleToolMetadata } from "../src/llm/compatibleToolMetadata.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentMessage, AgentTool } from "../src/agent/core/types.js";
import { ConfiguredProviderRuntime } from "../src/llm/ProviderRuntime.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";

// Opaque synthetic response metadata, never a real provider signature or credential.
const signature = "synthetic-thought-token-A";
const otherSignature = "synthetic-thought-token-B";
const parameters = { type: "object" as const, properties: { query: { type: "string" as const } }, required: ["query"], additionalProperties: false };
const sdkTools = { Inspect: tool({ inputSchema: jsonSchema<{ query: string }>(parameters) }) };
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function records(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value)); return value.map(record);
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
}
function calls(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return records(body.messages).filter(message => message.role === "assistant").flatMap(message => message.tool_calls ? records(message.tool_calls) : []);
}
function wireSignature(call: Record<string, unknown>): unknown {
  return call.extra_content ? record(record(call.extra_content).google).thought_signature : undefined;
}
function response(streaming: boolean, first = false, parallel = false): Response {
  const toolCalls = [signature, ...(parallel ? [otherSignature] : [])].map((value, index) => ({
    index, id: `inspect-${String(index)}`, type: "function", function: { name: "Inspect", arguments: JSON.stringify({ query: `value-${String(index)}` }) },
    extra_content: { google: { thought_signature: value } }
  }));
  const message = first ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: "OK" };
  const head = { id: "fixture", created: 1, model: "fixture" };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!streaming) return new Response(JSON.stringify({ ...head, object: "chat.completion", choices: [{ index: 0, message, finish_reason: first ? "tool_calls" : "stop" }], usage }), { headers: { "content-type": "application/json" } });
  return new Response([
    `data: ${JSON.stringify({ ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: message, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage })}`,
    "data: [DONE]", ""
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}
const route = { providerType: "gemini", api: "chat_completions", authMode: "api-key", modelId: "gemini-3.1-pro-preview", supportsReasoning: true,
  baseUrl: "https://provider.invalid/v1", apiKey: "inert-fixture", headers: {} } as const;

for (const [alias, namespace] of [["google", "google"], ["gemini", "gemini"], ["gemini-work", "gemini-work"], ["gemini-work", "geminiWork"], ["gemini_work", "geminiWork"], ["gemini.proxy", "gemini"]] as const) {
  for (const streaming of [false, true]) test(`wire ${streaming ? "stream" : "generate"} roundtrip keeps parallel signatures and ${alias}/${namespace} options`, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createVercelLanguageModel({ ...route, providerAlias: alias, fetcher: async (url, init) => {
      assert.equal(String(url), `${route.baseUrl}/chat/completions`); assert.ok(typeof init?.body === "string");
      bodies.push(record(JSON.parse(String(init.body)))); assert.ok(bodies.length <= 2);
      return response(streaming, bodies.length === 1, true);
    } });
    const providerOptions = { [namespace]: { reasoningEffort: "high" } };
    const options = { model, messages: [{ role: "user" as const, content: "Inspect two values" }], tools: sdkTools, providerOptions, maxRetries: 0 };
    const first = streaming ? streamText(options) : await generateText(options);
    const received = await first.toolCalls;
    assert.equal(received.length, 2);
    const history: AgentMessage[] = [options.messages[0]!, { role: "assistant", content: received.map(call => ({ type: "toolCall", id: call.toolCallId,
      name: call.toolName, arguments: record(call.input), providerMetadata: call.providerMetadata })) },
      ...received.map(call => ({ role: "toolResult" as const, toolCallId: call.toolCallId, toolName: call.toolName, content: [{ type: "text" as const, text: "synthetic result" }] }))];
    assert.deepEqual(received.map(call => call.providerMetadata), [{ [namespace]: { thoughtSignature: signature } }, { [namespace]: { thoughtSignature: otherSignature } }]);
    const before = structuredClone(history); freeze(history);
    const secondOptions = { ...options, messages: toModelMessages(history) };
    const second = streaming ? streamText(secondOptions) : await generateText(secondOptions);
    assert.equal(await second.text, "OK"); assert.equal(bodies.length, 2);
    assert.deepEqual(calls(bodies[1]!).map(wireSignature), [signature, otherSignature]);
    assert.deepEqual(calls(bodies[1]!).map(call => call.id), ["inspect-0", "inspect-1"]);
    assert.ok(bodies.every(body => body.reasoning_effort === "high"));
    assert.deepEqual(history, before);
  });
}

for (const enabled of [false, true]) for (const alias of ["google", "gemini", "gemini-work"]) {
  test(`normal configured agent loop returns signature with ${alias}, thinking=${String(enabled)}`, async () => {
    const bodies: Array<Record<string, unknown>> = []; let executions = 0;
    const config = configSchema.parse({ ...defaultConfig, defaultModel: "fixture", thinking: { ...defaultConfig.thinking, enabled },
      providers: { [alias]: { type: "gemini", baseUrl: route.baseUrl, apiKey: "inert-fixture" } },
      models: { fixture: { provider: alias, model: route.modelId } } });
    const runtime = new ConfiguredProviderRuntime(alias, config.providers[alias]!, new AiRegistry(), [], undefined, async (url, init) => {
      assert.equal(String(url), `${route.baseUrl}/chat/completions`); assert.ok(typeof init?.body === "string");
      bodies.push(record(JSON.parse(String(init.body)))); assert.ok(bodies.length <= 2);
      return response(true, bodies.length === 1);
    });
    const settings = runtime.createModelSettings(config, config.models.fixture!);
    assert.equal(settings.model.supportsTools, true); assert.ok(settings.vercelModel);
    const tools: AgentTool[] = [{ name: "Inspect", description: "Synthetic no-op inspection", parameters, execute: async (id, args) => {
      executions++; assert.equal(id, "inspect-0"); assert.deepEqual(args, { query: "value-0" }); return { content: [{ type: "text", text: "synthetic result" }] };
    } }];
    const events = [];
    for await (const event of vercelAgentLoopContinue({ messages: [{ role: "user", content: "Inspect a value" }], tools }, {
      model: settings.model, vercelModel: settings.vercelModel, tools, maxSteps: 3, maxRetries: 0,
      modelOptions: { providerOptions: settings.providerOptions, reasoning: settings.reasoning, cacheMarkers: settings.cacheMarkers }
    })) events.push(event);
    assert.equal(events.filter(event => event.type === "error").length, 0); assert.equal(executions, 1); assert.equal(bodies.length, 2);
    const end = events.find(event => event.type === "agent_end"); assert.ok(end);
    const assistant = end.messages[0]; assert.equal(assistant?.role, "assistant");
    const canonical = assistant.content.find(part => part.type === "toolCall"); assert.ok(canonical);
    assert.deepEqual(canonical.providerMetadata, { [alias]: { thoughtSignature: signature } });
    assert.equal(wireSignature(calls(bodies[1]!)[0]!), signature);
  });
}

function toolPart(id: string, providerOptions?: Record<string, Record<string, string | number | null>>) {
  return { type: "tool-call" as const, toolCallId: id, toolName: "Inspect", input: { query: id }, providerOptions };
}

test("projection preserves each owner, renamed historical aliases, repeated signatures and frozen inputs", () => {
  const prompt: LanguageModelV4Prompt = [{ role: "assistant", providerOptions: { message: { thoughtSignature: "not-call-local" } }, content: [
    { type: "text", text: "Keep text", providerOptions: { text: { thoughtSignature: "not-call-local" } } },
    toolPart("old", { "retired-alias": { thoughtSignature: signature, extra: "keep" }, google: { another: "keep" } }),
    toolPart("camel", { retiredAlias: { thoughtSignature: otherSignature }, "retired-alias": { thoughtSignature: otherSignature } })
  ] }, { role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "Inspect", output: { type: "text", value: "result" } }] },
  { role: "assistant", content: [toolPart("second-step", { previous: { thoughtSignature: "step-two" } })] }];
  const before = structuredClone(prompt); freeze(prompt);
  const projected = projectCompatibleToolMetadata(prompt);
  assert.deepEqual(prompt, before); assert.notStrictEqual(projected, prompt);
  assert.strictEqual(projected[0]!.providerOptions, prompt[0]!.providerOptions);
  const assistant = projected[0]; assert.equal(assistant?.role, "assistant");
  const source = prompt[0]; assert.equal(source?.role, "assistant");
  assert.strictEqual(assistant.content[0], source.content[0]); assert.strictEqual(projected[1], prompt[1]);
  assert.deepEqual(assistant.content[1]?.providerOptions, { "retired-alias": { thoughtSignature: signature, extra: "keep" }, google: { another: "keep", thoughtSignature: signature } });
  assert.equal(assistant.content[2]?.providerOptions?.google?.thoughtSignature, otherSignature);
  const next = projected[2]; assert.equal(next?.role, "assistant"); assert.equal(next.content[0]?.providerOptions?.google?.thoughtSignature, "step-two");
  assert.strictEqual(projectCompatibleToolMetadata(projected), projected);
});

test("projection never overwrites Google, guesses conflicts, copies non-call metadata or invents absent signatures", () => {
  const prompt: LanguageModelV4Prompt = [{ role: "user", content: [{ type: "text", text: signature, providerOptions: { alias: { thoughtSignature: signature } } }] },
    { role: "assistant", providerOptions: { alias: { thoughtSignature: signature } }, content: [
      { type: "reasoning", text: "reasoning", providerOptions: { alias: { thoughtSignature: signature } } },
      { type: "text", text: JSON.stringify({ thoughtSignature: signature }) },
      toolPart("absent"), toolPart("empty", { alias: { thoughtSignature: "" } }), toolPart("number", { alias: { thoughtSignature: 42 } }),
      toolPart("conflict", { one: { thoughtSignature: signature }, two: { thoughtSignature: otherSignature } }),
      ...[signature, "", null, 42].map((value, index) => toolPart(`explicit-${String(index)}`, { google: { thoughtSignature: value }, alias: { thoughtSignature: otherSignature } }))
    ] }, { role: "tool", content: [{ type: "tool-result", toolCallId: "absent", toolName: "Inspect", providerOptions: { alias: { thoughtSignature: signature } }, output: { type: "text", value: signature } }] }];
  freeze(prompt); assert.strictEqual(projectCompatibleToolMetadata(prompt), prompt);
});

for (const streaming of [false, true]) test(`wire ${streaming ? "stream" : "generate"} replays old aliases and separate batches without sharing unsigned calls`, async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "Inspect" }, { role: "assistant", content: [
    { ...toolPart("old", { retiredAlias: { thoughtSignature: signature } }) }, toolPart("unsigned")
  ] }, { role: "tool", content: ["old", "unsigned"].map(toolCallId => ({ type: "tool-result" as const, toolCallId, toolName: "Inspect", output: { type: "text" as const, value: "done" } })) },
  { role: "assistant", content: [toolPart("second", { "older-alias": { thoughtSignature: otherSignature } })] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "second", toolName: "Inspect", output: { type: "text", value: "done" } }] }];
  const before = structuredClone(messages); freeze(messages);
  const bodies: Array<Record<string, unknown>> = [];
  const model = createVercelLanguageModel({ ...route, providerAlias: "new-alias", fetcher: async (_url, init) => {
    bodies.push(record(JSON.parse(String(init?.body)))); return response(streaming);
  } });
  const options = { model, messages, maxRetries: 0 };
  const result = streaming ? streamText(options) : await generateText(options);
  assert.equal(await result.text, "OK"); assert.equal(bodies.length, 1);
  assert.deepEqual(calls(bodies[0]!).map(wireSignature), [signature, undefined, otherSignature]);
  assert.deepEqual(messages, before);
});

for (const [name, nativeRoute] of [
  ["native Google", { providerType: "google-native", api: "google_generative_ai", supportsReasoning: true }],
  ["Gemini native API override", { providerType: "gemini", api: "google_generative_ai", supportsReasoning: true }],
  ["generic compatible", { providerType: "openai-compatible", api: "chat_completions", supportsReasoning: false }],
  ["OpenAI compatible", { providerType: "openai", api: "chat_completions", supportsReasoning: false }],
  ["Anthropic", { providerType: "anthropic", api: "anthropic_messages", supportsReasoning: false }],
  ["Responses", { providerType: "openai", api: "responses", supportsReasoning: true }],
  ["native OpenAI Chat", { providerType: "openai", api: "chat_completions", supportsReasoning: true }]
] satisfies Array<[string, Pick<VercelModelInput, "providerType" | "api" | "supportsReasoning">]>) {
  test(`${name} does not project compatible-only alias metadata`, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createVercelLanguageModel({ ...route, ...nativeRoute, modelId: nativeRoute.api === "google_generative_ai" ? "gemini-2.5-flash" : nativeRoute.api === "anthropic_messages" ? "claude-3-5-sonnet-20241022" : "gpt-4o", providerAlias: "fixture", fetcher: async (_url, init) => {
      bodies.push(record(JSON.parse(String(init?.body))));
      if (nativeRoute.api === "google_generative_ai") return new Response(JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { headers: { "content-type": "application/json" } });
      if (nativeRoute.api === "anthropic_messages") return new Response(JSON.stringify({ id: "fixture", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });
      if (nativeRoute.api === "responses") return new Response(JSON.stringify({ id: "fixture", object: "response", created_at: 1, model: "fixture", status: "completed", error: null, output: [{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
      return response(false);
    } });
    for (const metadata of [undefined, { fixture: { thoughtSignature: signature } }]) {
      const messages: ModelMessage[] = [{ role: "user", content: "Inspect" }, { role: "assistant", content: [toolPart("call", metadata)] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "Inspect", output: { type: "text", value: "done" } }] }];
      assert.equal((await generateText({ model, messages, maxRetries: 0 })).text, "OK");
    }
    assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
  });
}
