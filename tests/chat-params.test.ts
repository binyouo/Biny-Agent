import assert from "node:assert/strict";
import { chatParamsSchema, configSchema, defaultConfig } from "../src/config/schema.js";

function testSchemaDefaults(): void {
  const parsed = chatParamsSchema.parse(undefined);
  assert.equal(parsed.temperature, undefined);
  assert.equal(parsed.maxOutputTokens, undefined);
  assert.equal(defaultConfig.chat.temperature, undefined);
  assert.equal(defaultConfig.chat.maxOutputTokens, undefined);
}

function testSchemaRoundTrip(): void {
  const config = configSchema.parse({
    ...defaultConfig,
    chat: { temperature: 0.7, maxOutputTokens: 2_048 }
  });
  assert.equal(config.chat.temperature, 0.7);
  assert.equal(config.chat.maxOutputTokens, 2_048);
}

function testSchemaRejectsOutOfRange(): void {
  assert.throws(() => configSchema.parse({ ...defaultConfig, chat: { temperature: 2.5 } }));
  assert.throws(() => configSchema.parse({ ...defaultConfig, chat: { temperature: -0.1 } }));
  assert.throws(() => configSchema.parse({ ...defaultConfig, chat: { maxOutputTokens: 100 } }));
  assert.throws(() => configSchema.parse({ ...defaultConfig, chat: { maxOutputTokens: 200_000 } }));
}

const tests: Array<[string, () => void]> = [
  ["schema 默认不下发聊天参数", testSchemaDefaults],
  ["schema 解析显式温度与输出上限", testSchemaRoundTrip],
  ["schema 拒绝越界温度与令牌数", testSchemaRejectsOutOfRange]
];

for (const [name, test] of tests) {
  test();
  console.log(`✔ ${name}`);
}
console.log("chat-params tests passed");
