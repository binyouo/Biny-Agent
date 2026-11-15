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
import { replaySession } from "../src/session/replay.js";
import { readSessionEvents } from "../src/session/events.js";
for (const mode of ["warm", "cold", "batch-warm", "batch-cold", "compacted", "branch", "terminal", "switch-session"] as const) {
  test(`durable notice receipt failure: ${mode}`, { timeout: 30000 }, async context => {
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
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const output = JSON.stringify(body.messages).includes("durable context checkpoint") ? checkpointText() : "Fixture complete";
      return new Response([{ choices: [{ index: 0, delta: { content: output }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"].map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const config = configSchema.parse({
      ...defaultConfig, defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: "http://notice-fixture.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "inert-fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false },
      checkpoints: { enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      activity: { ...defaultConfig.activity, enabled: false },
      context: { ...defaultConfig.context, compaction: { ...defaultConfig.context.compaction, enabled: false, keepRecentMessages: 2, keepRecentTokens: 2000 }, identity: { enabled: false, userEnabled: false }, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
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
    const sessionId = runtime.agent.getInfo().sessionId;
    const file = sessionFilePath(root, sessionId);
    const excluded = "INACTIVE_HISTORY_SENTINEL";
    await run();
    if (mode === "compacted") {
      await interactive.submitPrompt(excluded).completion;
      await run();
      await interactive.compactConversation();
      assert.ok((await replaySession(file)).contextCheckpoint);
    }
    if (mode === "branch") {
      const originalAnswer = (await replaySession(file)).messageTree.at(-1)!;
      for await (const _event of runtime.agent.retry(originalAnswer.id)) { /* drain public retry */ }
      const replacement = (await replaySession(file)).messageTree.at(-1)!;
      await interactive.submitPrompt(excluded).completion;
      await interactive.switchMessageVersion(replacement.id, "prev");
    }
    if (mode === "branch" || mode === "compacted") {
      bodies.length = 0;
      await run();
      assert.ok(!bodies.some(body => JSON.stringify(body.messages).includes(excluded)), "precondition: obsolete context is absent before persistence failure");
    }
    const channel = new TaskCommunication(runtime.taskRuns, sessionId);
    const task = runtime.taskRuns.create({ taskRunId: "synthetic-child", sessionId,
      task: { prompt: "inert owned task", communication: true, notifyParent: mode === "terminal" } });
    const attempt = runtime.taskRuns.createAttempt(task.taskRunId);
    runtime.taskRuns.transition(task.taskRunId, "queued", { attemptId: attempt.attemptId });
    runtime.taskRuns.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
    const reports = mode === "terminal" ? [] : mode.startsWith("batch") ? ["First durable child report", "Second durable child report"] : ["Durable child report"];
    const reportIds = reports.map((report, index) => channel.worker(task.taskRunId, attempt.attemptId).report(report, `report-${index}`).id);
    if (mode === "terminal") {
      runtime.taskRuns.transition(task.taskRunId, "completed", { attemptId: attempt.attemptId, artifacts: { output: "Terminal child result" } });
      const terminal = channel.notifications().find(notice => notice.terminal);
      assert.ok(terminal);
      reports.push("Terminal child result");
      reportIds.push(terminal.id);
    }
    const failingId = reportIds.at(-1)!;
    const database = runtime.runtimeAuthority.databaseHandle();
    database.exec(`CREATE TEMP TRIGGER notice_receipt_failure BEFORE INSERT ON task_events
      WHEN NEW.event_type = 'task.message.received' AND json_extract(NEW.payload_json, '$.messageId') = '${failingId}'
      BEGIN SELECT RAISE(ABORT, 'injected receipt persistence unavailable'); END;`);
    bodies.length = 0;
    const failed = await interactive.submitPrompt("Persist reports before acknowledgement failure.").completion;
    assert.notEqual(failed.status, "completed");
    assert.match(JSON.stringify(failed), /injected receipt persistence unavailable/);
    for (const report of reports) assert.ok(!bodies.some(body => JSON.stringify(body.messages).includes(report)), "no report has reached the provider before the failed batch returns");
    assert.equal(runtime.taskRuns.hasMessageReceipt(task.taskRunId, failingId), false);
    if (reportIds.length > 1) assert.equal(runtime.taskRuns.hasMessageReceipt(task.taskRunId, reportIds[0]!), true, "earlier batch member is already acknowledged");
    for (const id of reportIds) assert.equal((await readSessionEvents(file)).filter(event => event.type === "user_message" && event.messageId === id).length, 1);
    if (mode === "warm" || mode === "batch-warm") {
      const repeatedFailure = await interactive.submitPrompt("Retry while receipt storage is still unavailable.").completion;
      assert.notEqual(repeatedFailure.status, "completed");
      assert.match(JSON.stringify(repeatedFailure), /injected receipt persistence unavailable/);
    }
    database.exec("DROP TRIGGER notice_receipt_failure");
    if (mode.endsWith("cold")) {
      await interactive.close();
      cleanup.interactive = undefined;
      cleanup.runtime = undefined;
      const host = await createInteractiveAgentHost(root, { persistenceRoot: root, configStore: { load: async () => config, save: async () => undefined } });
      runtime = host.commands;
      interactive = host.runtime;
      cleanup.runtime = runtime;
      cleanup.interactive = interactive;
      await interactive.resumeSession(sessionId);
    }
    if (mode === "switch-session") {
      await interactive.startDraft();
      bodies.length = 0;
      await run();
      for (const report of reports) assert.ok(!bodies.some(body => JSON.stringify(body.messages).includes(report)), "failed delivery cannot leak into a new session");
      assert.equal(runtime.taskRuns.hasMessageReceipt(task.taskRunId, failingId), false);
      await interactive.resumeSession(sessionId);
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      bodies.length = 0;
      await run();
      for (const [index, report] of reports.entries()) {
        assert.ok(bodies.some(body => JSON.stringify(body.messages).includes(report)), "durable report must remain in restored model context");
        for (const body of bodies) assert.equal(JSON.stringify(body.messages).split(report).length - 1, 1, "report appears once per request, not reinjected twice");
        assert.equal(runtime.taskRuns.hasMessageReceipt(task.taskRunId, reportIds[index]!), true);
        assert.equal((await readSessionEvents(file)).filter(event => event.type === "user_message" && event.messageId === reportIds[index]).length, 1);
      }
      assert.ok(!bodies.some(body => JSON.stringify(body.messages).includes(excluded)), "failure recovery must not resurrect discarded context");
    }
    channel.close();
  });
}

function checkpointText(): string {
  return [
    "## Goal", "- Preserve the request. <!-- evidence:m0 -->",
    "## Constraints & Preferences", "- (none recorded)",
    "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
    "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
    "## All User Messages", "- Preserve the request. <!-- evidence:m0 -->",
    "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"
  ].join("\n");
}
