import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { attachmentRoot, readAttachment, saveAttachment, saveAttachmentContext } from "../src/attachments/store.js";

test("chat screenshot context reaches the model on first input and replay but stays out of session events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-shot-session-")), previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  const requests: AgentMessage[][] = [];
  const model: AgentModel = { provider: "test", modelId: "shot-model", stream: async context => {
    requests.push(structuredClone(context.messages));
    return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "Done" }; yield { type: "finish", reason: "stop" }; })();
  } };
  const config = configSchema.parse({ ...structuredClone(defaultConfig),
    providers: { sample: { type: "openai-compatible", baseUrl: "https://example.invalid/", apiKeyEnv: "BINY_TEST_UNCONFIGURED_KEY", modelProfiles: { "shot-model": { capabilities: { vision: true } } } } },
    models: { selected: { provider: "sample", model: "shot-model", capabilities: { vision: true } } }, defaultModel: "selected" });
  config.context.memory.useMemories = false; config.context.memory.generateMemories = false;
  const create = () => new AgentSession({ workspaceRoot: root, attachmentRoot: attachmentRoot(root), config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }), recorder: new SessionRecorder(root) });
  await ensureAgentDirs(root);
  let agent = create();
  try {
    const reference = await saveAttachment(root, "Notes.png", "image/png", Buffer.from("pixels"));
    await saveAttachmentContext(attachmentRoot(root), reference.path, "private-AX-context-9381");
    const attachment = await readAttachment(root, reference); assert.ok(attachment);
    await agent.initialize(); await agent.runTask("Explain this application", { attachments: [attachment] });
    assert.match(JSON.stringify(requests.at(-1)), /private-AX-context-9381/);
    const info = agent.getInfo(); await agent.close();
    assert.doesNotMatch(await readFile(info.sessionFile, "utf8"), /private-AX-context-9381|cGl4ZWxz/);
    agent = create(); await agent.initialize(); await agent.resume(info.sessionId); await agent.runTask("Continue");
    assert.match(JSON.stringify(requests.at(-1)), /private-AX-context-9381/);
    assert.match(JSON.stringify(requests.at(-1)), /untrusted source data/);
    assert.doesNotMatch(await readFile(info.sessionFile, "utf8"), /private-AX-context-9381/);
  } finally { await agent.close(); if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV]; else process.env[BINY_AGENT_DIR_ENV] = previous; await rm(root, { recursive: true, force: true }); }
});
