import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { readSessionEvents } from "../src/session/events.js";
import { listSessionFilePaths, sessionIdFromFile } from "../src/session/store.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

test("deleting a heartbeat session does not prevent later runtime heartbeats or projection recovery", { timeout: 30_000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-session-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let runtime: CommandRuntime | undefined;
  context.mock.method(globalThis, "fetch", async (input: unknown) => {
    assert.equal(input instanceof Request ? input.url : String(input), "http://heartbeat-session.invalid/v1/chat/completions");
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"HEARTBEAT_OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const config = configSchema.parse({
      ...defaultConfig, defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: "http://heartbeat-session.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false }, checkpoints: { enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      activity: { ...defaultConfig.activity, enabled: false },
      context: { ...defaultConfig.context, identity: { enabled: false, userEnabled: false }, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    const options = { configStore: { load: async () => config, save: async () => undefined } };
    runtime = await createCommandRuntime(root, options);
    assert.equal(await runtime.heartbeat.triggerNow(), true, runtime.heartbeat.status().lastError);
    const originalFile = await heartbeatFile(root);
    const originalId = sessionIdFromFile(originalFile);
    const originalProjection = runtime.runtimeAuthority.readEvents({ sessionId: originalId }).events;
    assert.ok(originalProjection.length > 0);
    await deleteSessionArtifacts(root, originalId);
    await runtime.close();
    runtime = undefined;
    await assert.rejects(access(originalFile), { code: "ENOENT" });

    runtime = await createCommandRuntime(root, options);
    assert.equal(await runtime.heartbeat.triggerNow(), true, runtime.heartbeat.status().lastError);
    const replacementFile = await heartbeatFile(root);
    const replacementId = sessionIdFromFile(replacementFile);
    assert.notEqual(replacementId, originalId, "a new background session cannot reuse the deleted session's projected identity");
    assert.equal(await runtime.heartbeat.triggerNow(), true, runtime.heartbeat.status().lastError);
    assert.equal(await heartbeatFile(root), replacementFile, "later triggers reuse the initialized background session");
    const replacementEvents = await readSessionEvents(replacementFile);
    assert.equal(replacementEvents.filter(event => event.type === "user_message" && event.metadata?.source === "heartbeat").length, 2);
    await runtime.close();
    runtime = undefined;

    const reopened = await RuntimeEventAuthority.open(root);
    try {
      assert.deepEqual(reopened.readEvents({ sessionId: originalId }).events, originalProjection, "deletion does not repurpose or overwrite existing runtime facts");
      const projected = reopened.readEvents({ sessionId: replacementId }).events;
      assert.equal(projected.length, replacementEvents.length);
      assert.equal(new Set(projected.map(event => event.eventSeq)).size, projected.length);
    } finally {
      reopened.close();
    }
  } finally {
    await runtime?.close();
    context.mock.restoreAll();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await removeTestRoot(root, { recursive: true, force: true });
  }
});

async function heartbeatFile(root: string): Promise<string> {
  const matches: string[] = [];
  for (const file of await listSessionFilePaths(root)) {
    const events = await readSessionEvents(file);
    if (events.some(event => event.type === "user_message" && event.metadata?.source === "heartbeat")) matches.push(file);
  }
  assert.equal(matches.length, 1, "the heartbeat has exactly one separate persisted session");
  return matches[0]!;
}
