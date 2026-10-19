/**
 * Paused report recovery through real PlanStart, TaskClosure and persistent stores.
 * The companion Host crash regression covers the public RPC/process boundary.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPlanTools } from "../src/extensions/plan.js";
import { GoalGraphStore, GraphSupervisor } from "../src/runtime/GoalGraphStore.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

for (const control of ["complete", "missing-output", "pause-before-projection"] as const) test(`paused report recovery: ${control}`, { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-paused-report-recovery-"));
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  let graphs = await GoalGraphStore.open(root, authority);
  let tasks = await DurableTaskRunStore.open(root, authority);
  let supervisor: GraphSupervisor | undefined;
  let firstWorkerCalls = 0;
  let downstreamWorkerCalls = 0;
  let supervisorCalls = 0;
  const executor = { executeTaskCheck: async (): Promise<never> => { throw new Error("Reports must not execute checks."); } };
  try {
    const start = createPlanTools({ graphs, taskRuns: tasks }).find((tool) => tool.name === "PlanStart")!;
    const input = start.schema!.parse({
      objective: "Read and synthesize a report",
      nodes: [
        { key: "inspect", task: "Inspect source evidence", acceptance: ["Return source observations"] },
        { key: "synthesize", task: "Synthesize upstream evidence", acceptance: ["Cite upstream report"], dependencies: ["inspect"] }
      ]
    });
    const execution = await start.resolveExecution(input);
    if ("isError" in execution) throw new Error(execution.errorMessage);
    await execution.execute({ toolCallId: "plan", operationId: "plan", sessionId: "reports", runId: "reports" });
    const graph = graphs.listGraphs()[0]!;
    const first = graph.nodes[0]!;
    const taskRunId = `graph:${graph.graphId}:${first.nodeId}`;
    tasks.create({ taskRunId, task: first.intent, parentRunId: `graph:${graph.graphId}` });
    assert.ok(graphs.claimIntent(graph.graphId, first.nodeId, "before-crash", taskRunId));
    // Missing-output is a negative persisted-evidence control, not the crash reproduction.
    const missingAttempt = control === "missing-output" ? tasks.createAttempt(taskRunId) : undefined;
    if (missingAttempt) {
      tasks.transition(taskRunId, "completed", { attemptId: missingAttempt.attemptId });
      graphs.pauseGraph(graph.graphId);
    }
    const result = missingAttempt ? { status: "completed" as const } : await runTaskClosure({
      taskRuns: tasks, taskRunId, workspaceRoot: root, ignore: [], executor,
      executeAttempt: async () => {
        firstWorkerCalls += 1;
        graphs.pauseGraph(graph.graphId);
        return "source evidence: persisted report";
      }
    });
    assert.equal(result.status, "completed");
    const completed = tasks.get(taskRunId)!;
    assert.equal(completed.status, "completed");
    assert.equal(graphs.inspectGraph(graph.graphId).nodes[0]?.status, "running");
    // Production has exactly this durable cut before executeNode projects result.
    // Do not invoke projectTaskClosure; close/reopen only the stores.
    graphs.close(); tasks.close(); authority.close();
    authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    graphs = await GoalGraphStore.open(root, authority);
    tasks = await DurableTaskRunStore.open(root, authority);
    const runtime = {
      getSnapshot: () => ({ state: { kind: "idle" }, info: { sessionId: "reports" } }),
      submitPrompt: () => {
        downstreamWorkerCalls += 1;
        return { completion: Promise.resolve({ status: "completed", output: "synthesis of source evidence" }) };
      },
      submitSupervisionTurn: () => {
        supervisorCalls += 1;
        return { completion: Promise.resolve({ status: "completed" }) };
      }
    } as unknown as InteractiveRuntimeHandle;
    supervisor = new GraphSupervisor({ getStore: () => graphs, getTaskRuns: () => tasks,
      runtime, getTaskCommandExecutor: () => executor, getWorkspaceRoot: () => root });
    supervisor.start();
    await supervisor.tick();
    assert.equal(graphs.inspectGraph(graph.graphId).status, "paused");
    assert.equal(graphs.inspectGraph(graph.graphId).nodes[0]?.status, "running");
    assert.equal(downstreamWorkerCalls, 0);
    graphs.resumeGraph(graph.graphId);
    graphs.createWake(graph.graphId, "graph_resumed");
    // Enqueue before entering tick without yielding first: it lands while
    // completed-report reconciliation awaits, and is also valid on the baseline.
    if (control === "pause-before-projection") queueMicrotask(() => graphs.pauseGraph(graph.graphId));
    const done = (): boolean => {
      const current = graphs.inspectGraph(graph.graphId);
      return control === "missing-output" ? current.nodes[0]?.status === "blocked" && supervisorCalls > 0
        : control === "pause-before-projection" ? current.status === "paused"
          : current.nodes.every((node) => node.status === "completed");
    };
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !done()) {
      await supervisor.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const current = graphs.inspectGraph(graph.graphId);
    if (control === "pause-before-projection") {
      assert.equal(current.status, "paused");
      assert.deepEqual(current.nodes.map((node) => node.status), ["running", "pending"]);
      assert.equal(downstreamWorkerCalls, 0);
      assert.equal(supervisorCalls, 0);
    } else if (control === "missing-output") {
      assert.deepEqual(current.nodes.map((node) => node.status), ["blocked", "pending"]);
      assert.equal(downstreamWorkerCalls, 0);
      assert.equal(supervisorCalls, 1, "new needs_attention wake is eventually delivered once");
    } else {
      assert.deepEqual(current.nodes.map((node) => node.status), ["completed", "completed"],
        "normal resume/ticks must reconcile committed A before dispatching dependent B");
      assert.equal(downstreamWorkerCalls, 1);
    }
    assert.equal(firstWorkerCalls, control === "missing-output" ? 0 : 1);
    assert.deepEqual(tasks.get(taskRunId)?.attempts, completed.attempts);
  } finally {
    supervisor?.stop();
    // Runtime completions in this fixture are immediate; join every scheduled closure
    // before closing its stores, including assertion-failure paths.
    while (supervisor?.hasActiveWork()) await new Promise<void>((resolve) => setImmediate(resolve));
    graphs.close(); tasks.close(); authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary pause/resume does not reconcile a still-active report Worker", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-live-report-resume-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const graphs = await GoalGraphStore.open(root, authority);
  const tasks = await DurableTaskRunStore.open(root, authority);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, info: { sessionId: "reports" } }),
    submitPrompt: () => {
      calls += 1;
      entered();
      return { completion: held.then(() => ({ status: "completed", output: "observed evidence" })) };
    },
    submitSupervisionTurn: () => ({ completion: Promise.resolve({ status: "completed" }) })
  } as unknown as InteractiveRuntimeHandle;
  const supervisor = new GraphSupervisor({ store: graphs, taskRuns: tasks, runtime,
    getWorkspaceRoot: () => root,
    getTaskCommandExecutor: () => ({ executeTaskCheck: async () => { throw new Error("Report checks forbidden."); } }) });
  try {
    const start = createPlanTools({ graphs, taskRuns: tasks }).find((tool) => tool.name === "PlanStart")!;
    const execution = await start.resolveExecution(start.schema!.parse({
      objective: "Inspect evidence",
      nodes: [
        { key: "inspect", task: "Inspect evidence", acceptance: ["Return observations"] },
        { key: "synthesize", task: "Synthesize observations", acceptance: ["Cite upstream report"], dependencies: ["inspect"] }
      ]
    }));
    if ("isError" in execution) throw new Error(execution.errorMessage);
    await execution.execute({ toolCallId: "live-plan", operationId: "live-plan", sessionId: "reports", runId: "reports" });
    const graphId = graphs.listGraphs()[0]!.graphId;
    supervisor.start();
    await started;
    const before = graphs.inspectGraph(graphId).nodes[0]!;
    assert.equal(before.status, "running");
    graphs.pauseGraph(graphId);
    graphs.resumeGraph(graphId);
    await supervisor.tick();
    assert.deepEqual(graphs.inspectGraph(graphId).nodes[0], before);
    assert.equal(calls, 1);
    // Keep the required downstream node dormant while the existing A finishes.
    graphs.pauseGraph(graphId);
    release();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && graphs.inspectGraph(graphId).nodes[0]?.status !== "completed") {
      await supervisor.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const completed = graphs.inspectGraph(graphId);
    assert.equal(completed.status, "paused");
    assert.deepEqual(completed.nodes.map((node) => node.status), ["completed", "pending"]);
    assert.equal(calls, 1);
    assert.equal(tasks.get(before.taskRunId!)?.attempts.length, 1);
  } finally {
    release();
    supervisor.stop();
    while (supervisor.hasActiveWork()) await new Promise<void>((resolve) => setImmediate(resolve));
    graphs.close(); tasks.close(); authority.close();
    await rm(root, { recursive: true, force: true });
  }
});
