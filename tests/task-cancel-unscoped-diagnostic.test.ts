import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";

for (const initialState of ["created", "queued"] as const) for (const mode of ["unchanged", "draft-owned", "draft-foreign", "resume-owned", "resume-foreign", "cold-resume-owned", "failed-resume", "return-original"] as const) {
  test(`TaskCancel unscoped diagnostic session ownership: ${mode} / ${initialState}`, { timeout: 30000 }, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-cancel-"));
    const old = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    let host: InteractiveAgentHost | undefined;
    context.after(async () => { try { await host?.runtime.close(); } finally {
      context.mock.restoreAll(); syncBuiltinESMExports();
      if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
      await fs.rm(root, { recursive: true, force: true });
    } });
    let cancelError: unknown;
    let cancelResult: unknown;
    context.mock.method(process, "kill", () => { throw new Error("No real process may be signalled"); });
    context.mock.method(childProcess, "spawn", () => { throw new Error("No subprocess permitted"); });
    syncBuiltinESMExports();
    context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      assert.equal(input instanceof Request ? input.url : String(input), "http://notice-fixture.invalid/v1/chat/completions");
      assert.equal(JSON.parse(String(init?.body)).messages.at(-1).role, "user");
      const delta = { content: "Fixture complete" };
      return new Response([{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"].map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
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
    const open = () => createInteractiveAgentHost(root, { persistenceRoot: root, configStore: { load: async () => config, save: async () => undefined } });
    host = await open();
    const run = async () => { const outcome = await host!.runtime.submitPrompt("Complete fixture turn.").completion; assert.equal(outcome.status, "completed", JSON.stringify(outcome)); };
    const original = host.commands.agent.getInfo().sessionId;
    await run();
    let current = original;
    if (!["unchanged", "failed-resume"].includes(mode)) {
      current = (await host.runtime.startDraft()).sessionId;
      await run();
      if (mode.startsWith("resume")) { await host.runtime.resumeSession(original); await host.runtime.resumeSession(current); }
      if (mode === "return-original") { await host.runtime.resumeSession(original); current = original; }
    }
    if (mode === "failed-resume") await assert.rejects(host.runtime.resumeSession("missing-fixture-session"));
    const owner = mode.endsWith("owned") ? current : original;
    const task = host.commands.taskRuns.create({ taskRunId: "synthetic-cancel", sessionId: owner, task: { prompt: "Inert cancellation evidence" } });
    if (initialState === "queued") {
      const attempt = host.commands.taskRuns.createAttempt(task.taskRunId);
      host.commands.taskRuns.transition(task.taskRunId, "queued", { attemptId: attempt.attemptId });
    }
    if (mode === "cold-resume-owned") {
      await host.runtime.close(); host = undefined; host = await open();
      assert.notEqual(host.commands.agent.getInfo().sessionId, current);
      await host.runtime.resumeSession(current);
    }
    const before = host.commands.taskRuns.get(task.taskRunId);
    const taskId = task.taskRunId;
    try { cancelResult = await host.commands.sessionCommand("TaskCancel", { taskRunId: taskId }); }
    catch (error) { cancelError = error; }
    if (owner === current) {
      assert.equal(cancelError, undefined, String(cancelError));
      assert.equal((cancelResult as {status: string}).status, "cancelled");
      assert.equal(host.commands.taskRuns.get(taskId)?.status, "cancelled");
    } else {
      assert.deepEqual(host.commands.taskRuns.get(taskId), before, "Foreign or invalid-scope task must remain completely unchanged");
      assert.match(String(cancelError), /another session/);
      assert.equal(cancelResult, undefined);
    }
  });
}
