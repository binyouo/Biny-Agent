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
import type { ModelRequestMetrics } from "../src/agent/core/types.js";

// HTTP permits an empty reason phrase; a failed Worker must still report the actual HTTP failure.
for (const response of [
  { name: "blank HTTP reason", statusText: "", contentType: "text/plain", body: "private-response-body-sentinel", reason: "Provider request failed (500)." },
  { name: "nonblank provider message", statusText: "Internal Server Error", contentType: "application/json",
    body: JSON.stringify({ error: { message: "Provider temporarily unavailable.", type: "server_error" } }), reason: "Provider temporarily unavailable." }
]) {
  test(`TaskStatus preserves ${response.name} through a real Worker and read-only reopening`, { timeout: 15_000 }, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-worker-provider-error-"));
    const workspaceRoot = path.join(temporary, "workspace");
    await mkdir(workspaceRoot);
    const previous = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
    let commands: CommandRuntime | undefined;
    let phase: "launch" | "status" = "launch";
    let called = false;
    let taskRunId = "";
    let workerRequests = 0;
    let statusResult: { status?: string; reason?: string } | undefined;
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
          result.writeHead(500, response.statusText, { "content-type": response.contentType, "x-private-fixture": "private-header-sentinel" });
          result.end(response.body);
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
      config.providers = { fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${String(address.port)}/private-url-sentinel/v1`, requiresApiKey: false, retry: { maxAttempts: 1, initialDelayMs: 1000, maxDelayMs: 30000 } } };
      config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
      config.extensions.subagent.enabled = true;
      config.extensions.subagent.maxSteps = 2;
      config.extensions.skills = [];
      config.checkpoints.enabled = false;
      config.heartbeat.enabled = false;
      config.context.memory.enabled = false;
      config.context.identity.enabled = false;
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
      assert.equal(task.status, "failed");
      assert.equal(workerRequests, 1, "the failed request must not start an extra Worker request");
      phase = "status"; called = false;
      const read = await commands.agent.runTask(`Read TaskStatus for ${taskRunId}.`, {
        capabilitySelection: { tools: ["TaskStatus"], skills: "none" }, emotionAnalysis: false
      });
      assert.equal(read.status, "completed", JSON.stringify(serverErrors));
      assert.deepEqual(serverErrors, []);
      assert.equal(statusResult?.status, "failed");
      assert.equal(statusResult?.reason, response.reason);
      const requestMetrics = commands.runtimeAuthority.readEvents({ limit: 1000 }).events
        .filter((event) => event.eventType === "session.model_request")
        .map((event) => (event.payload as { metrics: ModelRequestMetrics }).metrics)
        .filter((metrics) => metrics.requestContext?.operation === "subagent");
      assert.equal(requestMetrics.length, 1);
      assert.equal(requestMetrics[0]?.status, 500);
      assert.equal(requestMetrics[0]?.errorCode, "http_error");
      assert.equal(requestMetrics[0]?.error, response.reason);
      const failure = task.attempts[0]?.failure;
      assert.deepEqual(failure, { message: response.reason });
      assert.doesNotMatch(JSON.stringify({ failure, statusResult, requestMetrics }), /private-(?:response-body|header|url)-sentinel/);
      const sessionId = task.sessionId!;
      await commands.close(); commands = undefined;
      const authority = await RuntimeEventAuthority.openReadOnly(workspaceRoot);
      assert.ok(authority);
      const stored = await DurableTaskRunStore.open(workspaceRoot, authority);
      const channel = new TaskCommunication(stored, sessionId);
      try {
        assert.equal((await channel.inspect(taskRunId)).reason, response.reason);
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
