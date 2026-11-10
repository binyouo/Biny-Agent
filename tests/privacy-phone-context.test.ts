import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { maskText } from "../src/privacy/engine.js";
import { maskJson } from "../src/privacy/json.js";
import { RedactionStore } from "../src/privacy/store.js";
import { createPrivacyFetch } from "../src/privacy/privacyFetch.js";

const settings = { enabled: true };
const phone = "13800138000";
const card = "4111111111111111";

const identifiers = [
  '订单号 13800138000 已发货', '订单号：13800138000', '订单号是 13800138000', '编号为 13800138000',
  '工单号 13800138000', '交易号 13800138000', 'Order #13800138000 shipped', 'order 13800138000 failed',
  'ticket 13800138000', '#13800138000', 'invoice 13800138000', 'number 13800138000',
  '{"order_id":"13800138000"}', '{"userId":"13800138000"}', 'uid=13800138000&page=2',
  'token_id=13800138000', 'secretId=13800138000', 'token_hash=13800138000',
  'SELECT * FROM orders WHERE id = 13800138000;', '<id>13800138000</id>', '<value type="id">13800138000</value>',
  'trace_id=9f13800138000abc', 'build-13800138000x', 'v13800138000',
  '123e4567-e89b-12d3-a456-13800138000a', 'hash=x4111111111111111y'
];

for (const known of [false, true]) test(`identifier context and alphanumeric boundaries preserve numeric identifiers (known=${known})`, () => {
  const store = new RedactionStore(randomUUID());
  if (known) {
    maskText(`电话：${phone}`, settings, store);
    maskText(card, settings, store);
  }
  for (const text of identifiers) assert.equal(maskText(text, settings, store).text, text, text);
});

const phoneTexts = [
  phone, `我的手机号是 ${phone}`, `联系电话：${phone}`, `请打 ${phone}`, `call ${phone} now`,
  `张三 ${phone} 北京`, `+86 ${phone}`, `+86${phone}`, `86${phone}`, `order_id=+86${phone}`,
  `phone_number=${phone}`, `contactPhone: ${phone}`, `mobileNo=${phone}`, `PHONE_NUMBER=${phone}`,
  `Phone No: ${phone}`, `mobile number: ${phone}`, `phone no. ${phone}`, `phone number ${phone}`,
  `{"phone":"${phone}"}`, `{"contact_phone":"${phone}"}`, `{"number":"${phone}"}`,
  `<tel>${phone}</tel>`, `<mobile type="cn">${phone}</mobile>`, `mail me: person@acme.org or ${phone}`,
  `recorder ${phone}`, `phoneNumber: '${phone}'`, `联系电话是：${phone}`,
  `password=${phone}`, `DB_PASSWORD: ${phone}`, `clientSecret=${phone}`
];

test("phone labels, country prefixes and ordinary contact prose still mask and restore", () => {
  for (const text of phoneTexts) {
    const store = new RedactionStore(randomUUID());
    const result = maskText(text, settings, store);
    assert.ok(result.hits.some(hit => hit.kind === "PHONE"), text);
    assert.ok(!result.text.includes(phone), text);
    assert.equal(store.restore(result.text), text);
  }
});

const domains = [
  { name: "Anthropic", body: (input: unknown) => ({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "contact", input }] }] }),
    read: (source: string) => JSON.parse(source).messages[0].content[0].input },
  { name: "Gemini", body: (input: unknown) => ({ contents: [{ role: "model", parts: [{ functionCall: { name: "contact", args: input } }] }] }),
    read: (source: string) => JSON.parse(source).contents[0].parts[0].functionCall.args },
  { name: "Chat", body: (input: unknown) => ({ messages: [{ role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "contact", arguments: JSON.stringify(input) } }] }] }),
    read: (source: string) => JSON.parse(JSON.parse(source).messages[0].tool_calls[0].function.arguments) }
];

for (const domain of domains) test(`${domain.name} field semantics distinguish phone values from same-value identifiers`, () => {
  const store = new RedactionStore(randomUUID());
  const first = maskJson(JSON.stringify(domain.body({ user_id: phone })), settings, store);
  assert.equal(domain.read(first.text).user_id, phone);
  const source = JSON.stringify(domain.body({ user_id: phone, phone, contactPhone: phone, value: phone, text: `call ${phone}`, numbers: [phone], mobileNumbers: [phone] }));
  const result = maskJson(source, settings, store);
  const input = domain.read(result.text);
  assert.equal(input.user_id, phone);
  for (const value of [input.phone, input.contactPhone, input.value, input.text, input.mobileNumbers[0]]) assert.ok(!value.includes(phone));
  assert.equal(input.numbers[0], phone);
  assert.equal(domain.read(maskJson(JSON.stringify(domain.body({ order_id: phone, phone })), settings, store).text).order_id, phone);
});

test("explicit credentials remain sensitive even when their value looks like a business identifier", () => {
  const result = maskJson(JSON.stringify(domains[0]!.body({ password: phone, api_key: phone, order_id: phone })), settings, new RedactionStore(randomUUID()));
  const input = domains[0]!.read(result.text);
  assert.match(input.password, /^\{\{PASSWORD_/u);
  assert.match(input.api_key, /^\{\{SECRET_/u);
});

test("the outbound request keeps order ids and restores masked phone tool arguments", async () => {
  let sentBody = "";
  const fetch = createPrivacyFetch(async (_url, init) => {
    sentBody = String(init?.body);
    const sent = JSON.parse(sentBody);
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "contact", arguments: JSON.stringify({ phone: sent.messages[0].content[0].input.phone }) } }] } }] }), { headers: { "content-type": "application/json" } });
  }, { settings, provider: "fixture", model: "fixture", protocol: "anthropic" });
  const response = await fetch("https://fixture.invalid", { method: "POST", headers: { "x-session-id": randomUUID() },
    body: JSON.stringify(domains[0]!.body({ order_id: phone, phone })) });
  const sent = JSON.parse(sentBody);
  assert.equal(sent.messages[0].content[0].input.order_id, phone);
  assert.match(sent.messages[0].content[0].input.phone, /^\{\{PHONE_/u);
  assert.equal(JSON.parse((await response.json()).choices[0].message.tool_calls[0].function.arguments).phone, phone);
});
