import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { TurnStore } from "../src/session/turnStore.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { randomUUID } from "node:crypto";
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
  const owner = await createInteractiveAgentHost(root, { sessionId: "secondary", configStore: configStore(ownerConfig()) });
  // Recreate the original ownerless projection through the public store API; the worker/checkpoint/parent audit are real.
  owner.commands.taskRuns.create({ taskRunId: "legacy-child", parentRunId: "legacy-child", task: "cold owner task" });
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    assertNoReport(init);
    const durable = owner.commands.taskRuns.get("legacy-child")!;
    await owner.commands.agent.getSessionRecorder().flush();
    process.stdout.write(`OWNER_READY ${JSON.stringify({ taskId: durable.taskRunId, attemptId: durable.attempts[0]!.attemptId })}\n`);
    return await new Promise<Response>(() => undefined);
  };
  await owner.commands.startSubagentTask("cold owner task", { taskId: "legacy-child" }).completion;
} else {
  for (const mode of ["running-explicit", "parked-default", "old-unsafe-explicit"] as const) test(`legacy explicit resume preserves owner, attempt and communication: ${mode}`, { timeout: 20_000 }, async t => {
    await legacyFixture(t, async (_input, init) => { assertNoReport(init); return textResponse("safe continuation finished"); }, async ({ primary, secondary, rpc, initialize, taskId, attemptId }) => {
      const before = primary.commands.taskRuns.get(taskId)!;
      if (mode === "parked-default") await initialize();
      if (mode === "old-unsafe-explicit") primary.commands.taskRuns.transition(taskId, "blocked", { attemptId, failure: restartFailure });
      assert.equal(primary.commands.taskRuns.get(taskId)?.sessionId, undefined, "startup cannot bind an owner");
      const resumed = await rpc("task.resume", { taskRunId: taskId, ...(mode === "parked-default" ? {} : { sessionId: "secondary" }) }) as HostOperationResult<unknown>;
      assert.equal(resumed.accepted, true); assert.equal(resumed.sessionId, "secondary");
      await settle(() => !secondary.commands.hasBackgroundWork());
      const after = primary.commands.taskRuns.get(taskId)!;
      assert.equal(after.status, "completed"); assert.equal(after.sessionId, "secondary"); assert.equal(after.attempts.length, 1);
      assert.equal(after.attempts[0]?.attemptId, attemptId); assert.equal(after.task, before.task);
      assert.equal((after.attempts[0]!.artifacts as { workerExecution: { communication: boolean } }).workerExecution.communication, false);
      assert.equal(primary.commands.taskRuns.events(taskId).filter(event => event.eventType === "task.worker.owner_reconciled").length, 1);
    });
  });

  test("reconciled legacy owner routes cancellation before real Write even when provider ignores abort", { timeout: 20_000 }, async t => {
    const entered = deferred(); const release = deferred(); let requests = 0; let signal: AbortSignal | null | undefined;
    try {
      await legacyFixture(t, async (_input, init) => {
        assertNoReport(init); requests++;
        if (requests === 1) { signal = init?.signal; entered.resolve(); await release.promise; return writeResponse("cancelled-legacy.txt"); }
        return textResponse("unexpected write completion");
      }, async ({ primary, secondary, rpc, initialize, taskId, root }) => {
        await initialize();
        const resumed = await rpc("task.resume", { taskRunId: taskId }) as HostOperationResult<unknown>; assert.equal(resumed.accepted, true);
        await entered.promise;
        const cancelled = await rpc("task.cancel", { taskRunId: taskId }) as HostOperationResult<{ status: string }>;
        assert.equal(cancelled.accepted, true); assert.equal(cancelled.sessionId, "secondary"); assert.equal(signal?.aborted, true);
        release.resolve(); await settle(() => !secondary.commands.hasBackgroundWork());
        assert.equal(await exists(path.join(root, "cancelled-legacy.txt")), false); assert.equal(requests, 1);
        assert.equal(primary.commands.taskRuns.get(taskId)?.status, "aborted");
      });
    } finally { release.resolve(); }
  });

  for (const action of ["cancel", "dispose", "attempt", "revision", "conflicting-audit", "parent-change", "prepare-failure"] as const) test(`pending legacy preparation cannot bind or dispatch after ${action}`, { timeout: 20_000 }, async t => {
    let requests = 0;
    await legacyFixture(t, async () => { requests++; return textResponse("unexpected dispatch"); }, async ({ primary, secondary, rpc, initialize, taskId, attemptId, root }) => {
      await initialize();
      const entered = deferred(); const release = deferred();
      const load = TurnStore.prototype.load; let blocked = false;
      const mock = t.mock.method(TurnStore.prototype, "load", async function(this: TurnStore) {
        if (!blocked && secondary.commands.pendingTaskResume?.(taskId)) {
          blocked = true; entered.resolve(); await release.promise;
          if (action === "prepare-failure") throw new Error("injected preparation read failure");
        }
        return await load.call(this);
      });
      let closing: Promise<void> | undefined;
      try {
        const resuming = rpc("task.resume", { taskRunId: taskId });
        const duplicate = action === "cancel" ? rpc("task.resume", { taskRunId: taskId }) : undefined;
        await entered.promise;
        const before = primary.commands.taskRuns.get(taskId)!;
        if (action === "cancel") {
          for (let index = 0; index < 2; index++) {
            const cancelled = await rpc("task.cancel", { taskRunId: taskId }) as HostOperationResult<{ status: string }>;
            assert.equal(cancelled.accepted, true); assert.equal(cancelled.sessionId, "secondary"); assert.equal(cancelled.result?.status, "blocked");
          }
          assert.equal(primary.commands.taskRuns.get(taskId)?.revision, before.revision, "blocked cancellation relies on the admission signal, not a state revision");
        } else if (action === "dispose") closing = secondary.runtime.close();
        else if (action === "attempt") {
          primary.commands.taskRuns.createAttempt(taskId);
          assert.equal(primary.commands.taskRuns.get(taskId)?.revision, before.revision, "new attempt does not increment revision");
        } else if (action === "revision") primary.commands.taskRuns.transition(taskId, "blocked", { attemptId, highWaterSequence: 42 });
        else if (action === "conflicting-audit") {
          const aborted = new AbortController(); aborted.abort(new Error("pre-aborted duplicate"));
          assert.throws(() => primary.commands.startSubagentTask("cold owner task", { taskId, signal: aborted.signal }), /pre-aborted/u);
          await primary.commands.agent.getSessionRecorder().flush();
          assert.equal(primary.commands.taskRuns.get(taskId)?.revision, before.revision);
        } else if (action === "parent-change") await mutateCheckpoint(root, attemptId, checkpoint => { checkpoint.facts.parentRunId = "different-parent"; });
        release.resolve();
        const result = await resuming as HostOperationResult<unknown>; assert.equal(result.accepted, false);
        if (duplicate) assert.equal((await duplicate as HostOperationResult<unknown>).accepted, false);
        await closing;
        assert.equal(primary.commands.taskRuns.get(taskId)?.sessionId, undefined); assert.equal(requests, 0);
        assert.equal(primary.commands.taskRuns.events(taskId).some(event => event.eventType === "task.worker.owner_reconciled"), false);
        if (action !== "dispose") assert.equal(secondary.commands.pendingTaskResume?.(taskId), undefined);
        if (action === "cancel" || action === "prepare-failure") {
          mock.mock.restore();
          const retried = await rpc("task.resume", { taskRunId: taskId }) as HostOperationResult<unknown>; assert.equal(retried.accepted, true);
          await settle(() => !secondary.commands.hasBackgroundWork()); assert.equal(requests, 1);
        }
      } finally { release.resolve(); mock.mock.restore(); await closing; }
    });
  });

  for (const corrupt of ["missing-owner", "wrong-owner", "workspace", "prompt", "parent-run", "unknown-tool", "communication", "unrelated-unsafe", "pre-cancelled", "missing-parent-audit", "replaced-attempt", "same-owner-preabort", "duplicate-call", "parent-result"] as const) test(`legacy owner proof rejects ${corrupt} without binding or model work`, { timeout: 20_000 }, async t => {
    let requests = 0;
    await legacyFixture(t, async () => { requests++; return textResponse("unexpected work"); }, async ({ primary, secondary, rpc, taskId, attemptId, root }) => {
      if (["missing-owner", "wrong-owner", "workspace", "prompt", "parent-run"].includes(corrupt)) await mutateCheckpoint(root, attemptId, checkpoint => {
        if (corrupt === "missing-owner") delete checkpoint.facts.parentSessionId;
        if (corrupt === "wrong-owner") checkpoint.facts.parentSessionId = "primary";
        if (corrupt === "workspace") checkpoint.facts.workspaceRoot = path.dirname(root);
        if (corrupt === "prompt") checkpoint.prompt = "different prompt";
        if (corrupt === "parent-run") checkpoint.facts.parentRunId = "different parent";
      });
      else if (corrupt === "unknown-tool") {
        const recorder = new SessionRecorder(root, workerSessionId(attemptId));
        try { await recorder.recordAndFlush({ type: "tool_result", tool: "Write", toolCallId: "uncertain", executionStatus: "unknown", result: { error: "unknown side effect" } }); }
        finally { await recorder.close(); }
      } else if (corrupt === "communication") {
        const artifacts = primary.commands.taskRuns.get(taskId)!.attempts[0]!.artifacts as { workerExecution: Record<string, unknown> };
        primary.commands.taskRuns.transition(taskId, "running", { attemptId, artifacts: { workerExecution: { ...artifacts.workerExecution, communication: true } } });
      } else if (corrupt === "unrelated-unsafe") primary.commands.taskRuns.transition(taskId, "blocked", { attemptId, failure: { failureClass: "unsafe_recovery", message: "unknown side effect after dispatched Write" } });
      else if (corrupt === "pre-cancelled") primary.commands.taskRuns.transition(taskId, "cancelled", { attemptId });
      else if (corrupt === "missing-parent-audit") primary.commands.runtimeAuthority.databaseHandle().prepare("DELETE FROM runtime_events WHERE event_type = 'session.tool_call' AND json_extract(payload_json, '$.toolCallId') = ?").run(taskId);
      else if (corrupt === "replaced-attempt") primary.commands.taskRuns.createAttempt(taskId);
      else if (corrupt === "same-owner-preabort") {
        const signal = new AbortController(); signal.abort(new Error("same-owner duplicate was pre-aborted"));
        assert.throws(() => secondary.commands.startSubagentTask("cold owner task", { taskId, signal: signal.signal }), /pre-aborted/u);
        await secondary.commands.agent.getSessionRecorder().flush();
      } else if (corrupt === "duplicate-call") {
        secondary.commands.agent.recordHostedToolCall("Task", { task: "cold owner task" }, taskId);
        await secondary.commands.agent.getSessionRecorder().flush();
      } else if (corrupt === "parent-result") {
        secondary.commands.agent.recordHostedToolResult("Task", { error: "parent outcome is not sufficient to identify a pending original call" }, taskId, 1);
        await secondary.commands.agent.getSessionRecorder().flush();
      }

      const before = primary.commands.taskRuns.get(taskId);
      const resumed = await rpc("task.resume", { taskRunId: taskId }).then(result => ({ result: result as HostOperationResult<unknown> }), error => ({ error: String(error) }));
      assert.ok("error" in resumed || !resumed.result.accepted);
      assert.deepEqual(primary.commands.taskRuns.get(taskId), before, "unproven recovery must not rewrite durable evidence");
      assert.equal(requests, 0); assert.equal(secondary.commands.pendingTaskResume?.(taskId), undefined);
    });
  });

  for (const mutation of ["new-attempt", "conflicting-audit", "parent-result"] as const) test(`owner bind transaction rechecks ${mutation} after complete preparation`, { timeout: 20_000 }, async t => {
    let requests = 0;
    await legacyFixture(t, async () => { requests++; return textResponse("unexpected work"); }, async ({ primary, secondary, rpc, initialize, taskId }) => {
      await initialize(); const before = primary.commands.taskRuns.get(taskId)!;
      const reconcile = secondary.commands.taskRuns.reconcileWorkerOwner;
      const mock = t.mock.method(secondary.commands.taskRuns, "reconcileWorkerOwner", (proof: Parameters<typeof reconcile>[0]) => {
        if (mutation === "new-attempt") primary.commands.taskRuns.createAttempt(taskId);
        else primary.commands.runtimeAuthority.appendSessionEvent({ sessionId: mutation === "parent-result" ? "secondary" : "primary", createdAt: new Date().toISOString(), runtime: { eventId: randomUUID(), eventSeq: 1 }, event: {
          type: mutation === "parent-result" ? "tool_result" : "tool_call", time: new Date().toISOString(), tool: "Task", toolCallId: taskId, auditOnly: true, args: { task: "cold owner task" }, result: { error: "parent result appeared during preparation" }
        } });
        assert.equal(primary.commands.taskRuns.get(taskId)?.revision, before.revision);
        return reconcile.call(secondary.commands.taskRuns, proof);
      });
      try {
        const result = await rpc("task.resume", { taskRunId: taskId }) as HostOperationResult<unknown>;
        assert.equal(result.accepted, false); assert.equal(primary.commands.taskRuns.get(taskId)?.sessionId, undefined);
        assert.equal(requests, 0); assert.equal(primary.commands.taskRuns.events(taskId).some(event => event.eventType === "task.worker.owner_reconciled"), false);
      } finally { mock.mock.restore(); }
    });
  });

  test("concurrent explicit resumes share one admission and one provider dispatch", { timeout: 20_000 }, async t => {
    const release = deferred(); const entered = deferred(); let requests = 0;
    try {
      await legacyFixture(t, async (_input, init) => { assertNoReport(init); requests++; entered.resolve(); await release.promise; return textResponse("single completion"); }, async ({ primary, secondary, rpc, initialize, taskId, attemptId }) => {
        await initialize();
        const results = await Promise.all([rpc("task.resume", { taskRunId: taskId }), rpc("task.resume", { taskRunId: taskId })]) as Array<HostOperationResult<unknown>>;
        assert.ok(results.every(result => result.accepted && result.sessionId === "secondary"));
        await entered.promise; assert.equal(requests, 1); release.resolve();
        await settle(() => !secondary.commands.hasBackgroundWork());
        const task = primary.commands.taskRuns.get(taskId)!;
        assert.equal(task.attempts.length, 1); assert.equal(task.attempts[0]?.attemptId, attemptId); assert.equal(task.status, "completed");
        assert.equal(primary.commands.taskRuns.events(taskId).filter(event => event.eventType === "task.worker.owner_reconciled").length, 1);
      });
    } finally { release.resolve(); }
  });

  for (const background of [false, true]) test(`ordinary ${background ? "background" : "foreground"} slash lifecycle has one pending hosted call before its result`, { timeout: 15_000 }, async t => {
    const entered = deferred(); const release = deferred();
    try {
      await fixture(t, ownerConfig(), async (_input, init) => { assertNoReport(init); entered.resolve(); await release.promise; return textResponse("ordinary lifecycle result"); }, async ({ secondary }) => {
        const command = executeRuntimeCommand(secondary.runtime, secondary.commands, `/subagent ${background ? "start " : ""}ordinary lifecycle task`, "tui");
        const settled = command.then(value => ({ value }), error => ({ error }));
        if (background) assert.match((await command)!.content, /Started subagent task/u);
        await entered.promise;
        const taskId = secondary.commands.subagents!.listSnapshots()[0]!.taskId;
        await secondary.commands.agent.getSessionRecorder().flush();
        assert.deepEqual(secondary.commands.runtimeAuthority.readToolEvents([taskId]).map(event => event.eventType), ["session.tool_call"], "background command admission output is not a hosted Task result");
        release.resolve(); await settled; await secondary.runtime.waitForIdle(); await secondary.commands.agent.getSessionRecorder().flush();
        assert.deepEqual(secondary.commands.runtimeAuthority.readToolEvents([taskId]).map(event => event.eventType), ["session.tool_call", "session.tool_result"]);
      });
    } finally { release.resolve(); }
  });

  test("ownerless blocked cancellation without a validated admission fails explicitly", { timeout: 20_000 }, async t => {
    await legacyFixture(t, async () => textResponse("unused"), async ({ primary, rpc, initialize, taskId }) => {
      await initialize(); const before = primary.commands.taskRuns.get(taskId);
      await assert.rejects(rpc("task.cancel", { taskRunId: taskId }), /no validated pending resume admission/u);
      assert.deepEqual(primary.commands.taskRuns.get(taskId), before);
    });
  });
}

const restartFailure = { failureClass: "unsafe_recovery", message: "Host restarted without a safe Worker checkpoint; unknown side effects were not replayed." };
type FixtureInput = Parameters<typeof fixture>[3] extends (value: infer Value) => Promise<void> ? Value : never;
async function legacyFixture(t: TestContext, fetch: (_input: unknown, init?: RequestInit) => Promise<Response>, run: (value: FixtureInput & { taskId: string; attemptId: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-legacy-recovery-"));
  try { const legacy = await crashAtProvider(root); await fixture(t, ownerConfig(), fetch, async value => run({ ...value, taskId: legacy.taskId, attemptId: legacy.attemptId }), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function mutateCheckpoint(root: string, attemptId: string, mutate: (checkpoint: { facts: Record<string, unknown>; prompt: string }) => void) {
  const store = new TurnStore(root, workerSessionId(attemptId));
  const checkpoint = await store.load(); assert.ok(checkpoint);
  const mutable = checkpoint as typeof checkpoint & { facts: Record<string, unknown> }; mutate(mutable);
  await store.save(mutable.prompt, mutable.systemPrompt, mutable.messages, mutable.completedSteps, mutable.facts, mutable.terminal, mutable.previousTerminals, mutable.runtimeHighWater, mutable.turnId);
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
async function fixture(t: TestContext, config: AgentConfig, fetch: (_input: unknown, init?: RequestInit) => Promise<Response>, run: (f: { primary: Host; secondary: Host; root: string; initialize: () => Promise<void>; rpc: (operation: string, payload: Record<string, unknown>) => Promise<unknown> }) => Promise<void>, existingRoot?: string): Promise<void> {
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
    await run({ primary, secondary, root, initialize: () => server.initialize(), rpc: async (operation, payload) => await host.execute({ surface: "cli" }, { kind: "request", requestId: `owner-${++request}`, operation, payload }) });
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
