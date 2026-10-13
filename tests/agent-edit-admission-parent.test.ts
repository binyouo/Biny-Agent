/** Admission-only persistence guards. Model execution is forbidden by the fixture. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { activeSessionMessageIds } from "../src/session/messageTree.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-edit-admission-parent-"));
  const previousRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  const cleanup: { close?: () => Promise<void> } = {};
  t.after(async () => {
    try { await cleanup.close?.(); }
    finally {
      if (previousRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const config = structuredClone(defaultConfig);
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.diagnostics.enabled = false;
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({
    workspaceRoot: root, config, recorder, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    model: {
      provider: "fixture", modelId: "admission-only",
      stream: async () => { throw new Error("Admission must not execute a model"); }
    }
  });
  cleanup.close = async () => await agent.close();
  await agent.initialize();
  return { agent, recorder };
}

for (const nonroot of [false, true]) {
  test(`${nonroot ? "nonroot" : "root"} edit admission preserves the source parent and ordinary append cursor`, async t => {
    const { agent, recorder } = await fixture(t);
    const assistant = (messageId: string) => recorder.record({
      type: "agent_message", messageId,
      message: { role: "assistant", content: [{ type: "text", text: messageId }], stopReason: "stop" }
    });
    if (nonroot) {
      recorder.record({ type: "user_message", messageId: "prefix-user", content: "prefix" });
      assistant("prefix-assistant");
    }
    const original = recorder.record({ type: "user_message", messageId: "original-user", content: "original" });
    assert.equal(original.type, "user_message");
    if (original.type !== "user_message") throw new Error("Expected seeded user");
    assert.equal(original.parentMessageId, nonroot ? "prefix-assistant" : undefined);
    assistant("old-assistant");
    recorder.record({ type: "user_message", messageId: "old-followup", content: "old followup" });
    assistant("old-leaf");
    const options = {
      runId: "edit-run", turnId: "edit-turn", messageId: "fallback-id",
      replaceUserMessageId: "original-user", replacementUserMessageId: "edited-user"
    };
    await Promise.all([
      agent.admitUserMessage("edited", options),
      agent.admitUserMessage("edited", options)
    ]);
    const events = await readSessionEvents(recorder.filePath);
    const replacements = events.filter(event => event.type === "user_message" && event.runtime?.runId === "edit-run");
    assert.equal(replacements.length, 1, "pending duplicate admission writes one canonical user");
    const replacement = replacements[0];
    assert.ok(replacement?.type === "user_message");
    assert.equal(replacement.messageId, "edited-user");
    assert.equal(replacement.parentMessageId, original.parentMessageId);
    assert.equal(replacement.slotId, original.slotId);
    assert.equal(replacement.runtime?.turnId, "edit-turn");
    assert.deepEqual([...activeSessionMessageIds(events)].sort(),
      (nonroot ? ["edited-user", "prefix-user", "prefix-assistant"] : ["edited-user"]).sort(),
      "the replaced user and its descendants must not remain in the active branch");

    assistant("edited-assistant");
    await agent.admitUserMessage("edited", options);
    await assert.rejects(agent.admitUserMessage("conflicting edit", options), /identity was reused/u);
    await agent.admitUserMessage("ordinary", { runId: "ordinary-run", turnId: "ordinary-turn", messageId: "ordinary-user" });
    const after = await readSessionEvents(recorder.filePath);
    assert.equal(after.filter(event => event.type === "user_message" && event.runtime?.runId === "edit-run").length, 1,
      "completed duplicate admission must reuse its original canonical reference");
    const ordinary = after.find(event => event.type === "user_message" && event.messageId === "ordinary-user");
    assert.ok(ordinary?.type === "user_message");
    assert.equal(ordinary.parentMessageId, "edited-assistant", "duplicates must not rewind the cursor; ordinary input must append");
    assert.equal(ordinary.slotId, "ordinary-user");
    assert.equal(ordinary.runtime?.runId, "ordinary-run");
  });
}
