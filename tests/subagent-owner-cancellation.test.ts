import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { currentRuntimeHostIdentity, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import type { SessionRuntimeRegistry } from "../src/runtime/host/registry.js";
import type { HostOperationResult } from "../src/runtime/host/types.js";

type Host = Awaited<ReturnType<typeof createInteractiveAgentHost>>;
type InternalServer = { registry: SessionRuntimeRegistry; execute(connection: unknown, frame: HostRequestFrame): Promise<unknown> };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

if (process.argv[2] === "crash-worker") {
  const root = process.argv[3]!;
  const config = ownerConfig();
  const owner = await createInteractiveAgentHost(root, { sessionId: "secondary", configStore: configStore(config) });
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    assertNoReport(init);
    const task = owner.commands.subagents!.listSnapshots()[0]!;
    const durable = owner.commands.taskRuns.get(task.taskId)!;
    process.stdout.write(`OWNER_READY ${JSON.stringify({ taskId: task.taskId, attemptId: durable.attempts[0]!.attemptId, owner: durable.sessionId })}\n`);
    return await new Promise<Response>(() => undefined);
  };
  await executeRuntimeCommand(owner.runtime, owner.commands, "/subagent start cold owner task", "tui");
  await new Promise<void>(() => undefined);
} else {
  for (const ownerId of ["primary", "secondary"] as const) for (const mode of ["foreground", "background"] as const) {
    test(`${ownerId} ${mode} slash child is durably owned and cancels before any write`, { timeout: 15_000 }, async (t) => {
      const entered = deferred(); const release = deferred(); let signal: AbortSignal | null | undefined; let requests = 0;
      await fixture(t, ownerConfig(), async (_input, init) => {
        assertNoReport(init); requests += 1;
        if (requests === 1) { signal = init?.signal; entered.resolve(); await release.promise; signal?.throwIfAborted(); return writeResponse("after-cancel.txt"); }
        return textResponse("write finished");
      }, async ({ primary, secondary, rpc, root }) => {
        const owner = ownerId === "primary" ? primary : secondary;
        const observedOwners: Array<string | undefined> = [];
        const unsubscribe = owner.commands.subagents!.subscribe(snapshot => {
          if (snapshot.status === "queued") observedOwners.push(owner.commands.taskRuns.get(snapshot.taskId)?.sessionId);
        });
        const command = executeRuntimeCommand(owner.runtime, owner.commands,
          `/subagent ${mode === "background" ? "start " : ""}write the requested artifact`, "tui");
        const outcome = command.then(value => ({ value }), error => ({ error }));
        try {
          if (mode === "background") await command;
          await entered.promise;
          const snapshot = owner.commands.subagents!.listSnapshots()[0]!;
          const task = owner.commands.taskRuns.get(snapshot.taskId)!;
          const cancelled = await rpc("task.cancel", { taskRunId: task.taskRunId }) as HostOperationResult<{ status: string }>;
          const abortedAtAcknowledgement = signal?.aborted;
          release.resolve(); await owner.runtime.waitForIdle();
          const written = await exists(path.join(root, "after-cancel.txt"));
          assert.equal(written, false, "a pre-tool cancellation must stop a subsequent Write dispatch");
          assert.equal(cancelled.accepted, true);
          assert.equal(cancelled.sessionId, ownerId);
          assert.equal(cancelled.result?.status, "aborted", "live Worker cancellation retains the existing aborted projection");
          assert.equal(abortedAtAcknowledgement, true); assert.equal(requests, 1);
          assert.equal(task.sessionId, ownerId); assert.deepEqual(observedOwners, [ownerId], "owner exists before the first public queued snapshot");
          assert.equal((task.attempts[0]!.artifacts as { workerExecution: { communication: boolean; accessMode: string } }).workerExecution.communication, false);
          assert.equal((task.attempts[0]!.artifacts as { workerExecution: { accessMode: string } }).workerExecution.accessMode, "workspace");
          const created = owner.commands.runtimeAuthority.readEvents({ runId: task.parentRunId, limit: 1000 }).events.find(event => event.eventType === "task.created");
          assert.equal(created?.sessionId, ownerId);
          const settled = await outcome;
          if (mode === "foreground") { assert.ok("error" in settled); assert.match(String(settled.error), /cancelled/u); }
          else assert.ok("value" in settled);
        } finally { release.resolve(); unsubscribe(); await outcome; }
      });
    });
  }

  test("concurrent sessions cancel only the selected child and preserve the other's execution", { timeout: 15_000 }, async (t) => {
    const ready = { primary: deferred(), secondary: deferred() }; const release = { primary: deferred(), secondary: deferred() };
    const counts = { primary: 0, secondary: 0 }; const signals: Partial<Record<"primary" | "secondary", AbortSignal | null>> = {};
    await fixture(t, ownerConfig(), async (_input, init) => {
      assertNoReport(init);
      const owner = String(init?.body).includes("task-secondary") ? "secondary" : "primary";
      counts[owner] += 1;
      if (counts[owner] === 1) { signals[owner] = init?.signal; ready[owner].resolve(); await release[owner].promise; init?.signal?.throwIfAborted(); return writeResponse(`${owner}.txt`); }
      return textResponse("finished");
    }, async ({ primary, secondary, rpc, root }) => {
      try {
        await executeRuntimeCommand(primary.runtime, primary.commands, "/subagent start task-primary", "tui");
        await executeRuntimeCommand(secondary.runtime, secondary.commands, "/subagent start task-secondary", "tui");
        await Promise.all([ready.primary.promise, ready.secondary.promise]);
        const target = secondary.commands.subagents!.listSnapshots()[0]!;
        await rpc("task.cancel", { taskRunId: target.taskId });
        assert.equal(signals.secondary?.aborted, true); assert.equal(signals.primary?.aborted, false);
        release.primary.resolve(); release.secondary.resolve();
        await Promise.all([primary.runtime.waitForIdle(), secondary.runtime.waitForIdle()]);
        assert.equal(await exists(path.join(root, "secondary.txt")), false);
        assert.equal(await readFile(path.join(root, "primary.txt"), "utf8"), "bounded test write");
        assert.deepEqual(counts, { primary: 2, secondary: 1 });
        assert.equal(primary.commands.subagents!.listSnapshots()[0]?.status, "completed");
      } finally { release.primary.resolve(); release.secondary.resolve(); }
    });
  });

  test("queue rejection and pre-aborted input create no ghost TaskRun", { timeout: 15_000 }, async (t) => {
    const entered = deferred(); const release = deferred(); const config = ownerConfig();
    config.extensions.subagent.maxConcurrentSubagents = 1; config.extensions.subagent.maxPendingSubagents = 0;
    await fixture(t, config, async (_input, init) => { assertNoReport(init); entered.resolve(); await release.promise; init?.signal?.throwIfAborted(); return textResponse("done"); }, async ({ secondary }) => {
      const first = secondary.commands.startSubagentTask("occupier", { taskId: "occupier" }); void first.completion.catch(() => undefined);
      try {
        await entered.promise;
        assert.throws(() => secondary.commands.startSubagentTask("reject from full queue", { taskId: "rejected" }), /queue is full/u);
        assert.equal(secondary.commands.taskRuns.get("rejected"), undefined);
        assert.throws(() => secondary.commands.startSubagentTask("", { taskId: "empty" }), /cannot be empty/u);
        assert.equal(secondary.commands.taskRuns.get("empty"), undefined);
        const abort = new AbortController(); abort.abort(new Error("pre-aborted"));
        assert.throws(() => secondary.commands.startSubagentTask("already cancelled", { taskId: "aborted", signal: abort.signal }), /pre-aborted/u);
        assert.equal(secondary.commands.taskRuns.get("aborted"), undefined);
        assert.equal(secondary.commands.taskRuns.list().tasks.length, 1);
      } finally { secondary.commands.cancelTaskRun(first.taskId); release.resolve(); await first.completion.catch(() => undefined); }
    });
  });

  for (const bound of [false, true]) test(`${bound ? "bound" : "existing unbound"} task retains its established communication admission`, { timeout: 15_000 }, async (t) => {
    await fixture(t, ownerConfig(), async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tools: Array<{ function?: { name?: string } }> };
      assert.ok(body.tools.some(tool => tool.function?.name === "TaskReport")); return textResponse("bound child result");
    }, async ({ secondary }) => {
      const task = secondary.commands.taskRuns.create({ taskRunId: "bound-child", sessionId: "secondary", parentRunId: "parent", task: { prompt: "bound child", communication: true } });
      if (bound) {
        const started = await secondary.commands.startTaskRun(task.taskRunId); assert.equal((await started.completion).status, "completed");
      } else { assert.equal(await secondary.commands.startSubagentTask("bound child", { taskId: task.taskRunId }).completion, "bound child result"); }
      const after = secondary.commands.taskRuns.get(task.taskRunId)!;
      assert.equal(after.sessionId, "secondary"); assert.equal(after.parentRunId, "parent"); assert.deepEqual(after.task, task.task);
      assert.equal((after.attempts[0]!.artifacts as { workerExecution: { communication: boolean } }).workerExecution.communication, true);
    });
  });

  test("foreign established ownership rejects all admission routes without rebinding or task mutation", async (t) => {
    await fixture(t, ownerConfig(), async () => { assert.fail("foreign task cannot invoke a model"); }, async ({ primary, secondary }) => {
      const task = secondary.commands.taskRuns.create({ taskRunId: "foreign", sessionId: "secondary", task: { prompt: "foreign child", communication: true } });
      const before = secondary.commands.taskRuns.get(task.taskRunId);
      await assert.rejects(primary.commands.startTaskRun(task.taskRunId), /belongs to session secondary/u);
      await assert.rejects(primary.commands.resumeTaskRun(task.taskRunId), /belongs to session secondary/u);
      assert.throws(() => primary.commands.startSubagentTask("foreign child", { taskId: task.taskRunId }), /belongs to session secondary/u);
      assert.deepEqual(secondary.commands.taskRuns.get(task.taskRunId), before);
      assert.deepEqual(primary.commands.subagents!.listSnapshots(), []);
    });
  });

  for (const partial of ["local-task", "missing-task", "attempt-only"] as const) for (const foreign of [false, true]) {
    test(`incomplete ${partial} binding validates its actual ${foreign ? "foreign" : "local"} scheduler target`, async (t) => {
      let requests = 0;
      await fixture(t, ownerConfig(), async () => { requests += 1; return textResponse("effective target result"); }, async ({ primary, secondary }) => {
        const target = secondary.commands.taskRuns.create({ taskRunId: "effective-target", sessionId: foreign ? "secondary" : "primary", task: "effective target" });
        const unrelated = primary.commands.taskRuns.create({ taskRunId: "unrelated-task", sessionId: "secondary", task: "unrelated task" });
        const unrelatedAttempt = primary.commands.taskRuns.createAttempt(unrelated.taskRunId);
        const before = primary.commands.taskRuns.get(target.taskRunId);
        const unrelatedBefore = primary.commands.taskRuns.get(unrelated.taskRunId);
        const options = partial === "attempt-only" ? { attemptId: unrelatedAttempt.attemptId }
          : { taskRunId: partial === "local-task" ? unrelated.taskRunId : "missing-unrelated-task" };
        if (foreign) {
          assert.throws(() => primary.commands.startSubagentTask("effective target", { taskId: target.taskRunId, ...options }), /belongs to session secondary/u);
          assert.deepEqual(primary.commands.taskRuns.get(target.taskRunId), before);
          assert.deepEqual(primary.commands.subagents!.listSnapshots(), []);
        } else {
          assert.equal(await primary.commands.startSubagentTask("effective target", { taskId: target.taskRunId, ...options }).completion, "effective target result");
          const after = primary.commands.taskRuns.get(target.taskRunId)!;
          assert.equal(after.status, "completed"); assert.equal(after.sessionId, "primary");
          assert.equal(after.attempts.length, 1); assert.notEqual(after.attempts[0]!.attemptId, unrelatedAttempt.attemptId);
        }
        assert.equal(requests, foreign ? 0 : 1);
        assert.deepEqual(primary.commands.taskRuns.get(unrelated.taskRunId), unrelatedBefore);
        assert.equal(primary.commands.taskRuns.get("missing-unrelated-task"), undefined);
      });
    });
  }

  for (const foreign of [false, true]) test(`complete binding validates its ${foreign ? "foreign" : "local"} bound target independently of scheduler identity`, async (t) => {
    let requests = 0;
    await fixture(t, ownerConfig(), async (_input, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as { tools: Array<{ function?: { name?: string } }> };
      assert.ok(body.tools.some(tool => tool.function?.name === "TaskReport"));
      return textResponse("bound effective result");
    }, async ({ primary }) => {
      const target = primary.commands.taskRuns.create({ taskRunId: "bound-target", sessionId: foreign ? "secondary" : "primary", task: "bound target" });
      const attempt = primary.commands.taskRuns.createAttempt(target.taskRunId);
      const scheduler = primary.commands.taskRuns.create({ taskRunId: "scheduler-alias", sessionId: foreign ? "primary" : "secondary", task: "unrelated scheduler record" });
      const before = primary.commands.taskRuns.get(target.taskRunId);
      const schedulerBefore = primary.commands.taskRuns.get(scheduler.taskRunId);
      const options = { taskId: scheduler.taskRunId, taskRunId: target.taskRunId, attemptId: attempt.attemptId };
      if (foreign) {
        assert.throws(() => primary.commands.startSubagentTask("bound target", options), /belongs to session secondary/u);
        assert.deepEqual(primary.commands.taskRuns.get(target.taskRunId), before);
        assert.deepEqual(primary.commands.subagents!.listSnapshots(), []);
      } else {
        assert.equal(await primary.commands.startSubagentTask("bound target", options).completion, "bound effective result");
        const after = primary.commands.taskRuns.get(target.taskRunId)!;
        assert.equal(after.status, "completed"); assert.equal(after.sessionId, "primary");
        assert.equal(after.attempts.length, 1); assert.equal(after.attempts[0]!.attemptId, attempt.attemptId);
      }
      assert.deepEqual(primary.commands.taskRuns.get(scheduler.taskRunId), schedulerBefore);
      assert.equal(requests, foreign ? 0 : 1);
    });
  });

  test("snapshot creation ownership is write-once for an existing bound TaskRun", async (t) => {
    await fixture(t, ownerConfig(), async () => { assert.fail("snapshot projection cannot call a model"); }, async ({ secondary }) => {
      const task = secondary.commands.taskRuns.create({ taskRunId: "fixed-owner", sessionId: "secondary", task: "original task" });
      const attempt = secondary.commands.taskRuns.createAttempt(task.taskRunId);
      secondary.commands.taskRuns.syncSubagentSnapshot({ taskId: "scheduler-id", parentRunId: "parent", task: "snapshot task", status: "queued", createdAt: new Date().toISOString() }, { taskRunId: task.taskRunId, attemptId: attempt.attemptId, sessionId: "primary" });
      assert.equal(secondary.commands.taskRuns.get(task.taskRunId)?.sessionId, "secondary");
      assert.equal(secondary.commands.taskRuns.get(task.taskRunId)?.task, "original task");
    });
  });

  for (const cancel of [false, true]) test(`cold slash child routes ${cancel ? "resume then cancel" : "resume to completion"} to its persisted owner`, { timeout: 20_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-cold-subagent-owner-"));
    const ready = await crashAtProvider(root);
    const entered = deferred(); const release = deferred(); let signal: AbortSignal | null | undefined; let requests = 0;
    try {
      await fixture(t, ownerConfig(), async (_input, init) => {
        assertNoReport(init); requests += 1; signal = init?.signal; entered.resolve();
        if (cancel) { await release.promise; signal?.throwIfAborted(); return writeResponse("cold-after-cancel.txt"); }
        return textResponse("cold child result");
      }, async ({ secondary, primary, rpc }) => {
        assert.equal(primary.commands.taskRuns.get(ready.taskId)?.sessionId, "secondary");
        const resumed = await rpc("task.resume", { taskRunId: ready.taskId }) as HostOperationResult<unknown>;
        assert.equal(resumed.accepted, true); assert.equal(resumed.sessionId, "secondary");
        await entered.promise;
        if (cancel) {
          const cancelled = await rpc("task.cancel", { taskRunId: ready.taskId }) as HostOperationResult<{ status: string }>;
          assert.equal(cancelled.accepted, true); assert.equal(cancelled.sessionId, "secondary"); assert.equal(cancelled.result?.status, "aborted");
          assert.equal(signal?.aborted, true); release.resolve();
        }
        await settle(() => !secondary.commands.hasBackgroundWork());
        const task = secondary.commands.taskRuns.get(ready.taskId)!;
        assert.equal(task.sessionId, "secondary"); assert.equal(task.attempts.length, 1); assert.equal(task.attempts[0]?.attemptId, ready.attemptId);
        assert.equal(task.status, cancel ? "aborted" : "completed"); assert.equal(requests, 1);
        assert.equal(await exists(path.join(root, "cold-after-cancel.txt")), false);
        assert.equal((task.attempts[0]!.artifacts as { workerExecution: { communication: boolean } }).workerExecution.communication, false);
        const reader = await RuntimeEventAuthority.openReadOnly(root); assert.ok(reader); const tasks = await DurableTaskRunStore.open(root, reader);
        try { assert.deepEqual(tasks.get(ready.taskId), task); } finally { tasks.close(); reader.close(); }
      }, root);
    } finally { release.resolve(); await rm(root, { recursive: true, force: true }); }
  });
}

function ownerConfig(): AgentConfig {
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic"; config.toolModel = "synthetic";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false, retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 } } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
  config.permission = { ...config.permission, mode: "full-access", criticalAlwaysAsk: false, denyPaths: [] };
  config.extensions.subagent.enabled = true; config.extensions.subagent.allowedTools = ["Write"];
  config.checkpoints.enabled = false; config.heartbeat.enabled = false; config.context.memory.enabled = false; config.context.identity.enabled = false;
  return config;
}
function configStore(config: AgentConfig) { return { load: async () => structuredClone(config), save: async () => undefined }; }
async function fixture(t: TestContext, config: AgentConfig, fetch: (_input: unknown, init?: RequestInit) => Promise<Response>, run: (f: { primary: Host; secondary: Host; root: string; rpc: (operation: string, payload: Record<string, unknown>) => Promise<unknown> }) => Promise<void>, existingRoot?: string): Promise<void> {
  const root = existingRoot ?? await mkdtemp(path.join(os.tmpdir(), "biny-subagent-owner-"));
  const network = t.mock.method(globalThis, "fetch", fetch);
  const primary = await createInteractiveAgentHost(root, { sessionId: "primary", configStore: configStore(config) });
  const secondary = await createInteractiveAgentHost(root, { sessionId: "secondary", configStore: configStore(config) });
  const paths = runtimeHostPaths(root);
  const registration = { ...paths, ...currentRuntimeHostIdentity({}), protocolVersion: runtimeHostProtocolVersion, persistenceRoot: root, hostEpoch: "owner-fixture", token: "synthetic-fixture-token", pid: process.pid, createdAt: new Date().toISOString() };
  const server = new RuntimeHostServer(primary.runtime, primary.commands, registration, { close: async () => undefined }, async (sessionId) => { assert.equal(sessionId, "secondary"); return secondary; });
  const host = server as unknown as InternalServer;
  let request = 0;
  try {
    await host.registry.ensure("secondary");
    await run({ primary, secondary, root, rpc: async (operation, payload) => await host.execute({ surface: "cli" }, { kind: "request", requestId: `owner-${++request}`, operation, payload }) });
  } finally { await server.close(); await secondary.runtime.close(); network.mock.restore(); if (!existingRoot) await rm(root, { recursive: true, force: true }); }
}
function assertNoReport(init?: RequestInit): void {
  const body = JSON.parse(String(init?.body)) as { tools: Array<{ function?: { name?: string } }> };
  assert.ok(body.tools.some(tool => tool.function?.name === "Write"));
  assert.ok(!body.tools.some(tool => tool.function?.name === "TaskReport"), "routing metadata cannot grant TaskReport");
}
function writeResponse(file: string): Response {
  return stream([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `write-${file}`, function: { name: "Write", arguments: JSON.stringify({ path: file, content: "bounded test write" }) } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
}
function textResponse(content: string): Response { return stream([{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]); }
function stream(parts: unknown[]): Response { return new Response([...parts.map(part => `data: ${JSON.stringify(part)}`), "data: [DONE]"].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } }); }
async function exists(file: string): Promise<boolean> { return await access(file).then(() => true, () => false); }
async function settle(done: () => boolean): Promise<void> { const deadline = Date.now() + 8_000; while (!done()) { if (Date.now() >= deadline) throw new Error("Owner work did not settle."); await setImmediate(); } }
async function crashAtProvider(root: string): Promise<{ taskId: string; attemptId: string; owner: string }> {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "crash-worker", root], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errorOutput = "";
  child.stderr.on("data", chunk => { errorOutput += String(chunk); });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  try {
    const ready = await new Promise<{ taskId: string; attemptId: string; owner: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Worker did not reach provider: ${errorOutput}`)), 8_000);
      child.stdout.on("data", chunk => {
        output += String(chunk);
        const line = output.split("\n").find(value => value.startsWith("OWNER_READY "));
        if (!line) return;
        clearTimeout(timeout); resolve(JSON.parse(line.slice("OWNER_READY ".length)) as { taskId: string; attemptId: string; owner: string });
      });
      child.once("exit", code => { clearTimeout(timeout); if (!output.includes("OWNER_READY ")) reject(new Error(`Worker exited ${code}: ${errorOutput}`)); });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
    });
    child.kill("SIGKILL"); await exited; return ready;
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
}
