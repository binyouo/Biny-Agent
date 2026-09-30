/** The real ordinary-send path persists fresh-selection provenance across turns. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
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
const model: AgentModel = { provider: "test", modelId: "history", supportsTools: false, async stream() {
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: "answer" };
    yield { type: "finish", reason: "stop" };
  })();
} };
const config = configSchema.parse({ ...defaultConfig,
  context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
});
const observed: string[][] = [];
const historyLengths: number[] = [];
const agent = new AgentSession({ workspaceRoot: root, config, recorder, model, toolRegistry: new ToolRegistry(),
  permissionManager: new PermissionManager(config.permission),
  selectCapabilities: async (input) => {
    observed.push([...input.previousTools]);
    historyLengths.push(input.history.length);
    const fresh = observed.length === 1 ? ["old_topic_tool"] : [];
    input.onAutomaticToolsSelected?.(fresh);
    return { tools: [...fresh, ...input.previousTools], skills: [] };
  }
});
try {
  await agent.initialize();
  for (let turn = 0; turn < 5; turn++) {
    const outcome = await agent.runTask(`question ${turn}`, { emotionAnalysis: false });
    assert.equal(outcome.status, "completed", outcome.error);
  }
  assert.deepEqual(observed, [[], ["old_topic_tool"], ["old_topic_tool"], ["old_topic_tool"], []], "inherited tools expire without renewing themselves");
  assert.deepEqual(historyLengths, [0, 2, 4, 6, 8], "capability history uses the active path once and excludes the new user message");
  const metadata = (await readSessionEvents(recorder.filePath)).filter((event) => event.type === "message_metadata" && event.metadata.automaticToolSelection === true);
  assert.deepEqual(metadata.map((event) => event.type === "message_metadata" ? event.metadata.automaticToolFreshSelection : undefined), [["old_topic_tool"], [], [], [], []]);
  console.log("capability session history tests passed");
} finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
