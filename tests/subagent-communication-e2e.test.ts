import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { TaskRunWithAttempts } from "../src/runtime/TaskRunStore.js";
import type { TaskMessage } from "../src/runtime/TaskCommunication.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

test("parent tools, Host and CLI coordinate an asynchronous Worker through durable messages and results", { timeout: 25_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-subagent-communication-e2e-")));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let cancelRelease!: () => void;
  const cancelGate = new Promise<void>((resolve) => { cancelRelease = resolve; });
  let phase = "launch";
  let acted = false;
  let taskRunId = "";
  let workerRequests = 0;
  let parentRequests = 0;
  const providerErrors: unknown[] = [];
  const provider = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function?: { name?: string }; name?: string }>;
      };
      const system = JSON.stringify(body.messages[0]?.content);
      const names = new Set((body.tools ?? []).map((tool) => tool.function?.name ?? tool.name));
      let result: { text: string } | { name: string; args: Record<string, unknown> };
      if (system.includes("tool search assistant")) result = { text: '{"tools":["Task","TaskMessage","TaskStatus","TaskCancel"]}' };
      else if (system.includes("选择需要的工具") || system.includes("选择需要的技能")) result = { text: '{"tools":[],"skillIds":[]}' };
      else if (system.includes("focused, bounded worker inside Biny")) {
        const messages = JSON.stringify(body.messages);
        if (messages.includes("cancel target")) { await cancelGate; result = { text: "cancel target finished" }; }
        else {
          workerRequests += 1;
          if (workerRequests === 1) {
            assert.match(messages, /preserve original checks/);
            await gate;
            assert.ok(names.has("TaskReport"));
            result = { name: "TaskReport", args: { message: "inspection reached the requested boundary" } };
          } else {
            assert.match(messages, /also inspect src\/b.ts/);
            assert.equal(names.has("TaskMessage"), false, "children cannot target arbitrary sessions");
            result = { text: "corrected result" };
          }
        }
      } else {
        parentRequests += 1;
        const name = phase === "message" ? "TaskMessage" : phase === "result" ? "TaskStatus" : phase === "cancel" ? "TaskCancel" : "Task";
        if (!acted && !names.has(name)) result = { name: "ToolSearch", args: { query: name } };
        else if (!acted) {
          acted = true;
          result = { name, args: name === "Task"
            ? { task: phase === "launch" ? "inspect the assigned files" : "cancel target", background: true, constraints: ["preserve original checks"] }
            : name === "TaskMessage" ? { taskRunId, message: "also inspect src/b.ts" }
            : { taskRunId } };
        } else {
          if (phase === "result") assert.match(JSON.stringify(body.messages), /corrected result/);
          result = { text: `${phase} acknowledged` };
        }
      }
      const frames = "text" in result
        ? [{ choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]
        : [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${phase}-${workerRequests}`, function: { name: result.name, arguments: JSON.stringify(result.args) } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch (error) { providerErrors.push(error); res.writeHead(500); res.end("fixture rejected request"); }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  await saveConfig(root, configSchema.parse({
    ...defaultConfig, defaultModel: "synthetic", checkpoints: { enabled: false },
    chat: { ...defaultConfig.chat, defaultToolSelection: "auto", defaultSkillSelection: "none" },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { synthetic: { ...defaultConfig.models["deepseek-v4-flash"], provider: "local", model: "synthetic", capabilities: { tools: true, reasoning: false, streaming: true } } },
    extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true, maxSteps: 4 } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  }));
  const host = await startRuntimeHost(root, async (resourceRegistry) => await createInteractiveAgentHost(root, { resourceRegistry }));
  const connected = await connectRuntimeHost(root, { surface: "cli", clientId: "parent-client" });
  assert.ok(connected);
  let client = connected;
  const cli = path.resolve("src/cli/index.ts");
  const execFile = promisify(execFileCallback);
  const runCli = async (args: string[]) => await execFile(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "task", ...args, "--json"], { cwd: root, timeout: 10_000 });
  try {
    const sessionId = client.getSnapshot().info.sessionId;
    const launch = await client.submitPrompt("launch independent inspection").completion;
    assert.equal(launch.status, "completed", JSON.stringify(launch));
    assert.match(launch.output!, /launch acknowledged/, "the parent finishes while the child provider is held at the gate");
    const listed = await client.taskList() as { tasks: TaskRunWithAttempts[] };
    assert.equal(listed.tasks.length, 1);
    taskRunId = listed.tasks[0]!.taskRunId;
    assert.equal(listed.tasks[0]!.sessionId, sessionId);
    assert.equal(listed.tasks[0]!.status, "running");
    phase = "message"; acted = false;
    assert.equal((await client.submitPrompt("send the child additional context").completion).status, "completed");
    const queued = await client.taskWait(taskRunId, sessionId) as { task: TaskRunWithAttempts; messages: TaskMessage[] };
    assert.equal(queued.messages.length, 1);
    const message = queued.messages[0]!;
    assert.deepEqual(JSON.parse((await runCli(["message", taskRunId, message.content, "--session", sessionId, "--message-id", message.id])).stdout), message);
    const before = JSON.parse((await runCli(["wait", taskRunId, "--session", sessionId])).stdout) as { task: TaskRunWithAttempts };
    assert.equal(before.task.status, "running");
    await assert.rejects(runCli(["message", taskRunId, "intrusion", "--session", "different-session"]));
    release();
    let current = queued;
    const deadline = Date.now() + 5_000;
    while (current.task.status !== "completed" && Date.now() < deadline) current = await client.taskWait(taskRunId, sessionId, 1000, current.task.revision) as typeof queued;
    assert.equal(current.task.status, "completed", JSON.stringify(current));
    assert.equal((current.task.attempts[0]?.artifacts as { output?: string }).output, "corrected result");
    assert.equal(current.messages.filter((item) => item.direction === "parent").length, 1);
    assert.equal(current.messages[0]?.delivered, true);
    assert.ok(current.messages.some((item) => item.direction === "worker"));
    assert.equal(workerRequests, 2);
    const childEvents = await readSessionEvents(sessionFilePath(root, workerSessionId(current.task.attempts[0]!.attemptId)));
    assert.equal(childEvents.filter((event) => event.type === "user_message" && event.messageId === message.id).length, 1);
    assert.ok(childEvents.some((event) => event.type === "tool_call" && event.tool === "TaskReport"));
    assert.ok(childEvents.some((event) => event.type === "tool_result" && event.tool === "TaskReport"));
    await assert.rejects(client.taskMessage(taskRunId, sessionId, "late correction"), /no longer accepts/);
    phase = "result"; acted = false;
    assert.equal((await client.submitPrompt("read the inspection result").completion).status, "completed");
    await client.close();
    const reconnected = await connectRuntimeHost(root, { surface: "cli", clientId: "reconnected-parent" });
    assert.ok(reconnected); client = reconnected;
    assert.deepEqual((await client.taskWait(taskRunId, sessionId) as typeof queued).messages, current.messages);
    phase = "launch-cancel"; acted = false;
    assert.equal((await client.submitPrompt("launch a cancellable task").completion).status, "completed");
    const after = await client.taskList() as { tasks: TaskRunWithAttempts[] };
    taskRunId = after.tasks.find((task) => task.taskRunId !== current.task.taskRunId)!.taskRunId;
    phase = "cancel"; acted = false;
    assert.equal((await client.submitPrompt("cancel the last task").completion).status, "completed");
    assert.ok(["aborted", "cancelled"].includes((await client.taskGet(taskRunId) as TaskRunWithAttempts).status));
    assert.ok(parentRequests > 0);
    assert.deepEqual(providerErrors, []);
  } finally {
    release(); cancelRelease(); await client.close(); await host.close();
    provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
