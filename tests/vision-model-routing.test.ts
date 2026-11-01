import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import { attachmentRoot, readAttachment, saveAttachment } from "../src/attachments/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";

const selections = [
  { name: "未配置", alias: undefined, flag: undefined, enabled: false },
  { name: "旧配置", alias: "eyes", flag: undefined, enabled: true },
  { name: "开启", alias: "eyes", flag: true, enabled: true },
  { name: "关闭并保留选择", alias: "eyes", flag: false, enabled: false }
];
for (const vision of [true, false, undefined]) for (const selection of selections) {
  test(`视觉辅助只补足主模型的图片能力 vision=${vision} ${selection.name}`, async context => {
    const { enabled } = selection;
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-vision-routing-"));
    await ensureAgentDirs(root);
    const config = configSchema.parse({ ...defaultConfig,
      defaultModel: "primary", visionModel: selection.alias, visionModelEnabled: selection.flag,
      providers: { local: { type: "openai-compatible", baseUrl: "https://model.invalid/v1", requiresApiKey: false } },
      models: {
        primary: { provider: "local", model: "primary", capabilities: { vision } },
        eyes: { provider: "local", model: "eyes", capabilities: { vision: true } }
      },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
    });
    const requests: AgentMessage[][] = [];
    const visionRequests: AgentMessage[][] = [];
    const primary = testModel({ ...new ProviderRegistry(config).createModelSettings("primary").model,
      stream: async modelContext => {
        requests.push(structuredClone(modelContext.messages));
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: "Inspected" }; yield { type: "finish", reason: "stop" };
        })();
      }
    });
    const eyes = testModel({ provider: "test", modelId: "eyes", stream: async modelContext => {
      visionRequests.push(structuredClone(modelContext.messages));
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: "A blue square" }; yield { type: "finish", reason: "stop" };
      })();
    } });
    context.mock.method(ProviderRegistry.prototype, "createModelSettings", (alias: string) => {
      assert.equal(alias, "eyes", "只允许已配置的独立视觉请求");
      return { model: eyes, contextWindow: undefined };
    });
    const agent = new AgentSession({ workspaceRoot: root, attachmentRoot: attachmentRoot(root), config, model: primary,
      toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(root) });
    try {
      const reference = await saveAttachment(root, "square.png", "image/png", Buffer.from("pixels"));
      const attachment = await readAttachment(root, reference);
      assert.ok(attachment);
      await agent.initialize();
      const outcome = await agent.runTask("Describe the picture", { attachments: [attachment] });
      if (!enabled && vision === false) {
        assert.equal(outcome.status, "failed");
        assert.match(outcome.error ?? "", /图片输入/u);
        assert.equal(requests.length, 0);
      } else {
        assert.equal(outcome.status, "completed", outcome.error);
        assert.equal(requests.length, 1);
        const parts = requests[0]!.flatMap(message => typeof message.content === "string" ? [] : message.content);
        const auxiliary = enabled && vision !== true;
        assert.equal(parts.some(part => part.type === "image"), !auxiliary);
        assert.equal(JSON.stringify(requests[0]).includes("A blue square"), auxiliary);
      }
      assert.equal(visionRequests.length, enabled && vision !== true ? 1 : 0);
      assert.equal((await readAttachment(root, reference))?.data, attachment.data, "识图不能改写原附件");
    } finally { await agent.close(); await removeTestRoot(root, { recursive: true, force: true }); }
  });
}
