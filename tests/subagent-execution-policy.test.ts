import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { runSubagentTask } from "../src/extensions/subagent.js";
import { createToolRegistry, ToolRegistry } from "../src/tools/registry.js";
import { ToolAccesses } from "../src/tools/access.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { saveConfig } from "../src/config/loader.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { SubagentTaskManager } from "../src/runtime/SubagentTaskManager.js";

test("default workers survive elapsed wall time but still cancel and release their queue on close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const config = configSchema.parse({ ...defaultConfig, extensions: { subagent: {} } });
  const manager = new SubagentTaskManager({
    maxConcurrentSubagents: 1,
    timeoutMs: config.extensions.subagent.timeoutMs,
    execute: async (_task, context) => await new Promise<string>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    })
  });
  const running = manager.submit("continue useful work");
  const queued = manager.submit("wait for capacity");
  const results = Promise.allSettled([running.completion, queued.completion]);
  try {
    t.mock.timers.tick(3_600_000);
    assert.equal(manager.getSnapshot(running.taskId)?.status, "running");
    assert.equal(manager.getSnapshot(queued.taskId)?.status, "queued");
    assert.equal(running.deadline, undefined);
    assert.equal(config.extensions.subagent.maxSteps, undefined);
    assert.equal(configSchema.parse({ ...defaultConfig, extensions: { subagent: { maxSteps: 100 } } }).extensions.subagent.maxSteps, 100);
    assert.equal(defaultConfig.extensions.subagent.timeoutMs, undefined);
  } finally { await manager.close(); }
  assert.deepEqual((await results).map((result) => result.status), ["rejected", "rejected"]);
  assert.ok(manager.listSnapshots().every((task) => task.status === "aborted"));
});

test("tool progress keeps a long worker alive while a stalled model request expires", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-idle-"));
  const config = structuredClone(defaultConfig);
  const parent = new AbortController();
  let entered!: (signal: AbortSignal) => void;
  const waiting = new Promise<AbortSignal>(resolve => { entered = resolve; });
  let requests = 0;
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async (_context, options) => {
      requests += 1;
      if (requests === 1) return call("progress", "Bash", { command: "node slow.cjs" });
      const signal = options!.signal!;
      entered(signal);
      return await new Promise<AsyncIterable<ModelStreamEvent>>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  };
  const registry = new ToolRegistry();
  registry.registerBuiltinTool({ name: "Bash", description: "progress fixture", risk: "execute", capability: "shell.execute",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    schema: z.object({ command: z.string() }),
    resolveExecution: () => ({ approvalRule: "progress", accesses: ToolAccesses.none(), execute: async (context) => {
      assert.deepEqual(context.deniedPaths, [".env", ".ssh/"], "the shell boundary receives the parent path policy");
      for (let index = 0; index < 4; index += 1) {
        t.mock.timers.tick(120_000);
        assert.equal(context.signal?.aborted, false);
        context.onUpdate?.({ kind: "progress", text: "still working" });
      }
      return { exitCode: 0 };
    } })
  });
  const completion = runSubagentTask({ workspaceRoot: root, config, toolRegistry: registry,
    getModelSettings: () => ({ model, contextWindow: undefined }) }, "finish a long task", parent.signal, "workspace");
  const settled = completion.then(output => ({ output, error: undefined }), (error: unknown) => ({ output: undefined, error }));
  try {
    const signal = await waiting;
    t.mock.timers.tick(300_001);
    assert.equal(signal.aborted, true, "silence must end the request even without a total task deadline");
    assert.equal(((await settled).error as { stopReason?: string }).stopReason, "inactivity_timeout");
  } finally { parent.abort(new Error("fixture closed")); await settled; await rm(root, { recursive: true, force: true }); }
  t.mock.timers.tick(600_000);
  assert.equal(requests, 2);
});

test("a workspace worker can write and execute an assigned program through the normal command tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-command-"));
  const config = structuredClone(defaultConfig);
  config.permission = { ...config.permission, mode: "full-access", denyPaths: [] };
  let requests = 0;
  const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async (context) => {
      requests += 1;
      if (requests === 1) return call("write", "Write", { path: "hello.cjs", content: 'console.log("Hello, World!");\n' });
      if (requests === 2) return call("run", "Bash", { command: `"${process.execPath}" hello.cjs` });
      const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolCallId === "run");
      assert.match(JSON.stringify(result), /Hello, World!/);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "start" }; yield { type: "text-delta", text: "created and verified hello.cjs" }; yield { type: "finish", reason: "stop" };
      })();
    }
  };
  try {
    const output = await runSubagentTask({ workspaceRoot: root, config,
      toolRegistry: createToolRegistry({ workspaceRoot: root, ignore: [] }, { ...config.web.search, enabled: false }),
      getModelSettings: () => ({ model, contextWindow: undefined })
    }, "create and run hello.cjs", undefined, "workspace", undefined, { taskId: "hello", persistenceRoot: root });
    assert.equal(output, "created and verified hello.cjs");
    assert.equal(await readFile(path.join(root, "hello.cjs"), "utf8"), 'console.log("Hello, World!");\n');
    const events = await readSessionEvents(sessionFilePath(root, workerSessionId("hello")));
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "Bash" && JSON.stringify(event.result).includes("Hello, World!")));
    assert.ok(events.some((event) => event.type === "turn_status" && event.status === "completed"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function* call(id: string, name: string, args: Record<string, unknown>): AsyncGenerator<ModelStreamEvent> {
  yield { type: "start" };
  yield { type: "tool-call", id, name, arguments: args };
  yield { type: "finish", reason: "tool-calls" };
}

for (const [mode, denyPaths, stopReason] of [
  ["full-access", ["blocked.txt"], "permission_denied"],
  ["ask", [], "approval_required"]
] as const) {
  test(`worker ${stopReason} preserves the denied call and stops before another model request or write`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-blocked-"));
    const config = structuredClone(defaultConfig);
    config.permission = { ...config.permission, mode, denyPaths: [...denyPaths] };
    let requests = 0;
    const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
      stream: async () => {
        requests += 1;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "start" };
          if (requests === 1) {
            yield { type: "tool-call", id: "blocked-write", name: "Write", arguments: { path: "blocked.txt", content: "must not be written" } };
            yield { type: "tool-call", id: "later-write", name: "Write", arguments: { path: "later.txt", content: "must not start after blocker" } };
            yield { type: "finish", reason: "tool-calls" };
          } else { yield { type: "text-delta", text: "incorrect success" }; yield { type: "finish", reason: "stop" }; }
        })();
      }
    };
    try {
      await assert.rejects(runSubagentTask({ workspaceRoot: root, config,
        toolRegistry: createToolRegistry({ workspaceRoot: root, ignore: [] }, { ...config.web.search, enabled: false }),
        getModelSettings: () => ({ model, contextWindow: undefined })
      }, "write a file", undefined, "workspace", undefined, { taskId: "blocked", persistenceRoot: root }),
      new RegExp(`stopReason=${stopReason}`));
      assert.equal(requests, 1, "a policy block must not become a model retry loop");
      await assert.rejects(access(path.join(root, "blocked.txt")));
      await assert.rejects(access(path.join(root, "later.txt")));
      const events = await readSessionEvents(sessionFilePath(root, workerSessionId("blocked")));
      assert.ok(events.some((event) => event.type === "tool_result" && event.toolCallId === "blocked-write" && event.executionStatus === "failed"));
      assert.equal(events.some((event) => event.type === "tool_execution" && event.state === "running"), false);
      assert.equal(events.some((event) => event.type === "turn_status" && event.status === "completed"), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("TaskRun uses the live parent permission mode and persists a blocker without retaining an active worker", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-parent-policy-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let modelEntered!: () => void;
  const modelStarted = new Promise<void>(resolve => { modelEntered = resolve; });
  let releaseModel!: () => void;
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) { modelEntered(); await modelGate; }
    const delta = requests === 1
      ? { tool_calls: [{ index: 0, id: "blocked-write", function: { name: "Write", arguments: JSON.stringify({ path: "blocked.txt", content: "not authorized" }) } }] }
      : { content: "incorrect completion" };
    return new Response([
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }] }
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic";
  config.providers = { local: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "synthetic", capabilities: { tools: true, reasoning: false, streaming: true } } };
  config.extensions.subagent.enabled = true;
  config.checkpoints.enabled = false;
  config.heartbeat.enabled = false;
  config.context.memory.enabled = false;
  config.context.identity.enabled = false;
  await saveConfig(root, config);
  const runtime = await createCommandRuntime(root);
  try {
    const task = runtime.taskRuns.create({ sessionId: runtime.agent.getInfo().sessionId, task: { prompt: "write the assigned file", communication: true } });
    let firstFailureClass: unknown;
    runtime.subagents!.subscribe(snapshot => {
      if (snapshot.status === "incomplete") firstFailureClass = (runtime.taskRuns.get(task.taskRunId)?.attempts.at(-1)?.failure as { failureClass?: string })?.failureClass;
    });
    const started = await runtime.startTaskRun(task.taskRunId);
    await modelStarted;
    await runtime.agent.setPermissionMode("ask");
    releaseModel();
    await assert.rejects(started.completion, /stopReason=approval_required/);
    assert.equal(runtime.taskRuns.get(task.taskRunId)?.status, "incomplete");
    assert.equal(firstFailureClass, "approval_required", "the first persisted terminal notification must include the reason");
    const inspection = await runtime.taskCommunication!.inspect(task.taskRunId);
    assert.equal(inspection.stopReason, "approval_required");
    assert.equal(requests, 1);
    await assert.rejects(access(path.join(root, "blocked.txt")));
    assert.equal(runtime.hasBackgroundWork(), false);
    assert.ok(runtime.subagents!.listSnapshots().every(task => task.status === "incomplete"));
  } finally { releaseModel(); await runtime.close(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
