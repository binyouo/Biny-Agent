import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { runSubagentTask } from "../src/extensions/subagent.js";
import { createModelSettings } from "../src/llm/modelFactory.js";
import { SubagentTaskIncompleteError } from "../src/runtime/SubagentTaskManager.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import type { ModelRequestMetrics } from "../src/agent/core/types.js";

const partial = "I checked the first part; the remaining result is";
const diagnostic = "The upstream response failed after partial output.";
for (const response of [
  { name: "normal stop", finish: "stop", stopReason: undefined, status: "completed", reason: undefined },
  { name: "output limit", finish: "length", stopReason: "length", status: "incomplete", reason: `Subagent did not complete (stopReason=length).\n\n${partial}` },
  { name: "provider error", finish: "error", stopReason: undefined, status: "failed", reason: diagnostic },
  { name: "content filter", finish: "content_filter", stopReason: "other", status: "incomplete", reason: `Subagent did not complete (stopReason=other).\n\n${partial}` },
  { name: "early EOF", finish: undefined, stopReason: "other", status: "incomplete", reason: `Subagent did not complete (stopReason=other).\n\n${partial}` }
]) {
  test(`TaskStatus reports ${response.name} after partial text through a real Worker and read-only reopening`, { timeout: 15_000 }, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-partial-response-"));
    const workspaceRoot = path.join(temporary, "workspace");
    await mkdir(workspaceRoot);
    const previous = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
    let commands: CommandRuntime | undefined;
    let phase: "launch" | "status" = "launch";
    let called = false;
    let taskRunId = "";
    let workerRequests = 0;
    let statusResult: { status?: string; reason?: string; output?: string } | undefined;
    const serverErrors: unknown[] = [];
    const provider = http.createServer(async (request, result) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
          tools?: Array<{ function?: { name?: string } }>;
        };
        if (JSON.stringify(body.messages[0]?.content).includes("focused, bounded worker inside Biny")) {
          workerRequests += 1;
          result.writeHead(200, { "content-type": "text/event-stream" });
          result.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: partial }, finish_reason: null }] })}\n\n`);
          if (response.finish === "error") {
            result.write(`data: ${JSON.stringify({ error: { message: diagnostic, type: "server_error" } })}\n\n`);
          } else if (response.finish !== undefined) {
            result.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: response.finish }] })}\n\n`);
          }
          result.end(response.finish === undefined ? undefined : "data: [DONE]\n\n");
          return;
        }
        const name = phase === "launch" ? "Task" : "TaskStatus";
        assert.ok(body.tools?.some((tool) => tool.function?.name === name));
        let frames: unknown[];
        if (!called) {
          called = true;
          frames = [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${phase}`, function: { name,
              arguments: JSON.stringify(phase === "launch" ? { task: "Read the supplied context and report.", background: false } : { taskRunId }) } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
          ];
        } else {
          if (phase === "status") {
            const toolResult = [...body.messages].reverse().find((message) => message.role === "tool" && message.tool_call_id === "call-status");
            assert.ok(toolResult && typeof toolResult.content === "string");
            statusResult = JSON.parse(toolResult.content as string) as typeof statusResult;
          }
          frames = [{ choices: [{ index: 0, delta: { content: "Recorded the task outcome." }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
        }
        result.writeHead(200, { "content-type": "text/event-stream" });
        result.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
      } catch (error) { serverErrors.push(error); result.writeHead(500); result.end("fixture rejected request"); }
    });
    try {
      await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
      const address = provider.address();
      assert.ok(address && typeof address !== "string");
      const config = structuredClone(defaultConfig);
      config.defaultModel = "synthetic";
      config.toolModel = "synthetic";
      config.providers = { fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, requiresApiKey: false, retry: { maxAttempts: 1, initialDelayMs: 1000, maxDelayMs: 30000 } } };
      config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
      config.extensions.subagent.enabled = true;
      config.extensions.subagent.maxSteps = 2;
      config.extensions.skills = [];
      config.checkpoints.enabled = false;
      config.heartbeat.enabled = false;
      config.context.memory.enabled = false;
      config.context.identity.enabled = false;
      config.crystal.passiveEnabled = false;
      config.crystal.semanticScanEnabled = false;
      commands = await createCommandRuntime(workspaceRoot, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
      const launched = await commands.agent.runTask("Delegate the bounded read-only task.", {
        capabilitySelection: { tools: ["Task"], skills: "none" }, emotionAnalysis: false,
        confirmPermission: async () => ({ approved: true, action: "allow_once", scope: "once", confirmation: "yes" })
      });
      assert.equal(launched.status, "completed", JSON.stringify(serverErrors));
      const tasks = commands.taskRuns.list().tasks;
      assert.equal(tasks.length, 1);
      const task = tasks[0]!;
      taskRunId = task.taskRunId;
      assert.equal(task.status, response.status, JSON.stringify(task));
      assert.equal(workerRequests, 1, "the failed request must not start an extra Worker request");
      phase = "status"; called = false;
      const read = await commands.agent.runTask(`Read TaskStatus for ${taskRunId}.`, {
        capabilitySelection: { tools: ["TaskStatus"], skills: "none" }, emotionAnalysis: false
      });
      assert.equal(read.status, "completed", JSON.stringify(serverErrors));
      assert.deepEqual(serverErrors, []);
      assert.equal(statusResult?.status, response.status);
      assert.equal(statusResult?.reason, response.reason);
      assert.equal(statusResult?.output, response.status === "completed" ? partial : undefined);
      const requestMetrics = commands.runtimeAuthority.readEvents({ limit: 1000 }).events
        .filter((event) => event.eventType === "session.model_request")
        .map((event) => (event.payload as { metrics: ModelRequestMetrics }).metrics)
        .filter((metrics) => metrics.requestContext?.operation === "subagent");
      assert.equal(requestMetrics.length, 1);
      const failure = task.attempts[0]?.failure;
      assert.deepEqual(failure, response.reason === undefined ? undefined : response.stopReason === undefined
        ? { message: response.reason } : { message: response.reason, failureClass: response.stopReason });
      assert.equal(task.attempts.length, 1);
      const sessionId = task.sessionId!;
      await commands.close(); commands = undefined;
      const authority = await RuntimeEventAuthority.openReadOnly(workspaceRoot);
      assert.ok(authority);
      const stored = await DurableTaskRunStore.open(workspaceRoot, authority);
      const channel = new TaskCommunication(stored, sessionId);
      try {
        assert.equal((await channel.inspect(taskRunId)).status, response.status);
        assert.equal((await channel.inspect(taskRunId)).reason, response.reason);
        assert.equal((await channel.inspect(taskRunId)).stopReason, response.stopReason);
        assert.deepEqual(stored.get(taskRunId)?.attempts[0]?.failure, failure);
      } finally { channel.close(); stored.close(); authority.close(); }
    } finally {
      await commands?.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

for (const finish of ["stop", "length", "content_filter", undefined]) {
  test(`cold Worker handoff preserves ${finish ?? "early EOF"} without another provider request`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-partial-handoff-"));
    const previous = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    let requests = 0;
    const provider = http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: partial }, finish_reason: null }] })}\n\n`);
      if (finish !== undefined) response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })}\n\n`);
      response.end(finish === undefined ? undefined : "data: [DONE]\n\n");
    });
    try {
      await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
      const address = provider.address();
      assert.ok(address && typeof address !== "string");
      const config = structuredClone(defaultConfig);
      config.defaultModel = "synthetic";
      config.providers = { fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, requiresApiKey: false, retry: { maxAttempts: 1, initialDelayMs: 1000, maxDelayMs: 30000 } } };
      config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
      config.extensions.subagent.allowedTools = [];
      config.extensions.subagent.maxSteps = 2;
      const options = { workspaceRoot: root, config, toolRegistry: new ToolRegistry(), getModelSettings: () => createModelSettings(config),
        onUsage: async () => { if (finish === "stop") throw new Error("Usage observer unavailable after the final step."); }
      };
      const execution = { taskId: "partial-handoff", persistenceRoot: root };
      const run = () => runSubagentTask(options, "inspect", undefined, "read-only", undefined, execution);
      if (finish === "stop") await assert.rejects(run(), /Usage observer unavailable/);
      else await assert.rejects(run(), SubagentTaskIncompleteError);
      const turns = new TurnStore(root, workerSessionId(execution.taskId));
      const saved = await turns.load();
      assert.ok(saved);
      assert.equal(saved.messages.at(-1)?.role, "assistant");
      assert.equal((saved.facts as { status?: string }).status, "running");
      const before = await readSessionEvents(sessionFilePath(root, workerSessionId(execution.taskId)));
      assert.equal(before.some((event) => event.type === "turn_status" && event.status === "completed"), false);
      const resumed = runSubagentTask(options, "inspect", undefined, "read-only", undefined, { ...execution, resume: true });
      if (finish === "stop") assert.equal(await resumed, partial);
      else await assert.rejects(resumed, (error: unknown) => {
        assert.ok(error instanceof SubagentTaskIncompleteError);
        assert.match(error.message, /did not complete/);
        assert.ok(error.message.includes(partial));
        return true;
      });
      assert.equal(requests, 1, "recovering the stored terminal result must not replay a model request");
      const events = await readSessionEvents(sessionFilePath(root, workerSessionId(execution.taskId)));
      assert.equal(events.some((event) => event.type === "turn_status" && event.status === "completed"), finish === "stop");
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
