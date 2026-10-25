import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
for (const mode of ["unchanged", "draft-owned", "draft-foreign", "resume-owned", "resume-foreign", "cold-resume-owned", "failed-resume", "return-original", "wait-timeout", "wait-update", "wait-cancel", "wait-switch", "draft-wait-timeout", "draft-wait-update", "draft-wait-cancel", "draft-wait-switch"] as const) {
  test(`TaskStatus current session ownership: ${mode}`, { timeout: 30000 }, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-status-"));
    const old = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    let host: InteractiveAgentHost | undefined;
    context.after(async () => { try { await host?.runtime.close(); } finally {
      context.mock.restoreAll();
      if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
      await fs.rm(root, { recursive: true, force: true });
    } });
    let taskId: string | undefined = undefined;
    let toolSent = false;
    let observed: unknown;
    const waiting = mode.includes("wait-");
    const waitMode = mode.replace(/^draft-/, "");
    let waitArgs: {waitMs?: number; afterRevision?: number} = {};
    context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      assert.equal(input instanceof Request ? input.url : String(input), "http://notice-fixture.invalid/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      const call = taskId !== undefined && !toolSent
        && body.tools?.some((tool: {function: {name: string}}) => tool.function.name === "TaskStatus");
      if (call) {
        assert.ok(body.tools.some((tool: {function: {name: string}}) => tool.function.name === "TaskStatus"), "TaskStatus actually declared to model");
        toolSent = true;
      } else if (taskId !== undefined) {
        const result = body.messages.findLast((message: {role: string; tool_call_id?: string}) =>
          message.role === "tool" && message.tool_call_id === "status-fixture");
        if (result) observed = result;
      }
      const delta = call ? { tool_calls: [{ index: 0, id: "status-fixture", type: "function", function: { name: "TaskStatus", arguments: JSON.stringify({ taskRunId: taskId, ...waitArgs }) } }] } : { content: "Fixture complete" };
      return new Response([{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] }, "[DONE]"].map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const config = configSchema.parse({
      ...defaultConfig, agent: { ...defaultConfig.agent, toolExecutionMode: "direct" }, defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: "http://notice-fixture.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "inert-fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
      extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      checkpoints: { enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
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
    if ((!waiting || mode.startsWith("draft-")) && !["unchanged", "failed-resume"].includes(mode)) {
      current = (await host.runtime.startDraft()).sessionId;
      await run();
      if (mode.startsWith("resume")) { await host.runtime.resumeSession(original); await host.runtime.resumeSession(current); }
      if (mode === "return-original") { await host.runtime.resumeSession(original); current = original; }
    }
    if (mode === "failed-resume") await assert.rejects(host.runtime.resumeSession("missing-fixture-session"));
    const owner = (mode.endsWith("owned") || mode.startsWith("draft-wait")) ? current : original;
    const task = host.commands.taskRuns.create({ taskRunId: "synthetic-status", sessionId: owner, task: { prompt: "Synthetic status evidence", communication: true, notifyParent: false } });
    const attempt = host.commands.taskRuns.createAttempt(task.taskRunId);
    host.commands.taskRuns.transition(task.taskRunId, "queued", { attemptId: attempt.attemptId });
    host.commands.taskRuns.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
    const channel = new TaskCommunication(host.commands.taskRuns, owner);
    channel.send(task.taskRunId, "Owned mailbox marker", "mailbox-fixture");
    channel.close();
    const artifacts = host.commands.taskRuns.get(task.taskRunId)!.attempts.at(-1)!.artifacts as Record<string, unknown>;
    // No worker execution. The public task store holds an inert terminal result.
    if (!waiting) host.commands.taskRuns.transition(task.taskRunId, "completed", { attemptId: attempt.attemptId, artifacts: { ...artifacts, output: "Owned result marker" } });
    if (mode === "cold-resume-owned") {
      await host.runtime.close(); host = undefined;
      host = await open();
      assert.notEqual(host.commands.agent.getInfo().sessionId, current);
      await host.runtime.resumeSession(current);
    }
    assert.equal(host.commands.agent.getInfo().sessionId, current);
    taskId = task.taskRunId;
    if (waiting) {
      waitArgs = { waitMs: waitMode === "wait-timeout" ? 25 : 2000, afterRevision: host.commands.taskRuns.get(taskId)!.revision };
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      const unsubscribe = host.runtime.subscribe(({event}) => { if (event?.type === "tool.started" && event.tool === "TaskStatus") started(); });
      const submitted = host.runtime.submitPrompt("Read synthetic task status.");
      await startedPromise;
      await immediate();
      unsubscribe();
      if (waitMode === "wait-update") {
        host.commands.taskRuns.transition(taskId, "completed", { attemptId: attempt.attemptId, artifacts: { ...artifacts, output: "Owned result marker" } });
        host.commands.taskCommunication!.notify(taskId);
      }
      if (waitMode === "wait-switch") {
        await assert.rejects(host.runtime.startDraft(), /busy|running|active/i);
        await assert.rejects(host.runtime.resumeSession(original), /busy|running|active/i);
        assert.equal(host.commands.agent.getInfo().sessionId, owner);
        host.commands.taskRuns.transition(taskId, "completed", { attemptId: attempt.attemptId, artifacts: { ...artifacts, output: "Owned result marker" } });
        host.commands.taskCommunication!.notify(taskId);
      }
      if (waitMode === "wait-cancel") host.runtime.cancelCurrentRun("cancelled");
      const outcome = await submitted.completion;
      assert.equal(outcome.status, waitMode === "wait-cancel" ? "cancelled" : "completed", JSON.stringify(outcome));
      if (waitMode === "wait-cancel") { assert.equal(host.commands.taskRuns.get(taskId)!.status, "running"); return; }
    } else await run();
    if (mode === "draft-foreign") {
      // 后台模型请求不携带工具结果，不能清空前台请求已捕获的证据。
      await generateNativeText(new ProviderRegistry(config).createModelSettings("fixture").model,
        [{ role: "user", content: "Summarize the fixture conversation." }]);
    }
    assert.ok(toolSent);
    assert.ok(observed, "model received actual TaskStatus result");
    const text = JSON.stringify(observed);
    if (owner === current) { if (waitMode !== "wait-timeout") assert.match(text, /Owned result marker/); assert.match(text, /Owned mailbox marker/); assert.doesNotMatch(text, /belongs to another session/); }
    else { assert.match(text, /belongs to another session/); assert.doesNotMatch(text, /Owned result marker|Owned mailbox marker/); }
    assert.equal(host.commands.taskRuns.get(taskId)?.status, waitMode === "wait-timeout" ? "running" : "completed");
  });
}
