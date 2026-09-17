import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentRunOptions, AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent, AgentTurnOutcome } from "../src/agent/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionLeaseError, SessionLeaseStore } from "../src/runtime/SessionLease.js";
import { SessionRunLedger, type FinishSessionRunOptions, type StartSessionRunOptions } from "../src/session/runLedger.js";
import { SessionRecorder, type SessionTurnStatusEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs, resolveSessionFile } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolAccesses } from "../src/tools/access.js";
import type { Tool } from "../src/tools/types.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function main(): Promise<void> {
  await testCanonicalFaultBoundaries();
  await testSessionProjectionRecovery();
  await testSessionTerminalProjectionRecovery();
  await testAtomicRuntimeProjectionRollback();
  await testCanonicalTerminalAuthorityProjection();
  await testTerminalCommitOrdering();
  await testCancellationAfterCanonicalTerminalDoesNotLeaveBusySnapshot();
  await testDuplicateRunRetryDoesNotExecute();
  await testProviderFaultsBecomeTerminal();
  await testPermissionTargetChangeDoesNotExecute();
  await testSecondProcessCannotBypassLease();
  console.log("runtime fault injection tests passed");
}

async function testSessionProjectionRecovery(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-session-projection-"));
  const sessionId = "projection-recovery";
  try {
    await ensureAgentDirs(root);
    let failProjection = true;
    const recorder = new SessionRecorder(root, sessionId, undefined, {
      appendSessionEvent: () => {
        if (failProjection) {
          failProjection = false;
          throw new Error("injected authority projection failure");
        }
      }
    });
    recorder.setRuntimeContext({ runId: "run-projection", turnId: "turn-projection" });
    await assert.rejects(
      recorder.recordAndFlush({ type: "user_message", content: "canonical JSONL survives projection failure" }),
      /injected authority projection failure/
    );
    await recorder.close();

    const authority = await RuntimeEventAuthority.open(root);
    const firstProjection = authority.readEvents({ sessionId }).events;
    assert.equal(firstProjection.length, 1);
    assert.equal(firstProjection[0]?.eventId.length, 36);
    assert.equal(firstProjection[0]?.eventSeq, 1);
    assert.equal(firstProjection[0]?.runId, "run-projection");
    authority.close();

    const reopened = await RuntimeEventAuthority.open(root);
    assert.equal(reopened.readEvents({ sessionId }).events.length, 1, "reconciliation must be idempotent");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSessionTerminalProjectionRecovery(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-terminal-recovery-"));
  const sessionId = "terminal-recovery";
  try {
    await ensureAgentDirs(root);
    const authority = await RuntimeEventAuthority.open(root);
    authority.startRun({ runId: "terminal-recovery-run", sessionId, turnId: "terminal-recovery-turn" });
    const recorder = new SessionRecorder(root, sessionId);
    recorder.setRuntimeContext({ runId: "terminal-recovery-run", turnId: "terminal-recovery-turn" });
    const terminal = await recorder.recordAndFlush({
      type: "turn_status",
      status: "completed",
      stopReason: "model_stop",
      steps: 2
    });
    await recorder.close();

    const recovered = await authority.reconcileRunFromSession("terminal-recovery-run");
    assert.equal(recovered?.terminalStatus, "completed", "targeted reconciliation must repair a live owner projection");
    assert.equal(recovered?.terminalEventId, terminal.runtime?.eventId);
    authority.close();

    const reopened = await RuntimeEventAuthority.open(root);
    const run = reopened.getRun("terminal-recovery-run");
    assert.equal(run?.terminalStatus, "completed", "JSONL turn_status must complete an admitted run during startup reconciliation");
    assert.equal(run?.terminalEventId, terminal.runtime?.eventId);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testAtomicRuntimeProjectionRollback(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-atomic-projection-"));
  try {
    const authority = await RuntimeEventAuthority.open(root);
    assert.throws(() => authority.runEventTransaction({
      eventId: "atomic-projection-failure",
      sessionId: "atomic-session",
      invocationId: "atomic-invocation",
      runId: "atomic-run",
      turnId: "atomic-turn",
      eventType: "atomic.test",
      payload: { phase: "before-crash" }
    }, () => {
      authority.databaseHandle().prepare(
        "INSERT INTO goals (goal_id, workspace_id, status, title, payload_json, created_at, updated_at, revision) VALUES (?, ?, 'active', ?, '{}', ?, ?, 0)"
      ).run("atomic-goal", authority.workspaceId, "atomic", new Date().toISOString(), new Date().toISOString());
      throw new Error("injected projection crash");
    }), /injected projection crash/);
    assert.equal(authority.readEvents({ runId: "atomic-run" }).events.length, 0);
    assert.equal(authority.databaseHandle().prepare("SELECT goal_id FROM goals WHERE goal_id = ?").get("atomic-goal"), undefined);
    authority.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCanonicalTerminalAuthorityProjection(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-canonical-terminal-"));
  try {
    const authority = await RuntimeEventAuthority.open(root);
    authority.startRun({ runId: "canonical-run", sessionId: "canonical-session", turnId: "canonical-turn" });
    const terminal = authority.appendEvent({
      eventId: "canonical-terminal-event",
      eventSeq: 1,
      sessionId: "canonical-session",
      invocationId: "canonical-run",
      runId: "canonical-run",
      turnId: "canonical-turn",
      eventType: "session.turn_status",
      payload: { type: "turn_status", status: "failed", stopReason: "provider_error", steps: 1 }
    });
    const finished = authority.finishRun({
      runId: "canonical-run",
      status: "failed",
      terminalEventId: terminal.eventId,
      payload: { stopReason: "provider_error", steps: 1 }
    });
    assert.equal(finished.terminalEventId, terminal.eventId);
    assert.equal(authority.readEvents({ runId: "canonical-run" }).events.filter((event) => event.eventId === terminal.eventId).length, 1);
    assert.throws(() => authority.finishRun({ runId: "canonical-run", status: "completed", terminalEventId: terminal.eventId }), /already has terminal status/);
    authority.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCanonicalFaultBoundaries(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-facts-"));
  const sessionId = "fault-facts";
  const runId = "run-before-result";
  const turnId = "turn-facts";
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root, sessionId);
    recorder.setRuntimeContext({ runId, turnId });
    await recorder.recordAndFlush({ type: "user_message", content: "write once" });
    await recorder.recordAndFlush({
      type: "tool_call",
      tool: "Write",
      args: { path: "target.txt", content: "new" },
      toolCallId: "call-write",
      sequence: 1
    });
    const execution = await recorder.recordAndFlush({
      type: "tool_execution",
      tool: "Write",
      toolCallId: "call-write",
      sequence: 1,
      operationId: "operation-write",
      state: "side_effect_committed",
      fileChangeIsResult: true,
      change: { operation: "create", path: "target.txt", committed: true, diff: "+new" },
      retrySafety: "unsafe",
      evidence: "atomic rename committed"
    });
    const store = new TurnStore(root, sessionId);
    await store.save(
      "write once",
      undefined,
      [
        { role: "user", content: "write once" },
        { role: "assistant", content: [{ type: "toolCall", id: "call-write", name: "Write", arguments: { path: "target.txt", content: "new" } }] }
      ],
      1,
      undefined,
      undefined,
      undefined,
      execution.runtime
    );
    await recorder.close();

    const sessionFile = await resolveSessionFile(root, sessionId);
    const beforeResult = replaySessionEvents(await readSessionEvents(sessionFile), { expectedRuntimeHighWater: execution.runtime });
    assert.equal(beforeResult.recoveredToolResults[0]?.executionStatus, "succeeded");
    assert.equal(beforeResult.recoveredToolResults[0]?.operationId, "operation-write");
    assert.equal((await store.load())?.runtimeHighWater?.eventId, execution.runtime?.eventId);

    const continuationRecorder = new SessionRecorder(root, sessionId);
    continuationRecorder.setRuntimeContext({ runId: "run-recovery", turnId });
    const recovered = beforeResult.recoveredToolResults[0];
    assert.ok(recovered);
    await continuationRecorder.recordAndFlush(recovered);
    await continuationRecorder.close();
    const afterResult = replaySessionEvents(await readSessionEvents(sessionFile));
    assert.equal(afterResult.recoveredToolResults.length, 0, "a recovered result must not be appended twice");
    await store.clear();
    assert.equal(await store.load(), undefined, "a durable tool result may outlive its TurnStore checkpoint");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testTerminalCommitOrdering(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-terminal-"));
  try {
    const log: string[] = [];
    const runLedger = new RecordingLedger(root, log);
    const runtime = new InteractiveAgentRuntime(createFakeCommandRuntime(root, async function* (_input, options) {
      assert.equal(options.runId, "run-terminal");
      assert.equal(typeof options.turnId, "string");
      yield { type: "status", status: "completed" };
      yield done({ status: "completed", stopReason: "model_stop", finishReason: "stop", steps: 1, output: "done" });
    }, log), { runLedger });
    const hostEvents: string[] = [];
    runtime.subscribe((update) => {
      if (update.event) hostEvents.push(update.event.type);
      if (update.event?.type === "run.completed") log.push("host-terminal");
    });
    const submitted = runtime.submitPrompt("finish", [], { runId: "run-terminal", messageId: "message-terminal" });
    const outcome = await submitted.completion;
    assert.equal(outcome.status, "completed");
    assert.equal(log.indexOf("canonical-terminal") >= 0, true);
    assert.equal(log.indexOf("ledger-finish") > log.indexOf("canonical-terminal"), true);
    assert.equal(hostEvents.indexOf("run.completed") >= 0, true);
    assert.equal(log.indexOf("host-terminal") > log.indexOf("ledger-finish"), true);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCancellationAfterCanonicalTerminalDoesNotLeaveBusySnapshot(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-canonical-cancel-"));
  try {
    let releaseStream: (() => void) | undefined;
    let streamReachedCanonical: (() => void) | undefined;
    const reachedCanonical = new Promise<void>((resolve) => {
      streamReachedCanonical = resolve;
    });
    const streamRelease = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let canonical: SessionTurnStatusEvent | undefined;
    const commandRuntime = createFakeCommandRuntime(root, async function* (_input, options) {
      canonical = {
        type: "turn_status",
        status: "incomplete",
        stopReason: "hard_step_limit",
        steps: 3,
        summary: "The hard step limit was reached.",
        resumable: true,
        runtime: {
          eventId: "canonical-cancel-terminal",
          eventSeq: 4,
          runId: options.runId!,
          turnId: options.turnId!
        }
      };
      // AgentSession 已经持久化 canonical status，但 Host 还没拿到 done 时，用户点击停止。
      yield { type: "status", status: "incomplete" };
      streamReachedCanonical?.();
      await streamRelease;
    }, [], {
      ensureTerminalOutcome: async (_runId: string, _turnId: string, outcome: AgentTurnOutcome) => {
        if (!canonical || outcome.status !== canonical.status) {
          throw new Error("Run already has a conflicting terminal outcome.");
        }
        return canonical.runtime!;
      },
      readTerminalOutcome: async () => canonical
    });
    const runtime = new InteractiveAgentRuntime(commandRuntime);
    const hostEvents: string[] = [];
    runtime.subscribe((update) => {
      if (update.event) hostEvents.push(update.event.type);
    });
    const submitted = runtime.submitPrompt("stop after canonical status", [], {
      runId: "canonical-cancel-run",
      messageId: "canonical-cancel-message",
      turnId: "canonical-cancel-turn"
    });
    await reachedCanonical;
    assert.equal(runtime.cancelRun(submitted.runId), true);
    releaseStream?.();

    const outcome = await submitted.completion;
    assert.equal(outcome.status, "incomplete", "the existing canonical terminal status must win over late cancellation");
    assert.equal(runtime.getSnapshot().state.kind, "idle", "terminal recovery must release the interactive runtime");
    assert.equal(hostEvents.filter((type) => type === "run.incomplete").length, 1);
    assert.equal(hostEvents.includes("run.failed"), false);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDuplicateRunRetryDoesNotExecute(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-duplicate-run-"));
  const authority = await RuntimeEventAuthority.open(root);
  let executions = 0;
  try {
    const commandRuntime = createFakeCommandRuntime(root, async function* (_input, _options) {
      executions += 1;
      yield done({ status: "completed", stopReason: "model_stop", steps: 1, output: "once" });
    }, []);
    const firstRuntime = new InteractiveAgentRuntime(commandRuntime, { runtimeAuthority: authority });
    const first = await firstRuntime.submitPrompt("once", [], { runId: "duplicate-run", messageId: "first-message" }).completion;
    assert.equal(first.output, "once");

    const retryRuntime = new InteractiveAgentRuntime(commandRuntime, { runtimeAuthority: authority });
    const retry = await retryRuntime.submitPrompt("once", [], { runId: "duplicate-run", messageId: "retry-message" }).completion;
    assert.equal(retry.output, "once");
    assert.equal(executions, 1, "retrying the same runId must reuse the terminal completion");
    await retryRuntime.close();
    await firstRuntime.close();
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testProviderFaultsBecomeTerminal(): Promise<void> {
  const scenarios: Array<{ name: string; stream: (input: string, options: AgentRunOptions) => AsyncGenerator<AgentSessionEvent> }> = [
    {
      name: "no-terminal-finish",
      async *stream() {
        yield { type: "status", status: "thinking" };
      }
    },
    {
      name: "provider-request-error",
      async *stream() {
        yield { type: "error", message: "provider request failed", fatal: true };
      }
    },
    {
      name: "context-overflow",
      async *stream() {
        yield* [] as AgentSessionEvent[];
        throw new Error("context window overflow");
      }
    }
  ];
  for (const scenario of scenarios) {
    const root = await mkdtemp(path.join(os.tmpdir(), `biny-runtime-fault-${scenario.name}-`));
    try {
      const log: string[] = [];
      const runtime = new InteractiveAgentRuntime(createFakeCommandRuntime(root, scenario.stream, log));
      const hostEvents: string[] = [];
      runtime.subscribe((update) => {
        if (update.event) hostEvents.push(update.event.type);
      });
      const outcome = await runtime.submitPrompt(scenario.name).completion;
      assert.equal(outcome.status, "failed");
      assert.equal(log.filter((entry) => entry === "canonical-terminal").length, 1);
      assert.equal(hostEvents.filter((type) => type === "run.failed").length, 1);
      assert.equal(hostEvents.includes("run.completed"), false);
      await runtime.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function testPermissionTargetChangeDoesNotExecute(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-permission-"));
  try {
    const workspaceRoot = await realpath(root);
    await ensureAgentDirs(workspaceRoot);
    const target = path.join(workspaceRoot, "target.txt");
    await writeFile(target, "before");
    const config = structuredClone(defaultConfig) as AgentConfig;
    config.permission.mode = "ask";
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      name: "Write",
      description: "Write the target file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false
      },
      schema: z.object({ path: z.string(), content: z.string() }),
      risk: "write",
      resolveExecution(args: { path: string; content: string }) {
        return {
          approvalRule: "Write",
          accesses: ToolAccesses.writeFile(target),
          async execute() {
            executions += 1;
            await writeFile(target, args.content);
            return { written: true };
          }
        };
      }
    } satisfies Tool<{ path: string; content: string }>);
    const recorder = new SessionRecorder(workspaceRoot, "permission-fault");
    const coordinator = new ToolExecutionCoordinator(
      {
        workspaceRoot,
        config,
        recorder,
        toolRegistry: registry,
        confirmPermission: async () => {
          await writeFile(target, "changed-after-preview");
          return { approved: true, scope: "once" };
        }
      },
      new PermissionManager(config.permission),
      () => undefined
    );
    const tool = coordinator.createAgentTools().find((candidate) => candidate.name === "Write");
    assert.ok(tool);
    const result = await tool.execute("permission-call", { path: "target.txt", content: "must-not-write" });
    await coordinator.waitForIdle();
    assert.equal(executions, 0);
    assert.equal(await readFile(target, "utf8"), "changed-after-preview");
    const details = result.details as { stalePreview?: boolean } | undefined;
    assert.equal(details?.stalePreview, true);
    const events = await readSessionEvents(recorder.filePath);
    const toolResult = events.find((event) => event.type === "tool_result" && event.toolCallId === "permission-call");
    assert.equal(toolResult?.type === "tool_result" ? toolResult.executionStatus : undefined, "failed");
    assert.doesNotThrow(() => coordinator.assertCanContinue());
    await recorder.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSecondProcessCannotBypassLease(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fault-lease-"));
  let child: ReturnType<typeof spawn> | undefined;
  let store: SessionLeaseStore | undefined;
  try {
    child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--lease-worker", root], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    await waitForReady(child);
    store = await SessionLeaseStore.open(root);
    assert.throws(() => store!.acquire("lease-session"), SessionLeaseError);
    child.kill("SIGTERM");
    await waitForExit(child);
  } finally {
    store?.close();
    child?.kill();
    await rm(root, { recursive: true, force: true });
  }
}

class RecordingLedger extends SessionRunLedger {
  constructor(root: string, private readonly log: string[]) {
    super(root);
  }

  override async start(options: StartSessionRunOptions) {
    this.log.push("ledger-start");
    return await super.start(options);
  }

  override async finish(runId: string, options: FinishSessionRunOptions) {
    this.log.push("ledger-finish");
    return await super.finish(runId, options);
  }
}

function createFakeCommandRuntime(
  root: string,
  stream: (input: string, options: AgentRunOptions) => AsyncGenerator<AgentSessionEvent>,
  log: string[],
  agentOverrides: Record<string, unknown> = {}
): CommandRuntime {
  const info: AgentSessionInfo = {
    workspaceRoot: root,
    sessionId: "fault-session",
    sessionFile: path.join(root, "fault-session.jsonl"),
    provider: "test",
    modelLabel: "test/model",
    reasoningLabel: "Off",
    modelAlias: "test",
    thinking: "off"
  };
  const agent = {
    getInfo: () => info,
    getPermissionMode: () => "ask" as const,
    setPermissionMode: async () => undefined,
    prompt: stream,
    continueInterruptedTurn: async function* () { yield* emptyAgentSessionEvents(); },
    interruptedTurn: async () => undefined,
    contextStatus: async () => ({}) as never,
    ensureTerminalOutcome: async (runId: string, turnId: string, _outcome: AgentTurnOutcome) => {
      log.push("canonical-terminal");
      return { eventId: `terminal-${runId}`, eventSeq: 1, runId, turnId };
    },
    recordError: () => undefined,
    close: async () => undefined,
    ...agentOverrides
  };
  return {
    workspaceRoot: root,
    persistenceRoot: root,
    config: defaultConfig,
    agent,
    refreshSkills: async () => undefined,
    setSubagentParentRunId: () => undefined,
    cancelSubagentTasks: () => undefined,
    close: async () => undefined
  } as unknown as CommandRuntime;
}

function done(outcome: AgentTurnOutcome): AgentSessionEvent {
  return { type: "done", content: outcome.output, outcome };
}

async function* emptyAgentSessionEvents(): AsyncGenerator<AgentSessionEvent> {
  yield* [];
}

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Lease worker did not become ready.")), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes("ready\n")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

async function leaseWorker(root: string): Promise<void> {
  const store = await SessionLeaseStore.open(root);
  const lease = store.acquire("lease-session");
  process.stdout.write("ready\n");
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  lease.close();
  store.close();
}

if (process.argv.includes("--lease-worker")) {
  const root = process.argv.at(-1);
  if (!root) throw new Error("Missing lease worker root.");
  await leaseWorker(root);
} else {
  await main();
}
