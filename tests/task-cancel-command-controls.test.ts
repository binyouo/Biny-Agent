import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";

for (const scenario of ["unknown-scope", "repeated", "completed"] as const) {
 test(`TaskCancel public command control: ${scenario}`, async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-cancel-command-"));
  const old = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  context.mock.method(globalThis, "fetch", async () => { throw new Error("No provider may run"); });
    const config = configSchema.parse({
      ...defaultConfig, agent: { ...defaultConfig.agent, toolExecutionMode: "direct" }, defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: "http://notice-fixture.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "inert-fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
      extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      checkpoints: { enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      activity: { ...defaultConfig.activity, enabled: false },
      context: { ...defaultConfig.context, identity: { enabled: false, userEnabled: false }, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
  const host = await createInteractiveAgentHost(root, { persistenceRoot: root, configStore: { load: async () => config, save: async () => undefined } });
  try {
    const sessionId = host.commands.agent.getInfo().sessionId;
    host.commands.taskRuns.create({ taskRunId: "control", sessionId, task: { prompt: "synthetic" } });
    if (scenario === "completed") {
      const attempt = host.commands.taskRuns.createAttempt("control");
      host.commands.taskRuns.transition("control", "queued", { attemptId: attempt.attemptId });
      host.commands.taskRuns.transition("control", "running", { attemptId: attempt.attemptId });
      host.commands.taskRuns.transition("control", "completed", { attemptId: attempt.attemptId, artifacts: { output: "keep terminal output" } });
    }
    if (scenario === "repeated") await host.commands.sessionCommand("TaskCancel", { taskRunId: "control" });
    const before = host.commands.taskRuns.get("control");
    const events = host.commands.taskRuns.events("control");
    if (scenario === "unknown-scope") await assert.rejects(host.commands.sessionCommand("TaskCancel", { taskRunId: "control" }, "unknown-scope"), /expired|another run/);
    else assert.equal((await host.commands.sessionCommand("TaskCancel", { taskRunId: "control" }) as { status: string }).status, before?.status);
    assert.deepEqual(host.commands.taskRuns.get("control"), before);
    assert.deepEqual(host.commands.taskRuns.events("control"), events);
    assert.deepEqual(host.commands.subagents!.listSnapshots(), []);
  } finally {
    await host.runtime.close(); context.mock.restoreAll();
    if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
    await fs.rm(root, { recursive: true, force: true });
  }
 });
}
