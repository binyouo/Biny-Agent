import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { pendingTaskVerificationApproval, readTaskVerificationContract, type TaskVerificationEvidence } from "../src/runtime/taskVerification.js";

/**
 * Backend fallback entry coverage: only ensureRuntime is injected. The receiver
 * inherits runtimeMutation and startFallbackTaskRun without a Desktop/UI
 * constructor. CommandRuntime, approval, verification, Bash permission and audit,
 * TaskRunStore, RuntimeAuthority, and graph projection are their real implementations.
 * The candidate-producing model turn is replaced by a fixed initial output.
 */
test("fallback task.approve advances and completes real permission-gated verification", { timeout: 20_000 }, async t => {
  await fixture(t, async ({ commands, taskRunId, approve, root }) => {
    await approve(approvalId(commands, taskRunId));
    assert.equal(commands.taskRuns.get(taskRunId)?.status, "needs_approval");
    assert.deepEqual(checks(commands, taskRunId), [["one", "passed"], ["two", "blocked"]]);
    await approve(approvalId(commands, taskRunId));
    assert.equal(commands.taskRuns.get(taskRunId)?.status, "completed");
    assert.deepEqual(checks(commands, taskRunId), [["one", "passed"], ["two", "passed"]]);
    assert.equal(await readFile(path.join(root, ".verification-state", "executed"), "utf8"), "one\ntwo\n");
  });
});

test("fallback task.approve rejects a delayed duplicate before rewriting a newer pending check", { timeout: 20_000 }, async t => {
  await fixture(t, async ({ commands, taskRunId, approve, root }) => {
    const firstId = approvalId(commands, taskRunId);
    const gate = holdFirstArtifactRead(t, root);
    const delayed = approve(firstId).then(
      () => ({ accepted: true as const }),
      error => ({ accepted: false as const, error: String(error) })
    );
    try {
      await Promise.race([
        gate.entered,
        delayed.then(result => assert.fail(`Approval settled before its fingerprint barrier: ${JSON.stringify(result)}`))
      ]);
      await approve(firstId);
      const secondId = approvalId(commands, taskRunId);
      assert.notEqual(secondId, firstId);
      assert.deepEqual(checks(commands, taskRunId), [["one", "passed"], ["two", "blocked"]]);
      const before = commands.taskRuns.get(taskRunId)!;
      const eventsBefore = commands.taskRuns.events(taskRunId);
      gate.release();
      const result = await delayed;
      const after = commands.taskRuns.get(taskRunId)!;
      const newEvents = commands.taskRuns.events(taskRunId).slice(eventsBefore.length);
      // Durable events retain transient rewrites even if command-result recovery
      // later reconstructs the second check before runtimeMutation returns.
      t.diagnostic(JSON.stringify({
        delayed: result,
        beforeRevision: before.revision,
        afterRevision: after.revision,
        firstId,
        secondId,
        afterPending: pendingTaskVerificationApproval(after.attempts.at(-1)?.verification)?.approvalId,
        newEvents: newEvents.map(event => {
          const payload = event.payload as { status?: string; verification?: TaskVerificationEvidence };
          return { eventType: event.eventType, status: payload.status,
            pendingCheck: pendingTaskVerificationApproval(payload.verification)?.checkId,
            checks: payload.verification?.checks.map(check => [check.checkId, check.status]) };
        })
      }));
      assert.equal(result.accepted, false, "the backend entry must reject the stale approval, not dispatch another closure");
      if (!result.accepted) assert.match(result.error, /stale|changed|current|approval/iu);
      assert.deepEqual(after, before, "a rejected approval cannot change the current task or candidate evidence");
      assert.deepEqual(commands.taskRuns.events(taskRunId), eventsBefore, "stale approval must append no durable events");
      assert.equal(approvalId(commands, taskRunId), secondId);
      assert.equal(await readFile(path.join(root, ".verification-state", "executed"), "utf8"), "one\n");
    } finally {
      gate.release();
      await delayed;
      gate.restore();
    }
  });
});

function approvalId(commands: CommandRuntime, taskRunId: string): string {
  const pending = pendingTaskVerificationApproval(commands.taskRuns.get(taskRunId)?.attempts.at(-1)?.verification);
  assert.ok(pending);
  return pending.approvalId;
}

function checks(commands: CommandRuntime, taskRunId: string): Array<[string, string]> {
  const evidence = commands.taskRuns.get(taskRunId)?.attempts.at(-1)?.verification as TaskVerificationEvidence;
  return evidence.checks.map(check => [check.checkId, check.status]);
}

async function fixture(t: TestContext, run: (context: {
  commands: CommandRuntime;
  root: string;
  taskRunId: string;
  approve: (approvalId: string) => Promise<unknown>;
}) => Promise<void>): Promise<void> {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-fallback-approval-")));
  const root = path.join(temporary, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("This backend test must not contact a model or network."); });
  const listener = t.mock.method(net.Server.prototype, "listen", () => { throw new Error("This backend test must not bind a socket."); });
  let commands: CommandRuntime | undefined;
  try {
    await mkdir(path.join(root, ".verification-state"), { recursive: true });
    await writeFile(path.join(root, "artifact.txt"), "stable candidate\n");
    await writeFile(path.join(root, "definition.txt"), "stable check definition\n");
    const config = structuredClone(defaultConfig);
    config.defaultModel = "synthetic";
    config.toolModel = "synthetic";
    config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
    config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
    config.permission.mode = "ask";
    config.permission.criticalAlwaysAsk = true;
    config.permission.denyPaths = [];
    config.checkpoints.enabled = false;
    config.extensions.subagent.enabled = true;
    config.extensions.skills = [];
    config.heartbeat.enabled = false;
    config.context.memory.enabled = false;
    config.context.identity.enabled = false;
    config.workspace.ignore.push(".verification-state");
    commands = await createCommandRuntime(root, { configStore: {
      load: async () => structuredClone(config), save: async () => undefined
    } });
    const contract = readTaskVerificationContract({
      objective: "verify two checks", artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1,
      checks: ["one", "two"].map(id => ({
        id,
        command: `node -e "require('node:fs').appendFileSync('.verification-state/executed', '${id}\\n')"`,
        definitionPaths: ["definition.txt"]
      }))
    });
    const taskRunId = commands.taskRuns.create({
      sessionId: commands.agent.getInfo().sessionId,
      task: { prompt: "candidate", verification: contract }
    }).taskRunId;
    const seeded = await runTaskClosure({
      taskRuns: commands.taskRuns, taskRunId, workspaceRoot: root, ignore: config.workspace.ignore,
      executor: commands, executeAttempt: async () => "candidate result"
    });
    assert.equal(seeded.status, "needs_approval");
    assert.deepEqual(checks(commands, taskRunId), [["one", "blocked"]]);
    const receiver = Object.create(DesktopAgentManager.prototype) as DesktopAgentManager;
    Object.defineProperty(receiver, "ensureRuntime", { value: async (projectId: string) => {
      assert.equal(projectId, "backend-fallback-project");
      return { commands };
    } });
    const approve = (id: string) => receiver.runtimeMutation("backend-fallback-project", "task.approve", { taskRunId, approvalId: id });
    await run({ commands, taskRunId, root, approve });
    assert.equal(network.mock.callCount(), 0);
    assert.equal(listener.mock.callCount(), 0);
    assert.deepEqual(commands.subagents?.listSnapshots(), [], "approval resumes verification without another model worker");
  } finally {
    await commands?.close();
    network.mock.restore();
    listener.mock.restore();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
}

function holdFirstArtifactRead(t: TestContext, root: string) {
  const entered = deferred();
  const released = deferred();
  const original = fs.createReadStream;
  let armed = true;
  const mock = t.mock.method(fs, "createReadStream", (filename: Parameters<typeof fs.createReadStream>[0], options: Parameters<typeof fs.createReadStream>[1]) => {
    const stream = original(filename, options);
    if (armed && String(filename) === path.join(root, "artifact.txt")) {
      armed = false;
      const read = stream._read.bind(stream);
      stream._read = size => { entered.resolve(); void released.promise.then(() => read(size)); };
    }
    return stream;
  });
  syncBuiltinESMExports();
  return { entered: entered.promise, release: released.resolve, restore: () => { mock.mock.restore(); syncBuiltinESMExports(); } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
