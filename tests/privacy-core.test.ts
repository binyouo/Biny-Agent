import assert from "node:assert/strict";
import test from "node:test";
import {
  maskText,
  maskJson,
  restore,
  restoreJson,
  pendingTailLength,
  placeholderTag,
  placeholderPattern,
  resetStoreForTest,
  registeredCount,
  defaultRedactionSettings,
  type RedactionSettings
} from "../src/privacy/index.js";

function on(): RedactionSettings {
  return { ...defaultRedactionSettings, enabled: true };
}

/** 真实形状的 API Key。 */
const REAL_KEY = "sk-ant-api03-" + "Q7bK2mZ9pL4nR8sT1vW5xY0aC3dE6fG9hJ2k";
const realKeyPlaceholder = (): string => placeholderTag("API_KEY", REAL_KEY);

test("a secret is replaced by a stable placeholder and restores to the original", () => {
  resetStoreForTest();
  const first = maskText(`key=${REAL_KEY}`, on());
  assert.equal(first.text, `key=${realKeyPlaceholder()}`);
  assert.equal(first.hits.length, 1);
  assert.equal(first.hits[0]!.kind, "API_KEY");
  // 稳定性：同一值再次脱敏得到同一占位符
  assert.equal(maskText(`again ${REAL_KEY}`, on()).text, `again ${realKeyPlaceholder()}`);
  assert.equal(restore(first.text), `key=${REAL_KEY}`);
});

test("placeholder is deterministic for the same kind+value and distinct across values", () => {
  const a = placeholderTag("EMAIL", "a@acme-cn.com");
  const b = placeholderTag("EMAIL", "b@acme-cn.com");
  assert.equal(placeholderTag("EMAIL", "a@acme-cn.com"), a);
  assert.notEqual(a, b);
  placeholderPattern.lastIndex = 0;
  assert.ok(placeholderPattern.test(a));
});

test("private key block is masked and restored", () => {
  resetStoreForTest();
  const pem = ["-----BEGIN", "PRIVATE KEY-----", "MIIBVAIBADANBgkq", "-----END", "PRIVATE KEY-----"].join(" ");
  const out = maskText(`before ${pem} after`, on());
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0]!.kind, "PRIVATE_KEY");
  assert.equal(restore(out.text), `before ${pem} after`);
});

test("a single switch masks secrets and personal data together", () => {
  resetStoreForTest();
  const text = `key ${REAL_KEY} mail li.wei@acme-corp.cn call 13800138000 card 4111111111111111`;
  const off = maskText(text, defaultRedactionSettings);
  assert.equal(off.hits.length, 0);
  const result = maskText(text, on());
  const kinds = new Set(result.hits.map((hit) => hit.kind));
  assert.ok(kinds.has("API_KEY") && kinds.has("EMAIL") && kinds.has("PHONE") && kinds.has("BANK_CARD"));
  assert.equal(restore(result.text), text);
});

test("an invalid bank card (failed Luhn) is left alone", () => {
  resetStoreForTest();
  assert.equal(maskText("card 4111111111111112", on()).hits.length, 0);
});

test("a value masked once is masked again anywhere, even without surrounding context", () => {
  resetStoreForTest();
  maskText(REAL_KEY, on());
  const again = maskText(`the model said ${REAL_KEY} here`, on());
  assert.equal(again.hits.length, 1);
  assert.equal(again.text, `the model said ${realKeyPlaceholder()} here`);
});

test("maskText reports the original and masked value of each hit for the record", () => {
  resetStoreForTest();
  const result = maskText(`key=${REAL_KEY}`, on());
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]!.original, REAL_KEY);
  assert.equal(result.segments[0]!.masked, realKeyPlaceholder());
});

test("maskJson skips ids and encoded data, masks message content, restores back", () => {
  resetStoreForTest();
  const idValue = "req_sk-proj-ZZZZ0123456789ZZZZ0123456789";
  const dataValue = "data:image/png;base64,AAAABBBBCCCC";
  const body = JSON.stringify({
    model: "deepseek-v4",
    messages: [{ role: "user", content: `my key is ${REAL_KEY} thanks` }],
    metadata: { id: idValue, data: dataValue }
  });
  const result = maskJson(body, on());
  assert.equal(result.hits.length, 1);
  const parsed = JSON.parse(result.text) as { model: string; messages: Array<{ content: string }>; metadata: { id: string; data: string } };
  assert.equal(parsed.model, "deepseek-v4");
  assert.equal(parsed.messages[0]!.content, `my key is ${realKeyPlaceholder()} thanks`);
  assert.equal(parsed.metadata.id, idValue);
  assert.equal(parsed.metadata.data, dataValue);
  assert.equal(restoreJson(result.text), body);
});

test("maskJson leaves tool definition schema structure but masks its description", () => {
  resetStoreForTest();
  const body = JSON.stringify({
    tools: [{ name: "read_file", description: `reads a file with token ${REAL_KEY}`, input_schema: { type: "object", properties: { path: { type: "string" } } } }]
  });
  const parsed = JSON.parse(maskJson(body, on()).text) as { tools: Array<{ name: string; description: string; input_schema: { properties: Record<string, unknown> } }> };
  assert.equal(parsed.tools[0]!.name, "read_file");
  assert.equal(parsed.tools[0]!.description, `reads a file with token ${realKeyPlaceholder()}`);
  assert.deepEqual(Object.keys(parsed.tools[0]!.input_schema.properties), ["path"]);
});

test("non-JSON request body falls back to text masking", () => {
  resetStoreForTest();
  const result = maskJson(`plain ${REAL_KEY} text`, on());
  assert.equal(result.hits.length, 1);
  assert.equal(result.text, `plain ${realKeyPlaceholder()} text`);
});

test("pendingTailLength holds a split placeholder prefix and releases the rest", () => {
  const p = realKeyPlaceholder();
  assert.ok(pendingTailLength(`blah ${p.slice(0, 6)}`) > 0);
  assert.equal(pendingTailLength("blah PHONE_b5pu"), 0);
  assert.equal(pendingTailLength("blah done}"), 0);
  assert.equal(pendingTailLength("plain words "), 0);
});

test("restoreJson restores a whole JSON response", () => {
  resetStoreForTest();
  const placeholder = realKeyPlaceholder();
  maskText(REAL_KEY, on());
  const response = JSON.stringify({ choices: [{ message: { content: `the key is ${placeholder}` } }] });
  assert.equal(restoreJson(response), response.replace(placeholder, REAL_KEY));
});

test("nothing is registered when no rule matches", () => {
  resetStoreForTest();
  maskText("just some ordinary words", on());
  assert.equal(registeredCount(), 0);
});

test("Personal data categories are recognized with strict validation", () => {
  resetStoreForTest();
  const cases: Array<[string, string]> = [
    ["SSN", "ssn 457-55-5462 here"],
    ["PASSPORT", "passport no. X1234567"],
    ["IBAN", "iban GB82WEST12345698765432"],
    ["BIRTHDAY", "date of birth: 1990-05-12"],
    ["MAC", "mac 00:1a:2b:3c:4d:5e"],
    ["SERIAL", "serial: AB12CD34EF"],
    ["USERNAME", "ssh alice@webhost"],
    ["IP", "host 93.184.216.34"],
    ["BUCKET", "s3://acme-corp-backups/data"]
  ];
  for (const [kind, text] of cases) {
    const result = maskText(text, on());
    assert.ok(result.hits.some((hit) => hit.kind === kind), `${kind} should be masked in ${JSON.stringify(text)}`);
    assert.equal(restore(result.text), text);
  }
});

test("strict validators leave non-matching look-alikes alone (protects ordinary code/text)", () => {
  resetStoreForTest();
  const untouched = [
    "version 1.2.3.4",           // 版本号不是 IP
    "10.0.0.1 and 192.168.1.1",  // 私网 IP
    "serial port ready",          // 不是序列号
    "ssn 000-00-0000",            // 无效 SSN
    "card 1234-5678-9012-3456 x", // Luhn 不通过
    "s3://my-bucket/x",           // 示例桶
    "aa:bb:cc:dd:ee:ff"           // 占位 MAC
  ];
  for (const text of untouched) {
    assert.equal(maskText(text, on()).hits.length, 0, `should not mask ${JSON.stringify(text)}`);
  }
});

test("model-capability invariant: ids, signature blocks and tool schema are never rewritten", () => {
  resetStoreForTest();
  const body = JSON.stringify({
    model: "claude-x",
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "SIG_sk-ant-api03-ABCD0123456789ABCD0123456" }] },
      { role: "user", content: "email a@acme-corp.cn" }
    ],
    tool_calls: [{ id: "call_1234567890abcdef", type: "function", function: { name: "read_file", arguments: "{\"path\":\"/etc/hosts\"}" } }],
    tools: [{ type: "function", function: { name: "read_file", description: `reads with ${REAL_KEY}`, parameters: { type: "object", properties: { path: { type: "string" } } } } }]
  });
  const out = maskJson(body, on()).text;
  const parsed = JSON.parse(out) as {
    model: string;
    messages: Array<{ content: unknown }>;
    tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
    tools: Array<{ function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } }>;
  };
  // 模型名、调用 id、工具名与参数、签名原样
  assert.equal(parsed.model, "claude-x");
  assert.equal(parsed.tool_calls[0]!.id, "call_1234567890abcdef");
  assert.equal(parsed.tool_calls[0]!.function.name, "read_file");
  assert.equal(parsed.tool_calls[0]!.function.arguments, "{\"path\":\"/etc/hosts\"}");
  const thinking = (parsed.messages[0]!.content as Array<{ signature: string }>)[0]!;
  assert.equal(thinking.signature, "SIG_sk-ant-api03-ABCD0123456789ABCD0123456");
  // 工具 schema 结构保留，仅 description 被遮
  assert.equal(parsed.tools[0]!.function.name, "read_file");
  assert.deepEqual(Object.keys(parsed.tools[0]!.function.parameters.properties), ["path"]);
  assert.ok(!parsed.tools[0]!.function.description.includes(REAL_KEY));
});
