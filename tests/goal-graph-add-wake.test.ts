/** Add must preserve supervision without releasing failed dependencies or executing work. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { GoalGraphStore as Store, GraphRecord } from "../src/runtime/GoalGraphStore.js";
import type { RuntimeEventAuthority as Authority } from "../src/runtime/RuntimeAuthority.js";

process.env.BINY_TEST_PROCESS = "1";
const { GoalGraphStore } = await import("../src/runtime/GoalGraphStore.js");
const { RuntimeEventAuthority } = await import("../src/runtime/RuntimeAuthority.js");
const { planTasksToNodes } = await import("../src/runtime/planWork.js");
const owner = "graph-add-owner";
const input = (key: string, dependencies: string[] = []) => planTasksToNodes([
  { key, title: key, task: `Read-only report ${key}`, acceptance: [`Report ${key}`], dependencies }
])[0]!;
const node = (graph: GraphRecord, key: string) => {
  const found = graph.nodes.find((candidate) => candidate.nodeKey === key);
  assert.ok(found, key);
  return found;
};

for (const status of ["failed", "blocked"] as const) {
  for (const phase of ["pending", "claimed"] as const) {
    await test(`add preserves current attention after ${status} with an old ${phase} wake`, async () => fixture(async (f) => {
      const before = attention(f.store, status);
      const oldWake = f.store.listSupervisorWakes()[0]!;
      if (phase === "claimed") assert.ok(f.store.claimSupervisorWake(oldWake.wakeId));
      const added = f.store.addSupervisedNodes(before.graphId, owner, [input("C", ["B"])]);
      f.store.createWake(before.graphId, "plan_updated");
      assert.equal(added.revision, before.revision + 1);
      assert.equal(added.replanCount, 1);
      assert.deepEqual(added.nodes.slice(0, before.nodes.length), before.nodes);
      if (phase === "pending") assert.equal(f.store.claimSupervisorWake(oldWake.wakeId), undefined);
      else f.store.finishSupervisorWake(oldWake.wakeId, "completed");
      assert.equal(f.authority.databaseHandle().prepare("SELECT status FROM graph_wakes WHERE wake_id = ?").get(oldWake.wakeId)?.status,
        phase === "pending" ? "discarded" : "completed");
      for (const key of ["B", "C"]) {
        assert.equal(node(added, key).status, "pending");
        assert.equal(f.store.claimIntent(added.graphId, node(added, key).nodeId), undefined);
      }
      assert.deepEqual(f.store.readyNodes(added.graphId), []);
      assert.equal(f.store.supervisorCheckpoint(added), "needs_attention");
      const wakes = f.store.listSupervisorWakes();
      assert.equal(wakes.length, 1, "add must queue the current checkpoint after retiring the old wake");
      const current = wakes[0]!;
      assert.equal(current.graphRevision, added.revision);
      assert.equal(current.checkpoint, "needs_attention");
      assert.equal(current.sessionId, owner);
      assert.equal(current.status, "pending");
      assert.notEqual(current.wakeId, oldWake.wakeId);
      assert.ok(current.runId);
      assert.notEqual(current.runId, oldWake.runId, "the old supervision turn cannot consume the new revision");
      await f.reopen();
      assert.deepEqual(f.store.inspectGraph(added.graphId), added);
      assert.deepEqual(f.store.listSupervisorWakes(), wakes, "the current wake is durable");
      assert.deepEqual(f.store.readyNodes(added.graphId), []);
      f.store.resumeGraph(added.graphId);
      assert.deepEqual(f.store.listSupervisorWakes(), wakes, "queueing the same revision is idempotent");
      const claimed = f.store.claimSupervisorWake(current.wakeId);
      assert.equal(claimed?.runId, current.runId);
      assert.equal(claimed?.status, "claimed");
      assert.equal(claimed?.attempt, 1);
      f.store.finishSupervisorWake(current.wakeId, "completed");
      f.store.resumeGraph(added.graphId);
      assert.deepEqual(f.store.listSupervisorWakes(), [], "a delivered checkpoint is not reopened");
      assert.equal(f.store.claimSupervisorWake(current.wakeId), undefined);
      assert.equal(f.authority.databaseHandle().prepare("SELECT COUNT(*) AS total FROM graph_wakes WHERE graph_id = ? AND kind = 'supervisor' AND graph_revision = ?").get(added.graphId, added.revision)?.total, 1);
      assert.deepEqual(f.store.inspectGraph(added.graphId), added, "supervision never executes or releases B/C");
    }));
  }
}

await test("add exposes attention while independent work stays ready for supervisor-first scheduling", async () => fixture((f) => {
  const before = attention(f.store, "blocked");
  const oldWake = f.store.listSupervisorWakes()[0]!;
  const added = f.store.addSupervisedNodes(before.graphId, owner, [input("C")]);
  assert.equal(f.store.claimSupervisorWake(oldWake.wakeId), undefined);
  assert.deepEqual(f.store.readyNodes(added.graphId).map((item) => item.nodeKey), ["C"]);
  assert.equal(f.store.claimIntent(added.graphId, node(added, "B").nodeId), undefined);
  assert.equal(f.store.supervisorCheckpoint(added), "needs_attention");
  // GraphSupervisor.scan already delivers listed supervisor wakes before ready nodes.
  const wakes = f.store.listSupervisorWakes();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]?.graphRevision, added.revision);
  assert.ok(f.store.claimSupervisorWake(wakes[0]!.wakeId));
  assert.deepEqual(f.store.inspectGraph(added.graphId), added, "claiming supervision leaves C pending");
}));

await test("healthy runnable add does not invent a supervisor checkpoint", async () => fixture((f) => {
  const graph = f.store.createSupervisedGraph({ supervisorSessionId: owner, nodes: [input("A")] });
  f.store.startGraph(graph.graphId);
  const added = f.store.addSupervisedNodes(graph.graphId, owner, [input("B", ["A"])]);
  assert.equal(f.store.supervisorCheckpoint(added), undefined);
  assert.deepEqual(f.store.listSupervisorWakes(), []);
  assert.deepEqual(f.store.readyNodes(added.graphId).map((item) => item.nodeKey), ["A"]);
}));

await test("replacement completion still releases dependencies in order after add", async () => fixture((f) => {
  const before = attention(f.store, "failed");
  f.store.addSupervisedNodes(before.graphId, owner, [input("C", ["B"])]);
  const replaced = f.store.replaceSupervisedNode(before.graphId, owner, node(before, "A").nodeId, { nodeKey: "A2", prompt: "Read-only replacement report" });
  assert.equal(replaced.replanCount, 2);
  assert.equal(f.store.supervisorCheckpoint(replaced), undefined);
  for (const wake of f.store.listSupervisorWakes()) assert.equal(f.store.claimSupervisorWake(wake.wakeId), undefined);
  for (const key of ["A2", "B", "C"]) {
    assert.deepEqual(f.store.readyNodes(before.graphId).map((item) => item.nodeKey), [key]);
    const current = node(f.store.inspectGraph(before.graphId), key);
    assert.ok(f.store.claimIntent(before.graphId, current.nodeId));
    f.store.completeNode(before.graphId, current.nodeId, "completed", { syntheticStoreTransition: "completed" });
  }
  const settled = f.store.inspectGraph(before.graphId);
  assert.deepEqual(node(settled, "A"), node(before, "A"));
  assert.equal(f.store.supervisorCheckpoint(settled), "settled");
  assert.equal(f.store.listSupervisorWakes().filter((wake) => wake.graphRevision === settled.revision && wake.checkpoint === "settled").length, 1);
}));

function attention(store: Store, status: "failed" | "blocked"): GraphRecord {
  const graph = store.createSupervisedGraph({ supervisorSessionId: owner, nodes: [input("A"), input("B", ["A"])] });
  store.startGraph(graph.graphId);
  assert.ok(store.claimIntent(graph.graphId, node(graph, "A").nodeId));
  store.completeNode(graph.graphId, node(graph, "A").nodeId, status, { syntheticStoreTransition: status });
  assert.deepEqual(store.readyNodes(graph.graphId), []);
  assert.equal(store.listSupervisorWakes().length, 1);
  return store.inspectGraph(graph.graphId);
}

interface Fixture { store: Store; authority: Authority; reopen(): Promise<void> }

async function fixture(execute: (value: Fixture) => Promise<void> | void): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-graph-add-wake-test-")));
  const workspace = path.join(root, "workspace");
  const agent = path.join(root, "agent");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  let current: Fixture | undefined;
  process.env.BINY_AGENT_DIR = agent;
  try {
    assert.deepEqual(await readdir(root), []);
    await mkdir(workspace);
    assert.equal(existsSync(agent), false);
    const authority = await RuntimeEventAuthority.open(workspace, { backfillLegacySessions: false });
    const store = await GoalGraphStore.open(workspace, authority);
    current = { store, authority, async reopen() {
      this.store.close(); this.authority.close();
      this.authority = await RuntimeEventAuthority.open(workspace, { backfillLegacySessions: false });
      this.store = await GoalGraphStore.open(workspace, this.authority);
    } };
    assert.ok(authority.databasePath.startsWith(agent + path.sep));
    assert.deepEqual(store.listGraphs(), []);
    assert.deepEqual(authority.readEvents().events, []);
    await execute(current);
  } finally {
    try {
      if (current) for (const table of ["task_runs", "task_attempts", "task_events", "agent_runs", "runtime_backfills"]) {
        assert.equal(current.authority.databaseHandle().prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total, 0, `${table} must stay empty`);
      }
    } finally {
      current?.store.close(); current?.authority.close();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    }
  }
}
