import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPrivacyFetch } from "../src/privacy/privacyFetch.js";
import { maskingDetail, maskingOverview, resetMaskRecordsForTest } from "../src/privacy/record.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";

type Protocol = "chat" | "anthropic" | "responses" | "gemini";
const secret = "sk-proj-fixture0123456789abcdefghijklmnop";
const notice = "Privacy placeholders written as {{TYPE_<hash>}} stand for values kept on this computer. "
  + "Copy each placeholder unchanged in replies and tool arguments; the local runtime restores its value before tool execution. "
  + "Do not infer the hidden value, substitute examples, or ask the user to reveal it.";

async function outgoing(protocol: Protocol, body: unknown, options: { enabled?: boolean; providerType?: string; sessionId?: string } = {}): Promise<string> {
  let sent = "";
  const fetch = createPrivacyFetch(async (_url, init) => {
    sent = String(init?.body);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }, { settings: { enabled: options.enabled ?? true }, provider: "fixture", model: "fixture", protocol, providerType: options.providerType });
  await (await fetch("https://fixture.invalid", { method: "POST", headers: { "x-session-id": options.sessionId ?? randomUUID() },
    body: typeof body === "string" ? body : JSON.stringify(body) })).text();
  return sent;
}

const conversations = {
  chat: { messages: [{ role: "system", content: "Keep these instructions." }, { role: "user", content: secret }] },
  anthropic: { system: [{ type: "text", text: "Keep these instructions.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: secret }] }] },
  responses: { instructions: "Keep these instructions.", input: [{ role: "user", content: [{ type: "input_text", text: secret }] }] },
  gemini: { systemInstruction: { parts: [{ text: "Keep these instructions." }] }, contents: [{ role: "user", parts: [{ text: secret }] }] }
};

for (const protocol of Object.keys(conversations) as Protocol[]) test(`${protocol} explains placeholders without rewriting earlier instructions`, async () => {
  const sent = await outgoing(protocol, conversations[protocol]);
  assert.ok(!sent.includes(secret));
  assert.equal(sent.split(notice).length - 1, 1);
  const body = JSON.parse(sent);
  if (protocol === "chat") {
    assert.deepEqual(body.messages[0], conversations.chat.messages[0]);
    assert.ok(body.messages[1].content.endsWith("\n\n" + notice));
  } else if (protocol === "anthropic") {
    assert.deepEqual(body.system, conversations.anthropic.system);
    assert.deepEqual(body.messages[0].content[1], { type: "text", text: notice });
  } else if (protocol === "responses") {
    assert.equal(body.instructions, "Keep these instructions.");
    assert.deepEqual(body.input[1], { role: "developer", content: [{ type: "input_text", text: notice }] });
  } else {
    assert.deepEqual(body.systemInstruction, conversations.gemini.systemInstruction);
    assert.deepEqual(body.contents[0].parts[1], { text: notice });
  }
});

for (const protocol of ["chat", "anthropic", "gemini"] as const) test(`${protocol} keeps the already sent conversation prefix when a tool first reveals a secret`, async () => {
  const prefix = protocol === "gemini"
    ? [{ role: "user", parts: [{ text: "Start." }] }, { role: "model", parts: [{ text: "Reading." }] }]
    : [{ role: "user", content: "Start." }, { role: "assistant", content: "Reading." }];
  const messages = protocol === "gemini" ? [...prefix, { role: "user", parts: [{ functionResponse: { name: "read", response: { text: secret } } }] }]
    : protocol === "anthropic" ? [...prefix, { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: secret }] }]
      : [...prefix, { role: "tool", tool_call_id: "read-1", content: secret }];
  const input = protocol === "gemini" ? { contents: messages } : { messages };
  const sessionId = randomUUID();
  const first = await outgoing(protocol, input, { sessionId });
  const second = await outgoing(protocol, input, { sessionId });
  assert.equal(second, first);
  const sent = JSON.parse(first);
  assert.deepEqual((sent.contents ?? sent.messages).slice(0, 2), prefix);
  assert.equal(first.split(notice).length - 1, 1);
});

test("Responses keeps a parallel tool-output batch together and leaves instructions and earlier items alone", async () => {
  const prefix = [{ role: "user", content: "Read both files." }, { type: "function_call", call_id: "read-1", name: "read", arguments: "{}" }];
  const body = { instructions: "Original instructions.", input: [...prefix,
    { type: "function_call_output", call_id: "read-1", output: secret },
    { type: "function_call_output", call_id: "read-2", output: "Second file." }, { role: "user", content: "Continue." }] };
  const sent = JSON.parse(await outgoing("responses", body));
  assert.equal(sent.instructions, body.instructions);
  assert.deepEqual(sent.input.slice(0, 2), prefix);
  assert.equal(sent.input[3].call_id, "read-2");
  assert.equal(sent.input[4].role, "developer");
  assert.equal(sent.input[5].content, "Continue.");
});

for (const protocol of Object.keys(conversations) as Protocol[]) test(`${protocol} puts a notice in instructions when system text or tools are masked`, async () => {
  const body = protocol === "chat" ? { messages: [{ role: "developer", content: secret }, { role: "user", content: "Continue." }] }
    : protocol === "anthropic" ? { system: [{ type: "text", text: secret, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "Continue." }] }
      : protocol === "responses" ? { instructions: secret, input: [{ role: "user", content: "Continue." }] }
        : { system_instruction: { parts: [{ text: secret }] }, contents: [{ role: "user", parts: [{ text: "Continue." }] }] };
  const sent = JSON.parse(await outgoing(protocol, body));
  if (protocol === "chat") assert.ok(sent.messages[0].content.endsWith(notice));
  else if (protocol === "anthropic") {
    assert.deepEqual(sent.system[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(sent.system[1], { type: "text", text: notice });
  } else if (protocol === "responses") assert.equal(sent.input[0].role, "developer");
  else assert.deepEqual(sent.system_instruction.parts[1], { text: notice });
});

test("masked tool descriptions get an instruction without changing schemas or call identity", async () => {
  const tools = [{ type: "function", function: { name: "read", description: secret, parameters: { type: "object", properties: { id: { type: "string" } } } } }];
  const sent = JSON.parse(await outgoing("chat", { tools, messages: [{ role: "user", content: "Read." }] }));
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[0].content, notice);
  assert.deepEqual(sent.tools[0].function.parameters, tools[0]!.function.parameters);
  assert.equal(sent.tools[0].function.name, "read");
});

test("adding the notice preserves numeric literals, signed blocks and all unrelated bytes", async () => {
  const original = '{ "model":"fixture", "budget":9007199254740993, "messages":[{"role":"user","content":[{"type":"text","text":"' + secret + '"},{"type":"thinking","thinking":"sealed","signature":"fixture-signature"}]}] }';
  const sent = await outgoing("anthropic", original);
  const tag = /\{\{API_KEY_[a-z2-7]{8}\}\}/u.exec(sent)![0];
  const added = ',' + JSON.stringify({ type: "text", text: notice });
  assert.ok(sent.includes(added));
  assert.equal(sent.replace(added, "").replace(tag, secret), original);
});

test("unmasked, disabled and unknown-placeholder requests get no notice", async () => {
  for (const [content, enabled] of [["ordinary text", true], [secret, false], ["{{PASSWORD_aaaaaaaa}}", true]] as const) {
    const body = JSON.stringify({ messages: [{ role: "user", content }] });
    assert.equal(await outgoing("chat", body, { enabled }), body);
  }
});

for (const providerType of ["claude-subscription", "openai-codex"]) test(`${providerType} keeps client instructions intact while masking still runs`, async () => {
  const sent = await outgoing(providerType === "openai-codex" ? "responses" : "anthropic", conversations[providerType === "openai-codex" ? "responses" : "anthropic"], { providerType });
  assert.ok(!sent.includes(secret));
  assert.ok(!sent.includes(notice));
});

test("stored Responses continuation avoids accumulating notices", async () => {
  const sent = await outgoing("responses", { previous_response_id: "resp-fixture", ...conversations.responses });
  assert.ok(!sent.includes(secret));
  assert.ok(!sent.includes(notice));
});

test("known placeholders in compacted text are explained and an existing notice is not duplicated", async () => {
  const bodies: string[] = [];
  const fetch = createPrivacyFetch(async (_url, init) => { bodies.push(String(init?.body)); return new Response("{}"); },
    { settings: { enabled: true }, provider: "fixture", model: "fixture", protocol: "chat" });
  const headers = { "x-session-id": randomUUID() };
  await fetch("https://fixture.invalid", { method: "POST", headers, body: JSON.stringify(conversations.chat) });
  const tag = /\{\{API_KEY_[a-z2-7]{8}\}\}/u.exec(bodies[0]!)![0];
  await fetch("https://fixture.invalid", { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: `Summary: use ${tag}` }] }) });
  assert.ok(bodies[1]!.includes(notice));
  await fetch("https://fixture.invalid", { method: "POST", headers, body: bodies[1] });
  assert.equal(bodies[2], bodies[1]);
});

test("request details include the notice actually sent with the masked request", async () => {
  resetMaskRecordsForTest();
  const sent = JSON.parse(await outgoing("responses", conversations.responses));
  const record = maskingDetail(maskingOverview().records[0]!.id)!;
  assert.equal(record.count, 1);
  assert.equal(record.preview.find(group => group.path === "input[1].content[0].text")?.masked, notice);
  assert.equal(record.preview.find(group => group.path === "input[0].content[0].text")?.masked, sent.input[0].content[0].text);
});

test("Responses string input keeps its text and redaction highlights after adding a developer message", async () => {
  resetMaskRecordsForTest();
  const sent = JSON.parse(await outgoing("responses", { input: secret }));
  assert.equal(sent.input[0].role, "developer");
  assert.match(sent.input[1].content, /^\{\{API_KEY_[a-z2-7]{8}\}\}$/u);
  const record = maskingDetail(maskingOverview().records[0]!.id)!;
  const field = record.preview.find(group => group.path === "input[1].content")!;
  assert.equal(field.original, secret);
  assert.equal(field.segments[0]?.original, secret);
});

test("an assistant tool call with null content gets one content field and keeps its call unchanged", async () => {
  const sent = await outgoing("chat", { messages: [{ role: "assistant", content: null,
    tool_calls: [{ id: "call-fixture", type: "function", function: { name: "connect", arguments: JSON.stringify({ password: secret }) } }] }] });
  assert.equal(sent.split('"content":').length - 1, 1);
  const message = JSON.parse(sent).messages[0];
  assert.equal(message.content, notice);
  assert.equal(message.tool_calls[0].id, "call-fixture");
  assert.match(JSON.parse(message.tool_calls[0].function.arguments).password, /^\{\{PASSWORD_[a-z2-7]{8}\}\}$/u);
});

for (const protocol of Object.keys(conversations) as Protocol[]) test(`${protocol} SDK sends the notice and restores the value in the provider response`, async () => {
  let sent = "";
  const providerType = protocol === "chat" ? "openai-compatible" : protocol === "responses" ? "openai" : protocol === "anthropic" ? "anthropic" : "google-native";
  const model = createVercelLanguageModel({ providerAlias: "fixture", providerType, authMode: "api-key",
    api: protocol === "chat" ? "chat_completions" : protocol === "responses" ? "responses" : protocol === "anthropic" ? "anthropic_messages" : "google_generative_ai",
    modelId: "fixture", supportsReasoning: false, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-auth", headers: {},
    privacy: { settings: { enabled: true } }, fetcher: async (_url, init) => {
      sent = String(init?.body);
      const tag = /\{\{API_KEY_[a-z2-7]{8}\}\}/u.exec(sent)![0];
      const body = protocol === "chat" ? { id: "chat-fixture", choices: [{ index: 0, message: { role: "assistant", content: tag }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        : protocol === "anthropic" ? { id: "msg-fixture", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: tag }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
          : protocol === "gemini" ? { candidates: [{ content: { role: "model", parts: [{ text: tag }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }
            : { id: "resp-fixture", object: "response", created_at: 1, model: "fixture", status: "completed", output: [{ type: "message", id: "msg-fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: tag, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    } });
  const response = await model.doGenerate({ prompt: [{ role: "system", content: "Original instructions." }, { role: "user", content: [{ type: "text", text: secret }] }] });
  assert.equal(sent.split(notice).length - 1, 1);
  assert.ok(!sent.includes(secret));
  assert.ok(response.content.some(part => part.type === "text" && part.text === secret));
});
