import assert from "node:assert/strict";
import test from "node:test";
import { createPrivacyFetch } from "../src/privacy/privacyFetch.js";
import { recordMask, maskingOverview, maskingDetail, resetMaskRecordsForTest } from "../src/privacy/record.js";
import { maskText, defaultRedactionSettings, resetStoreForTest, placeholderTag, type RedactionSettings } from "../src/privacy/index.js";

function on(): RedactionSettings {
  return { ...defaultRedactionSettings, enabled: true };
}

const REAL_KEY = "sk-ant-api03-" + "Q7bK2mZ9pL4nR8sT1vW5xY0aC3dE6fG9hJ2k";

test("privacy fetch masks the outbound body and restores the inbound JSON", async () => {
  resetStoreForTest();
  resetMaskRecordsForTest();
  let seenBody = "";
  const baseFetch: typeof globalThis.fetch = async (_input, init) => {
    seenBody = String(init?.body ?? "");
    const incoming = { choices: [{ message: { content: `ack ${JSON.parse(seenBody).messages[0].content}` } }] };
    return new Response(JSON.stringify(incoming), { status: 200, headers: { "content-type": "application/json" } });
  };
  const fetch = createPrivacyFetch(baseFetch, { settings: on(), provider: "test", model: "m1" });
  const requestBody = JSON.stringify({ messages: [{ role: "user", content: `my key ${REAL_KEY}` }] });
  const response = await fetch("https://vendor.example/v1/chat", { method: "POST", body: requestBody });
  assert.ok(!seenBody.includes(REAL_KEY));
  assert.match(seenBody, /\{\{API_KEY_[a-z2-7]{8}\}\}/u);
  const parsed = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.equal(parsed.choices[0]!.message.content, `ack my key ${REAL_KEY}`);
});

test("privacy fetch records a request even when nothing needed masking", async () => {
  resetStoreForTest();
  resetMaskRecordsForTest();
  const baseFetch: typeof globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const fetch = createPrivacyFetch(baseFetch, { settings: on(), provider: "test", model: "m1" });
  await fetch("https://vendor.example/v1/chat", { method: "POST", body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "just a chat" }] }) });
  const overview = maskingOverview();
  assert.equal(overview.records.length, 1);
  assert.equal(overview.records[0]!.count, 0);
  assert.equal(overview.summary.total, 0);
  const detail = maskingDetail(overview.records[0]!.id)!;
  assert.ok(detail.preview.some(group => group.original === "just a chat"));
});

test("privacy fetch passes through unchanged when masking is off", async () => {
  let calls = 0;
  const baseFetch: typeof globalThis.fetch = async () => { calls += 1; return new Response("ok", { status: 200 }); };
  const fetch = createPrivacyFetch(baseFetch, { settings: defaultRedactionSettings, provider: "test", model: "m1" });
  const response = await fetch("https://vendor.example/x", { method: "POST", body: "plain" });
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 1);
});

test("records keep the before/after diff for display, without persisting originals", async () => {
  resetStoreForTest();
  resetMaskRecordsForTest();
  const { segments } = maskText(REAL_KEY, on());
  const record = recordMask({ provider: "acme", model: "m2", segments: [{ path: "messages.0.content", original: REAL_KEY, masked: segments[0]!.masked, segments }] });
  assert.ok(record);
  assert.equal(record!.count, 1);
  assert.equal(record!.preview[0]!.path, "messages.0.content");
  assert.equal(record!.preview[0]!.segments[0]!.original, REAL_KEY);
  assert.equal(record!.preview[0]!.segments[0]!.masked, placeholderTag("API_KEY", REAL_KEY));
  assert.equal(maskingOverview().summary.total, 1);
});

test("a request with nothing to mask records nothing", () => {
  resetMaskRecordsForTest();
  const record = recordMask({ provider: "acme", model: "m2", segments: [] });
  assert.equal(record, undefined);
  assert.equal(maskingOverview().records.length, 0);
});

test("an unmasked request with readable content is still recorded for observation", () => {
  resetMaskRecordsForTest();
  const preview = [{ path: "messages[0].content", role: "user", original: "普通正文，没有敏感信息", masked: "普通正文，没有敏感信息", segments: [] }];
  const record = recordMask({ provider: "acme", model: "m2", segments: [], preview })!;
  assert.ok(record);
  assert.equal(record.count, 0);
  assert.equal(record.uniqueValues, 0);
  assert.deepEqual(record.kinds, {});
  assert.equal(record.preview[0]!.original, "普通正文，没有敏感信息");
  const overview = maskingOverview();
  assert.equal(overview.records.length, 1);
  assert.equal(overview.summary.total, 0);
  assert.equal(maskingDetail(record.id)!.preview.length, 1);
});

test("record summaries omit originals, details are detached and truncation is explicit", () => {
  resetMaskRecordsForTest();
  const original = `${REAL_KEY} ${"普通正文".repeat(160000)} ${REAL_KEY}`;
  const masked = maskText(original, on());
  const record = recordMask({ provider: "fixture", model: "fixture", segments: [{ path: "messages.0.content", original, masked: masked.text, segments: masked.segments }] })!;
  const detail = maskingDetail(record.id)!;
  detail.preview[0]!.original = "modified by caller";
  assert.ok(maskingDetail(record.id)!.preview[0]!.original.startsWith(REAL_KEY));
  assert.equal(record.count, 2);
  assert.equal(record.truncated, true);
  assert.ok(record.preview[0]!.original.length < original.length);
  for (let i = 0; i < 102; i++) recordMask({ provider: "fixture", model: "fixture", segments: [{ path: "text", original: REAL_KEY, masked: masked.segments[0]!.masked, segments: [masked.segments[0]!] }] });
  const overview = maskingOverview();
  assert.equal(overview.records.length, 103);
  assert.equal(overview.summary.total, 104);
  assert.ok(!JSON.stringify(overview).includes(REAL_KEY));
});
