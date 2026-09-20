/** 通过真实 AgentSession 验证准备并行、能力门禁和取消落盘；只替换模型边界。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readSessionEvents } from "../src/session/events.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { z } from "zod";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-prompt-preparation-"));
const previousGlobal = process.env[BINY_AGENT_DIR_ENV];
const globalDir = path.join(root, "global");
process.env[BINY_AGENT_DIR_ENV] = globalDir;
await mkdir(globalDir, { recursive: true });
await writeFile(path.join(globalDir, "MEMORY.md"), "# MEMORY.md\n\n## Learned\n\n文件记忆首轮标记。\n", "utf8");
const config = configSchema.parse({
  ...defaultConfig, defaultModel: "test",
  providers: { test: { type: "openai", apiKey: "test-placeholder" } },
  models: { test: { provider: "test", model: "test", contextWindow: 1_000_000 } },
  context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: true, generateMemories: false } }
});
await ensureAgentDirs(root);
const recorder = new SessionRecorder(root);
let selectionReady = false;
let providerCalls = 0;
const preparationStages: string[] = [];
let releaseSelection!: () => void;
const selectionGate = new Promise<void>((resolve) => { releaseSelection = resolve; });
const model: AgentModel = {
  provider: "test", modelId: "test",
  stream: async (context) => {
    assert.equal(selectionReady, true, "主模型必须等待能力筛选完成");
    assert.deepEqual(preparationStages.filter((stage) => stage !== "ready"), ["memory", "skills", "tools", "workspace", "waiting"]);
    assert.deepEqual(context.tools, []);
    assert.match(context.systemPrompt ?? "", /选中 Skill 正文首轮标记/u);
    assert.match(JSON.stringify(context.messages), /文件记忆首轮标记/u);
    providerCalls++;
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    })();
  }
};
let cancelSelection = false;
const toolRegistry = new ToolRegistry();
toolRegistry.registerBuiltinTool({
  name: "broken",
  description: "Malformed schema fixture",
  parameters: {
    type: "object",
    properties: { payload: { type: "object", required: { invalid: true } } }
  },
  schema: z.object({}),
  resolveExecution: () => ({ isError: true, result: "must not execute", errorMessage: "must not execute" })
} as unknown as Tool);
const agent = new AgentSession({
  workspaceRoot: root, config, model, recorder,
  toolRegistry, permissionManager: new PermissionManager(config.permission),
  skillPrompt: async (selection) => {
    if (selection === "none") return undefined;
    assert.deepEqual(selection, ["selected-skill"]);
    return "# Skill: selected-skill\n\n选中 Skill 正文首轮标记";
  },
  selectCapabilities: async ({ signal, history, input }) => {
    assert.ok(history.every((message) => message.content !== input), "当前消息不重复进入筛选历史");
    if (cancelSelection) {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } else {
      await selectionGate;
    }
    selectionReady = true;
    if (input === "broken-schema") return { tools: ["broken"], skills: "none" };
    return { tools: "none", skills: ["selected-skill"] };
  }
});
const watchdog = setTimeout(() => { releaseSelection(); }, 3_000);
try {
  await agent.initialize();
  let workspaceBeforeSelection = false;
  const firstEvents: AgentSessionEvent[] = [];
  for await (const event of agent.prompt("first", { emotionAnalysis: false, messageId: "first-id" })) {
    firstEvents.push(event);
    if (event.type === "preparation.updated") preparationStages.push(event.stage);
    if (event.type === "preparation.updated" && event.stage === "workspace") {
      workspaceBeforeSelection = !selectionReady;
      releaseSelection();
    }
  }
  assert.equal(workspaceBeforeSelection, true, "工作区/记忆准备与筛选并行启动");
  assert.equal(providerCalls, 1, JSON.stringify(firstEvents));
  await recorder.flush();
  const events = await readSessionEvents(recorder.filePath);
  assert.equal(events.filter((event) => event.type === "user_message").length, 1);
  assert.ok(events.some((event) => event.type === "message_metadata" && event.metadata.capabilitySelection));

  cancelSelection = true;
  const controller = new AbortController();
  for await (const event of agent.prompt("cancel", { emotionAnalysis: false, messageId: "cancel-id", abortSignal: controller.signal })) {
    if (event.type === "preparation.updated" && event.stage === "workspace") controller.abort();
  }
  assert.equal(providerCalls, 1, "取消准备后不能发起主请求");
  await recorder.flush();
  const cancelledEvents = await readSessionEvents(recorder.filePath);
  assert.equal(cancelledEvents.some((event) => event.type === "message_metadata" && event.messageId === "cancel-id"), false, "取消后不追加筛选结果");

  cancelSelection = false;
  const schemaEvents: AgentSessionEvent[] = [];
  for await (const event of agent.prompt("broken-schema", { emotionAnalysis: false, messageId: "broken-id" })) schemaEvents.push(event);
  assert.equal(providerCalls, 1, "schema 本地校验失败不能发起首轮主模型请求");
  assert.equal(schemaEvents.some((event) => event.type === "tool.started"), false);
  const schemaError = schemaEvents.find((event) => event.type === "error");
  assert.match(schemaError?.type === "error" ? schemaError.message : "", /Tool broken.*parameters\.properties\.payload\.required/u);
} finally {
  clearTimeout(watchdog);
  releaseSelection();
  await agent.close();
  if (previousGlobal === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousGlobal;
  await rm(root, { recursive: true, force: true });
}
console.log("prompt preparation tests passed");
