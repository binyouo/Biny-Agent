import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

const taskRunId = "recoverable-child";
const sessionId = "parent-session";

if (process.argv[2] === "crash-initial" || process.argv[2] === "crash-resumed") {
  await crashWorker(process.argv[3]!, process.argv[2] === "crash-resumed");
} else {
  // A single restart cannot reveal whether continuation erased its own durable admission.
  test("a twice-interrupted child keeps its admitted communication and delivers its report and result once", { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-repeat-recovery-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    let commands: CommandRuntime | undefined;
    let requests = 0;
    const fetch = t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> };
      assert.ok(body.tools.some(tool => tool.function.name === "TaskReport"));
      assert.equal(body.messages.filter(message => message.role === "user" && String(message.content).includes("retain the original finding")).length, 1);
      assert.ok(body.messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes("finding before interruption")));
      return stream({ content: "final result after two interruptions" }, "stop");
    });
    try {
      const initial = await killAtRequest(root, "crash-initial");
      const continued = await killAtRequest(root, "crash-resumed");
      assert.equal(continued.attemptId, initial.attemptId);
      commands = await createCommandRuntime(root, { sessionId, configStore: configStore() });
      const resumed = await commands.resumeTaskRun(taskRunId);
      const result = await resumed.completion;
      assert.equal(result.status, "completed");
      assert.deepEqual(continued.workerExecution, initial.workerExecution, "each continuation retains the complete original admission");
      assert.equal(result.output, "final result after two interruptions");
      assert.equal(requests, 1, "explicit recovery issues only the outstanding model request");
      const task = commands.taskRuns.get(taskRunId)!;
      assert.equal(task.status, "completed");
      assert.equal(task.attempts.length, 1);
      assert.equal(task.attempts[0]!.attemptId, initial.attemptId);
      const events = await readSessionEvents(sessionFilePath(root, workerSessionId(initial.attemptId)));
      assert.equal(events.filter(event => event.type === "tool_call" && event.tool === "TaskReport").length, 1);
      assert.equal(events.filter(event => event.type === "tool_result" && event.tool === "TaskReport").length, 1);
      assert.equal(events.filter(event => event.type === "user_message" && event.messageId === "parent-correction").length, 1);
      const notices = commands.taskCommunication!.notifications();
      assert.equal(notices.length, 2);
      assert.match(notices[0]!.content, /finding before interruption/u);
      assert.match(notices[1]!.content, /final result after two interruptions/u);
      for (const notice of notices) commands.taskCommunication!.acknowledge(notice);
      await commands.close();
      commands = await createCommandRuntime(root, { sessionId, configStore: configStore() });
      assert.deepEqual(commands.taskCommunication!.notifications(), [], "reconnection cannot redeliver acknowledged output");
      assert.equal(commands.taskRuns.get(taskRunId)?.status, "completed");
      assert.equal(requests, 1, "reading a reconnected child never dispatches it");
    } finally {
      await commands?.close();
      fetch.mock.restore();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function crashWorker(root: string, resumed: boolean): Promise<void> {
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
    requests += 1;
    if (!resumed && requests === 1) {
      commands.taskCommunication!.send(taskRunId, "retain the original finding", "parent-correction");
      return stream({ tool_calls: [{ index: 0, id: "report-once", function: { name: "TaskReport", arguments: JSON.stringify({ message: "finding before interruption" }) } }] }, "tool_calls");
    }
    assert.match(JSON.stringify(body.messages), /finding before interruption/u);
    assert.match(JSON.stringify(body.messages), /retain the original finding/u);
    const attempt = commands.taskRuns.get(taskRunId)!.attempts.at(-1)!;
    process.send?.({ attemptId: attempt.attemptId, workerExecution: (attempt.artifacts as { workerExecution: unknown }).workerExecution });
    return await new Promise<Response>(() => undefined);
  };
  const commands = await createCommandRuntime(root, { sessionId, configStore: configStore() });
  if (!resumed) commands.taskRuns.create({ taskRunId, sessionId, task: { prompt: "inspect the assigned files", communication: true, notifyParent: true } });
  const started = resumed ? await commands.resumeTaskRun(taskRunId) : await commands.startTaskRun(taskRunId);
  await started.completion;
  throw new Error("The fixture must be killed while its fake provider is awaiting a response.");
}

interface WorkerBoundary { attemptId: string; workerExecution: unknown }

async function killAtRequest(root: string, mode: string): Promise<WorkerBoundary> {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), mode, root], {
    env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let stderr = "";
  child.stderr?.on("data", (value: Buffer) => { stderr += value.toString(); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<WorkerBoundary>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Worker did not reach its request boundary: ${stderr}`)), 10_000);
      child.once("message", (message: WorkerBoundary) => resolve(message));
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Worker exited before its request boundary: ${stderr}`)));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}

function configStore() {
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic";
  config.toolModel = "synthetic";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false, retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 } } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic", capabilities: { tools: true, reasoning: false, streaming: true } } };
  config.checkpoints.enabled = false;
  config.extensions.subagent.enabled = true;
  config.extensions.subagent.allowedTools = [];
  config.extensions.subagent.maxSteps = 6;
  config.heartbeat.enabled = false;
  config.context.memory.enabled = false;
  config.context.identity.enabled = false;
  return { load: async () => structuredClone(config), save: async () => undefined };
}

function stream(delta: unknown, finishReason: string): Response {
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }, "[DONE]"
  ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
