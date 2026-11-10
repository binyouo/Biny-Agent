import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { maskText } from "../src/privacy/engine.js";
import { RedactionStore } from "../src/privacy/store.js";
import { createPrivacyFetch } from "../src/privacy/privacyFetch.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { maskJson } from "../src/privacy/json.js";

const settings = { enabled: true };
const cases = [
  ["password=letmein", "letmein"], ["password=12345678", "12345678"], ["passwd=abc", "abc"],
  ["DB_PASSWORD=letters", "letters"], ["database.password: 321", "321"], ["PASSWORD：纯字母密码", "纯字母密码"],
  ['{"password":"letmein"}', "letmein"], ["password='123'", "123"], ['password="hello world"', "hello world"],
  ['password="中文 密码!"', "中文 密码!"], ["password=letmein, continue", "letmein"],
  ['password="string"', "string"], ["password=string", "string"], ["password=`letmein`", "letmein"],
  ["password=short1", "short1"], ["password=abc!@#", "abc!@#"], ["password=ab", "ab"],
  ["password=12", "12"], ['password="7"', "7"], ["password: letmein", "letmein"], ["password=password", "password"]
] as const;

for (const [source, value] of cases) test(`ordinary text masks the complete explicit password: ${source}`, () => {
  const store = new RedactionStore(randomUUID());
  const result = maskText(source, settings, store);
  const segment = result.segments.find(segment => segment.original === value)!;
  assert.ok(segment);
  assert.match(segment.masked, /^\{\{PASSWORD_[a-z2-7]{8}\}\}$/u);
  const start = source.lastIndexOf(value);
  assert.equal(result.text, source.slice(0, start) + segment.masked + source.slice(start + value.length));
  assert.equal(store.restore(result.text), source);
});

test("variable references, type declarations, placeholders and password metadata remain unchanged", () => {
  const sources = [
    "password=$PASSWORD", 'password="${PASSWORD}"', "password=%PASSWORD%", "password=<password>",
    "password=process.env.PASSWORD", "password=process.env.PASSWORD_V2", "password=env.PASSWORD", "password=os.environ['PASSWORD']",
    "password=readPassword()", "password: string", "password: str", "password=null", "password=undefined",
    "password=***", "password=xxxx", "password={{PASSWORD_abcdefgh}}", "password_length=12345678",
    "password_hash=letmein", "notpassword=letmein", "newPasswordPolicy: strong", "just letmein and 12345678",
    "password=", 'password=""'
  ];
  for (const source of sources) assert.equal(maskText(source, settings, new RedactionStore(randomUUID())).text, source, source);
});

test("structured explicit password fields also protect short literals", () => {
  for (const password of ["a", "ab", "7", "12"]) {
    const store = new RedactionStore(randomUUID());
    const result = maskJson(JSON.stringify({ messages: [{ content: [{ type: "tool_use", input: { password } }] }] }), settings, store);
    const value = JSON.parse(result.text).messages[0].content[0].input.password;
    assert.match(value, /^\{\{PASSWORD_[a-z2-7]{8}\}\}$/u);
    assert.equal(store.restore(value), password);
  }
});

test("quotes and escaped characters are restored without swallowing neighbouring fields", () => {
  const source = String.raw`password="hello\"world"; user=alice`;
  const value = String.raw`hello\"world`;
  const store = new RedactionStore(randomUUID());
  const result = maskText(source, settings, store);
  assert.ok(result.segments.some(segment => segment.original === value));
  assert.ok(result.text.endsWith('; user=alice'));
  assert.equal(store.restore(result.text), source);
});

for (const protocol of ["chat", "anthropic", "responses", "gemini"] as const) test(`${protocol} outbound messages mask weak passwords and streamed tool parameters restore`, async () => {
  const value = "letmein";
  let sent = "";
  const fetch = createPrivacyFetch(async (_url, init) => {
    sent = String(init?.body);
    const tag = /\{\{PASSWORD_[a-z2-7]{8}\}\}/u.exec(sent)![0];
    const args = JSON.stringify({ password: tag });
    const frame = protocol === "chat" ? { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] }
      : protocol === "anthropic" ? { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }
        : protocol === "responses" ? { type: "response.function_call_arguments.delta", item_id: "call-1", delta: args }
          : { candidates: [{ index: 0, content: { parts: [{ functionCall: { name: "login", args: { password: tag } } }] } }] };
    return new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }, { settings, provider: "fixture", model: "fixture", protocol });
  const source = "password=" + value;
  const body = protocol === "responses" ? { input: [{ role: "user", content: [{ type: "input_text", text: source }] }] }
    : protocol === "gemini" ? { contents: [{ role: "user", parts: [{ text: source }] }] }
      : { messages: [{ role: "user", content: [{ type: "text", text: source }] }] };
  const response = await fetch("https://fixture.invalid", { method: "POST", headers: { "x-session-id": randomUUID() }, body: JSON.stringify(body) });
  assert.ok(!sent.includes(value));
  const event = JSON.parse((await response.text()).split("\n")[0]!.slice(6));
  const restored = protocol === "chat" ? JSON.parse(event.choices[0].delta.tool_calls[0].function.arguments).password
    : protocol === "anthropic" ? JSON.parse(event.delta.partial_json).password
      : protocol === "responses" ? JSON.parse(event.delta).password : event.candidates[0].content.parts[0].functionCall.args.password;
  assert.equal(restored, value);
});

test("the real SDK request masks a numeric password and returns its original value", async () => {
  const value = "12345678";
  let sent = "";
  const model = createVercelLanguageModel({ providerAlias: "fixture", providerType: "openai-compatible", api: "chat_completions",
    authMode: "api-key", modelId: "fixture", supportsReasoning: false, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-auth", headers: {}, privacy: { settings },
    fetcher: async (_url, init) => {
      sent = String(init?.body);
      const tag = /\{\{PASSWORD_[a-z2-7]{8}\}\}/u.exec(sent)![0];
      return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: tag }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    } });
  const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "password=" + value }] }], headers: { "x-session-id": randomUUID() } });
  assert.ok(!sent.includes(value));
  assert.ok(result.content.some(part => part.type === "text" && part.text === value));
});
