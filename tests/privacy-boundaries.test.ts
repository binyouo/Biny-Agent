import assert from "node:assert/strict";
import test from "node:test";
import { maskJson, maskText, resetStoreForTest } from "../src/privacy/index.js";
import { createPrivacyFetch } from "../src/privacy/privacyFetch.js";

const settings = { enabled: true };
const key = "sk-proj-0123456789abcdefghijklmnop";

test("message text is masked at indexed paths while signed blocks stay intact", () => {
  resetStoreForTest();
  const sealed = { type: "thinking", thinking: key, signature: "signature" };
  const result = maskJson(JSON.stringify({ messages: [{ content: [{ type: "text", text: key }, sealed] }] }), settings);
  const body = JSON.parse(result.text);
  assert.ok(!body.messages[0].content[0].text.includes(key));
  assert.deepEqual(body.messages[0].content[1], sealed);
  assert.equal(result.segments[0]?.path, "messages.0.content.0.text");
});

test("tool input keys are user data even when they look like protocol keys", () => {
  const result = maskJson(JSON.stringify({ messages: [{ content: [{ type: "tool_use", id: "call1", name: "send", input: { name: key, user_id: key, text: key } }] }] }), settings);
  assert.ok(!result.text.includes(key));
});

test("known values sharing a prefix remain recognized", () => {
  resetStoreForTest();
  maskText("password=abcdefgh1234 password=abcdefgh5678", settings);
  assert.equal(maskText("abcdefgh1234 abcdefgh5678", settings).hits.length, 2);
});

test("SSE restores across events and safely escapes JSON strings", { timeout: 5000 }, async () => {
  const secret = "-----BEGIN PRIVATE KEY-----\nabc\"def\\ghi\n-----END PRIVATE KEY-----";
  const fetch = createPrivacyFetch(async (_url, init) => {
    const placeholder = JSON.parse(String(init?.body)).messages[0].content;
    const parts = [placeholder.slice(0, 7), placeholder.slice(7)];
    const events = parts.map((content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(events, { headers: { "content-type": "text/event-stream" } });
  }, { settings, provider: "test", model: "test" });
  const response = await fetch("https://test.invalid/chat", { method: "POST", body: JSON.stringify({ messages: [{ content: secret }] }) });
  const chunks = (await response.text()).split("\n\n").filter((s) => s.startsWith("data: {")).map((s) => JSON.parse(s.slice(6)));
  assert.equal(chunks.map((x) => x.choices[0].delta.content).join(""), secret);
});

test("Request objects are masked, malformed JSON and unsupported bodies never leave", { timeout: 5000 }, async () => {
  let sent = "";
  let calls = 0;
  const fetch = createPrivacyFetch(async (url, init) => {
    calls++;
    sent = typeof init?.body === "string" ? init.body : await (url as Request).text();
    return new Response("{}");
  }, { settings, provider: "test", model: "test" });
  await fetch(new Request("https://test.invalid/chat", { method: "POST", body: JSON.stringify({ messages: [{ content: key }] }) }));
  assert.ok(!sent.includes(key));
  await assert.rejects(fetch("https://test.invalid/chat", { method: "POST", body: '{"messages":' }));
  await assert.rejects(fetch("https://test.invalid/chat", { method: "POST", body: new FormData() }));
  assert.equal(calls, 1);
});

test("a response cannot restore a value belonging to another session", { timeout: 5000 }, async () => {
  let stolen = "";
  const fetch = createPrivacyFetch(async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    if (sent.messages[0].content.includes("{{")) stolen = sent.messages[0].content;
    return new Response(JSON.stringify({ content: stolen }), { headers: { "content-type": "application/json" } });
  }, { settings, provider: "test", model: "test" });
  const first = await fetch("https://test.invalid/chat", { method: "POST", headers: { "x-session-id": "one" }, body: JSON.stringify({ messages: [{ content: key }] }) });
  assert.equal((await first.json()).content, key);
  const second = await fetch("https://test.invalid/chat", { method: "POST", headers: { "x-session-id": "two" }, body: JSON.stringify({ messages: [{ content: "hello" }] }) });
  assert.equal((await second.json()).content, stolen);
});

test("JSON rewriting preserves surrounding bytes and nested tool argument escaping", () => {
  const source = '{  "messages" : [ { "content" : "' + key + '" } ], "budget":9007199254740993 }';
  const result = maskJson(source, settings);
  assert.equal(result.text.replace(result.segments[0]!.segments[0]!.masked, key), source);
});

test("SSE tool arguments stay valid JSON with quotes, backslashes and interleaved calls", { timeout: 5000 }, async () => {
  const secrets = ["-----BEGIN PRIVATE KEY-----\na\"b\\c\n-----END PRIVATE KEY-----", key];
  const fetch = createPrivacyFetch(async (_url, init) => {
    const tags = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content);
    const frames = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"secret":"' + tags[0].slice(0, 9) } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"secret":"' + tags[1].slice(0, 8) } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: tags[0].slice(9) + '"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: tags[1].slice(8) + '"}' } }] } }] }
    ];
    const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    // 每个字节独立到达，覆盖 UTF-8/framing 与模型事件两个分块层。
    const bytes = new TextEncoder().encode(text);
    let i = 0;
    return new Response(new ReadableStream({ pull(c) { if (i === bytes.length) c.close(); else c.enqueue(bytes.slice(i, ++i)); } }), { headers: { "content-type": "text/event-stream" } });
  }, { settings, provider: "test", model: "test" });
  const response = await fetch("https://test.invalid", { method: "POST", body: JSON.stringify({ messages: secrets.map((content) => ({ content })) }) });
  const collected = ["", ""];
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const call = JSON.parse(line.slice(6)).choices[0].delta.tool_calls[0];
    collected[call.index] += call.function.arguments;
  }
  assert.deepEqual(collected.map((s) => JSON.parse(s).secret), secrets);
});

test("Anthropic signed thinking is preserved while text deltas and tool JSON restore", { timeout: 5000 }, async () => {
  const fetch = createPrivacyFetch(async (_url, init) => {
    const tag = JSON.parse(String(init?.body)).messages[0].content;
    return new Response([
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: tag } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: tag.slice(0, 5) } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: tag.slice(5) } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" }
    ].map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }, { settings, provider: "test", model: "test" });
  const response = await fetch("https://test.invalid", { method: "POST", body: JSON.stringify({ messages: [{ content: key }] }) });
  const frames = (await response.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(6)));
  assert.match(frames[0].delta.thinking, /^\{\{API_KEY_/u);
  assert.equal(frames.filter((f) => f.index === 1 && f.delta).map((f) => f.delta.text).join(""), key);
});

test("explicit sensitive fields and Chinese labels mask values without masking traceback prose", () => {
  resetStoreForTest();
  const result = maskJson(JSON.stringify({ messages: [{ content: [{ type: "tool_use", input: { password: 'a"b\\中文', api_key: "onlyletterssecret" } }] }] }), settings);
  const input = JSON.parse(result.text).messages[0].content[0].input;
  assert.match(input.password, /^\{\{/u);
  assert.match(input.api_key, /^\{\{/u);
  assert.equal(maskText("密码：你好世界2026", settings).hits.length, 1);
  assert.equal(maskText("Traceback (most recent call last):", settings).hits.length, 0);
  assert.equal(maskText("birthday: 1990-02-31", settings).hits.length, 0);
});

for (const protocol of ["responses", "gemini"] as const) test(`${protocol} text deltas restore independently`, { timeout: 5000 }, async () => {
  const fetch = createPrivacyFetch(async (_url, init) => {
    const tag = JSON.parse(String(init?.body)).messages[0].content;
    const frames = [tag.slice(0, 8), tag.slice(8)].map((text) => protocol === "responses"
      ? { type: "response.output_text.delta", item_id: "message-1", output_index: 0, content_index: 0, delta: text }
      : { candidates: [{ index: 0, content: { parts: [{ text }] } }] });
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }, { settings, provider: "test", model: "test" });
  const response = await fetch("https://test.invalid", { method: "POST", body: JSON.stringify({ messages: [{ content: key }] }) });
  const frames = (await response.text()).split("\n").filter((s) => s.startsWith("data:")).map((s) => JSON.parse(s.slice(6)));
  assert.equal(frames.map((f) => protocol === "responses" ? f.delta : f.candidates[0].content.parts[0].text).join(""), key);
});

test("response cancellation reaches the source and early abort never sends", { timeout: 5000 }, async () => {
  let cancelled = false, calls = 0;
  const fetch = createPrivacyFetch(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  }, { settings, provider: "test", model: "test" });
  const response = await fetch("https://test.invalid", { method: "POST", body: JSON.stringify({ content: key }) });
  await response.body!.cancel();
  assert.equal(cancelled, true);
  await assert.rejects(fetch("https://test.invalid", { method: "POST", signal: AbortSignal.abort(), body: JSON.stringify({ content: key }) }));
  assert.equal(calls, 1);
});
