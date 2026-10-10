import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { TurnStore } from "../src/session/turnStore.js";
import { WorkerSession, readWorkerSessionCheckpoint, workerSessionId } from "../src/runtime/WorkerSession.js";
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

import { sessionFilePath } from "../src/session/store.js";
import { readSessionEvents } from "../src/session/events.js";
import { redactSecrets } from "../src/utils/secrets.js";
if (process.argv[2] === "crash-worker") {
  const root = process.argv[3]!; const bound = process.argv[4] === "bound";
  const owner = await createInteractiveAgentHost(root, { sessionId: "secondary", configStore: configStore(ownerConfig()) });
  const taskId = "completed-before-projection";
  owner.commands.taskRuns.create({ taskRunId: taskId, parentRunId: taskId, task: "produce a bounded final report", ...(bound ? { sessionId: "secondary" } : {}) });
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls++;
    if (process.argv[5] === "with-write" && providerCalls === 1) return stream([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "completed-write", function: { name: "Write", arguments: JSON.stringify({ path: "completion-artifact.txt", content: "written exactly once before completion" }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ]);
    return textResponse(contentFor(process.argv[5] ?? "plain"));
  };
  const complete = WorkerSession.prototype.complete;
  WorkerSession.prototype.complete = async function(this: WorkerSession, output: string) {
    await complete.call(this, output);
    await owner.commands.agent.getSessionRecorder().flush();
    const task = owner.commands.taskRuns.get(taskId)!;
    process.stdout.write(`OWNER_READY ${JSON.stringify({ taskId, attemptId: task.attempts[0]!.attemptId })}\n`);
    await new Promise<void>(() => undefined);
  };
  await owner.commands.startSubagentTask("produce a bounded final report", { taskId }).completion;
} else {
  for (const [bound, outputCase] of [[false, "plain"], [true, "plain"], [false, "redaction"], [false, "large"], [false, "with-write"]] as const) test(`${bound ? "owned control" : "legacy"} completed output projects exactly without work: ${outputCase}`, { timeout: 20_000 }, async t => {
    await completedFixture(t, bound, outputCase, async ({ primary, secondary, rpc, initialize, taskId, attemptId, root }) => {
      const saved = await readWorkerSessionCheckpoint(root, attemptId);
      assert.equal(saved.facts.output, redactSecrets(contentFor(outputCase)));
      if (outputCase === "with-write") {
        assert.equal(await readFile(path.join(root, "completion-artifact.txt"), "utf8"), "written exactly once before completion");
        await rm(path.join(root, "completion-artifact.txt"));
      }
      await initialize();
      assert.equal(primary.commands.taskRuns.get(taskId)?.sessionId, bound ? "secondary" : undefined, "startup cannot bind missing ownership");
      assert.equal(primary.commands.taskRuns.get(taskId)?.status, "blocked", "startup does not project completed output");
      const resumed = await rpc("task.resume", { taskRunId: taskId }) as HostOperationResult<unknown>;
      assert.equal(resumed.accepted, true); assert.equal(resumed.sessionId, "secondary");
      await settle(() => !secondary.commands.hasBackgroundWork());
      const task = primary.commands.taskRuns.get(taskId)!;
      assert.equal(task.status, "completed"); assert.equal(task.attempts.length, 1); assert.equal(task.attempts[0]!.attemptId, attemptId);
      const artifacts = task.attempts[0]!.artifacts as { output: string; workerExecution: { communication: boolean } };
      assert.equal(artifacts.output, saved.facts.output); assert.equal(artifacts.workerExecution.communication, bound);
      const ownerEvents = primary.commands.taskRuns.events(taskId).filter(event => event.eventType === "task.worker.owner_reconciled");
      assert.equal(ownerEvents.length, bound ? 0 : 1);
      if (!bound) assert.match(String((ownerEvents[0]!.payload as { completionDigest: string }).completionDigest), /^[a-f0-9]{64}$/u);
      const again = await rpc("task.resume", { taskRunId: taskId }) as HostOperationResult<unknown>;
      assert.equal(again.accepted, false, "completed task resume retains the existing response contract");
      assert.deepEqual(primary.commands.taskRuns.get(taskId), task, "repeat must preserve the already projected result and event identity");
      if (outputCase === "with-write") assert.equal(await access(path.join(root, "completion-artifact.txt")).then(() => true, () => false), false, "the completed Write must not replay during result projection");
    });
  });

  for (const mutation of ["output-mismatch", "summary-mismatch", "steps-mismatch", "reason-mismatch", "matching-duplicate", "matching-duplicate-covered", "conflicting-terminal", "foreign-terminal", "checkpoint-before-terminal", "no-output", "non-string-output", "no-terminal", "invalid-terminal", "post-terminal-message", "late-metadata"] as const) test(`completed legacy proof handles ${mutation}`, { timeout: 20_000 }, async t => {
    await completedFixture(t, false, "plain", async ({ primary, secondary, rpc, initialize, taskId, attemptId, root }) => {
      // Corrupt fixtures after authority has opened, so this tests recovery proof rather than offline immutable-event ingestion.
      await mutateEvidence(root, attemptId, mutation); await initialize();
      const before = primary.commands.taskRuns.get(taskId)!;
      const response = await rpc("task.resume", { taskRunId: taskId }).then(result => ({ result: result as HostOperationResult<unknown> }), error => ({ error: String(error) }));
      const allowed = mutation === "matching-duplicate-covered" || mutation === "late-metadata";
      if (allowed) {
        assert.ok("result" in response && response.result.accepted);
        await settle(() => !secondary.commands.hasBackgroundWork());
        assert.equal((primary.commands.taskRuns.get(taskId)!.attempts[0]!.artifacts as { output: string }).output, contentFor("plain"));
      } else {
        assert.ok("error" in response || !response.result.accepted);
        assert.deepEqual(primary.commands.taskRuns.get(taskId), before);
        assert.equal(primary.commands.taskRuns.get(taskId)?.sessionId, undefined);
      }
    });
  });

  for (const mutation of ["cancel", "latest-attempt", "coherent-output-change", "parent-result", "duplicate-resume", "late-metadata", "dispose"] as const) test(`completed legacy preparation preserves authority during ${mutation}`, { timeout: 20_000 }, async t => {
    await completedFixture(t, false, "plain", async ({ primary, secondary, rpc, initialize, taskId, attemptId, root }) => {
      await initialize();
      const entered = deferred(); const release = deferred();
      const open = WorkerSession.open;
      const mock = t.mock.method(WorkerSession, "open", async (...args: Parameters<typeof WorkerSession.open>) => {
        const worker = await open(...args);
        if (args[0].resume && args[0].taskId === attemptId) { entered.resolve(); await release.promise; }
        return worker;
      });
      let closing: Promise<void> | undefined;
      try {
        const pending = rpc("task.resume", { taskRunId: taskId });
        await entered.promise;
        const before = primary.commands.taskRuns.get(taskId)!;
        let duplicate: Promise<unknown> | undefined;
        if (mutation === "cancel") {
          const cancelled = await rpc("task.cancel", { taskRunId: taskId }) as HostOperationResult<unknown>;
          assert.equal(cancelled.accepted, true); assert.equal(cancelled.sessionId, "secondary");
          assert.equal(primary.commands.taskRuns.get(taskId)?.revision, before.revision);
        } else if (mutation === "latest-attempt") {
          primary.commands.taskRuns.createAttempt(taskId);
          assert.equal(primary.commands.taskRuns.get(taskId)?.revision, before.revision);
        } else if (mutation === "coherent-output-change" || mutation === "late-metadata") await mutateEvidence(root, attemptId, mutation);
        else if (mutation === "parent-result") {
          secondary.commands.agent.recordHostedToolResult("Task", { error: "parent identity changed" }, taskId, 1);
          await secondary.commands.agent.getSessionRecorder().flush();
        } else if (mutation === "duplicate-resume") duplicate = rpc("task.resume", { taskRunId: taskId });
        else if (mutation === "dispose") closing = secondary.runtime.close();
        release.resolve();
        const response = await pending as HostOperationResult<unknown>;
        const allowed = mutation === "duplicate-resume" || mutation === "late-metadata";
        assert.equal(response.accepted, allowed);
        if (duplicate) assert.equal((await duplicate as HostOperationResult<unknown>).accepted, true);
        await closing;
        if (mutation !== "dispose") await settle(() => !secondary.commands.hasBackgroundWork());
        const task = primary.commands.taskRuns.get(taskId)!;
        const output = (task.attempts[0]!.artifacts as { output?: string }).output;
        if (allowed) { assert.equal(output, contentFor("plain")); assert.equal(task.status, "completed"); }
        else { assert.equal(output, undefined); assert.equal(task.sessionId, undefined); assert.notEqual(task.status, "completed"); }
      } finally { release.resolve(); mock.mock.restore(); await closing; }
    });
  });
}

type CompletedFixture = Parameters<typeof fixture>[3] extends (value: infer Value) => Promise<void> ? Value : never;
async function completedFixture(t: TestContext, bound: boolean, outputCase: string, run: (value: CompletedFixture & { taskId: string; attemptId: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-completed-projection-"));
  let requests = 0;
  try {
    const identity = await crashAtProvider(root, bound, outputCase);
    await fixture(t, ownerConfig(), async () => { requests++; return textResponse("unexpected repeated model work"); }, async value => run({ ...value, taskId: identity.taskId, attemptId: identity.attemptId }), root);
    assert.equal(requests, 0, "completed recovery must perform zero provider calls");
  } finally { await rm(root, { recursive: true, force: true }); }
}

function contentFor(kind: string): string {
  if (kind === "redaction") return "A harmless synthetic example: token=fixture-placeholder; report finished.";
  if (kind === "large") return "長文🙂 exact report\n".repeat(4096);
  return "durable completed report survives process exit";
}
async function mutateEvidence(root: string, attemptId: string, mutation: string): Promise<void> {
  const sessionId = workerSessionId(attemptId);
  const store = new TurnStore(root, sessionId);
  const checkpoint = (await store.load())!;
  const facts = checkpoint.facts as {output?: string};
  const file = sessionFilePath(root, sessionId);
  const events = await readSessionEvents(file);
  const terminalIndex = events.findIndex(event => event.type === "turn_status" && event.status === "completed");
  const terminal = events[terminalIndex]!;
  assert.equal(terminal.type, "turn_status");
  if (terminal.type !== "turn_status") throw new Error("Missing fixture terminal");
  if (mutation === "output-mismatch" || mutation === "coherent-output-change") facts.output = "changed durable output";
  if (mutation === "summary-mismatch" || mutation === "coherent-output-change") terminal.summary = "changed durable output";
  if (mutation === "steps-mismatch") terminal.steps += 1;
  if (mutation === "reason-mismatch") terminal.stopReason = "step_limit";
  if (mutation === "matching-duplicate" || mutation === "matching-duplicate-covered" || mutation === "conflicting-terminal") {
    const duplicate = structuredClone(terminal);
    duplicate.runtime = { ...terminal.runtime!, eventId: randomUUID(), eventSeq: terminal.runtime!.eventSeq + 1 };
    if (mutation === "conflicting-terminal") { duplicate.status = "cancelled"; duplicate.stopReason = "cancelled"; }
    events.push(duplicate);
    if (mutation !== "matching-duplicate") checkpoint.runtimeHighWater = duplicate.runtime;
  }
  if (mutation === "foreign-terminal") {
    checkpoint.runtimeHighWater = structuredClone(events[terminalIndex - 1]!.runtime!);
    terminal.runtime = { ...terminal.runtime!, runId: "foreign-run", turnId: "foreign-turn" };
  }
  if (mutation === "checkpoint-before-terminal") checkpoint.runtimeHighWater = structuredClone(events[terminalIndex - 1]!.runtime!);
  if (mutation === "no-output") delete facts.output;
  if (mutation === "non-string-output") (facts as unknown as { output: unknown }).output = 17;
  if (mutation === "no-terminal") { events.splice(terminalIndex, 1); checkpoint.runtimeHighWater = structuredClone(events.at(-1)!.runtime!); }
  if (mutation === "invalid-terminal") (terminal as unknown as {steps: unknown}).steps = "corrupt";
  if (mutation === "post-terminal-message") events.push({ type: "user_message", content: "new operational input after completion", time: new Date().toISOString(), runtime: { ...terminal.runtime!, eventId: randomUUID(), eventSeq: terminal.runtime!.eventSeq + 1 } });
  if (mutation === "late-metadata") events.push({ type: "model_request", time: new Date().toISOString(), runtime: { ...terminal.runtime!, eventId: randomUUID(), eventSeq: terminal.runtime!.eventSeq + 1 }, metrics: {
    requestId: "late-accounting", provider: "fixture", modelId: "synthetic", startedAt: new Date().toISOString(), durationMs: 0, attempts: [], eventCount: 0
  } });
  await writeFile(file, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  await store.save(checkpoint.prompt, checkpoint.systemPrompt, checkpoint.messages, checkpoint.completedSteps, checkpoint.facts, checkpoint.terminal, checkpoint.previousTerminals, checkpoint.runtimeHighWater, checkpoint.turnId);
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
function textResponse(content: string): Response { return stream([{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]); }
function stream(parts: unknown[]): Response { return new Response([...parts.map(part => `data: ${JSON.stringify(part)}`), "data: [DONE]"].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } }); }
async function settle(done: () => boolean): Promise<void> { const deadline = Date.now() + 8_000; while (!done()) { if (Date.now() >= deadline) throw new Error("Owner work did not settle."); await setImmediate(); } }
async function crashAtProvider(root: string, bound: boolean, outputCase = "plain"): Promise<{ taskId: string; attemptId: string; owner: string }> {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "crash-worker", root, bound ? "bound" : "legacy", outputCase], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
