import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../src/agent/types.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { PermissionManager, type PermissionMode } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { GoalGraphStore, GraphSupervisor } from "../src/runtime/GoalGraphStore.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import {
  fingerprintTaskVerificationDefinitions,
  readTaskDefinition,
  readTaskVerificationContract,
  recoverTaskCheckExecution,
  taskCheckToolCallId,
  taskVerificationFingerprint,
  verifyTaskCandidate,
  type TaskCandidateArtifacts,
  type TaskCommandExecution,
  type TaskCommandExecutor,
  type TaskVerificationContract
} from "../src/runtime/taskVerification.js";
import { createRunCommandTool } from "../src/tools/shell/runCommand.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolOperationId } from "../src/tools/types.js";

interface Fixture {
  root: string;
  authority: RuntimeEventAuthority;
  tasks: DurableTaskRunStore;
  graphs: GoalGraphStore;
  executor: TaskCommandExecutor;
  close(): Promise<void>;
}

const verificationIgnore = [".biny", ".verification-state"];

async function main(): Promise<void> {
  await testGraphVerificationRepairAndDownstreamUnlock();
  await testFailedVerificationDoesNotUnlockDownstream();
  await testRepairLimitStopsAttempts();
  await testUnavailableEnvironmentDoesNotRepair();
  await testCancellationAndLateEvidenceCannotComplete();
  await testSubagentCompletionStopsAtVerifying();
  await testVerifyingRecoveryDoesNotRepeatWorker();
  await testGraphRecoveryResumesVerificationOnly();
  await testGraphRecoveryProjectsCompletedVerification();
  await testUnsafeVerifyingRecoveryBlocks();
  await testVerificationDefinitionCannotBeWeakened();
  await testRepairScopeViolationBlocksCompletion();
  await testDefinitionChangeInvalidatesPassedEvidence();
  await testStaleAttemptEvidenceCannotAdvanceCurrentAttempt();
  await testDuplicateSubagentCompletionIsIdempotent();
  await testPersistedPassedEvidenceRepairsStatusWithoutCommand();
  await testAttemptLimitSurvivesStoreReopen();
  await testProcessBoundaryReusesDurableToolResult();
  await testProcessBoundaryBlocksUnknownToolOutcome();
  await testLegacyTaskCompatibility();
  console.log("task verification tests passed");
}

async function testGraphVerificationRepairAndDownstreamUnlock(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "bad\n", "utf8");
    const graph = fixture.graphs.createGraph(undefined, [
      {
        nodeKey: "build",
        prompt: "produce artifact",
        verification: verificationContract(2)
      },
      { nodeKey: "publish", prompt: "consume verified artifact", dependencies: ["build"] }
    ]);
    fixture.graphs.startGraph(graph.graphId);
    let workerCalls = 0;
    const runtime = graphRuntime(async (prompt) => {
      workerCalls += 1;
      if (prompt.includes("定向修复 Attempt")) await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
      return `worker-${String(workerCalls)}`;
    });
    const supervisor = graphSupervisor(fixture, runtime);
    try {
      await tickAndSettle(supervisor);
      await waitForGraphNodeStatus(fixture.graphs, graph.graphId, "build", "completed");
      const afterBuild = fixture.graphs.inspectGraph(graph.graphId);
      assert.equal(
        afterBuild.nodes.find((node) => node.nodeKey === "build")?.status,
        "completed",
        JSON.stringify({ graph: afterBuild, tasks: fixture.tasks.list({ limit: 20 }).tasks })
      );
      assert.equal(afterBuild.nodes.find((node) => node.nodeKey === "publish")?.status, "pending");
      const buildTask = fixture.tasks.get(`graph:${graph.graphId}:${afterBuild.nodes[0]!.nodeId}`);
      assert.equal(buildTask?.attempts.length, 2);
      assert.equal(buildTask?.attempts[0]?.status, "failed");
      assert.equal(buildTask?.attempts[1]?.status, "completed");
      assert.match(JSON.stringify(buildTask?.attempts[0]?.verification), /Command exited with code 1/u);
      assert.match(JSON.stringify(buildTask?.attempts[1]?.verification), /"status":"passed"/u);
      assert.equal(await readFile(path.join(fixture.root, "artifact.txt"), "utf8"), "good\n");

      await tickAndSettle(supervisor);
      await waitForGraphNodeStatus(fixture.graphs, graph.graphId, "publish", "completed");
      assert.equal(fixture.graphs.inspectGraph(graph.graphId).status, "completed");
      assert.equal(workerCalls, 3, "two build Attempts plus the downstream node should execute");
    } finally {
      supervisor.stop();
    }
  } finally {
    await fixture.close();
  }
}

async function testFailedVerificationDoesNotUnlockDownstream(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "bad\n", "utf8");
    const graph = fixture.graphs.createGraph(undefined, [
      { nodeKey: "build", prompt: "leave artifact bad", verification: verificationContract(1) },
      { nodeKey: "publish", prompt: "must not run", dependencies: ["build"] }
    ]);
    fixture.graphs.startGraph(graph.graphId);
    let workerCalls = 0;
    const supervisor = graphSupervisor(fixture, graphRuntime(async () => {
      workerCalls += 1;
      return "candidate";
    }));
    try {
      await tickAndSettle(supervisor);
      await waitForGraphNodeStatus(fixture.graphs, graph.graphId, "build", "failed");
      const inspected = fixture.graphs.inspectGraph(graph.graphId);
      assert.equal(inspected.status, "failed");
      assert.equal(inspected.nodes[0]?.status, "failed");
      assert.equal(inspected.nodes[1]?.status, "pending");
      assert.equal(workerCalls, 1);
    } finally {
      supervisor.stop();
    }
  } finally {
    await fixture.close();
  }
}

async function testRepairLimitStopsAttempts(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "bad\n", "utf8");
    const task = fixture.tasks.create({ task: { prompt: "try twice", verification: verificationContract(2) } });
    let workerCalls = 0;
    const result = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: fixture.executor,
      executeAttempt: async () => {
        workerCalls += 1;
        return `candidate-${String(workerCalls)}`;
      }
    });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason ?? "", /limit is 2/u);
    assert.equal(fixture.tasks.get(task.taskRunId)?.attempts.length, 2);
    assert.equal(workerCalls, 2);
  } finally {
    await fixture.close();
  }
}

async function testUnavailableEnvironmentDoesNotRepair(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "bad\n", "utf8");
    const contract = {
      ...verificationContract(3),
      checks: [{ id: "missing", command: "biny-command-that-does-not-exist" }]
    };
    const task = fixture.tasks.create({ task: { prompt: "do not rewrite for missing environment", verification: contract } });
    let workerCalls = 0;
    const result = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: fixture.executor,
      executeAttempt: async () => {
        workerCalls += 1;
        return "candidate";
      }
    });
    assert.equal(result.status, "blocked");
    assert.equal(workerCalls, 1);
    assert.equal(fixture.tasks.get(task.taskRunId)?.attempts.length, 1);
  } finally {
    await fixture.close();
  }

  const denied = await createFixture("read-only");
  try {
    await writeFile(path.join(denied.root, "artifact.txt"), "good\n", "utf8");
    const task = denied.tasks.create({ task: { prompt: "permission blocked", verification: verificationContract(3) } });
    let workerCalls = 0;
    const result = await runTaskClosure({
      taskRuns: denied.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: denied.root,
      ignore: verificationIgnore,
      executor: denied.executor,
      executeAttempt: async () => {
        workerCalls += 1;
        return "candidate";
      }
    });
    assert.equal(result.status, "blocked");
    assert.equal(workerCalls, 1);
  } finally {
    await denied.close();
  }
}

async function testCancellationAndLateEvidenceCannotComplete(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    const task = fixture.tasks.create({ task: { prompt: "cancel during verification", verification: verificationContract(1) } });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const delayedExecutor: TaskCommandExecutor = {
      executeTaskCheck: async () => {
        await waiting;
        return { result: { status: "completed", exitCode: 0, stdout: "", stderr: "" }, toolCallId: "late-check", eventReferences: ["late-check"] };
      }
    };
    const closure = runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: delayedExecutor,
      executeAttempt: async () => "candidate"
    });
    await waitForStatus(fixture.tasks, task.taskRunId, "verifying");
    const attempt = fixture.tasks.get(task.taskRunId)?.attempts.at(-1);
    assert.ok(attempt);
    fixture.tasks.transition(task.taskRunId, "cancelled", { attemptId: attempt.attemptId });
    release();
    assert.equal((await closure).status, "cancelled");
    assert.equal(fixture.tasks.get(task.taskRunId)?.status, "cancelled");
  } finally {
    await fixture.close();
  }
}

async function testVerifyingRecoveryDoesNotRepeatWorker(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    const contract = verificationContract(2);
    const task = fixture.tasks.create({ task: { prompt: "resume verification", verification: contract } });
    const attempt = fixture.tasks.createAttempt(task.taskRunId);
    fixture.tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
    fixture.tasks.transition(task.taskRunId, "verifying", {
      attemptId: attempt.attemptId,
      artifacts: await persistedCandidate(fixture.root, contract, "persisted candidate")
    });
    let workerCalls = 0;
    const result = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: fixture.executor,
      executeAttempt: async () => {
        workerCalls += 1;
        return "unexpected rerun";
      }
    });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(workerCalls, 0);
    assert.equal(fixture.tasks.get(task.taskRunId)?.attempts.length, 1);
  } finally {
    await fixture.close();
  }
}

async function testSubagentCompletionStopsAtVerifying(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    const task = fixture.tasks.create({ task: { prompt: "candidate only", verification: verificationContract(1) } });
    const attempt = fixture.tasks.createAttempt(task.taskRunId);
    const snapshot = {
      taskId: "subagent-execution-id",
      parentRunId: task.taskRunId,
      task: "candidate only",
      status: "queued" as const,
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 1_000).toISOString(),
      accessMode: "workspace" as const
    };
    const binding = {
      taskRunId: task.taskRunId,
      attemptId: attempt.attemptId,
      completedStatus: "verifying" as const
    };
    fixture.tasks.syncSubagentSnapshot(snapshot, binding);
    fixture.tasks.syncSubagentSnapshot({ ...snapshot, status: "running" }, binding);
    fixture.tasks.syncSubagentSnapshot({ ...snapshot, status: "completed" }, binding);
    assert.equal(fixture.tasks.get(task.taskRunId)?.status, "verifying");
  } finally {
    await fixture.close();
  }
}

async function testUnsafeVerifyingRecoveryBlocks(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    const task = fixture.tasks.create({ task: { prompt: "missing candidate", verification: verificationContract(2) } });
    const attempt = fixture.tasks.createAttempt(task.taskRunId);
    fixture.tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
    fixture.tasks.transition(task.taskRunId, "verifying", { attemptId: attempt.attemptId });
    const result = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: fixture.executor,
      executeAttempt: async () => "must not run"
    });
    assert.equal(result.status, "blocked");
    assert.match(result.reason ?? "", /persisted candidate/u);
  } finally {
    await fixture.close();
  }
}

async function testGraphRecoveryResumesVerificationOnly(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    const contract = verificationContract(2);
    const graph = fixture.graphs.createGraph(undefined, [{
      nodeKey: "recover",
      prompt: "resume only verification",
      verification: contract
    }]);
    fixture.graphs.startGraph(graph.graphId);
    const node = fixture.graphs.readyNodes(graph.graphId)[0]!;
    const taskRunId = `graph:${graph.graphId}:${node.nodeId}`;
    assert.ok(fixture.graphs.claimIntent(graph.graphId, node.nodeId, "before-restart", taskRunId));
    const task = fixture.tasks.create({ taskRunId, task: node.intent, parentRunId: `graph:${graph.graphId}` });
    const attempt = fixture.tasks.createAttempt(task.taskRunId);
    fixture.tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
    fixture.tasks.transition(task.taskRunId, "verifying", {
      attemptId: attempt.attemptId,
      artifacts: await persistedCandidate(fixture.root, contract, "persisted candidate")
    });

    fixture.graphs.recoverRunningNodes(fixture.tasks);
    assert.equal(fixture.graphs.inspectGraph(graph.graphId).nodes[0]?.status, "ready");
    let workerCalls = 0;
    const supervisor = graphSupervisor(fixture, graphRuntime(async () => {
      workerCalls += 1;
      return "must not rerun";
    }));
    try {
      await tickAndSettle(supervisor);
      await waitForGraphNodeStatus(fixture.graphs, graph.graphId, "recover", "completed");
      assert.equal(workerCalls, 0);
      assert.equal(fixture.tasks.get(taskRunId)?.attempts.length, 1);
    } finally {
      supervisor.stop();
    }
  } finally {
    await fixture.close();
  }
}

async function testGraphRecoveryProjectsCompletedVerification(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    const contract = verificationContract(1);
    const graph = fixture.graphs.createGraph(undefined, [{ nodeKey: "project", prompt: "persist before projection", verification: contract }]);
    fixture.graphs.startGraph(graph.graphId);
    const node = fixture.graphs.readyNodes(graph.graphId)[0]!;
    const taskRunId = `graph:${graph.graphId}:${node.nodeId}`;
    assert.ok(fixture.graphs.claimIntent(graph.graphId, node.nodeId, "projection-boundary", taskRunId));
    fixture.tasks.create({ taskRunId, task: node.intent, parentRunId: `graph:${graph.graphId}` });
    const completed = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: fixture.executor,
      executeAttempt: async () => "persisted output"
    });
    assert.equal(completed.status, "completed");
    assert.equal(fixture.graphs.inspectGraph(graph.graphId).nodes[0]?.status, "running");

    fixture.graphs.recoverRunningNodes(fixture.tasks);
    assert.equal(fixture.graphs.inspectGraph(graph.graphId).nodes[0]?.status, "ready");
    let workerCalls = 0;
    const supervisor = graphSupervisor(fixture, graphRuntime(async () => {
      workerCalls += 1;
      return "must not rerun";
    }));
    try {
      await tickAndSettle(supervisor);
      await waitForGraphNodeStatus(fixture.graphs, graph.graphId, "project", "completed");
      assert.equal(workerCalls, 0);
    } finally {
      supervisor.stop();
    }
  } finally {
    await fixture.close();
  }
}

async function testVerificationDefinitionCannotBeWeakened(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "bad\n", "utf8");
    await writeFile(path.join(fixture.root, "package.json"), "{\"scripts\":{\"verify\":\"node verify.mjs\"}}\n", "utf8");
    await writeFile(path.join(fixture.root, "verify.mjs"), "import fs from 'node:fs'; process.exit(fs.readFileSync('artifact.txt', 'utf8').trim() === 'good' ? 0 : 1);\n", "utf8");
    const contract = readTaskVerificationContract({
      version: 1,
      objective: "run the original verification script",
      checks: [{ id: "script", command: "npm run verify", definitionPaths: ["package.json", "verify.mjs"] }],
      artifactPaths: ["artifact.txt"],
      allowedRepairPaths: ["artifact.txt", "package.json", "verify.mjs"],
      maxAttempts: 2
    });
    const task = fixture.tasks.create({ task: { prompt: "do not weaken verification", verification: contract } });
    let checks = 0;
    const result = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: {
        executeTaskCheck: async (input) => {
          checks += 1;
          return await fixture.executor.executeTaskCheck(input);
        }
      },
      executeAttempt: async () => {
        await writeFile(path.join(fixture.root, "package.json"), "{\"scripts\":{\"verify\":\"node -e \\\"process.exit(0)\\\"\"}}\n", "utf8");
        return "candidate";
      }
    });
    assert.equal(result.status, "blocked");
    assert.match(result.reason ?? "", /definition inputs changed/u);
    assert.equal(checks, 0, "a weakened verification script must be rejected before execution");
  } finally {
    await fixture.close();
  }
}

async function testRepairScopeViolationBlocksCompletion(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    const contract = verificationContract(1);
    const task = fixture.tasks.create({ task: { prompt: "touch only artifact.txt", verification: contract } });
    let checks = 0;
    const result = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: {
        executeTaskCheck: async (input) => {
          checks += 1;
          return await fixture.executor.executeTaskCheck(input);
        }
      },
      executeAttempt: async () => {
        await writeFile(path.join(fixture.root, "outside.txt"), "out of scope\n", "utf8");
        return "candidate";
      }
    });
    assert.equal(result.status, "blocked");
    assert.match(result.reason ?? "", /outside allowedRepairPaths/u);
    assert.equal(checks, 0);
    assert.deepEqual(result.evidence?.repairScope?.violationPaths, ["outside.txt"]);
  } finally {
    await fixture.close();
  }
}

async function testDefinitionChangeInvalidatesPassedEvidence(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    await writeFile(path.join(fixture.root, "verification.config.json"), "{\"strict\":true}\n", "utf8");
    const contract = readTaskVerificationContract({
      ...verificationContract(1),
      checks: [{ ...verificationContract(1).checks[0], definitionPaths: ["verification.config.json"] }]
    });
    const task = fixture.tasks.create({ task: { prompt: "produce verified artifact", verification: contract } });
    const completed = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: fixture.executor,
      executeAttempt: async () => "candidate"
    });
    assert.equal(completed.status, "completed");
    await writeFile(path.join(fixture.root, "verification.config.json"), "{\"strict\":false}\n", "utf8");
    let checks = 0;
    const reconciled = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: { executeTaskCheck: async () => { checks += 1; throw new Error("must not rerun a terminal task"); } },
      executeAttempt: async () => "must not run"
    });
    assert.equal(reconciled.status, "blocked");
    assert.match(reconciled.reason ?? "", /no longer matches/u);
    assert.equal(checks, 0);
  } finally {
    await fixture.close();
  }
}

async function testStaleAttemptEvidenceCannotAdvanceCurrentAttempt(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    const contract = verificationContract(2);
    const task = fixture.tasks.create({ task: { prompt: "stale verification", verification: contract } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const closure = runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: {
        executeTaskCheck: async () => {
          await gate;
          return { result: { exitCode: 0 }, toolCallId: "late", eventReferences: ["late"] };
        }
      },
      executeAttempt: async () => "candidate-1"
    });
    await waitForStatus(fixture.tasks, task.taskRunId, "verifying");
    const first = fixture.tasks.get(task.taskRunId)?.attempts.at(-1);
    assert.ok(first);
    fixture.tasks.prepareVerificationRepair(task.taskRunId, first.attemptId, {
      verification: { status: "failed" },
      artifacts: first.artifacts,
      failure: { message: "superseded" }
    });
    const second = fixture.tasks.createAttempt(task.taskRunId);
    fixture.tasks.transition(task.taskRunId, "running", { attemptId: second.attemptId });
    release();
    assert.equal((await closure).status, "cancelled");
    const current = fixture.tasks.get(task.taskRunId);
    assert.equal(current?.status, "running");
    assert.equal(current?.attempts.at(-1)?.attemptId, second.attemptId);
  } finally {
    await fixture.close();
  }
}

async function testDuplicateSubagentCompletionIsIdempotent(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    const task = fixture.tasks.create({ task: { prompt: "duplicate callback", verification: verificationContract(1) } });
    const attempt = fixture.tasks.createAttempt(task.taskRunId);
    const snapshot = {
      taskId: "duplicate-callback",
      parentRunId: task.taskRunId,
      task: "duplicate callback",
      status: "running" as const,
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 1_000).toISOString(),
      accessMode: "workspace" as const
    };
    const binding = { taskRunId: task.taskRunId, attemptId: attempt.attemptId, completedStatus: "verifying" as const };
    fixture.tasks.syncSubagentSnapshot(snapshot, binding);
    fixture.tasks.syncSubagentSnapshot({ ...snapshot, status: "completed" }, binding);
    const revision = fixture.tasks.get(task.taskRunId)?.revision;
    fixture.tasks.syncSubagentSnapshot({ ...snapshot, status: "completed" }, binding);
    const current = fixture.tasks.get(task.taskRunId);
    assert.equal(current?.status, "verifying");
    assert.equal(current?.revision, revision);
    assert.equal(current?.attempts.length, 1);
  } finally {
    await fixture.close();
  }
}

async function testPersistedPassedEvidenceRepairsStatusWithoutCommand(): Promise<void> {
  const fixture = await createFixture("full-access");
  try {
    await writeFile(path.join(fixture.root, "artifact.txt"), "good\n", "utf8");
    const contract = verificationContract(1);
    const task = fixture.tasks.create({ task: { prompt: "persisted pass", verification: contract } });
    const attempt = fixture.tasks.createAttempt(task.taskRunId);
    fixture.tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
    const artifacts = await persistedCandidate(fixture.root, contract, "candidate");
    fixture.tasks.transition(task.taskRunId, "verifying", { attemptId: attempt.attemptId, artifacts });
    const evidence = await verifyTaskCandidate({
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      taskRunId: task.taskRunId,
      attemptId: attempt.attemptId,
      contract,
      definitionFingerprint: artifacts.definitionFingerprint,
      repairScope: artifacts.repairScope,
      executor: fixture.executor
    });
    assert.equal(evidence.status, "passed");
    fixture.tasks.transition(task.taskRunId, "verifying", {
      attemptId: attempt.attemptId,
      verification: evidence,
      artifacts: { ...artifacts, artifactFingerprint: evidence.artifactFingerprint }
    });
    let checks = 0;
    const result = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: { executeTaskCheck: async () => { checks += 1; throw new Error("must reuse evidence"); } },
      executeAttempt: async () => "must not run"
    });
    assert.equal(result.status, "completed");
    assert.equal(checks, 0);
  } finally {
    await fixture.close();
  }
}

async function testAttemptLimitSurvivesStoreReopen(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-task-verification-reopen-"));
  await ensureAgentDirs(root);
  await writeFile(path.join(root, "artifact.txt"), "bad\n", "utf8");
  const contract = verificationContract(2);
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  let tasks = await DurableTaskRunStore.open(root, authority);
  let realExecutor = createRealTaskExecutor(root, "full-access", authority, "verification-reopen-1");
  const task = tasks.create({ taskRunId: "reopen-limit", task: { prompt: "do not exceed two total Attempts", verification: contract } });
  const first = tasks.createAttempt(task.taskRunId);
  tasks.transition(task.taskRunId, "running", { attemptId: first.attemptId });
  const artifacts = await persistedCandidate(root, contract, "candidate-1");
  tasks.transition(task.taskRunId, "verifying", { attemptId: first.attemptId, artifacts });
  const evidence = await verifyTaskCandidate({
    workspaceRoot: root,
    ignore: verificationIgnore,
    taskRunId: task.taskRunId,
    attemptId: first.attemptId,
    contract,
    definitionFingerprint: artifacts.definitionFingerprint,
    repairScope: artifacts.repairScope,
    executor: realExecutor.executor
  });
  assert.equal(evidence.status, "failed");
  const persisted = { ...artifacts, artifactFingerprint: evidence.artifactFingerprint };
  tasks.transition(task.taskRunId, "verifying", { attemptId: first.attemptId, verification: evidence, artifacts: persisted });
  tasks.prepareVerificationRepair(task.taskRunId, first.attemptId, {
    verification: evidence,
    artifacts: persisted,
    failure: { message: evidence.reason }
  });
  await realExecutor.recorder.close();
  tasks.close();
  authority.close();

  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  tasks = await DurableTaskRunStore.open(root, authority);
  realExecutor = createRealTaskExecutor(root, "full-access", authority, "verification-reopen-2");
  try {
    const result = await runTaskClosure({
      taskRuns: tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: root,
      ignore: verificationIgnore,
      executor: realExecutor.executor,
      executeAttempt: async () => "candidate-2"
    });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason ?? "", /limit is 2/u);
    assert.equal(tasks.get(task.taskRunId)?.attempts.length, 2);
  } finally {
    await realExecutor.recorder.close();
    tasks.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testProcessBoundaryReusesDurableToolResult(): Promise<void> {
  const root = await prepareProcessBoundaryTask("process-reuse");
  try {
    await runVerificationChild(root, "process-reuse", "execute");
    await runVerificationChild(root, "process-reuse", "recover");
    assert.equal((await readFile(path.join(root, ".verification-state", "verification-count"), "utf8")).trim(), "1");
    const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const tasks = await DurableTaskRunStore.open(root, authority);
    try {
      const task = tasks.get("process-reuse");
      assert.equal(task?.status, "completed");
      const evidence = task?.attempts[0]?.verification as { checks?: Array<{ recovered?: boolean }> } | undefined;
      assert.equal(evidence?.checks?.[0]?.recovered, true);
    } finally {
      tasks.close();
      authority.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testProcessBoundaryBlocksUnknownToolOutcome(): Promise<void> {
  const root = await prepareProcessBoundaryTask("process-unknown");
  try {
    await runVerificationChild(root, "process-unknown", "admit");
    await runVerificationChild(root, "process-unknown", "recover");
    const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const tasks = await DurableTaskRunStore.open(root, authority);
    try {
      const task = tasks.get("process-unknown");
      assert.equal(task?.status, "blocked");
      assert.match(JSON.stringify(task?.attempts[0]?.verification), /may have been dispatched/u);
    } finally {
      tasks.close();
      authority.close();
    }
    await assert.rejects(readFile(path.join(root, ".verification-state", "verification-count"), "utf8"), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function prepareProcessBoundaryTask(taskRunId: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-task-verification-process-"));
  await ensureAgentDirs(root);
  await mkdir(path.join(root, ".verification-state"), { recursive: true });
  await writeFile(path.join(root, "artifact.txt"), "good\n", "utf8");
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  try {
    const contract = processBoundaryContract();
    const task = tasks.create({ taskRunId, task: { prompt: "recover process-boundary verification", verification: contract } });
    const attempt = tasks.createAttempt(task.taskRunId, { attemptId: `${taskRunId}-attempt` });
    tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
    tasks.transition(task.taskRunId, "verifying", {
      attemptId: attempt.attemptId,
      artifacts: await persistedCandidate(root, contract, "persisted candidate")
    });
  } finally {
    tasks.close();
    authority.close();
  }
  return root;
}

function processBoundaryContract(): TaskVerificationContract {
  return readTaskVerificationContract({
    version: 1,
    objective: "execute the verification command once",
    checks: [{
      id: "counted-check",
      command: "node -e \"require('node:fs').appendFileSync('.verification-state/verification-count','1\\n')\"",
      definitionPaths: []
    }],
    artifactPaths: ["artifact.txt"],
    allowedRepairPaths: ["artifact.txt"],
    maxAttempts: 1
  });
}

async function runVerificationChild(root: string, taskRunId: string, mode: "execute" | "admit" | "recover"): Promise<void> {
  const testFile = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, ["--import", "tsx", testFile], {
    cwd: path.resolve(path.dirname(testFile), ".."),
    env: {
      ...process.env,
      BINY_VERIFICATION_CHILD_MODE: mode,
      BINY_VERIFICATION_CHILD_ROOT: root,
      BINY_VERIFICATION_CHILD_TASK: taskRunId
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, `verification child ${mode} failed\nstdout: ${stdout}\nstderr: ${stderr}`);
}

async function runVerificationChildMode(mode: string, root: string, taskRunId: string): Promise<void> {
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  const task = tasks.get(taskRunId);
  assert.ok(task);
  const attempt = task.attempts[0];
  assert.ok(attempt);
  const contract = readTaskDefinition(task.task).verification;
  assert.ok(contract);
  const input = {
    command: contract.checks[0]!.command,
    checkId: contract.checks[0]!.id,
    contractFingerprint: taskVerificationFingerprint(contract),
    taskRunId,
    attemptId: attempt.attemptId
  };
  const sessionId = `verification-process-${taskRunId}`;
  if (mode === "admit") {
    const recorder = new SessionRecorder(root, sessionId, undefined, authority.asSink());
    recorder.repairTailForAppend();
    const toolCallId = taskCheckToolCallId(input);
    const operationId = createToolOperationId(sessionId, toolCallId);
    await recorder.recordAndFlush({ type: "tool_call", tool: "Bash", args: { command: input.command }, toolCallId, sequence: 1 });
    await recorder.recordAndFlush({ type: "tool_execution", tool: "Bash", toolCallId, sequence: 1, operationId, state: "admitted", retrySafety: "unknown" });
    await recorder.close();
  } else {
    const realExecutor = createRealTaskExecutor(root, "full-access", authority, sessionId);
    try {
      if (mode === "execute") {
        const execution = await realExecutor.executor.executeTaskCheck(input);
        const result = execution.result as { exitCode?: unknown; error?: unknown; reason?: unknown };
        assert.equal(result.exitCode, 0, JSON.stringify(result));
      } else {
        await runTaskClosure({
          taskRuns: tasks,
          taskRunId,
          workspaceRoot: root,
          ignore: verificationIgnore,
          executor: realExecutor.executor,
          executeAttempt: async () => { throw new Error("recovery must not repeat the Worker"); }
        });
      }
    } finally {
      await realExecutor.recorder.close();
    }
  }
  tasks.close();
  authority.close();
}

async function testLegacyTaskCompatibility(): Promise<void> {
  assert.equal(readTaskDefinition({ title: "legacy title", description: "legacy description" }).prompt, "legacy title\n\nlegacy description");
  const fixture = await createFixture("read-only");
  try {
    const task = fixture.tasks.create({ task: "legacy task without verification" });
    let checks = 0;
    const result = await runTaskClosure({
      taskRuns: fixture.tasks,
      taskRunId: task.taskRunId,
      workspaceRoot: fixture.root,
      ignore: verificationIgnore,
      executor: { executeTaskCheck: async () => { checks += 1; throw new Error("must not run"); } },
      executeAttempt: async () => "legacy output"
    });
    assert.equal(result.status, "completed");
    assert.equal(checks, 0);
    assert.deepEqual(fixture.tasks.get(task.taskRunId)?.attempts[0]?.artifacts, { output: "legacy output" });
  } finally {
    await fixture.close();
  }
}

function verificationContract(maxAttempts: number): TaskVerificationContract {
  return readTaskVerificationContract({
    version: 1,
    objective: "artifact.txt must contain good",
    context: "temporary integration workspace",
    artifactPaths: ["artifact.txt"],
    allowedRepairPaths: ["artifact.txt"],
    maxAttempts,
    checks: [{
      id: "content",
      command: "node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('artifact.txt','utf8').trim()==='good'?0:1)\"",
      definitionPaths: []
    }]
  });
}

async function persistedCandidate(root: string, contract: TaskVerificationContract, output: string): Promise<TaskCandidateArtifacts> {
  return {
    output,
    definitionFingerprint: await fingerprintTaskVerificationDefinitions(root, contract, verificationIgnore),
    repairScope: { enforcement: "post_execution_change_guard", changedPaths: [], violationPaths: [] }
  };
}

async function createFixture(mode: PermissionMode): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-task-verification-"));
  await ensureAgentDirs(root);
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  const graphs = await GoalGraphStore.open(root, authority);
  const realExecutor = createRealTaskExecutor(root, mode, authority, `verification-${randomUUID()}`);
  const executor = realExecutor.executor;
  const recorder = realExecutor.recorder;
  return {
    root,
    authority,
    tasks,
    graphs,
    executor,
    close: async () => {
      await recorder.close();
      graphs.close();
      tasks.close();
      authority.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function createRealTaskExecutor(
  root: string,
  mode: PermissionMode,
  authority: RuntimeEventAuthority,
  sessionId: string
): { executor: TaskCommandExecutor; recorder: SessionRecorder } {
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.permission.mode = mode;
  config.sandbox.mode = "off";
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createRunCommandTool({ workspaceRoot: root, ignore: verificationIgnore }, config.sandbox));
  const permission = new PermissionManager(config.permission);
  const recorder = new SessionRecorder(root, sessionId, undefined, authority.asSink());
  recorder.repairTailForAppend();
  const inFlightChecks = new Map<string, Promise<TaskCommandExecution>>();
  const executeTaskCheckOnce = async (input: Parameters<TaskCommandExecutor["executeTaskCheck"]>[0]): Promise<TaskCommandExecution> => {
    await recorder.flush();
    const recovery = recoverTaskCheckExecution(await readSessionEvents(recorder.filePath), recorder.sessionId, input);
    if (recovery.action !== "execute") return recovery.execution;
    const events: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
    const coordinator = new ToolExecutionCoordinator(
      {
        workspaceRoot: root,
        config,
        recorder,
        toolRegistry: registry,
        confirmPermission: async () => ({ approved: false, message: "test did not grant permission" }),
        runId: input.taskRunId,
        turnId: input.attemptId
      },
      permission,
      (event) => events.push(event),
      () => ({}),
      new Set(["Bash"]),
      { maxToolCalls: 1, maxRepeatedActions: 1 }
    );
    const bash = coordinator.createAgentTools().find((tool) => tool.name === "Bash");
    assert.ok(bash);
    const toolCallId = recovery.toolCallId;
    const result = await bash.execute(toolCallId, {
      command: input.command,
      cwd: input.cwd ?? ".",
      timeoutMs: input.timeoutMs ?? 120_000
    }, input.signal);
    await coordinator.waitForIdle();
    const event = [...events].reverse().find((candidate) =>
      (candidate.type === "tool.completed" || candidate.type === "tool.failed") && candidate.toolCallId === toolCallId
    );
    const operationId = event && "operationId" in event ? event.operationId : undefined;
    return {
      result: result.details ?? result,
      toolCallId,
      operationId,
      eventReferences: [toolCallId, operationId].filter((reference): reference is string => reference !== undefined)
    };
  };
  const executor: TaskCommandExecutor = {
    executeTaskCheck: (input): Promise<TaskCommandExecution> => {
      const key = taskCheckToolCallId(input);
      const existing = inFlightChecks.get(key);
      if (existing) return existing;
      const completion = executeTaskCheckOnce(input).finally(() => {
        if (inFlightChecks.get(key) === completion) inFlightChecks.delete(key);
      });
      inFlightChecks.set(key, completion);
      return completion;
    }
  };
  return { executor, recorder };
}

function graphRuntime(run: (prompt: string) => Promise<string>): InteractiveRuntimeHandle {
  return {
    getSnapshot: () => ({ revision: 0, state: { kind: "idle" } }),
    submitPrompt: (prompt, _attachments, ids) => ({
      runId: ids?.runId ?? randomUUID(),
      messageId: randomUUID(),
      completion: run(prompt).then((output) => ({
        runId: ids?.runId ?? randomUUID(),
        status: "completed" as const,
        stopReason: "model_stop" as const,
        steps: 1,
        output,
        durationMs: 1
      }))
    })
  } as unknown as InteractiveRuntimeHandle;
}

function graphSupervisor(fixture: Fixture, runtime: InteractiveRuntimeHandle): GraphSupervisor {
  return new GraphSupervisor({
    store: fixture.graphs,
    runtime,
    taskRuns: fixture.tasks,
    getTaskCommandExecutor: () => fixture.executor,
    getWorkspaceRoot: () => fixture.root,
    getWorkspaceIgnore: () => verificationIgnore,
    tickMs: 100
  });
}

async function tickAndSettle(supervisor: GraphSupervisor): Promise<void> {
  await supervisor.tick();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

async function waitForStatus(tasks: DurableTaskRunStore, taskRunId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (tasks.get(taskRunId)?.status === status) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${status}`);
}

async function waitForGraphNodeStatus(
  graphs: GoalGraphStore,
  graphId: string,
  nodeKey: string,
  status: string
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (graphs.inspectGraph(graphId).nodes.find((node) => node.nodeKey === nodeKey)?.status === status) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for graph node ${nodeKey} status ${status}: ${JSON.stringify(graphs.inspectGraph(graphId))}`);
}

const childMode = process.env.BINY_VERIFICATION_CHILD_MODE;
const childRoot = process.env.BINY_VERIFICATION_CHILD_ROOT;
const childTaskRunId = process.env.BINY_VERIFICATION_CHILD_TASK;
if (childMode && childRoot && childTaskRunId) await runVerificationChildMode(childMode, childRoot, childTaskRunId);
else await main();
