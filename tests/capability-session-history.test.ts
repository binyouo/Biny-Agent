/** 普通发送必须累计预选并从持久会话恢复；只测选择器不能发现跨轮历史丢失。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-capability-session-history-"));
await ensureAgentDirs(root);
const recorder = new SessionRecorder(root);
const registry = new ToolRegistry();
for (const name of ["old_topic_tool", "unused_tool"]) registry.registerBuiltinTool({
  name, description: name, risk: "read", exposure: "deferred", parameters: { type: "object", properties: {} }, schema: z.object({}),
  resolveExecution: () => ({ approvalRule: name, execute: async () => ({ ok: true }) })
});
const requests: string[][] = [];
const model: AgentModel = { provider: "test", modelId: "history", supportsTools: true, async stream(context) {
  requests.push(context.tools.map((tool) => tool.name));
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: "answer" };
    yield { type: "finish", reason: "stop" };
  })();
} };
let selection = ["old_topic_tool"];
const selector: AgentModel = { provider: "test", modelId: "selector", async stream() {
  const tools = selection;
  selection = [];
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: JSON.stringify({ tools }) };
    yield { type: "finish", reason: "stop" };
  })();
} };
const config = configSchema.parse({ ...defaultConfig,
  agent: { ...defaultConfig.agent, toolExecutionMode: "direct" },
  crystal: { ...defaultConfig.crystal, passiveEnabled: false },
  context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
});
const agent = new AgentSession({ workspaceRoot: root, config, recorder, model, toolRegistry: registry,
  permissionManager: new PermissionManager(config.permission),
  selectCapabilities: (input) => preselectCapabilities({ ...input, tools: registry.list(), skills: [],
    models: [{ model: selector, failureDomain: "test-selector" }] })
});
const run = async (tools: "auto" | "none" | string[] = "auto") => {
  const outcome = await agent.runTask("Continue this task", { emotionAnalysis: false, capabilitySelection: { tools, skills: "none" } });
  assert.equal(outcome.status, "completed", outcome.error);
  return requests.at(-1);
};
try {
  await agent.initialize();
  for (let turn = 0; turn < 6; turn++) {
    assert.deepEqual(await run(), ["old_topic_tool"], `turn ${turn + 1} retains the first selection even when the selector returns nothing`);
  }
  const metadata = (await readSessionEvents(recorder.filePath)).filter((event) => event.type === "message_metadata" && event.metadata.automaticToolSelection === true);
  assert.equal(metadata.length, 6);
  for (const event of metadata) if (event.type === "message_metadata") {
    assert.deepEqual(event.metadata.capabilitySelection, { tools: ["old_topic_tool"], skills: "none" }, "persist the cumulative selection for replay");
  }
  await agent.startNewSession();
  assert.deepEqual(await run(), [], "a new session cannot inherit preselected tools");
  await agent.resume(recorder.sessionId);
  assert.deepEqual(await run(), ["old_topic_tool"], "resume reconstructs accumulated selection from the session");
  assert.deepEqual(await run(["unused_tool"]), ["unused_tool"], "explicit lists cannot be widened by accumulated choices");
  assert.deepEqual(await run("none"), [], "none disables accumulated tools");
  assert.deepEqual(await run(), ["old_topic_tool"], "manual choices never enter automatic history");
  registry.unregister("old_topic_tool");
  assert.deepEqual(await run(), [], "unregistered tools cannot be restored by saved selections");
  await agent.startNewSession();
  const cumulativeSessionId = agent.getSessionRecorder().sessionId;
  const cumulativeTools = Array.from({ length: 520 }, (_, index) => `retained_${index}`);
  for (const name of cumulativeTools) registry.registerBuiltinTool({
    name, description: name, risk: "read", exposure: "deferred", parameters: { type: "object", properties: {} }, schema: z.object({}),
    resolveExecution: () => ({ approvalRule: name, execute: async () => ({ ok: true }) })
  });
  for (let start = 0; start < cumulativeTools.length; start += 32) {
    selection = cumulativeTools.slice(start, start + 32);
    assert.deepEqual(await run(), cumulativeTools.slice(0, start + 32), "each turn appends only newly selected tools within its budget");
  }
  await agent.startNewSession();
  await agent.resume(cumulativeSessionId);
  assert.deepEqual(await run(), cumulativeTools, "replay must retain accumulated selections larger than the per-message input limit of 512");
  console.log("capability session history tests passed");
} finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
