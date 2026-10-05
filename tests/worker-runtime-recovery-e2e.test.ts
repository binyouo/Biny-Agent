import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost, connectRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { createModelSettings } from "../src/llm/modelFactory.js";
import { runSubagentTask } from "../src/extensions/subagent.js";

if (process.argv[2] === "crash-worker") {
  await crashWorker(process.argv[3]!);
} else if (process.argv[2] === "crash-unknown" || process.argv[2] === "crash-completed") {
  await crashAtToolBoundary(process.argv[3]!, process.argv[2]);
} else {
  test("public task resume continues a killed worker without repeating its write and preserves verification baseline", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-cold-e2e-"));
    const originalFetch = globalThis.fetch;
    let runtime: Awaited<ReturnType<typeof createCommandRuntime>> | undefined;
    let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
    let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
    let releaseProvider: (() => void) | undefined;
    await writeFile(path.join(root, "artifact.txt"), "before");
    try {
      const identity = await killAtContinuationBoundary(root);
      let requests = 0;
      const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: unknown }> };
        requests += 1;
        assert.ok(body.messages?.some((message) => message.role === "tool"), "provider continuation must contain the durable tool result");
        assert.match(JSON.stringify(body.messages), /write-once/u);
        await providerGate;
        return streamText("candidate ready after restart");
      }) as typeof fetch;
      runtime = await createCommandRuntime(root, { configStore: configStore(), sessionId: "parent-session" });
      const taskBefore = runtime.taskRuns.get("crashed-task")!;
      assert.equal(taskBefore.status, "running");
      assert.equal(taskBefore.attempts.length, 1);
      const interactive = new InteractiveAgentRuntime(runtime);
      host = await startRuntimeHost(root, async () => ({ commands: runtime!, runtime: interactive }));
      assert.equal(runtime.taskRuns.get("crashed-task")?.status, "blocked");
      assert.equal((runtime.taskRuns.get("crashed-task")?.attempts[0]?.failure as { failureClass?: string }).failureClass, "worker_interrupted");
      assert.equal(requests, 0, "Host startup must not execute a parked Worker");
      assert.equal(runtime.graphs.inspectGraph("worker-graph").nodes[0]?.status, "running", "the graph must retain its parked claim without dispatching another worker");
      client = await connectRuntimeHost(root, { clientId: "worker-recovery-test", surface: "tui" });
      assert.ok(client);
      const admissions = await Promise.all([client.taskResume("crashed-task"), client.taskResume("crashed-task")]);
      for (const accepted of admissions) assert.equal(accepted.accepted, true, JSON.stringify(accepted));
      assert.equal(runtime.taskRuns.events("crashed-task").filter((event) => event.eventType === "task.worker.resumed").length, 1);
      const restored = await runtime.resumeTaskRun("crashed-task");
      releaseProvider();
      const result = await restored.completion;
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(requests, 1);
      assert.equal(runtime.graphs.inspectGraph("worker-graph").nodes[0]?.status, "completed", "explicit worker continuation must close its graph node");
      const taskAfter = runtime.taskRuns.get("crashed-task")!;
      assert.equal(taskAfter.attempts.length, 1, "continuation must not create a replacement Attempt");
      assert.equal(taskAfter.attempts[0]?.attemptId, identity.attemptId);
      assert.equal((taskAfter.attempts[0]?.verification as { status?: string }).status, "passed");
      const events = await readSessionEvents(sessionFilePath(root, workerSessionId(identity.attemptId)));
      assert.equal(events.filter((event) => event.type === "tool_call" && event.tool === "Write").length, 1);
      assert.equal(events.filter((event) => event.type === "user_message").length, 1);
      const runIds = new Set(events.flatMap((event) => event.runtime?.runId ? [event.runtime.runId] : []));
      assert.equal(runIds.size, 2, "cold continuation gets a new execution identity");
      const turns = new Set(events.flatMap((event) => event.runtime?.turnId ? [event.runtime.turnId] : []));
      assert.equal(turns.size, 1);
      assert.equal(await readFile(path.join(root, "artifact.txt"), "utf8"), "candidate");
      const verification = taskAfter.attempts[0]?.verification as { repairScope?: { changedPaths?: string[] } };
      assert.deepEqual(verification.repairScope?.changedPaths, ["artifact.txt"], "verification compares against the original pre-crash baseline");
    } finally {
      releaseProvider?.();
      globalThis.fetch = originalFetch;
      await client?.close();
      if (host) await host.close();
      else await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const mode of ["crash-unknown", "crash-completed"] as const) {
    test(`Host restart ${mode === "crash-unknown" ? "blocks an unknown dispatched write" : "recovers completed output without another provider request"}`, { timeout: 30_000 }, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-boundary-e2e-"));
      const originalFetch = globalThis.fetch;
      let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
      let runtime: Awaited<ReturnType<typeof createCommandRuntime>> | undefined;
      try {
        await writeFile(path.join(root, "artifact.txt"), "before");
        const identity = await killAtContinuationBoundary(root, mode);
        let requests = 0;
        globalThis.fetch = (async () => { requests += 1; throw new Error("No provider execution is allowed at this boundary."); }) as typeof fetch;
        runtime = await createCommandRuntime(root, { configStore: configStore(), sessionId: "parent-session" });
        host = await startRuntimeHost(root, async () => ({ commands: runtime!, runtime: new InteractiveAgentRuntime(runtime!) }));
        const parked = runtime.taskRuns.get("crashed-task")!;
        assert.equal(parked.status, "blocked");
        const failure = parked.attempts[0]?.failure as { failureClass?: string };
        if (mode === "crash-unknown") {
          assert.equal(failure.failureClass, "unsafe_recovery");
          await assert.rejects(runtime.resumeTaskRun("crashed-task"), /resume requires/u);
        } else {
          assert.equal(failure.failureClass, "worker_interrupted");
          const resumed = await runtime.resumeTaskRun("crashed-task");
          assert.equal((await resumed.completion).status, "completed");
          assert.equal(runtime.taskRuns.get("crashed-task")?.attempts[0]?.attemptId, identity.attemptId);
        }
        assert.equal(requests, 0);
        assert.equal(await readFile(path.join(root, "artifact.txt"), "utf8"), "candidate");
        const events = await readSessionEvents(sessionFilePath(root, workerSessionId(identity.attemptId)));
        assert.equal(events.filter((event) => event.type === "tool_call" && event.tool === "Write").length, 1);
        if (mode === "crash-unknown") assert.equal(events.filter((event) => event.type === "tool_result" && event.tool === "Write").length, 0);
      } finally {
        globalThis.fetch = originalFetch;
        if (host) await host.close(); else await runtime?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

async function killAtContinuationBoundary(root: string, mode = "crash-worker"): Promise<{ attemptId: string }> {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), mode, root], {
    env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const ready = await new Promise<{ attemptId: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Worker did not reach a durable boundary: ${stderr}`)), 20_000);
      child.once("message", (message: { attemptId: string }) => { clearTimeout(timeout); resolve(message); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Worker exited before checkpoint: ${stderr}`)); });
    });
    child.kill("SIGKILL");
    await exited;
    return ready;
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
}

async function crashAtToolBoundary(root: string, mode: string): Promise<void> {
  const configuration = config();
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  tasks.create({ taskRunId: "crashed-task", sessionId: "parent-session", task: {
    prompt: "produce candidate", verification: { objective: "candidate exists", checks: [{ command: "node --version" }],
      artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1 }
  } });
  tasks.transition("crashed-task", "queued");
  const registry = createToolRegistry({ workspaceRoot: root, ignore: configuration.workspace.ignore });
  if (mode === "crash-unknown") {
    const original = registry.get("Write");
    registry.unregister("Write");
    registry.registerBuiltinTool({ ...original, resolveExecution: (args, context) => {
      const execution = original.resolveExecution(args, context);
      return { ...execution, execute: async (executionContext) => {
        await execution.execute(executionContext);
        process.send?.({ attemptId: tasks.get("crashed-task")!.attempts[0]!.attemptId });
        return await new Promise<never>(() => undefined);
      } };
    } });
  }
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return requests === 1 ? stream([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "write-once", function: { name: "Write", arguments: JSON.stringify({ path: "artifact.txt", content: "candidate" }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ]) : streamText("candidate completed before crash");
  }) as typeof fetch;
  await runTaskClosure({ taskRuns: tasks, taskRunId: "crashed-task", workspaceRoot: root, ignore: configuration.workspace.ignore,
    executor: { executeTaskCheck: async () => assert.fail("crash must precede verification") },
    executeAttempt: async (prompt, attempt) => {
      const output = await runSubagentTask({ workspaceRoot: root, config: configuration, toolRegistry: registry,
        getModelSettings: () => createModelSettings(configuration)
      }, prompt, undefined, "workspace", undefined, {
        persistenceRoot: root, taskId: attempt.attemptId, parentSessionId: "parent-session", runtimeEventSink: authority.asSink()
      });
      process.send?.({ attemptId: attempt.attemptId });
      await new Promise<never>(() => undefined);
      return output;
    }
  });
}

async function crashWorker(root: string): Promise<void> {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests === 1) return stream([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "write-once", function: { name: "Write", arguments: JSON.stringify({ path: "artifact.txt", content: "candidate" }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ]);
    process.send?.({ attemptId: runtime.taskRuns.get("crashed-task")!.attempts.at(-1)!.attemptId });
    return await new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const runtime = await createCommandRuntime(root, { configStore: configStore(), sessionId: "parent-session" });
  runtime.taskRuns.create({ taskRunId: "crashed-task", sessionId: "parent-session", task: {
    prompt: "produce candidate", verification: { objective: "candidate exists", checks: [{ command: "node --version" }],
      artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1 }
  } });
  const graph = runtime.graphs.createGraph(undefined, [{ nodeKey: "worker", prompt: "produce candidate" }], {}, "worker-graph");
  runtime.graphs.startGraph(graph.graphId);
  assert.ok(runtime.graphs.claimIntent(graph.graphId, graph.nodes[0]!.nodeId, "before-crash", "crashed-task"));
  const submitted = await runtime.startTaskRun("crashed-task");
  await submitted.completion;
  throw new Error("Worker should have been killed while awaiting the next provider response.");
}

function configStore() {
  return { load: async () => config(), save: async () => undefined };
}

function config(): AgentConfig {
  return { ...defaultConfig, defaultModel: "synthetic",
    providers: { fixture: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "fixture-key" } },
    models: { synthetic: { ...defaultConfig.models["deepseek-v4-flash"], provider: "fixture", model: "synthetic", displayName: "Synthetic" } },
    permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [] }, checkpoints: { enabled: false },
    extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true, allowedTools: ["Read", "Write"], maxSteps: 6 } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  };
}

function streamText(content: string): Response {
  return stream([{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
}

function stream(parts: unknown[]): Response {
  return new Response(`${parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
