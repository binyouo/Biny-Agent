import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPrivacyFetch } from "../src/privacy/privacyFetch.js";
import { maskJson } from "../src/privacy/json.js";
import { RedactionStore } from "../src/privacy/store.js";
import { SseRestorer } from "../src/privacy/stream.js";

const settings = { enabled: true };
const secret = "sk-proj-fixture0123456789abcdefghijklmnop";
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const request = (session: string, messages: unknown[]) => ({ method: "POST", headers: { "x-session-id": session }, body: JSON.stringify({ messages }) });

test("a compacted session restores an earlier tool credential, but another session cannot", { timeout: 5000 }, async () => {
  const session = randomUUID();
  let tag = "";
  const fetch = createPrivacyFetch(async (_url, init) => {
    const text = JSON.parse(String(init?.body)).messages[0].content;
    if (!tag && text.startsWith("{{")) tag = text;
    return json({ choices: [{ message: { tool_calls: [{ function: { name: "browser_fill", arguments: JSON.stringify({ text: tag }) } }] } }] });
  }, { settings, provider: "fixture", model: "fixture" });
  const value = async (response: Response) => JSON.parse((await response.json()).choices[0].message.tool_calls[0].function.arguments).text;
  assert.equal(await value(await fetch("https://fixture.invalid", request(session, [{ content: secret }]))), secret);
  assert.equal(await value(await fetch("https://fixture.invalid", request(session, [{ content: "Compacted: continue the login." }]))), secret);
  assert.equal(await value(await fetch("https://fixture.invalid", request(randomUUID(), [{ content: "sk-proj-other0123456789abcdefghijklmnop" }]))), tag);
});

test("an earlier response cannot acquire mappings discovered by a later overlapping request", { timeout: 5000 }, async () => {
  const session = randomUUID();
  let release!: (response: Response) => void;
  let laterTag = "";
  const fetch = createPrivacyFetch(async (_url, init) => {
    const text = JSON.parse(String(init?.body)).messages[0].content;
    if (text === "first") return await new Promise<Response>(resolve => { release = resolve; });
    laterTag = text;
    return json({ content: text });
  }, { settings, provider: "fixture", model: "fixture" });
  const first = fetch("https://fixture.invalid", request(session, [{ content: "first" }]));
  const later = await fetch("https://fixture.invalid", request(session, [{ content: secret }]));
  assert.equal((await later.json()).content, secret);
  release(json({ content: laterTag }));
  assert.equal((await (await first).json()).content, laterTag);
});

test("newly identified values do not rewrite sent history, but new summary text masks them", () => {
  const store = new RedactionStore(randomUUID());
  const original = "Historical note: fixtureletterssecret";
  const first = maskJson(JSON.stringify({ messages: [{ content: original }] }), settings, store);
  const second = maskJson(JSON.stringify({ messages: [{ content: original }, { content: [{ type: "tool_use", input: { password: "fixtureletterssecret" } }] }] }), settings, store);
  assert.equal(JSON.parse(first.text).messages[0].content, original);
  assert.equal(JSON.parse(second.text).messages[0].content, original);
  assert.ok(!JSON.parse(second.text).messages[1].content[0].input.password.includes("fixtureletterssecret"));
  const summary = maskJson(JSON.stringify({ messages: [{ content: "Summary: fixtureletterssecret" }] }), settings, store);
  assert.ok(!summary.text.includes("fixtureletterssecret"));
  assert.equal(JSON.parse(maskJson(JSON.stringify({ messages: [{ content: original }] }), settings, store).text).messages[0].content, original);
});

test("cached ordinary text cannot bypass a newly explicit password field", () => {
  const store = new RedactionStore(randomUUID());
  maskJson(JSON.stringify({ content: "fixtureletterssecret" }), settings, store);
  const result = maskJson(JSON.stringify({ messages: [{ content: [{ type: "tool_use", input: { password: "fixtureletterssecret" } }] }] }), settings, store);
  assert.ok(!result.text.includes("fixtureletterssecret"));
});

for (const protocol of ["chat", "anthropic", "responses"] as const) test(`${protocol} restores rewritten placeholders at every tool-delta split`, { timeout: 5000 }, async () => {
  const session = randomUUID();
  let tag = "", pieces: string[] = [];
  const frame = (text: string): unknown => protocol === "chat"
    ? { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: text } }] } }] }
    : protocol === "anthropic" ? { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: text } }
      : { type: "response.function_call_arguments.delta", item_id: "tool-1", delta: text };
  const fetch = createPrivacyFetch(async (_url, init) => {
    const content = JSON.parse(String(init?.body)).messages[0].content;
    if (content.startsWith("{{")) tag = content;
    if (!pieces.length) return json({ content: tag });
    return new Response(pieces.map(s => `data: ${JSON.stringify(frame(s))}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }, { settings, provider: "fixture", model: "fixture" });
  await (await fetch("https://fixture.invalid", request(session, [{ content: secret }]))).text();
  const body = tag.slice(2, -2);
  for (const variant of [tag, `{{ ${body.toLowerCase()} }}`, `{${body.toUpperCase()}}`, body.toLowerCase(), `{{${body}`, `${body}}}`]) {
    for (let split = 1; split < variant.length; split++) {
      pieces = ['{"password":"' + variant.slice(0, split), variant.slice(split) + '"}'];
      const response = await fetch("https://fixture.invalid", request(session, [{ content: "Compacted: continue." }]));
      const events = (await response.text()).split("\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
      const args = events.map(e => protocol === "chat" ? e.choices[0].delta.tool_calls[0].function.arguments : protocol === "anthropic" ? e.delta.partial_json : e.delta).join("");
      assert.equal(JSON.parse(args).password, secret, `${variant}, split ${split}`);
    }
  }
});

test("complete bare text placeholders restore at stream termination; unknown and longer identifiers stay literal", { timeout: 5000 }, async () => {
  let tag = "";
  const session = randomUUID();
  const fetch = createPrivacyFetch(async (_url, init) => {
    const text = JSON.parse(String(init?.body)).messages[0].content;
    if (text.startsWith("{{")) { tag = text; return json({ content: tag }); }
    const body = tag.slice(2, -2);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: `unknown {{PASSWORD_aaaaaaaa}} longer ${body}x actual ${body.toLowerCase()}` } }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }, { settings, provider: "fixture", model: "fixture" });
  await (await fetch("https://fixture.invalid", request(session, [{ content: secret }]))).text();
  const response = await fetch("https://fixture.invalid", request(session, [{ content: "continue" }]));
  const content = JSON.parse((await response.text()).split("\n")[0]!.slice(6)).choices[0].delta.content;
  assert.equal(content, `unknown {{PASSWORD_aaaaaaaa}} longer ${tag.slice(2, -2)}x actual ${secret}`);
});

test("session capacity eviction does not reject new sessions or break an in-flight response", { timeout: 5000 }, async () => {
  let tag = "";
  const fetch = createPrivacyFetch(async (_url, init) => {
    const content = JSON.parse(String(init?.body)).messages[0].content;
    if (content.startsWith("{{")) tag = content;
    return json({ content: tag });
  }, { settings, provider: "fixture", model: "fixture" });
  const pending = await fetch("https://fixture.invalid", request(randomUUID(), [{ content: secret }]));
  for (let i = 0; i < 140; i++) await (await fetch("https://fixture.invalid", request(randomUUID(), [{ content: "hello" }]))).text();
  assert.equal((await pending.json()).content, secret);
});

test("bounded values evict idle mappings while sent text can rebuild the same placeholder", () => {
  const store = new RedactionStore(randomUUID(), { values: 2, characters: 1000, sentEntries: 2, sentSpans: 4 });
  const source = JSON.stringify({ content: "password=fixturefirst123" });
  const first = maskJson(source, settings, store).text;
  const tag = JSON.parse(first).content.slice("password=".length);
  const snapshot = store.snapshot();
  store.register("SECRET", "fixturesecond456");
  store.register("SECRET", "fixturethird789");
  assert.equal(store.count, 2);
  assert.equal(store.restore(tag), tag);
  assert.equal(snapshot.get(tag), "fixturefirst123");
  assert.equal(maskJson(source, settings, store).text, first);
  assert.equal(store.restore(tag), "fixturefirst123");
});

test("one request cannot evict values it still needs to mask", () => {
  const store = new RedactionStore(randomUUID(), { values: 2, characters: 1000, sentEntries: 2, sentSpans: 4 });
  const source = JSON.stringify({ messages: [{ content: "fixturefirstsecret" }, { content: [{ type: "tool_use", input: {
    password: "fixturefirstsecret", secret: "fixturesecondsecret", token: "fixturethirdsecret"
  } }] }] });
  assert.throws(() => maskJson(source, settings, store), /Privacy.*limit/u);
});

test("a chunk boundary cannot turn part of a longer identifier into a credential", () => {
  const store = new RedactionStore(randomUUID());
  const tag = store.register("PASSWORD", "syntheticcredential").slice(2, -2);
  for (const prefix of ["0", "user", "hello "]) {
    const stream = new SseRestorer(text => store.restore(text), ["PASSWORD"]);
    let output = "";
    for (const content of [prefix, tag]) output += stream.push(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    output += stream.push("", true);
    const text = output.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)).choices[0].delta.content).join("");
    assert.equal(text, prefix === "hello " ? "hello syntheticcredential" : prefix + tag);
  }
});
