import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { queryObjects } from "node:v8";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { SessionLeaseStore } from "../src/runtime/SessionLease.js";
import { WorkerSession, workerSessionId } from "../src/runtime/WorkerSession.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

test("saturated real Runtime rejects a resumed worker, releases its lease and retains no prepared WorkerSession", { timeout: 60_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "worker-admission-")));
  const originalFetch = globalThis.fetch;
  let runtime: Awaited<ReturnType<typeof createCommandRuntime>> | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await writeFile(path.join(root, "artifact.txt"), "before");
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "tests/worker-runtime-recovery-e2e.test.ts", "crash-worker", root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = "";
    assert.ok(child.stderr);
    child.stderr.on("data", data => { errors += String(data); });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    let identity: { attemptId: string };
    try {
      identity = await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(errors || "checkpoint deadline")), 30_000);
        child.once("message", message => { clearTimeout(deadline); resolve(message as { attemptId: string }); });
        child.once("error", error => { clearTimeout(deadline); reject(error); });
        child.once("exit", () => { clearTimeout(deadline); reject(new Error(errors || "unexpected child exit")); });
      });
    } finally { child.kill("SIGKILL"); await exited; }
    let requests = 0;
    let entered!: () => void;
    const atProvider = new Promise<void>(resolve => { entered = resolve; });
    globalThis.fetch = async () => {
      requests += 1;
      entered();
      await gate;
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"holder done"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    };
    const config: AgentConfig = { ...defaultConfig, defaultModel: "synthetic",
      providers: { fixture: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "fixture-key" } },
      models: { synthetic: { ...defaultConfig.models["deepseek-v4-flash"], provider: "fixture", model: "synthetic", displayName: "Synthetic" } },
      permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [] }, checkpoints: { enabled: false },
      extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true, allowedTools: ["Read", "Write"], maxSteps: 6, maxConcurrentSubagents: 1, maxPendingSubagents: 0 } },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
    };
    runtime = await createCommandRuntime(root, { configStore: { load: async () => config, save: async () => undefined }, sessionId: "parent-session" });
    const holder = runtime.startSubagentTask("hold the only worker slot");
    await atProvider;
    assert.equal(runtime.subagents!.listSnapshots().filter(item => item.status === "running").length, 1);
    const before = queryObjects(WorkerSession);
    await rejectResume(runtime);
    assert.equal(requests, 1, "rejected continuation must never request the provider");
    const task = runtime.taskRuns.get("crashed-task")!;
    assert.equal(task.attempts.length, 1);
    assert.equal(task.attempts[0]!.attemptId, identity.attemptId);
    assert.equal((task.attempts[0]!.failure as { failureClass: string }).failureClass, "dispatch_failed");
    const leases = await SessionLeaseStore.open(root);
    try { leases.acquire(workerSessionId(identity.attemptId)).close(); } finally { leases.close(); }
    const events = await readSessionEvents(sessionFilePath(root, workerSessionId(identity.attemptId)));
    assert.equal(events.filter(event => event.type === "tool_call" && event.tool === "Write").length, 1);
    await nextTurn();
    const after = queryObjects(WorkerSession);
    assert.equal(after, before, "settled admission must not retain the prepared worker object graph");
    release();
    assert.equal(await holder.completion, "holder done");
  } finally { release(); await runtime?.close(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});

async function rejectResume(runtime: Awaited<ReturnType<typeof createCommandRuntime>>): Promise<void> {
  const submitted = await runtime.resumeTaskRun("crashed-task");
  await assert.rejects(submitted.completion, /queue is full/i);
}
