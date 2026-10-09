import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixtureCleanup } from "./helpers/fixture-cleanup.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { TaskRunWithAttempts } from "../src/runtime/TaskRunStore.js";
import type { TaskMessage } from "../src/runtime/TaskCommunication.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

test("foreground Task admits an Attempt and records scoped Worker reports and execution events", { timeout: 25_000 }, async (t) => {
  let cancelRelease!: () => void;
  const cancelGate = new Promise<void>((resolve) => { cancelRelease = resolve; });
  t.after(() => { cancelRelease(); });
  const cleanup = fixtureCleanup(t);
  let root = await mkdtemp(path.join(os.tmpdir(), "biny-subagent-communication-e2e-"));
  cleanup(async () => { await rm(root, { recursive: true, force: true }); });
  root = await realpath(root);
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  // 工作区参数不决定全局配置位置；直接运行也必须隔离配置、Host 和派生 CLI。
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  cleanup(() => {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
  });
  const phase = "launch";
  let acted = false;
  const taskRunId = "";
  let workerRequests = 0;
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

            assert.ok(names.has("TaskReport"));
            result = { name: "TaskReport", args: { message: "inspection reached the requested boundary" } };
          } else {

            assert.equal(names.has("TaskMessage"), false, "children cannot target arbitrary sessions");
            result = { text: "corrected result" };
          }
        }
      } else {
        const name = phase === "message" ? "TaskMessage" : phase === "result" ? "TaskStatus" : phase === "cancel" ? "TaskCancel" : "Task";
        if (!acted && !names.has(name)) result = { name: "ToolSearch", args: { query: name } };
        else if (!acted) {
          acted = true;
          result = { name, args: name === "Task"
            ? { task: phase === "launch" ? "inspect the assigned files" : "cancel target", name: "检查数据 / α", description: "查设置页加载慢问题", background: false, constraints: ["preserve original checks"] }
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
  cleanup(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
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
  cleanup(async () => { await host.close(); });
  const connected = await connectRuntimeHost(root, { surface: "cli", clientId: "parent-client" });
  assert.ok(connected);
  const client = connected;
  cleanup(async () => { await client.close(); });
  const sessionId = client.getSnapshot().info.sessionId;
  const launch = await client.submitPrompt("launch independent inspection").completion;
  assert.equal(launch.status, "completed", JSON.stringify(launch));
  const listed = await client.taskList() as { tasks: TaskRunWithAttempts[] };
  assert.equal(listed.tasks.length, 1);
  const current = listed.tasks[0]!;
  assert.equal(current.sessionId, sessionId);
  assert.equal(current.status, "completed");
  const inspected = await client.taskInspect(current.taskRunId, sessionId);
  assert.deepEqual(inspected.activity.findLast(entry => entry.kind === "model")?.model, { provider: "openai-compatible", id: "synthetic" }, "the worker model comes from its persisted request, not the parent selection");
  assert.equal(inspected.name, "检查数据 / α", "display names survive persistence without selecting a named agent role");
  assert.equal(inspected.description, "查设置页加载慢问题", "the short task description survives Task admission and inspection independently of the worker name");
  assert.equal(current.attempts.length, 1);
  const messages = (current.attempts[0]?.artifacts as { communication?: { messages: TaskMessage[] } }).communication?.messages ?? [];
  assert.ok(messages.some((item) => item.direction === "worker"), "foreground worker report is persisted");
  const childEvents = await readSessionEvents(sessionFilePath(root, workerSessionId(current.attempts[0]!.attemptId)));
  assert.ok(childEvents.some((event) => event.type === "tool_call" && event.tool === "TaskReport"));
  assert.ok(childEvents.some((event) => event.type === "tool_result" && event.tool === "TaskReport"));
  assert.equal(workerRequests, 2);
  const parentEvents = await readSessionEvents(sessionFilePath(root, sessionId));
  assert.equal(parentEvents.filter((event) => event.type === "user_message" && event.metadata?.source === "subagent").length, 1, "foreground explicit reports arrive once without a duplicate completion notification");
  assert.deepEqual(providerErrors, []);
});
