import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { GoalGraphStore, GraphSupervisor } from "../src/runtime/GoalGraphStore.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const outcome of ["resolve", "reject"] as const) {
for (const phase of ["runtime", "commands"] as const) {
  for (const action of ["none", "pause", "stop", "cancel", "pause-resume", "new-claim"] as const) {
    test(`${outcome}: ${action} while awaiting ${phase} preparation preserves undispatched claim ownership`, { timeout: 10_000 }, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-graph-pause-admission-"));
      const config = structuredClone(defaultConfig);
      config.defaultModel = "synthetic"; config.toolModel = "synthetic";
      config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
      config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
      config.checkpoints.enabled = false; config.extensions.subagent.enabled = true;
      config.heartbeat.enabled = false; config.context.memory.enabled = false; config.context.identity.enabled = false;
      const network = t.mock.method(globalThis, "fetch", async () => streamText("completed bounded graph work"));
      const entered = deferred<void>(); const release = deferred<void>();
      const commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
      const runtime = new InteractiveAgentRuntime(commands);
      let runtimeResolutions = 0;
      let commandResolutions = 0;
      const supervisor = new GraphSupervisor({ store: commands.graphs, taskRuns: commands.taskRuns, runtime,
        resolveSupervisorRuntime: async () => {
          runtimeResolutions += 1;
          if (phase === "runtime" && runtimeResolutions === 2) {
            entered.resolve(); await release.promise;
            if (outcome === "reject") throw new Error("injected runtime preparation failure");
          }
          return runtime;
        },
        resolveSupervisorCommands: async () => {
          commandResolutions += 1;
          if (phase === "commands" && commandResolutions === 1) {
            entered.resolve(); await release.promise;
            if (outcome === "reject") throw new Error("injected commands preparation failure");
          }
          return commands;
        }
      });
      try {
        const graph = commands.graphs.createSupervisedGraph({ supervisorSessionId: commands.agent.getInfo().sessionId, nodes: [{ nodeKey: "first", prompt: "inspect evidence" }] });
        commands.graphs.startGraph(graph.graphId);
        await supervisor.tick(); await entered.promise;
        const node = commands.graphs.inspectGraph(graph.graphId).nodes[0]!;
        assert.equal(node.status, "running");
        assert.equal(commands.taskRuns.list().tasks.length, 0);
        let newTask: ReturnType<DurableTaskRunStore["get"]>;
        if (action === "pause" || action === "pause-resume") commands.graphs.pauseGraph(graph.graphId);
        if (action === "pause-resume") commands.graphs.resumeGraph(graph.graphId);
        if (action === "stop") supervisor.stop();
        if (action === "cancel") commands.graphs.cancelGraph(graph.graphId);
        if (action === "new-claim") {
          commands.graphs.recoverRunningNodes(commands.taskRuns);
          assert.ok(commands.graphs.claimIntent(graph.graphId, node.nodeId, randomUUID(), node.taskRunId));
          commands.taskRuns.create({ taskRunId: node.taskRunId, task: "new owner's work" });
          const attempt = commands.taskRuns.createAttempt(node.taskRunId!);
          newTask = commands.taskRuns.transition(node.taskRunId!, "running", { attemptId: attempt.attemptId, artifacts: { owner: "new claim" } });
        }
        release.resolve();
        await settle(() => !supervisor.hasActiveWork());
        const current = commands.graphs.inspectGraph(graph.graphId);
        if (action === "pause") {
          assert.equal(current.status, "paused"); assert.equal(current.nodes[0]?.status, "ready");
          assert.equal(commands.taskRuns.list().tasks.length, 0); assert.equal(network.mock.callCount(), 0);
          await supervisor.tick(); assert.equal(network.mock.callCount(), 0, "paused recovery never dispatches");
          commands.graphs.resumeGraph(graph.graphId);
          await supervisor.tick(); await settle(() => !supervisor.hasActiveWork());
          assert.equal(commands.graphs.inspectGraph(graph.graphId).nodes[0]?.status, "completed");
          assert.equal(network.mock.callCount(), 1); assert.equal(commands.taskRuns.list().tasks[0]?.attempts.length, 1);
        } else if (action === "pause-resume" || action === "none") {
          if (outcome === "resolve") {
            assert.equal(current.nodes[0]?.status, "completed"); assert.equal(network.mock.callCount(), 1);
            assert.equal(commands.taskRuns.list().tasks[0]?.attempts.length, 1, "same admitted claim dispatches once");
          } else {
            assert.equal(current.nodes[0]?.status, "failed"); assert.equal(network.mock.callCount(), 0);
            assert.match(String((current.nodes[0]?.artifact as { error?: string } | undefined)?.error), new RegExp(`injected ${phase} preparation failure`, "u"));
            assert.equal(commands.taskRuns.list().tasks.length, 0, "still-owned preparation failure preserves its original error without a fake TaskRun");
          }
        } else if (action === "new-claim") {
          assert.equal(current.nodes[0]?.status, "running"); assert.equal(network.mock.callCount(), 0);
          assert.deepEqual(commands.taskRuns.get(node.taskRunId!), newTask, "stale preparation cannot fail or dispatch the new owner's TaskRun");
        } else {
          assert.equal(current.status, action === "cancel" ? "cancelled" : "running");
          assert.equal(current.nodes[0]?.status, action === "cancel" ? "cancelled" : "ready");
          assert.equal(commands.taskRuns.list().tasks.length, 0); assert.equal(network.mock.callCount(), 0);
        }
      } finally { release.resolve(); supervisor.stop(); await runtime.close(); network.mock.restore(); await rm(root, { recursive: true, force: true }); }
    });
  }
}

}

for (const paused of [false, true]) test(`startup recovers undispatched claim when graph is ${paused ? "paused" : "running"}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-paused-graph-restart-"));
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  let graphs = await GoalGraphStore.open(root, authority); let tasks = await DurableTaskRunStore.open(root, authority);
  try {
    const graph = graphs.createGraph([{ nodeKey: "first", prompt: "inspect" }]); graphs.startGraph(graph.graphId);
    const node = graphs.readyNodes(graph.graphId)[0]!;
    const taskRunId = `graph:${graph.graphId}:${node.nodeId}`;
    graphs.claimIntent(graph.graphId, node.nodeId, undefined, taskRunId);
    if (paused) graphs.pauseGraph(graph.graphId);
    graphs.close(); tasks.close(); authority.close();
    authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    graphs = await GoalGraphStore.open(root, authority); tasks = await DurableTaskRunStore.open(root, authority);
    graphs.recoverRunningNodes(tasks);
    const recovered = graphs.inspectGraph(graph.graphId);
    assert.equal(recovered.status, paused ? "paused" : "running"); assert.equal(recovered.nodes[0]?.status, "ready");
    const events = graphs.listGraphEvents(graph.graphId, { limit: 1000 }).events;
    graphs.recoverRunningNodes(tasks);
    assert.deepEqual(graphs.inspectGraph(graph.graphId), recovered, "recovery is idempotent");
    assert.deepEqual(graphs.listGraphEvents(graph.graphId, { limit: 1000 }).events, events);
    if (paused) { assert.deepEqual(graphs.readyNodes(graph.graphId), []); graphs.resumeGraph(graph.graphId); }
    assert.equal(graphs.readyNodes(graph.graphId).length, 1);
    assert.equal(tasks.list().tasks.length, 0);
  } finally { graphs.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
});

for (const evidence of ["task-created", "task-running", "task-completed", "fallback-admitted", "fallback-completed", "cancelled", "changed-token"] as const) {
  test(`paused recovery does not release ${evidence} evidence`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-graph-claim-evidence-"));
    const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const graphs = await GoalGraphStore.open(root, authority); const tasks = await DurableTaskRunStore.open(root, authority);
    try {
      const graph = graphs.createGraph([{ nodeKey: "first", prompt: "inspect" }]); graphs.startGraph(graph.graphId);
      const node = graphs.readyNodes(graph.graphId)[0]!; const taskRunId = `graph:${graph.graphId}:${node.nodeId}`;
      const claim = graphs.claimIntent(graph.graphId, node.nodeId, undefined, taskRunId)!;
      assert.ok(claim);
      if (evidence.startsWith("task-")) {
        tasks.create({ taskRunId, task: "existing admitted task" });
        if (evidence !== "task-created") {
          const attempt = tasks.createAttempt(taskRunId);
          tasks.transition(taskRunId, evidence === "task-completed" ? "completed" : "running", { attemptId: attempt.attemptId });
        }
      }
      if (evidence.startsWith("fallback-")) {
        const admitted = authority.startRun({ sessionId: "fallback-session", runId: "fallback-run", turnId: "fallback-turn", continuationSource: `graph:${graph.graphId}:intent:${claim.claimId}` });
        if (evidence === "fallback-completed") authority.finishRun({ runId: admitted.runId, status: "completed", payload: { output: "already dispatched" } });
      }
      if (evidence === "cancelled") graphs.cancelGraph(graph.graphId); else graphs.pauseGraph(graph.graphId);
      const before = graphs.inspectGraph(graph.graphId);
      const beforeEvents = graphs.listGraphEvents(graph.graphId, { limit: 1000 }).events;
      const selected = evidence === "changed-token" ? { ...claim, claimToken: randomUUID() } : claim;
      assert.equal(graphs.releaseUndispatchedClaim(selected, "test ignored release"), false);
      assert.deepEqual(graphs.inspectGraph(graph.graphId), before);
      assert.deepEqual(graphs.listGraphEvents(graph.graphId, { limit: 1000 }).events, beforeEvents, "failed release rolls back its attempted recovery event");
      if (evidence !== "changed-token") { graphs.recoverRunningNodes(tasks); assert.deepEqual(graphs.inspectGraph(graph.graphId), before); }
    } finally { graphs.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
  });
}

async function settle(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) { if (Date.now() >= deadline) throw new Error("Graph work did not settle."); await setImmediate(); }
}

function streamText(content: string): Response {
  return new Response([
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
    "[DONE]"
  ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

for (const fail of [false, true]) for (const action of ["pause", "stop"] as const) {
  test(`dispatched fixed fallback ${fail ? "failure" : "success"} survives ${action} without a TaskRun`, { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-fixed-fallback-result-"));
    const entered = deferred<void>(); const release = deferred<void>();
    const config = structuredClone(defaultConfig);
    config.defaultModel = "synthetic"; config.toolModel = "synthetic";
    config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false, retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 } } };
    config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
    config.checkpoints.enabled = false; config.heartbeat.enabled = false;
    config.context.memory.enabled = false; config.context.identity.enabled = false;
    const network = t.mock.method(globalThis, "fetch", async () => {
      entered.resolve(); await release.promise;
      if (fail) throw new Error("injected dispatched fallback provider failure");
      return streamText("fallback completed");
    });
    const commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
    const runtime = new InteractiveAgentRuntime(commands);
    const supervisor = new GraphSupervisor({ store: commands.graphs, runtime });
    try {
      const graph = commands.graphs.createGraph([{ nodeKey: "first", prompt: "inspect evidence" }]);
      commands.graphs.startGraph(graph.graphId);
      await supervisor.tick(); await entered.promise;
      assert.equal(commands.taskRuns.list().tasks.length, 0);
      assert.equal(commands.graphs.inspectGraph(graph.graphId).nodes[0]?.status, "running");
      if (action === "pause") commands.graphs.pauseGraph(graph.graphId); else supervisor.stop();
      release.resolve(); await settle(() => !supervisor.hasActiveWork());
      const current = commands.graphs.inspectGraph(graph.graphId);
      assert.equal(current.nodes[0]?.status, fail ? "failed" : "completed");
      assert.equal(current.status, fail ? "failed" : "completed");
      assert.equal(commands.taskRuns.list().tasks.length, 0);
      if (fail) assert.match(String((current.nodes[0]?.artifact as { error?: string } | undefined)?.error), /fallback provider failure/u);
      assert.ok(network.mock.callCount() > 0);
    } finally { release.resolve(); supervisor.stop(); await runtime.close(); network.mock.restore(); await rm(root, { recursive: true, force: true }); }
  });
}
