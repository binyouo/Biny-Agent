/** 聊天展示偏好走配置契约，不能在保存时被剥离，也不改变旧配置默认行为。 */
import assert from "node:assert/strict";
import { chatParamsSchema } from "../src/config/schema.js";

const response = { streaming: false, showTokenUsage: false, markdown: false, singleDollarMath: false, collapseThinking: false, openLinksInBrowser: true };
assert.deepEqual(chatParamsSchema.parse({ response }).response, response);
assert.equal(chatParamsSchema.parse({}).response, undefined);
assert.throws(() => chatParamsSchema.parse({ response: { streaming: "false" } }));
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createFileConfigStore } = await import("../src/config/store.js");
const root = await mkdtemp(join(tmpdir(), "biny-chat-preferences-"));
try {
  const store = createFileConfigStore(root, { globalDir: join(root, "config") });
  const config = await store.load();
  config.chat.response = response;
  await store.save(config);
  const reopened = createFileConfigStore(root, { globalDir: join(root, "config") });
  assert.deepEqual((await reopened.load()).chat.response, response);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("chat response settings tests passed");
