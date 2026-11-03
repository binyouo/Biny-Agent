import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { generateText, streamText, type ModelMessage } from "ai";
import type { LanguageModelV4Prompt, LanguageModelV4FilePart } from "@ai-sdk/provider";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentMessage } from "../src/agent/core/types.js";
import { createVercelLanguageModel, type VercelModelInput } from "../src/llm/vercelModel.js";

function pixelImage(red: number, green: number, blue: number): string {
  const chunk = (name: string, data: Buffer): Buffer => {
    const type = Buffer.from(name); const size = Buffer.alloc(4); const checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue]))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const imageA = pixelImage(255, 0, 0);
const imageB = pixelImage(0, 0, 255);
const firstText = "  First 中文 😀 caption\r\nEND-A\t  ";
const secondText = "Second caption <literal> END-B";
const latest = "Continue: KEEP-LATEST-USER";

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function records(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

function matching(value: unknown, type: string): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return [];
  return [...(!Array.isArray(value) && record(value).type === type ? [record(value)] : []),
    ...Object.values(value).flatMap(child => matching(child, type))];
}

function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

function history(options: { parallel?: boolean; imageOnly?: boolean; latest?: boolean; patch?: boolean; twoBatches?: boolean } = {}): AgentMessage[] {
  const calls = [{ type: "toolCall" as const, id: "image-call", name: "BrowserScreenshot", arguments: {} }];
  if (options.parallel) calls.push({ type: "toolCall", id: "read-call", name: "Read", arguments: {} });
  if (options.patch) calls.push({ type: "toolCall", id: "patch-call", name: "apply_patch", arguments: {} });
  const messages: AgentMessage[] = [
    { role: "user", content: "Inspect" },
    { role: "assistant", content: calls },
    { role: "toolResult", toolName: "BrowserScreenshot", toolCallId: "image-call", isError: false,
      content: options.imageOnly ? [{ type: "image", mimeType: "image/png", data: imageA }] : [
        { type: "text", text: firstText }, { type: "image", mimeType: "image/png", data: imageA },
        { type: "text", text: secondText }, { type: "image", mimeType: "image/png", data: imageB }
      ] }
  ];
  if (options.parallel) messages.push({ role: "toolResult", toolName: "Read", toolCallId: "read-call", content: [{ type: "text", text: "READ-RESULT" }] });
  if (options.patch) messages.push({ role: "toolResult", toolName: "apply_patch", toolCallId: "patch-call", content: [{ type: "text", text: "PATCH-RESULT" }] });
  if (options.twoBatches) messages.push(
    { role: "assistant", content: [{ type: "toolCall", id: "second-call", name: "RenderImage", arguments: {} }] },
    { role: "toolResult", toolName: "RenderImage", toolCallId: "second-call", content: [{ type: "image", mimeType: "image/png", data: imageA }] }
  );
  if (options.latest) messages.push({ role: "user", content: latest });
  return messages;
}

interface Route { providerType: string; api: VercelModelInput["api"]; supportsReasoning: boolean }
const chatRoutes: Array<[string, Route]> = [
  ["compatible", { providerType: "openai-compatible", api: "chat_completions", supportsReasoning: false }],
  ["OpenAI nonreasoning", { providerType: "openai", api: "chat_completions", supportsReasoning: false }],
  ["OpenAI reasoning", { providerType: "openai", api: "chat_completions", supportsReasoning: true }]
];

function responseFor(api: Route["api"], streaming: boolean): Response {
  const headers = { "content-type": streaming ? "text/event-stream" : "application/json" };
  if (streaming) {
    const head = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    return new Response([
      `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
      "data: [DONE]", ""
    ].join("\n\n"), { headers });
  }
  if (api === "responses") return new Response(JSON.stringify({ id: "response-fixture", object: "response", created_at: 1,
    status: "completed", error: null, model: "fixture", output: [{ id: "message-fixture", type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "OK", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { headers });
  if (api === "anthropic_messages") return new Response(JSON.stringify({ id: "message-fixture", type: "message", role: "assistant", model: "fixture",
    content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { headers });
  if (api === "google_generative_ai") return new Response(JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: "fixture" }), { headers });
  return new Response(JSON.stringify({ id: "fixture", object: "chat.completion", created: 1, model: "fixture", choices: [
    { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }
  ], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers });
}

async function request(route: Route, messages: ModelMessage[], options: { streaming?: boolean; supportsVision?: boolean } = {}): Promise<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  const model = createVercelLanguageModel({ ...route, providerAlias: "fixture", authMode: "api-key", modelId: "fixture",
    supportsVision: options.supportsVision, baseUrl: "https://provider.invalid/v1", apiKey: "fixture-not-a-credential", headers: {},
    fetcher: async (url, init) => {
      assert.ok(String(url).startsWith("https://provider.invalid/v1/"), "only the injected synthetic endpoint is used");
      assert.ok(typeof init?.body === "string");
      requests.push(record(JSON.parse(init.body)));
      return responseFor(route.api, options.streaming ?? false);
    }
  });
  const response = options.streaming ? streamText({ model, messages, maxRetries: 0 }) : await generateText({ model, messages, maxRetries: 0 });
  assert.equal(await response.text, "OK");
  assert.equal(requests.length, 1);
  return requests[0]!;
}

function assertToolImageWire(body: Record<string, unknown>, expectedImages: readonly string[]): void {
  const messages = records(body.messages);
  const images = matching(messages, "image_url");
  assert.deepEqual(images.map(image => record(image.image_url).url), expectedImages.map(data => `data:image/png;base64,${data}`),
    "tool images must be actual image input in their original order, never only encoded text");
  for (const message of messages.filter(item => item.role === "tool")) {
    assert.ok(typeof message.content === "string");
    for (const data of expectedImages) assert.equal(message.content.includes(data), false, "binary data must not remain in tool text");
  }
}

for (const [name, route] of chatRoutes) for (const streaming of [false, true]) {
  test(`wire Chat ${name} ${streaming ? "stream" : "generate"} preserves image modality and parallel result adjacency`, async () => {
    const source = history({ parallel: true, latest: true });
    const before = structuredClone(source); freeze(source);
    const body = await request(route, toModelMessages(source), { streaming, supportsVision: true });
    assertToolImageWire(body, [imageA, imageB]);
    const messages = records(body.messages);
    assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "tool", "user", "user"]);
    assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["image-call", "read-call"]);
    const output = records(JSON.parse(String(messages[2]!.content)));
    assert.equal(output[0]!.text, firstText); assert.match(String(output[1]!.text), /Image 1/u);
    assert.equal(output[2]!.text, secondText); assert.match(String(output[3]!.text), /Image 2/u);
    const media = records(messages[4]!.content);
    assert.deepEqual(media.map(part => part.type), ["text", "image_url", "text", "image_url"]);
    assert.match(String(media[0]!.text), /BrowserScreenshot.*image-call.*image 1/u);
    assert.match(String(media[2]!.text), /BrowserScreenshot.*image-call.*image 2/u);
    assert.match(String(media[0]!.text), /not a new user request/u);
    assert.equal(messages.at(-1)!.content, latest);
    assert.deepEqual(source, before);
  });
}

test("wire image-only batches flush at EOF and do not cross an assistant boundary", async () => {
  const body = await request(chatRoutes[0]![1], toModelMessages(history({ imageOnly: true, twoBatches: true })), { supportsVision: true });
  assertToolImageWire(body, [imageA, imageA]);
  const messages = records(body.messages);
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "user", "assistant", "tool", "user"]);
  assert.match(String(records(messages[3]!.content)[0]!.text), /image-call/u);
  assert.match(String(records(messages[6]!.content)[0]!.text), /second-call/u);
});

test("wire parallel image results keep each tool association and per-result numbering", async () => {
  const source = history({ imageOnly: true, parallel: true });
  const secondResult = source[3]; assert.equal(secondResult?.role, "toolResult");
  secondResult.content = [{ type: "image", mimeType: "image/png", data: imageB }];
  const body = await request(chatRoutes[0]![1], toModelMessages(source), { supportsVision: true });
  assertToolImageWire(body, [imageA, imageB]);
  const messages = records(body.messages);
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "tool", "user"]);
  const media = records(messages[4]!.content);
  assert.match(String(media[0]!.text), /BrowserScreenshot.*image-call.*image 1/u);
  assert.match(String(media[2]!.text), /Read.*read-call.*image 1/u);
});

test("wire unknown vision capability permits the existing direct-image attempt", async () => {
  assertToolImageWire(await request(chatRoutes[0]![1], toModelMessages(history({ imageOnly: true }))), [imageA]);
});

test("wire explicitly non-visual models retain their existing request behavior", async () => {
  const body = await request(chatRoutes[0]![1], toModelMessages(history({ imageOnly: true })), { supportsVision: false });
  assert.equal(matching(body, "image_url").length, 0);
  assert.ok(String(records(body.messages).find(message => message.role === "tool")!.content).includes(imageA));
});

test("wire vision descriptions and text-only tool results stay unchanged", async () => {
  const source = history();
  const result = source[2]; assert.equal(result?.role, "toolResult");
  result.content = [{ type: "text", text: "[Image description from vision model; may be incomplete]\nDESCRIPTION" }];
  const messages = toModelMessages(source);
  const compatible = await request(chatRoutes[0]![1], messages, { supportsVision: true });
  const nonvisual = await request(chatRoutes[0]![1], messages, { supportsVision: false });
  assert.deepEqual(compatible, nonvisual);
  assert.equal(matching(compatible, "image_url").length, 0);
});

for (const vision of [true, false, undefined]) test(`wire resolved ProviderRuntime vision=${String(vision)} reaches the Chat adapter`, async () => {
  const { ConfiguredProviderRuntime } = await import("../src/llm/ProviderRuntime.js");
  const { AiRegistry } = await import("../src/llm/AiRegistry.js");
  const { configSchema, defaultConfig } = await import("../src/config/schema.js");
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "fixture",
    thinking: { ...defaultConfig.thinking, enabled: false },
    providers: { fixture: { type: "openai-compatible", baseUrl: "https://provider.invalid/v1", apiKey: "fixture-not-a-credential" } },
    models: { fixture: { provider: "fixture", model: "fixture", capabilities: { vision } } }
  });
  const requests: Array<Record<string, unknown>> = [];
  const runtime = new ConfiguredProviderRuntime("fixture", config.providers.fixture!, new AiRegistry(), [], undefined, async (url, init) => {
    assert.equal(String(url), "https://provider.invalid/v1/chat/completions");
    assert.ok(typeof init?.body === "string");
    requests.push(record(JSON.parse(init.body)));
    return responseFor("chat_completions", false);
  });
  const settings = runtime.createModelSettings(config, config.models.fixture!);
  assert.equal(settings.model.supportsVision, vision);
  assert.ok(settings.vercelModel);
  await generateText({ model: settings.vercelModel, messages: toModelMessages(history({ imageOnly: true })), maxRetries: 0 });
  assert.equal(requests.length, 1);
  if (vision === false) assert.equal(matching(requests[0], "image_url").length, 0);
  else assertToolImageWire(requests[0]!, [imageA]);
});

test("wire projected images precede existing historical patch notes without splitting tool results", async () => {
  const body = await request(chatRoutes[0]![1], toModelMessages(history({ imageOnly: true, parallel: true, patch: true, latest: true })), { supportsVision: true });
  assertToolImageWire(body, [imageA]);
  const messages = records(body.messages);
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "tool", "user", "assistant", "user"]);
  assert.match(String(messages[5]!.content), /Historical file patch result.*PATCH-RESULT/u);
  assert.equal(messages.at(-1)!.content, latest);
});

for (const [name, route, imageType] of [
  ["Responses", { providerType: "openai", api: "responses", supportsReasoning: true }, "input_image"],
  ["Anthropic", { providerType: "anthropic", api: "anthropic_messages", supportsReasoning: false }, "image"],
  ["Google", { providerType: "google-native", api: "google_generative_ai", supportsReasoning: false }, "inlineData"]
] as const) test(`wire ${name} keeps its native tool-image encoding`, async () => {
  const messages = toModelMessages(history({ imageOnly: true }));
  const body = await request(route, messages, { supportsVision: true });
  assert.deepEqual(body, await request(route, messages, { supportsVision: false }), "vision capability must not change native protocol requests");
  assert.equal(JSON.stringify(body).includes("Tool-provided image"), false);
  assert.ok(JSON.stringify(body).includes(imageA));
  if (imageType === "inlineData") assert.ok(JSON.stringify(body).includes('"inlineData"'));
  else assert.equal(matching(body, imageType).length, 1);
});

test("pure projection preserves all metadata at its owner and is idempotent", async () => {
  const { projectChatToolImages } = await import("../src/llm/chatToolImages.js");
  const file: LanguageModelV4FilePart = { type: "file", mediaType: "image/png", data: { type: "data", data: imageA }, providerOptions: { fixture: { image: "keep" } } };
  const prompt: LanguageModelV4Prompt = [{ role: "tool", providerOptions: { fixture: { message: "keep" } }, content: [
    { type: "tool-result", toolName: "Image", toolCallId: "call", providerOptions: { fixture: { part: "keep" } }, output: {
      type: "content", value: [
        { type: "text", text: firstText, providerOptions: { fixture: { text: "keep" } } }, file
      ] } }
  ] }];
  const before = structuredClone(prompt); freeze(prompt);
  const projected = projectChatToolImages(prompt);
  assert.deepEqual(prompt, before);
  assert.deepEqual(projected[0]!.providerOptions, prompt[0]!.providerOptions);
  const message = projected[0]; assert.equal(message?.role, "tool");
  const original = prompt[0]; assert.equal(original?.role, "tool");
  const result = message.content[0]; const old = original.content[0];
  assert.equal(result?.type, "tool-result"); assert.equal(old?.type, "tool-result");
  assert.deepEqual(result.providerOptions, old.providerOptions);
  assert.equal(result.output.type, "content"); assert.equal(old.output.type, "content");
  assert.strictEqual(result.output.value[0], old.output.value[0]);
  const imageMessage = projected[1]; assert.equal(imageMessage?.role, "user");
  assert.equal(imageMessage.providerOptions, undefined);
  assert.strictEqual(imageMessage.content[1], file);
  assert.strictEqual(projectChatToolImages(projected), projected);
});

test("pure text, errors, JSON, non-image files and unsupported image data kinds are untouched", async () => {
  const { projectChatToolImages } = await import("../src/llm/chatToolImages.js");
  const prompt: LanguageModelV4Prompt = [{ role: "tool", content: [
    { type: "tool-result", toolName: "Read", toolCallId: "text", output: { type: "text", value: firstText, providerOptions: { fixture: { output: "keep" } } } },
    { type: "tool-result", toolName: "Read", toolCallId: "error", output: { type: "error-text", value: imageA } },
    { type: "tool-result", toolName: "Read", toolCallId: "json", output: { type: "json", value: { image: imageA } } },
    { type: "tool-result", toolName: "Read", toolCallId: "content", output: { type: "content", value: [
      { type: "text", text: imageA },
      { type: "file", mediaType: "audio/wav", data: { type: "data", data: "AAAA" } },
      { type: "file", mediaType: "image/png", data: { type: "reference", reference: { fixture: "file-id" } } },
      { type: "file", mediaType: "image/png", data: { type: "text", text: imageA } },
      { type: "file", mediaType: "image/png", data: { type: "url", url: new URL("https://fixture.invalid/image.png") } }
    ] } }
  ] }];
  const before = JSON.stringify(prompt); freeze(prompt);
  assert.strictEqual(projectChatToolImages(prompt), prompt);
  assert.equal(JSON.stringify(prompt), before);
});
