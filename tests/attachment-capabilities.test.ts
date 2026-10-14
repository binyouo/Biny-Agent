/** 附件入口必须使用解析后的能力，同时保留用户明确关闭能力的约束。 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { parseModelCatalog } from "../src/ai/modelCatalog.js";

const image = { name: "screen.png", mimeType: "image/png", data: "synthetic" };
test("目录识别对象形式的输入模态，输出模态不能冒充图片输入能力", () => {
  // 实际网关返回 modalities.input；原来的 supports_vision 和数组用例未覆盖此格式。
  const entries = parseModelCatalog({ data: [
    { id: "workbuddy-ai/deepseek-v4.1-flash", modalities: { input: ["text", "image"], output: ["text"] } },
    { id: "image-output", modalities: { input: ["text"], output: ["image"] } },
    { id: "disabled", supports_vision: false, modalities: { input: ["image"] } }
  ] }, "gateway", "openai-compatible");
  assert.deepEqual(entries.map(entry => entry.capabilities.vision), [true, undefined, false]);
});

// 已知模型用例无法发现自定义网关缺少元数据时的误拦；未知能力应允许请求，显式禁用仍拒绝。
for (const vision of [undefined, true, false]) {
  test(`自定义模型图片输入遵守三态能力 vision=${vision}`, () => {
    const config = configSchema.parse({
      ...structuredClone(defaultConfig),
      providers: { gateway: { type: "openai-compatible", baseUrl: "https://gateway.invalid/v1", requiresApiKey: false,
        modelProfiles: { "custom-model": { capabilities: { vision } } } } },
      models: { selected: { provider: "gateway", model: "custom-model" } },
      defaultModel: "selected"
    });
    const manager = new ModelManager(process.cwd(), config);
    assert.equal(manager.getCapabilities().vision, vision, "未知能力不能伪装成明确不支持");
    const session: AgentSession = Object.create(AgentSession.prototype);
    Object.defineProperty(session, "options", { value: { config, modelManager: manager } });
    if (vision === false) assert.throws(() => session.assertAttachmentsSupported([image]), /图片/u);
    else assert.doesNotThrow(() => session.assertAttachmentsSupported([image]));
  });
}

for (const managed of [false, true]) {
  for (const vision of [undefined, false]) {
    test(`附件能力使用模型元数据 managed=${managed} vision=${vision}`, () => {
      const config = configSchema.parse({
        ...structuredClone(defaultConfig),
        providers: { sample: { type: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", apiKey: "test-key", modelProfiles: { "glm-5.3-flash": { capabilities: { vision } } } } },
        models: { selected: { provider: "sample", model: "glm-5.3-flash", capabilities: { vision: false } } },
        defaultModel: "selected"
      });
      // 单独执行实际入口，不初始化与能力检查无关的记忆、工具和持久化服务。
      const session: AgentSession = Object.create(AgentSession.prototype);
      Object.defineProperty(session, "options", { value: {
        config,
        modelManager: managed ? new ModelManager(process.cwd(), config) : undefined
      } });
      if (vision === false) {
        assert.throws(() => session.assertAttachmentsSupported([image]), /图片/u);
      } else {
        assert.doesNotThrow(() => session.assertAttachmentsSupported([image]));
      }
      assert.throws(() => session.assertAttachmentsSupported([{ ...image, mimeType: "audio/wav" }]), /audio/u);
    });
  }
}

test("图片内容会映射为 provider 的原生 file part", () => {
  const messages = toModelMessages([{
    role: "user",
    content: [
      { type: "text", text: "分析棋盘" },
      { type: "image", mimeType: "image/png", data: "base64-image" }
    ]
  }]);
  assert.deepEqual(messages, [{
    role: "user",
    content: [
      { type: "text", text: "分析棋盘" },
      { type: "file", mediaType: "image/png", data: "base64-image" }
    ]
  }]);
});
