import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

for (const mode of ["initialization failure", "close during initialization", "unused"] as const) {
  test(`lazy heartbeat lifecycle: ${mode}`, { timeout: 15_000 }, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-lazy-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    let runtime: CommandRuntime | undefined;
    let pending: Promise<boolean> | undefined;
    let closing: Promise<void> | undefined;
    let attempts = 0;
    let closedHeartbeats = 0;
    let requests = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const initialize = AgentSession.prototype.initialize;
    const close = AgentSession.prototype.close;
    context.mock.method(AgentSession.prototype, "initialize", async function (this: AgentSession) {
      if (this.getSessionRecorder().sessionId !== "heartbeat") return await initialize.call(this);
      attempts++;
      await initialize.call(this);
      started.resolve();
      if (mode === "initialization failure" && attempts === 1) throw new Error("heartbeat initialization failed");
      if (mode === "close during initialization") await release.promise;
    });
    context.mock.method(AgentSession.prototype, "close", async function (this: AgentSession) {
      await close.call(this);
      if (this.getSessionRecorder().sessionId === "heartbeat") closedHeartbeats++;
    });
    context.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"HEARTBEAT_OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const config = configSchema.parse({
        ...defaultConfig, defaultModel: "fixture", toolModel: "fixture",
        providers: { fixture: { type: "openai-compatible", baseUrl: "http://heartbeat-lazy.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
        models: { fixture: { provider: "fixture", model: "fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
        thinking: { ...defaultConfig.thinking, enabled: false }, checkpoints: { enabled: false },
        chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },

        activity: { ...defaultConfig.activity, enabled: false },
        context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
        heartbeat: { ...defaultConfig.heartbeat, enabled: false }
      });
      runtime = await createCommandRuntime(root, { configStore: { load: async () => config, save: async () => undefined } });
      assert.equal(attempts, 0);
      if (mode === "initialization failure") {
        assert.equal(await runtime.heartbeat.triggerNow(), false);
        assert.match(runtime.heartbeat.status().lastError ?? "", /heartbeat initialization failed/u);
        assert.equal(closedHeartbeats, 1, "failed initialization releases the partial session before retry");
        assert.equal(requests, 0);
        assert.equal(await runtime.heartbeat.triggerNow(), true, runtime.heartbeat.status().lastError);
        assert.equal(attempts, 2);
        assert.equal(requests, 1);
      } else if (mode === "close during initialization") {
        pending = runtime.heartbeat.triggerNow();
        await started.promise;
        assert.equal(await runtime.heartbeat.triggerNow(), false, "an initializing heartbeat is already in flight");
        closing = runtime.close();
        release.resolve();
        assert.equal(await pending, false);
        await closing;
        assert.equal(closedHeartbeats, 1);
        assert.equal(requests, 0, "shutdown must cancel the first run even if initialization finishes late");
        runtime = undefined;
      }
      await runtime?.close();
      runtime = undefined;
      if (mode === "unused") {
        assert.equal(attempts, 0);
        assert.equal(closedHeartbeats, 0);
        assert.equal(requests, 0);
      }
    } finally {
      release.resolve();
      await pending;
      if (closing) await closing; else await runtime?.close();
      context.mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
      await removeTestRoot(root, { recursive: true, force: true });
    }
  });
}
