/** 暂停使旧监督检查点过期；恢复后仍须交付当前依赖状态，不重新执行节点。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoalGraphStore, GraphSupervisor, type SupervisorCheckpoint } from "../src/runtime/GoalGraphStore.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

for (const checkpoint of ["needs_attention", "settled"] as const) {
  for (const finishWhilePaused of [false, true]) {
    await testResumeCheckpoint(checkpoint, finishWhilePaused);
  }
}
await testResumeRunnableAndFixedGraphs();
console.log("goal graph resume tests passed");

async function testResumeCheckpoint(checkpoint: SupervisorCheckpoint, finishWhilePaused: boolean): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-graph-resume-"));
  let authority = await RuntimeEventAuthority.open(root);
  let graphs = await GoalGraphStore.open(root, authority);
  const prompts: string[] = [];
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, info: { sessionId: "owner" } }),
    submitSupervisionTurn: (prompt: string) => {
      prompts.push(prompt);
      return { completion: Promise.resolve({ status: "completed" }) };
    },
    submitPrompt: () => { throw new Error("Resume must not rerun completed or failed work."); }
  } as unknown as InteractiveRuntimeHandle;
  const supervisor = new GraphSupervisor({ getStore: () => graphs, runtime });
  try {
    const graph = graphs.createSupervisedGraph({
      supervisorSessionId: "owner",
      nodes: [
        { nodeKey: "first", prompt: "Produce evidence" },
        { nodeKey: "second", prompt: "Use upstream evidence", dependencies: ["first"] }
      ]
    });
    graphs.startGraph(graph.graphId);
    const first = graphs.readyNodes(graph.graphId)[0]!;
    assert.ok(graphs.claimIntent(graph.graphId, first.nodeId));
    let finalNode = first;
    if (checkpoint === "settled") {
      graphs.completeNode(graph.graphId, first.nodeId, "completed", { output: "upstream evidence" });
      finalNode = graphs.readyNodes(graph.graphId)[0]!;
      assert.ok(graphs.claimIntent(graph.graphId, finalNode.nodeId));
    }
    if (finishWhilePaused) graphs.pauseGraph(graph.graphId);
    graphs.completeNode(graph.graphId, finalNode.nodeId, checkpoint === "settled" ? "completed" : "failed", { output: "preserved evidence" });
    if (!finishWhilePaused) graphs.pauseGraph(graph.graphId);
    const paused = graphs.inspectGraph(graph.graphId);
    await supervisor.tick();
    assert.deepEqual(prompts, [], "paused graphs must not dispatch supervision");
    assert.deepEqual(graphs.listSupervisorWakes(), [], "pre-pause revision wakes are discarded");

    // 重新打开持久状态，覆盖暂停期间重启后再恢复的同一入口。
    graphs.close();
    authority.close();
    authority = await RuntimeEventAuthority.open(root);
    graphs = await GoalGraphStore.open(root, authority);
    const resumed = graphs.resumeGraph(graph.graphId);
    graphs.createWake(graph.graphId, "graph_resumed");
    assert.equal(resumed.status, "running");
    assert.deepEqual(resumed.nodes, paused.nodes, "resuming preserves node outcomes, dependencies, and evidence");
    assert.deepEqual(graphs.readyNodes(graph.graphId), [], "the checkpoint has no dispatchable worker");
    const wakes = graphs.listSupervisorWakes();
    assert.equal(wakes.length, 1, "resume must enqueue current supervision even when no node is ready");
    assert.equal(wakes[0]?.checkpoint, checkpoint);
    assert.equal(wakes[0]?.graphRevision, resumed.revision);
    assert.equal(wakes[0]?.sessionId, "owner");
    graphs.resumeGraph(graph.graphId);
    assert.deepEqual(graphs.listSupervisorWakes(), wakes, "repeated resume must not duplicate the checkpoint");

    await supervisor.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(prompts.length, 1, "the current checkpoint must reach its supervisor");
    assert.ok(prompts[0]?.includes(`at ${checkpoint} revision ${String(resumed.revision)}`));
    assert.deepEqual(graphs.listSupervisorWakes(), []);
    graphs.resumeGraph(graph.graphId);
    assert.deepEqual(graphs.listSupervisorWakes(), [], "an idempotent resume must not reopen a delivered checkpoint");
    await supervisor.tick();
    assert.equal(prompts.length, 1, "later scans must not redeliver the same checkpoint");
    assert.equal(graphs.inspectGraph(graph.graphId).status, "running", "the supervisor still owns final graph disposition");
  } finally {
    supervisor.stop();
    graphs.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testResumeRunnableAndFixedGraphs(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-graph-resume-runnable-"));
  const authority = await RuntimeEventAuthority.open(root);
  const graphs = await GoalGraphStore.open(root, authority);
  try {
    const nodes = [{ nodeKey: "first", prompt: "Work" }];
    const fixed = graphs.createGraph(undefined, nodes);
    const supervised = graphs.createSupervisedGraph({ supervisorSessionId: "owner", nodes });
    for (const graph of [fixed, supervised]) {
      graphs.startGraph(graph.graphId);
      graphs.pauseGraph(graph.graphId);
      graphs.resumeGraph(graph.graphId);
      assert.deepEqual(graphs.readyNodes(graph.graphId).map((node) => node.nodeKey), ["first"]);
      assert.deepEqual(graphs.listSupervisorWakes(), [], "runnable work does not require a supervision checkpoint");
      graphs.cancelGraph(graph.graphId);
      assert.throws(() => graphs.resumeGraph(graph.graphId), /cannot transition from cancelled/u);
    }
  } finally {
    graphs.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}
