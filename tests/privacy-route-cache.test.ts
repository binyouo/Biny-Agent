import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPrivacyFetch } from "../src/privacy/privacyFetch.js";
import { maskJson } from "../src/privacy/json.js";
import { RedactionStore } from "../src/privacy/store.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";

const secret = "fixtureletterscredential";
const history = { role: "user", content: `Historical reference: ${secret}` };
const disclosed = { role: "user", content: `密码：${secret}` };
const settings = { enabled: true };

function client(sessionId: string, provider: string, baseUrl?: string, protocol: "chat" | "responses" = "chat") {
  const bodies: string[] = [];
  let reply = "ready";
  const fetch = createPrivacyFetch(async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ content: reply }), { headers: { "content-type": "application/json" } });
  }, { settings, provider, model: "fixture", protocol, baseUrl });
  return { bodies, reply: (text: string) => { reply = text; }, send: async (messages: unknown[], url = "https://fixture.invalid/v1/chat/completions") => {
    const response = await fetch(url, { method: "POST", headers: { "x-session-id": sessionId }, body: JSON.stringify(protocol === "responses" ? { input: messages } : { messages }) });
    return await response.json();
  } };
}

for (const target of ["provider", "endpoint", "protocol"] as const) test(`${target} changes reprocess history while the original target retains its prefix`, async () => {
  const sessionId = randomUUID();
  const a = client(sessionId, "provider-a", "https://one.invalid/v1");
  const b = client(sessionId, target === "provider" ? "provider-b" : "provider-a",
    target === "endpoint" ? "https://two.invalid/v1" : "https://one.invalid/v1", target === "protocol" ? "responses" : "chat");
  await a.send([history]);
  await a.send([history, disclosed]);
  assert.equal(JSON.parse(a.bodies[1]!).messages[0].content, history.content);
  await b.send([history]);
  assert.ok(!b.bodies[0]!.includes(secret));
  await a.send([history]);
  assert.equal(a.bodies[2], a.bodies[0]);
  await b.send([history]);
  assert.equal(b.bodies[1], b.bodies[0]);
});

test("a direct fetch without a configured base URL isolates its actual request URL", async () => {
  const a = client(randomUUID(), "fixture");
  await a.send([history], "https://one.invalid/v1/chat/completions");
  await a.send([history, disclosed], "https://one.invalid/v1/chat/completions");
  await a.send([history], "https://two.invalid/v1/chat/completions");
  assert.ok(!a.bodies[2]!.includes(secret));
});

test("streaming and non-streaming requests to the same configured endpoint reuse the same decision", async () => {
  const a = client(randomUUID(), "fixture", "https://fixture.invalid/v1");
  await a.send([history], "https://fixture.invalid/v1/models/fixture:generateContent");
  await a.send([history, disclosed], "https://fixture.invalid/v1/models/fixture:streamGenerateContent?alt=sse");
  assert.equal(JSON.parse(a.bodies[1]!).messages[0].content, history.content);
});

test("switching targets keeps session placeholders restorable and does not share values with another session", async () => {
  const sessionId = randomUUID();
  const a = client(sessionId, "provider-a");
  await a.send([disclosed]);
  const tag = /\{\{SECRET_[a-z2-7]{8}\}\}/u.exec(a.bodies[0]!)![0];
  const b = client(sessionId, "provider-b");
  b.reply(tag);
  assert.equal((await b.send([{ role: "user", content: "Compacted: continue." }])).content, secret);
  const other = client(randomUUID(), "provider-b");
  other.reply(tag);
  assert.equal((await other.send([{ role: "user", content: "Continue." }])).content, tag);
});

test("a late response uses its original snapshot even when another target discovers a credential", { timeout: 5000 }, async () => {
  const sessionId = randomUUID();
  let release!: (response: Response) => void;
  const a = createPrivacyFetch(async () => await new Promise<Response>(resolve => { release = resolve; }),
    { settings, provider: "provider-a", model: "fixture", protocol: "chat" });
  const pending = a("https://one.invalid", { method: "POST", headers: { "x-session-id": sessionId }, body: JSON.stringify({ messages: [{ role: "user", content: "Before." }] }) });
  const b = client(sessionId, "provider-b");
  await b.send([disclosed]);
  const tag = /\{\{SECRET_[a-z2-7]{8}\}\}/u.exec(b.bodies[0]!)![0];
  release(new Response(JSON.stringify({ content: tag }), { headers: { "content-type": "application/json" } }));
  assert.equal((await (await pending).json()).content, tag);
});

test("route entries share the existing bounded cache and eviction safely reprocesses a forgotten prefix", () => {
  const store = new RedactionStore(randomUUID(), { values: 10, characters: 1000, sentEntries: 2, sentSpans: 10 });
  const body = JSON.stringify({ messages: [history] });
  assert.equal(maskJson(body, settings, store, "a").text, body);
  store.register("SECRET", secret);
  const b = maskJson(body, settings, store, "b").text;
  assert.ok(!b.includes(secret));
  assert.equal(maskJson(body, settings, store, "a").text, body);
  assert.equal(maskJson(body, settings, store, "c").text, b);
  assert.equal(maskJson(body, settings, store, "b").text, b);
  assert.equal(maskJson(body, settings, store, "a").text, b);
});

test("the SDK supplies one stable endpoint identity across models and isolates an endpoint change", async () => {
  const sessionId = randomUUID();
  const bodies: string[] = [];
  const model = (baseUrl: string, modelId: string) => createVercelLanguageModel({ providerAlias: "fixture", providerType: "openai-compatible",
    api: "chat_completions", authMode: "api-key", modelId, supportsReasoning: false, baseUrl, apiKey: "fixture-auth", headers: {},
    privacy: { settings }, fetcher: async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ id: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    } });
  const a = model("https://one.invalid/v1", "model-a");
  const a2 = model("https://one.invalid/v1", "model-b");
  const b = model("https://two.invalid/v1", "model-a");
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: history.content }] }];
  await a.doGenerate({ prompt, headers: { "x-session-id": sessionId } });
  await a.doGenerate({ prompt: [...prompt, { role: "user", content: [{ type: "text", text: disclosed.content }] }], headers: { "x-session-id": sessionId } });
  await a2.doGenerate({ prompt, headers: { "x-session-id": sessionId } });
  assert.equal(JSON.parse(bodies[2]!).messages[0].content, history.content);
  await b.doGenerate({ prompt, headers: { "x-session-id": sessionId } });
  assert.ok(!bodies[3]!.includes(secret));
});

test("the native Gemini SDK shares history decisions across generate and stream endpoints", async () => {
  const bodies: string[] = [];
  const urls: string[] = [];
  const model = createVercelLanguageModel({ providerAlias: "fixture", providerType: "google-native", api: "google_generative_ai",
    authMode: "api-key", modelId: "fixture", supportsReasoning: false, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-auth", headers: {},
    privacy: { settings }, fetcher: async (url, init) => {
      urls.push(String(url));
      bodies.push(String(init?.body));
      const body = { candidates: [{ content: { role: "model", parts: [{ text: "ready" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      return String(url).includes(":streamGenerateContent")
        ? new Response(`data: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    } });
  const headers = { "x-session-id": randomUUID() };
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: history.content }] }];
  await model.doGenerate({ prompt, headers });
  const response = await model.doStream({ prompt: [...prompt, { role: "user", content: [{ type: "text", text: disclosed.content }] }], headers });
  for await (const part of response.stream) assert.notEqual(part.type, "error");
  assert.notEqual(urls[0], urls[1]);
  assert.equal(JSON.parse(bodies[1]!).contents[0].parts[0].text, history.content);
});
