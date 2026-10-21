import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost, InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { sessionFilePath } from "../src/session/store.js";
import { readSessionEvents } from "../src/session/events.js";
for (const mode of ["unchanged", "draft-foreign", "resume-foreign", "return-original", "draft-owned", "cold-resume-owned", "failed-resume", "wrong-ack", "no-notices"] as const) {
  test(`child notice current session ownership: ${mode}`, { timeout: 30000 }, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-child-notice-"));
    const old = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    const cleanup: { runtime?: CommandRuntime; interactive?: InteractiveAgentRuntime } = {};
    context.after(async () => {
      try {
        if (cleanup.interactive) await cleanup.interactive.close();
        else await cleanup.runtime?.close();
      } finally {
        context.mock.restoreAll();
        if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      assert.equal(input instanceof Request ? input.url : String(input), "http://notice-fixture.invalid/v1/chat/completions");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response([{ choices: [{ index: 0, delta: { content: "Fixture complete" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"].map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const config = configSchema.parse({
      ...defaultConfig, defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: "http://notice-fixture.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "inert-fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      checkpoints: { enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      activity: { ...defaultConfig.activity, enabled: false },
      context: { ...defaultConfig.context, identity: { enabled: false, userEnabled: false }, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });

    let runtime = await createCommandRuntime(root, { configStore: { load: async () => config, save: async () => undefined } });
    cleanup.runtime = runtime;
    let interactive = new InteractiveAgentRuntime(runtime);
    cleanup.interactive = interactive;
    const run = async () => {
      const result = await interactive.submitPrompt("Complete this inert fixture turn.").completion;
      assert.equal(result.status, "completed", JSON.stringify(result));
    };
    const original = runtime.agent.getInfo().sessionId;
    await run(); // Persist A so that completed resume has a real public history.
    let current = original;
    const originalChannel = new TaskCommunication(runtime.taskRuns, original);
    // Keep a real A-owned worker closure alive across a completed session switch.
    const oldWorker = mode === "draft-foreign" || mode === "resume-foreign" ? (() => {
      const task = runtime.taskRuns.create({ taskRunId: "synthetic-child", sessionId: original,
        task: { prompt: "inert owned task", communication: true, notifyParent: false } });
      const attempt = runtime.taskRuns.createAttempt(task.taskRunId);
      runtime.taskRuns.transition(task.taskRunId, "queued", { attemptId: attempt.attemptId });
      runtime.taskRuns.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
      return originalChannel.worker(task.taskRunId, attempt.attemptId);
    })() : undefined;
    if (mode !== "unchanged" && mode !== "no-notices" && mode !== "failed-resume" && mode !== "wrong-ack") {
      current = (await interactive.startDraft()).sessionId;
      await run(); // Persist B before injecting any child report.
      if (mode === "resume-foreign") {
        await interactive.resumeSession(original);
        await interactive.resumeSession(current);
      }
      if (mode === "return-original") {
        await interactive.resumeSession(original);
        current = original;
      }

    }
    if (mode === "failed-resume") await assert.rejects(interactive.resumeSession("missing-fixture-session"));
    assert.equal(runtime.agent.getInfo().sessionId, current);
    const owner = mode === "draft-owned" || mode === "cold-resume-owned" ? current : original;
    const channel = new TaskCommunication(runtime.taskRuns, owner);
    const marker = "Synthetic child report for its actual owner";
    let reportId: string | undefined;
    if (oldWorker) {
      reportId = oldWorker.report(marker, "report-one").id;
      assert.equal(runtime.taskRuns.hasMessageReceipt("synthetic-child", reportId), false);
    } else if (mode !== "no-notices") {
      const task = runtime.taskRuns.create({ taskRunId: "synthetic-child", sessionId: owner,
        task: { prompt: "inert owned task", communication: true, notifyParent: false } });
      const attempt = runtime.taskRuns.createAttempt(task.taskRunId);
      runtime.taskRuns.transition(task.taskRunId, "queued", { attemptId: attempt.attemptId });
      runtime.taskRuns.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
      reportId = channel.worker(task.taskRunId, attempt.attemptId).report(marker, "report-one").id;
      assert.equal(runtime.taskRuns.hasMessageReceipt(task.taskRunId, reportId), false);
    }
    if (mode === "cold-resume-owned") {
      channel.close();
      await interactive.close();
      cleanup.interactive = undefined;
      cleanup.runtime = undefined;
      // Same public construction/resume sequence used for saved-session Host factories.
      // Do not start a Host server or invoke its socket transport.
      const host = await createInteractiveAgentHost(root, {
        persistenceRoot: root,
        configStore: { load: async () => config, save: async () => undefined }
      });
      runtime = host.commands;
      interactive = host.runtime;
      cleanup.runtime = runtime;
      cleanup.interactive = interactive;
      assert.notEqual(runtime.agent.getInfo().sessionId, current);
      await interactive.resumeSession(current);
      assert.equal(runtime.agent.getInfo().sessionId, current);
      assert.equal(runtime.taskRuns.hasMessageReceipt("synthetic-child", reportId!), false);
    }
    if (mode === "wrong-ack") {
      const notice = channel.notifications()[0];
      assert.ok(notice);
      assert.throws(() => channel.acknowledge(notice, "not-the-owner"), /another session/);
      assert.equal(runtime.taskRuns.hasMessageReceipt("synthetic-child", reportId!), false);
    }
    bodies.length = 0;
    await run();
    const events = await readSessionEvents(sessionFilePath(root, current));
    const notices = events.filter(event => event.type === "user_message" && event.metadata?.source === "subagent");
    const expectedDelivery = reportId !== undefined && owner === current;
    const observed = {
      noticeCount: notices.length,
      containsMarker: notices.some(event => event.type === "user_message" && event.content.includes(marker)),
      receipt: reportId === undefined ? false : runtime.taskRuns.hasMessageReceipt("synthetic-child", reportId),
      providerSawMarker: bodies.some(body => JSON.stringify(body.messages).includes(marker))
    };
    assert.deepEqual(observed, {
      noticeCount: expectedDelivery ? 1 : 0,
      containsMarker: expectedDelivery,
      receipt: expectedDelivery,
      providerSawMarker: expectedDelivery
    }, "only current-session child reports may enter the model/history and be acknowledged");
    if (reportId !== undefined && owner !== current) {
      await interactive.resumeSession(owner);
      await run();
      const ownerEvents = await readSessionEvents(sessionFilePath(root, owner));
      assert.equal(ownerEvents.filter(event => event.type === "user_message" && event.messageId === reportId).length, 1);
      assert.equal(runtime.taskRuns.hasMessageReceipt("synthetic-child", reportId), true);
    }
    await run();
    const afterRepeat = await readSessionEvents(sessionFilePath(root, runtime.agent.getInfo().sessionId));
    assert.equal(afterRepeat.filter(event => event.type === "user_message" && event.messageId === reportId).length, reportId ? 1 : 0,
      "repeat turns must not redeliver an acknowledged report");
    channel.close();
    originalChannel.close();
  });
}
