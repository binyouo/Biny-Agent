import assert from "node:assert/strict";
import test from "node:test";
import { createPrivacyFetch } from "../src/privacy/privacyFetch.js";
import { maskingOverview, maskingDetail, resetMaskRecordsForTest } from "../src/privacy/record.js";

const key = "sk-proj-fixture000000000000000000000";
test("request detail includes unchanged protocol fields and actual wire model", async () => {
  resetMaskRecordsForTest();
  const body = '{"model":"wire-model","stream":true,"budget":9007199254740993,"tools":[],"metadata":{},"messages":[{"role":"system","content":"Keep the format."},{"role":"user","content":"' + key + '"}]}';
  let sent = "";
  const fetch = createPrivacyFetch(async (_input, init) => { sent = String(init?.body); return new Response("{}"); }, { settings: { enabled: true }, provider: "fixture-provider", model: "configured-model" });
  await fetch("https://fixture.invalid", { method: "POST", body });
  const record = maskingDetail(maskingOverview().records[0]!.id)!;
  assert.equal(record.model, "wire-model");
  const fields = Object.fromEntries(record.preview.map(group => [group.path, group]));
  assert.equal(fields["messages[0].role"]?.original, "system");
  assert.equal(fields["messages[0].content"]?.original, "Keep the format.");
  assert.equal(fields["messages[1].content"]?.role, "user");
  assert.equal(fields.budget?.original, "9007199254740993");
  assert.equal(fields.stream?.original, "true");
  assert.equal(fields.tools?.original, "[]");
  assert.equal(fields.metadata?.original, "{}");
  assert.equal(record.requestBytes, Buffer.byteLength(body));
  assert.equal(record.uniqueValues, 1);
  assert.ok(!sent.includes(key));
  assert.ok(!JSON.stringify(maskingOverview()).includes(key));
});

test("long unchanged context does not discard later changes or a complete modest request", async () => {
  resetMaskRecordsForTest();
  const context = "unchanged context ".repeat(8000);
  const body = JSON.stringify({ model: "wire", messages: [{ role: "system", content: context }, { role: "user", content: key }] });
  const fetch = createPrivacyFetch(async () => new Response("{}"), { settings: { enabled: true }, provider: "fixture", model: "wire" });
  await fetch("https://fixture.invalid", { method: "POST", body });
  const detail = maskingDetail(maskingOverview().records[0]!.id)!;
  assert.equal(detail.truncated, false);
  assert.equal(detail.preview.find(group => group.path === "messages[0].content")?.original, context);
  assert.equal(detail.preview.find(group => group.path === "messages[1].content")?.segments[0]?.original, key);
});

test("nested tool JSON has inspectable leaves, roles and original-value highlights", async () => {
  resetMaskRecordsForTest();
  const body = JSON.stringify({ messages: [{ role: "assistant", tool_calls: [{ id: "call-fixture", type: "function", function: { name: "connect", arguments: JSON.stringify({ password: 'fixture\\"secret', retry: false }) } }] }] });
  const fetch = createPrivacyFetch(async () => new Response("{}"), { settings: { enabled: true }, provider: "fixture", model: "wire" });
  await fetch("https://fixture.invalid", { method: "POST", body });
  const detail = maskingDetail(maskingOverview().records[0]!.id)!;
  const password = detail.preview.find(group => group.path.endsWith("arguments.password"))!;
  assert.equal(password.original, 'fixture\\"secret');
  assert.equal(password.role, "assistant");
  assert.equal(password.segments[0]?.original, 'fixture\\"secret');
  assert.equal(detail.preview.find(group => group.path.endsWith("arguments.retry"))?.original, "false");
});
