/** Graph 查询必须沿持久 graph identity 汇总事件，不能遗漏 TaskRun 承载的节点事实。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planStatus } from "../src/extensions/plan.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority, type RuntimeEventPage } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

for (const status of ["completed", "failed", "blocked"] as const) {
  await test(`graph events includes persisted TaskRun ${status} outcomes through the public command`, async () => {
    await fixture(async (_root, authority, graphs, tasks) => {
      const graph = graphs.createGraph(undefined, [{ nodeKey: "work", prompt: "Inspect fixture" }], {}, `fixed-${status}`);
      const node = graph.nodes[0]!;
      const taskRunId = `graph:${graph.graphId}:${node.nodeId}`;
      tasks.create({ taskRunId, task: node.intent, parentRunId: `graph:${graph.graphId}` });
      graphs.startGraph(graph.graphId);
      graphs.claimIntent(graph.graphId, node.nodeId, `claim-${status}`, taskRunId);
      graphs.completeNode(graph.graphId, node.nodeId, status, { output: `persisted ${status} evidence` }, taskRunId);
      const expected = authority.readEvents().events.filter((event) => event.runId === `graph:${graph.graphId}` || event.turnId === `graph:${graph.graphId}`);
      assert.ok(expected.some((event) => event.eventType === "graph.node.status" && event.runId === taskRunId), "the node outcome is durably present");
      assert.ok(expected.some((event) => event.eventType === "task.created"), "existing task creation history must remain visible");
      const before = authority.readEvents();
      for (const source of ["desktop", "tui"] as const) {
        const result = await executeRuntimeCommand({} as InteractiveRuntimeHandle, { graphs } as CommandRuntime, `/graph events ${graph.graphId}`, source);
        const page = JSON.parse(result!.content) as RuntimeEventPage;
        assert.deepEqual(page.events, JSON.parse(JSON.stringify(expected)), "graph events must include the TaskRun-backed node outcome");
        assert.equal(page.hasMore, false);
        assert.equal(page.gap, false);
      }
      assert.deepEqual(authority.readEvents(), before, "queries must not append or rewrite runtime facts");
    });
  });
}

await test("graph events retains recovery and supervisor facts after a read-only reopen", async () => {
  await fixture(async (root, authority, graphs, tasks) => {
    const graph = graphs.createSupervisedGraph({
      graphId: "supervised:query_%",
      supervisorSessionId: "owner",
      nodes: [{ nodeKey: "first", prompt: "Inspect fixture" }, { nodeKey: "second", prompt: "Read result", dependencies: ["first"] }]
    });
    graphs.createSupervisedGraph({ graphId: `${graph.graphId}:other`, supervisorSessionId: "owner", nodes: [{ nodeKey: "first", prompt: "Other graph" }] });
    graphs.startGraph(graph.graphId);
    const first = graph.nodes[0]!;
    const missingTaskRunId = `graph:${graph.graphId}:${first.nodeId}`;
    graphs.claimIntent(graph.graphId, first.nodeId, "first-claim", missingTaskRunId);
    graphs.recoverNode(graph.graphId, first.nodeId, "ready", "Persisted recovery evidence", missingTaskRunId);
    graphs.claimIntent(graph.graphId, first.nodeId, "second-claim", missingTaskRunId);
    graphs.completeNode(graph.graphId, first.nodeId, "failed", { error: "Persisted failure evidence" }, missingTaskRunId);
    graphs.replaceSupervisedNode(graph.graphId, "owner", first.nodeId, { nodeKey: "retry", prompt: "Inspect again" });
    const expected = authority.readEvents().events.filter((event) => event.runId === `graph:${graph.graphId}` || event.turnId === `graph:${graph.graphId}`);
    assert.ok(expected.some((event) => event.eventType === "graph.node.recovered"));
    assert.ok(expected.some((event) => event.eventType === "graph.replanned" && event.sessionId === "owner"));
    assert.ok(expected.some((event) => event.eventType === "graph.supervisor_wake.created" && event.sessionId === "owner"));
    const result = await executeRuntimeCommand({} as InteractiveRuntimeHandle, { graphs } as CommandRuntime, `/graph events ${graph.graphId}`, "tui");
    assert.deepEqual(JSON.parse(result!.content).events, JSON.parse(JSON.stringify(expected)), "recovery, task, and supervisor identities must all remain visible without prefix matches");
    assert.deepEqual(graphs.listGraphEvents(graph.graphId).events, expected);
    assert.deepEqual(graphs.listGraphEvents("unknown-graph").events, []);

    const readOnly = await RuntimeEventAuthority.openReadOnly(root);
    assert.ok(readOnly);
    const reopened = await GoalGraphStore.open(root, readOnly);
    try {
      assert.deepEqual(reopened.listGraphEvents(graph.graphId).events, expected, "existing persisted identities work through a read-only reopened connection");
      assert.equal(tasks.get(missingTaskRunId), undefined, "history does not depend on a surviving TaskRun row");
    } finally {
      reopened.close();
      readOnly.close();
    }
  });
});

await test("run-or-turn event filters preserve workspace isolation, identity, order, and pagination", async () => {
  await fixture(async (root, authority) => {
    const other = await RuntimeEventAuthority.open(root, { workspaceId: "another-workspace", backfillLegacySessions: false });
    try {
      const firstInput = { eventId: "first", sessionId: "one", runId: "run-one", turnId: "shared-turn", eventType: "fixture.first", payload: {}, createdAt: "2026-01-01T00:00:00.000Z" };
      const first = authority.appendEvent(firstInput);
      authority.appendEvent({ ...firstInput, eventId: "unrelated", turnId: "other-turn" });
      other.appendEvent({ ...firstInput, eventId: "foreign" });
      const second = authority.appendEvent({ ...firstInput, eventId: "second", sessionId: "two", runId: "run-two" });
      authority.appendEvent(firstInput);
      const third = authority.appendEvent({ ...firstInput, eventId: "third", sessionId: "two", runId: "shared-turn", turnId: "child-turn" });
      const firstPage = authority.readEvents({ runOrTurnId: "shared-turn", limit: 2 });
      assert.deepEqual(firstPage.events, [first, second], "filter before paging; use sequence order when timestamps tie; no duplicate or foreign facts");
      assert.equal(firstPage.hasMore, true);
      assert.equal(firstPage.nextCursor, second.sequence);
      const lastPage = authority.readEvents({ runOrTurnId: "shared-turn", afterSequence: firstPage.nextCursor, limit: 2 });
      assert.deepEqual(lastPage.events, [third]);
      assert.equal(lastPage.hasMore, false);
      assert.equal(lastPage.nextCursor, undefined);
      assert.deepEqual(authority.readEvents({ runOrTurnId: "shared-turn", runId: "run-one", sessionId: "one" }).events, [first]);
      assert.deepEqual(authority.readEvents({ runOrTurnId: "other-turn", runId: "run-two" }).events, []);
      assert.deepEqual(authority.readEvents({ runId: "run-two" }).events, [second], "existing run-only queries retain their contract");
      assert.deepEqual(authority.readEvents({ sessionId: "two" }).events, [second, third], "existing session-only queries retain their contract");
    } finally {
      other.close();
    }
  });
});

await test("graph list, detail, and plan projection retain dependency and session identities", async () => {
  await fixture(async (root, authority, graphs, tasks) => {
    const goal = graphs.createGoal("Inspect graph query fixtures", { scope: "local" }, "query-goal");
    const graph = graphs.createSupervisedGraph({
      goalId: goal.goalId, graphId: "query-graph", supervisorSessionId: "owner",
      nodes: [
        { nodeKey: "z-first", prompt: "First source" },
        { nodeKey: "a-second", prompt: "Second source" },
        { nodeKey: "dependent", prompt: "Combine sources", dependencies: ["a-second", "z-first", "a-second"] }
      ]
    });
    graphs.startGraph(graph.graphId);
    graphs.claimIntent(graph.graphId, graph.nodes[0]!.nodeId, "query-claim", "missing-task");
    const detail = graphs.inspectGraph(graph.graphId);
    assert.deepEqual(graphs.listGraphs(), [detail]);
    assert.deepEqual(graphs.listGoals(), [graphs.getGoal(goal.goalId)]);
    assert.deepEqual(detail.nodes.map((node) => node.nodeKey), ["z-first", "a-second", "dependent"], "node order is insertion order, not alphabetical");
    assert.deepEqual(detail.nodes[2]!.dependencies, ["a-second", "z-first", "a-second"], "query projection preserves persisted edge identities and ordering");
    const before = authority.readEvents();
    const status = planStatus({ graphs, taskRuns: tasks }, graph.graphId, "owner");
    assert.equal(status.nodes[0]!.taskRunId, "missing-task");
    assert.equal(status.nodes[0]!.taskStatus, undefined);
    assert.throws(() => planStatus({ graphs, taskRuns: tasks }, graph.graphId, "other-session"), /does not belong/u);

    const foreign = await RuntimeEventAuthority.open(root, { workspaceId: "foreign-workspace", backfillLegacySessions: false });
    const foreignGraphs = await GoalGraphStore.open(root, foreign);
    try {
      assert.deepEqual(foreignGraphs.listGoals(), []);
      assert.deepEqual(foreignGraphs.listGraphs(), []);
      assert.equal(foreignGraphs.getGoal(goal.goalId), undefined);
      assert.equal(foreignGraphs.getGraph(graph.graphId), undefined);
      assert.deepEqual(foreignGraphs.listGraphEvents(graph.graphId).events, []);
      assert.throws(() => foreignGraphs.inspectGraph(graph.graphId), /does not exist/u);
    } finally {
      foreignGraphs.close();
      foreign.close();
    }
    assert.deepEqual(authority.readEvents(), before, "list, detail, and rejected session queries remain read-only");
  });
});

async function fixture(execute: (root: string, authority: RuntimeEventAuthority, graphs: GoalGraphStore, tasks: DurableTaskRunStore) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-goal-graph-queries-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
  const root = path.join(temporary, "workspace");
  await mkdir(root);
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const graphs = await GoalGraphStore.open(root, authority);
  const tasks = await DurableTaskRunStore.open(root, authority);
  try {
    await execute(root, authority, graphs, tasks);
  } finally {
    tasks.close();
    graphs.close();
    authority.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
}
