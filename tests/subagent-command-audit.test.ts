import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";

for (const background of [false, true]) {
  test(`ordinary ${background ? "background" : "foreground"} slash child records exactly one call and result`, { timeout: 15_000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-audit-"));
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const network = t.mock.method(globalThis, "fetch", async () => {
      entered.resolve(); await release.promise;
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"completed"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    const config = ownerConfig();
    const host = await createInteractiveAgentHost(root, { sessionId: "owner", configStore: { load: async () => config, save: async () => undefined } });
    try {
      const command = executeRuntimeCommand(host.runtime, host.commands, `/subagent ${background ? "start " : ""}ordinary lifecycle task`, "tui");
      const settled = command.then(value => ({ value }), error => ({ error }));
      if (background) assert.match((await command)!.content, /Started subagent task/u);
      await entered.promise;
      const taskId = host.commands.subagents!.listSnapshots()[0]!.taskId;
      await host.commands.agent.getSessionRecorder().flush();
      assert.deepEqual(host.commands.runtimeAuthority.readToolEvents([taskId]).map(event => event.eventType), ["session.tool_call"]);
      release.resolve(); await settled; await host.runtime.waitForIdle(); await host.commands.agent.getSessionRecorder().flush();
      assert.deepEqual(host.commands.runtimeAuthority.readToolEvents([taskId]).map(event => event.eventType), ["session.tool_call", "session.tool_result"]);
    } finally { release.resolve(); await host.runtime.close(); network.mock.restore(); await rm(root, { recursive: true, force: true }); }
  });
}

function ownerConfig(): AgentConfig {
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic"; config.toolModel = "synthetic";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false, retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 } } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
  config.permission = { ...config.permission, mode: "full-access", criticalAlwaysAsk: false, denyPaths: [] };
  config.extensions.subagent.enabled = true; config.extensions.subagent.allowedTools = ["Write"];
  config.checkpoints.enabled = false; config.heartbeat.enabled = false; config.context.memory.enabled = false; config.context.identity.enabled = false;
  return config;
}
