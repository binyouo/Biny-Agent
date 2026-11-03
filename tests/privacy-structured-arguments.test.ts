import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { maskJson, restoreJson } from "../src/privacy/json.js";
import { RedactionStore } from "../src/privacy/store.js";

const fixture = await mkdtemp(path.join(os.tmpdir(), "biny-privacy-structured-arguments-"));
const previousRoot = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = fixture;
after(async () => {
  if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousRoot;
  await rm(fixture, { recursive: true, force: true });
});

type Provider = "anthropic" | "google";
async function request(provider: Provider, enabled: boolean, input: Record<string, unknown>, result: Record<string, string> = { text: "done" }) {
  let calls = 0;
  let sent: unknown;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    sent = JSON.parse(String(init?.body));
    const body = provider === "anthropic"
      ? { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
      : { candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const model = createVercelLanguageModel({
    providerType: provider === "anthropic" ? "anthropic" : "google-native", providerAlias: "fixture",
    api: provider === "anthropic" ? "anthropic_messages" : "google_generative_ai",
    modelId: provider === "anthropic" ? "claude-sonnet-4-5" : "gemini-2.5-flash", supportsReasoning: false,
    baseUrl: "https://fixture.example.test", authMode: "api-key", apiKey: "fixture-not-a-credential", headers: {}, fetcher,
    privacy: { settings: { enabled } }
  });
  const response = await model.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "Continue the example." }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_fixture", toolName: "example", input }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_fixture", toolName: "example", output: { type: "json", value: result } }] }
    ],
    tools: [{ type: "function", name: "example", description: "Synthetic example.", inputSchema: { type: "object", properties: Object.fromEntries(Object.keys(input).map(key => [key, key === "nested" ? { type: "object" } : { type: "string" }])), required: Object.keys(input) } }]
  });
  assert.equal(calls, 1);
  assert.equal(response.content.length, 1);
  assert.ok(response.content[0]?.type === "text");
  assert.equal(response.content[0].text, "done");
  const body = sent as {
    messages?: Array<{ content: Array<{ type: string; input?: unknown }> }>;
    contents?: Array<{ parts: Array<{ functionCall?: { args: unknown }; functionResponse?: { response: { content: unknown } } }> }>;
  };
  if (provider === "anthropic") {
    assert.deepEqual(body.messages?.flatMap(message => message.content).find(part => part.type === "tool_use")?.input, input);
  } else {
    const parts = body.contents?.flatMap(content => content.parts);
    assert.deepEqual(parts?.find(part => part.functionCall)?.functionCall?.args, input);
    assert.deepEqual(parts?.find(part => part.functionResponse)?.functionResponse?.response.content, result);
  }
  return JSON.stringify(sent);
}

for (const provider of ["anthropic", "google"] as const) {
  test(`${provider}: privacy-off structured arguments remain supported`, async () => {
    assert.ok((await request(provider, false, { arguments: "--help" })).includes("--help"));
  });
  test(`${provider}: unrelated ordinary field remains supported`, async () => {
    assert.ok((await request(provider, true, { flags: "--help" })).includes("--help"));
  });
  test(`${provider}: structured arguments is a domain string, not encoded JSON`, async () => {
    assert.ok((await request(provider, true, { arguments: "--help" })).includes("--help"));
  });
  test(`${provider}: nested structured arguments remains ordinary data`, async () => {
    assert.ok((await request(provider, true, { nested: { arguments: "plain value" } })).includes("plain value"));
  });
}
test("Google: JSON tool result may contain ordinary arguments", async () => {
  assert.ok((await request("google", true, { flags: "--help" }, { arguments: "plain result" })).includes("plain result"));
});

const secret = "sk-proj-0123456789abcdefghijklmnop"; // Explicit synthetic fixture, never a real credential.
const domains = [
  { name: "Anthropic tool input", build: (value: string) => ({ messages: [{ content: [{ type: "tool_use", input: { arguments: value } }] }] }) },
  { name: "Google tool input", build: (value: string) => ({ contents: [{ parts: [{ functionCall: { args: { arguments: value } } }] }] }) },
  { name: "Google tool result", build: (value: string) => ({ contents: [{ parts: [{ functionResponse: { response: { content: { arguments: value } } } }] }] }) }
];
for (const domain of domains) test(`${domain.name}: ordinary argument content is still masked and restored`, () => {
  const store = new RedactionStore(`synthetic-${domain.name}`);
  const body = JSON.stringify(domain.build(`plain ${secret} value`));
  const masked = maskJson(body, { enabled: true }, store);
  assert.ok(masked.hits.length > 0);
  assert.ok(!masked.text.includes(secret));
  assert.equal(restoreJson(masked.text, value => store.restore(value)), body);
});

test("OpenAI encoded arguments retain masking, escaping and malformed-input refusal", () => {
  const store = new RedactionStore("synthetic-openai");
  const build = (value: string) => ({ messages: [{ tool_calls: [{ type: "function", function: { name: "example", arguments: value } }] }] });
  const body = JSON.stringify(build(JSON.stringify({ arguments: `quoted "${secret}" \\ tail` })));
  const masked = maskJson(body, { enabled: true }, store);
  assert.ok(!masked.text.includes(secret));
  assert.equal(restoreJson(masked.text, value => store.restore(value)), body);
  assert.throws(() => maskJson(JSON.stringify(build("not JSON")), { enabled: true }, store), /Privacy cannot mask malformed tool arguments/u);
});
test("Responses and generic encoded arguments retain malformed-input refusal", () => {
  assert.throws(() => maskJson(JSON.stringify({ input: [{ type: "function_call", name: "example", arguments: "not JSON" }] }), { enabled: true }, new RedactionStore("synthetic-responses")), /Privacy cannot mask malformed tool arguments/u);
  assert.throws(() => maskJson(JSON.stringify({ arguments: "not JSON" }), { enabled: true }, new RedactionStore("synthetic-generic")), /Privacy cannot mask malformed tool arguments/u);
});
test("a JSON-looking string within tool data retains its original representation", () => {
  const store = new RedactionStore("synthetic-json-looking");
  const body = JSON.stringify(domains[0]!.build(` { "text": "${secret}" } `));
  const masked = maskJson(body, { enabled: true }, store);
  assert.ok(!masked.text.includes(secret));
  assert.equal(restoreJson(masked.text, value => store.restore(value)), body);
});
test("valid JSON domain strings retain sensitive-key masking even for weak values", () => {
  for (const domain of domains) {
    const store = new RedactionStore(`synthetic-json-sensitive-key-${domain.name}`);
    const weak = "ordinary-fixture-value";
    const body = JSON.stringify(domain.build(JSON.stringify({ password: weak })));
    const masked = maskJson(body, { enabled: true }, store);
    assert.ok(masked.hits.some(hit => hit.kind === "PASSWORD"));
    assert.ok(!masked.text.includes(weak));
    assert.equal(restoreJson(masked.text, value => store.restore(value)), body);
  }
});
