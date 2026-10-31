import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore, type TaskRunStatus } from "../src/runtime/TaskRunStore.js";
import { GoalGraphStore, GraphSupervisor } from "../src/runtime/GoalGraphStore.js";
import { SubagentTaskManager } from "../src/runtime/SubagentTaskManager.js";

async function fixture(run: (f: Awaited<ReturnType<typeof openFixture>>) => Promise<void>): Promise<void> {
  const f = await openFixture();
  try { await run(f); } finally { await f.close(); }
}
async function openFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-graph-failed-recovery-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  let tasks = await DurableTaskRunStore.open(root, authority);
  let graphs = await GoalGraphStore.open(root, authority);
  let dispatches = 0;
  const supervisor = new GraphSupervisor({
    getStore: () => graphs, getTaskRuns: () => tasks,
    // Runtime/provider boundaries are deliberately inert. A busy owner leaves
    // the durable supervisor wake pending; no Host delivery is claimed.
    resolveSupervisorRuntime: async () => ({ getSnapshot: () => ({ state: { kind: "running" } }) }) as never,
    resolveSupervisorCommands: async () => { dispatches += 1; throw new Error("No Worker dispatch is allowed."); }
  });
  return {
    root, get tasks() { return tasks; }, get graphs() { return graphs; },
    get dispatches() { return dispatches; },
    async seed(status: TaskRunStatus, paused = true, managerFailure = false) {
      const intent = { prompt: "Read and report", planBlock: { kind: "report", taskKey: "a", title: "A", acceptance: ["report"] } };
      const graph = graphs.createSupervisedGraph({ graphId: "graph", supervisorSessionId: "parent", nodes: [
        { nodeKey: "a", prompt: intent.prompt, intent },
        { nodeKey: "b", prompt: "Use A", dependencies: ["a"], intent: { ...intent, prompt: "Use A" } }
      ] });
      graphs.startGraph(graph.graphId);
      const node = graph.nodes[0];
      const taskRunId = `graph:${graph.graphId}:${node.nodeId}`;
      graphs.claimIntent(graph.graphId, node.nodeId, undefined, taskRunId);
      tasks.create({ taskRunId, sessionId: "parent", task: intent });
      const attempt = tasks.createAttempt(taskRunId);
      tasks.transition(taskRunId, "queued");
      if (paused && !managerFailure) graphs.pauseGraph(graph.graphId);
      if (managerFailure) {
        const manager = new SubagentTaskManager({ maxConcurrentSubagents: 1,
          onSnapshot: (snapshot) => tasks.syncSubagentSnapshot(snapshot, { taskRunId, attemptId: attempt.attemptId }),
          execute: async () => {
            if (paused) graphs.pauseGraph(graph.graphId);
            throw new Error("provider execution failed");
          }
        });
        try { await assert.rejects(manager.run(intent.prompt, { taskId: attempt.attemptId }), /provider execution failed/u); }
        finally { await manager.close(); }
        assert.equal(tasks.get(taskRunId)?.status, "failed");
      } else {
        tasks.transition(taskRunId, "running", { attemptId: attempt.attemptId });
        if (status !== "running") tasks.transition(taskRunId, status, { attemptId: attempt.attemptId,
          failure: status === "blocked" ? { failureClass: "worker_interrupted" } : undefined,
          artifacts: status === "completed" ? { output: "Existing report" } : undefined });
      }
      return { node, taskRunId, attempt };
    },
    async reopen() {
      graphs.close(); tasks.close(); authority.close();
      authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
      tasks = await DurableTaskRunStore.open(root, authority);
      graphs = await GoalGraphStore.open(root, authority);
      graphs.recoverRunningNodes(tasks);
    },
    tick: () => supervisor.tick(),
    async close() {
      supervisor.stop(); graphs.close(); tasks.close(); authority.close();
      if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  };
}

for (const reopened of [false, true]) {
  test(`failed Worker becomes inspectable after pause/resume (cold reopen=${reopened})`, async () => fixture(async (f) => {
    const { taskRunId, node } = await f.seed("failed", true, true);
    const original = JSON.stringify(f.tasks.get(taskRunId));
    if (reopened) await f.reopen();
    await f.tick();
    assert.equal(f.graphs.getGraph("graph")?.nodes[0].status, "running", "paused graph is untouched");
    f.graphs.resumeGraph("graph");
    await f.tick();
    const graph = f.graphs.getGraph("graph")!;
    assert.equal(graph.nodes[0].status, "failed");
    assert.equal(graph.nodes[1].status, "pending");
    assert.deepEqual(f.graphs.readyNodes("graph"), []);
    assert.equal(f.graphs.supervisorCheckpoint(graph), "needs_attention");
    assert.equal(f.graphs.listSupervisorWakes().filter(w => w.graphId === "graph").length, 1);
    const revision = graph.revision;
    await f.tick(); await f.tick();
    assert.equal(f.graphs.getGraph("graph")?.revision, revision);
    assert.equal(f.graphs.listSupervisorWakes().filter(w => w.graphId === "graph").length, 1);
    const events = f.graphs.listGraphEvents("graph", { limit: 1000 }).events;
    assert.equal(events.filter(event => event.eventType === "graph.supervisor_wake.created").length, 1);
    assert.equal(events.filter(event => event.eventType === "graph.node.status"
      && (event.payload as { nodeId?: string; status?: string }).nodeId === node.nodeId
      && (event.payload as { status?: string }).status === "failed").length, 1);
    assert.equal(JSON.stringify(f.tasks.get(taskRunId)), original, "attempts and terminal evidence are not rewritten");
    assert.equal(f.dispatches, 0);
    const replacement = f.graphs.replaceSupervisedNode("graph", "parent", node.nodeId, { nodeKey: "a-replacement", prompt: "Retry deliberately" });
    assert.equal(replacement.nodes.at(-1)?.replacesNodeId, node.nodeId);
    assert.deepEqual(f.graphs.readyNodes("graph").map(n => n.nodeKey), ["a-replacement"]);
  }));
}

test("ordinary running-graph startup already projects failure", async () => fixture(async f => {
  await f.seed("failed", false, true); await f.reopen();
  assert.equal(f.graphs.getGraph("graph")?.nodes[0].status, "failed");
  assert.equal(f.graphs.supervisorCheckpoint(f.graphs.getGraph("graph")!), "needs_attention");
}));

for (const status of ["running", "verifying", "needs_approval", "blocked", "incomplete", "cancelled", "aborted", "policy_denied", "budget_exhausted"] as const) {
  test(`does not reinterpret ${status} TaskRun during ordinary resume`, async () => fixture(async f => {
    const { taskRunId } = await f.seed(status);
    const before = JSON.stringify(f.tasks.get(taskRunId));
    f.graphs.resumeGraph("graph"); await f.tick();
    assert.equal(f.graphs.getGraph("graph")?.nodes[0].status, "running");
    assert.equal(JSON.stringify(f.tasks.get(taskRunId)), before);
    assert.equal(f.dispatches, 0);
  }));
}

test("cancelled graph does not accept a late failed-task projection", async () => fixture(async f => {
  await f.seed("failed", true, true); f.graphs.cancelGraph("graph");
  const before = JSON.stringify(f.graphs.getGraph("graph")); await f.tick();
  assert.equal(JSON.stringify(f.graphs.getGraph("graph")), before);
  assert.equal(f.dispatches, 0);
}));


test("existing completed-report reconciliation remains intact", async () => fixture(async f => {
  const { taskRunId } = await f.seed("completed"); await f.reopen();
  const before = JSON.stringify(f.tasks.get(taskRunId));
  f.graphs.resumeGraph("graph"); await f.tick();
  assert.equal(f.graphs.getGraph("graph")?.nodes[0].status, "completed");
  assert.deepEqual(f.graphs.readyNodes("graph").map(n => n.nodeKey), ["b"]);
  assert.equal(JSON.stringify(f.tasks.get(taskRunId)), before);
  assert.equal(f.dispatches, 0);
}));

for (const action of ["pause", "cancel"] as const) {
  test(`${action} during preceding report reconciliation preserves the next failed node boundary`, async () => fixture(async f => {
    const intent = { prompt: "Report", planBlock: { kind: "report", taskKey: "report", title: "Report", acceptance: ["report"] } };
    const graph = f.graphs.createSupervisedGraph({ graphId: "graph", supervisorSessionId: "parent", nodes: [
      { nodeKey: "report", prompt: "Report", intent }, { nodeKey: "failure", prompt: "Fail", intent }
    ] });
    f.graphs.startGraph("graph");
    for (const [index, node] of graph.nodes.entries()) {
      const id = `graph:graph:${node.nodeId}`;
      f.graphs.claimIntent("graph", node.nodeId, undefined, id);
      f.tasks.create({ taskRunId: id, sessionId: "parent", task: intent });
      const attempt = f.tasks.createAttempt(id);
      f.tasks.transition(id, "queued"); f.tasks.transition(id, "running", { attemptId: attempt.attemptId });
      f.tasks.transition(id, index === 0 ? "completed" : "failed", { attemptId: attempt.attemptId, artifacts: { output: "Report" } });
    }
    const firstId = `graph:graph:${graph.nodes[0].nodeId}`;
    const get = f.tasks.get.bind(f.tasks);
    let reads = 0; let changed = false;
    // Schedule the public graph operation at the real async closure boundary.
    // All task reads and closure execution still use the original implementations.
    f.tasks.get = id => {
      const result = get(id);
      if (id === firstId && ++reads === 2) queueMicrotask(() => {
        changed = true;
        if (action === "pause") f.graphs.pauseGraph("graph"); else f.graphs.cancelGraph("graph");
      });
      return result;
    };
    try { await f.tick(); } finally { f.tasks.get = get; }
    assert.equal(changed, true);
    const after = f.graphs.getGraph("graph")!;
    assert.equal(after.status, action === "pause" ? "paused" : "cancelled");
    assert.deepEqual(after.nodes.map(n => n.status), action === "pause" ? ["running", "running"] : ["cancelled", "cancelled"]);
    assert.equal(f.dispatches, 0);
  }));
}
