/** supervised GoalGraph、模型工具入口与 Host 监督唤醒的最小闭环。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { createPlanTools } from "../src/extensions/plan.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { startRuntimeHost, connectRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { GoalGraphStore, GraphSupervisor } from "../src/runtime/GoalGraphStore.js";
import { InteractiveAgentRuntime, type InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { pendingTaskVerificationApproval, readTaskDefinition, type TaskVerificationContract } from "../src/runtime/taskVerification.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

const contract: TaskVerificationContract = {
  version: 1,
  objective: "artifact is valid",
  checks: [{ id: "check", command: "node -e \"process.exit(0)\"", definitionPaths: [] }],
  artifactPaths: ["artifact.txt"],
  allowedRepairPaths: ["artifact.txt"],
  maxAttempts: 2
};

await testSupervisedGraphStateMachine();
await testBusyCheckpointDoesNotBlockOtherGraphs();
await testNaturalLanguagePlanStartAndInternalWakeTurn();
await testHostPlanApprovalRestartAndDelivery();
await testHostPlanApprovalRestartAndDelivery(true);
await testHostPlanApprovalRestartAndDelivery(false, true);
await testHostReadOnlyReportPlan();
console.log("plan execute tests passed");

async function testSupervisedGraphStateMachine(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-plan-store-"));
  const authority = await RuntimeEventAuthority.open(root);
  const tasks = await DurableTaskRunStore.open(root, authority);
  let graphs = await GoalGraphStore.open(root, authority);
  try {
    assert.throws(() => graphs.createSupervisedGraph({
      supervisorSessionId: "session-a",
      nodes: [
        node("a", []),
        node("b", ["missing"])
      ]
    }), /missing node/u);
    assert.throws(() => graphs.createSupervisedGraph({
      supervisorSessionId: "session-a",
      nodes: [
        node("a", ["b"]),
        node("b", ["a"])
      ]
    }), /cycle/u);

    const created = graphs.createSupervisedGraph({
      supervisorSessionId: "session-a",
      supervisorRunId: "root-run",
      nodes: [node("a", []), node("b", ["a"])]
    });
    assert.equal(created.mode, "supervised");
    assert.equal(created.maxReplans, 2);
    graphs.startGraph(created.graphId);
    const first = graphs.readyNodes(created.graphId)[0]!;
    assert.equal(first.nodeKey, "a");
    assert.ok(graphs.claimIntent(created.graphId, first.nodeId));
    graphs.completeNode(created.graphId, first.nodeId, "failed", { error: "first failure" });
    assert.equal(graphs.inspectGraph(created.graphId).status, "running", "supervised nodes must not auto-finish the graph");
    assert.equal(graphs.listSupervisorWakes().at(-1)?.checkpoint, "needs_attention");
    assert.throws(
      () => graphs.replaceSupervisedNode(created.graphId, "other-session", first.nodeId, { nodeKey: "a2", prompt: "repair" }),
      /another session/u
    );

    let graph = graphs.replaceSupervisedNode(created.graphId, "session-a", first.nodeId, { nodeKey: "a2", prompt: "repair without weakening checks" });
    const replacement = graph.nodes.find((candidate) => candidate.replacesNodeId === first.nodeId)!;
    const inherited = readTaskDefinition(replacement.intent).verification;
    assert.equal(inherited?.objective, contract.objective);
    assert.deepEqual(inherited?.artifactPaths, contract.artifactPaths);
    assert.deepEqual(inherited?.checks.map((check) => ({ id: check.id, command: check.command })), [{ id: "check", command: contract.checks[0]!.command }]);
    assert.ok(graphs.claimIntent(graph.graphId, replacement.nodeId));
    graphs.completeNode(graph.graphId, replacement.nodeId, "completed", { verification: { status: "passed" } });
    const second = graphs.readyNodes(graph.graphId)[0]!;
    assert.equal(second.nodeKey, "b", "dependency must follow the latest replacement chain");
    assert.ok(graphs.claimIntent(graph.graphId, second.nodeId));
    graphs.completeNode(graph.graphId, second.nodeId, "completed", { verification: { status: "passed" } });
    graph = graphs.inspectGraph(graph.graphId);
    assert.equal(graph.status, "running");
    assert.equal(graphs.listSupervisorWakes().at(-1)?.checkpoint, "settled");

    graphs.addSupervisedNodes(graph.graphId, "session-a", [node("c", ["b"])]);
    assert.throws(() => graphs.addSupervisedNodes(graph.graphId, "session-a", [node("d", [])]), /replan limit/u);
    const staleWake = graphs.listSupervisorWakes().find((wake) => wake.graphRevision !== graphs.inspectGraph(graph.graphId).revision);
    assert.ok(staleWake);
    assert.equal(graphs.claimSupervisorWake(staleWake.wakeId), undefined, "old revision wakes must be discarded");
    const third = graphs.readyNodes(graph.graphId)[0]!;
    assert.ok(graphs.claimIntent(graph.graphId, third.nodeId));
    graphs.completeNode(graph.graphId, third.nodeId, "completed", { verification: { status: "passed" } });
    const finished = graphs.finishSupervisedGraph(graph.graphId, "session-a", "completed", "all checks passed");
    assert.equal(finished.status, "completed");

    const controlled = graphs.createSupervisedGraph({ supervisorSessionId: "session-tool", nodes: [node("p", []), node("q", ["p"])] });
    graphs.startGraph(controlled.graphId);
    const [, statusTool, updateTool] = createPlanTools({ graphs, taskRuns: tasks });
    const toolContext = { toolCallId: "plan-tool", operationId: "plan-tool", sessionId: "session-tool", runId: "supervisor-run", turnId: "supervisor-run" };
    const stopArgs = { action: "stop" as const, graphId: controlled.graphId, reason: "test stop" };
    await assert.rejects(executeTool(updateTool!, stopArgs, toolContext), /PlanStatus must be called/u);
    await executeTool(statusTool!, { graphId: controlled.graphId }, toolContext);
    const stopped = await executeTool(updateTool!, stopArgs, toolContext) as { status?: string };
    assert.equal(stopped.status, "cancelled");

    const wakeGraph = graphs.createSupervisedGraph({ supervisorSessionId: "session-wake", nodes: [node("x", []), node("y", ["x"])] });
    graphs.startGraph(wakeGraph.graphId);
    const x = graphs.readyNodes(wakeGraph.graphId)[0]!;
    graphs.claimIntent(wakeGraph.graphId, x.nodeId);
    graphs.completeNode(wakeGraph.graphId, x.nodeId, "failed");
    graphs.close();
    graphs = await GoalGraphStore.open(root, authority);
    let wakeRuns = 0;
    const fakeRuntime = {
      getSnapshot: () => ({ state: { kind: "idle" }, info: { sessionId: "session-wake" } }),
      submitSupervisionTurn: () => {
        wakeRuns += 1;
        return { runId: "wake", messageId: "wake-message", completion: Promise.resolve({ runId: "wake", status: "completed", stopReason: "model_stop", steps: 1, output: "reported", durationMs: 1 }) };
      }
    } as unknown as InteractiveRuntimeHandle;
    const supervisor = new GraphSupervisor({ store: graphs, runtime: fakeRuntime, taskRuns: tasks, resolveSupervisorRuntime: async () => fakeRuntime });
    await supervisor.tick();
    await waitUntil(() => wakeRuns === 1 && graphs.listSupervisorWakes().every((wake) => wake.graphId !== wakeGraph.graphId));
    await supervisor.tick();
    assert.equal(wakeRuns, 1, "duplicate scans must not dispatch the same checkpoint twice");
    supervisor.stop();

    const terminalWakeGraph = graphs.createSupervisedGraph({ supervisorSessionId: "session-wake", nodes: [node("m", []), node("n", ["m"])] });
    graphs.startGraph(terminalWakeGraph.graphId);
    const m = graphs.readyNodes(terminalWakeGraph.graphId)[0]!;
    graphs.claimIntent(terminalWakeGraph.graphId, m.nodeId);
    graphs.completeNode(terminalWakeGraph.graphId, m.nodeId, "failed");
    const terminalWake = graphs.listSupervisorWakes().find((wake) => wake.graphId === terminalWakeGraph.graphId)!;
    const claimed = graphs.claimSupervisorWake(terminalWake.wakeId)!;
    authority.startRun({ runId: claimed.runId!, sessionId: claimed.sessionId!, turnId: claimed.runId! });
    authority.finishRun({ runId: claimed.runId!, status: "completed", payload: { output: "already delivered" } });
    graphs.close();
    graphs = await GoalGraphStore.open(root, authority);
    const restartedSupervisor = new GraphSupervisor({ store: graphs, runtime: fakeRuntime, taskRuns: tasks, resolveSupervisorRuntime: async () => fakeRuntime });
    await restartedSupervisor.tick();
    await waitUntil(() => graphs.listSupervisorWakes().every((wake) => wake.graphId !== terminalWakeGraph.graphId));
    assert.equal(wakeRuns, 1, "a terminal deterministic wake run must not execute again after restart");
    restartedSupervisor.stop();
  } finally {
    graphs.close();
    tasks.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testBusyCheckpointDoesNotBlockOtherGraphs(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-plan-busy-checkpoint-"));
  const authority = await RuntimeEventAuthority.open(root);
  const tasks = await DurableTaskRunStore.open(root, authority);
  const graphs = await GoalGraphStore.open(root, authority);
  let busy = true;
  const outcome = { runId: "boundary-run", status: "completed", stopReason: "model_stop", steps: 1, output: "done", durationMs: 1 };
  const idleRuntime = {
    getSnapshot: () => ({ state: { kind: "idle" }, info: { sessionId: "idle-session", planning: false } }),
    submitPrompt: () => ({ completion: Promise.resolve(outcome) })
  } as unknown as InteractiveRuntimeHandle;
  const ownerRuntime = {
    getSnapshot: () => ({ state: { kind: busy ? "runs" : "idle" }, info: { sessionId: "owner", planning: false } }),
    submitSupervisionTurn: () => ({ completion: Promise.resolve(outcome) })
  } as unknown as InteractiveRuntimeHandle;
  const supervisor = new GraphSupervisor({ store: graphs, runtime: idleRuntime, resolveSupervisorRuntime: async () => ownerRuntime });
  try {
    // Given 监督检查点所属会话繁忙；Then 保留待处理 wake，但允许其他空闲会话推进。
    const waiting = graphs.createSupervisedGraph({ supervisorSessionId: "owner", nodes: [node("a", []), node("b", ["a"])] });
    graphs.startGraph(waiting.graphId);
    const first = graphs.readyNodes(waiting.graphId)[0]!;
    graphs.claimIntent(waiting.graphId, first.nodeId);
    graphs.completeNode(waiting.graphId, first.nodeId, "failed");
    const wake = graphs.listSupervisorWakes()[0]!;
    const fixed = graphs.createGraph(undefined, [{ nodeKey: "independent", prompt: "work" }, { nodeKey: "next", prompt: "more work" }]);
    graphs.startGraph(fixed.graphId);
    const scheduleWakeId = graphs.createWake(fixed.graphId, "test-ready");
    await supervisor.tick();
    await waitUntil(() => graphs.inspectGraph(fixed.graphId).nodes[0]?.status === "completed");
    assert.equal(graphs.inspectGraph(fixed.graphId).nodes[1]?.status, "pending", "one scan dispatches only one serial worker");
    assert.equal(graphs.listSupervisorWakes().find((item) => item.wakeId === wake.wakeId)?.status, "pending");
    assert.ok(graphs.listGraphEvents(fixed.graphId).events.some((event) => event.eventType === "graph.wake.completed" && JSON.stringify(event.payload).includes(scheduleWakeId)));

    // When 原会话空闲；Then 先完成监督 wake，下一次扫描才能认领第二项工作。
    busy = false;
    await supervisor.tick();
    await waitUntil(() => !graphs.listSupervisorWakes().some((item) => item.wakeId === wake.wakeId));
    assert.equal(graphs.inspectGraph(fixed.graphId).nodes[1]?.status, "pending");
    await supervisor.tick();
    await waitUntil(() => graphs.inspectGraph(fixed.graphId).status === "completed");
  } finally {
    supervisor.stop();
    graphs.close(); tasks.close(); authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testNaturalLanguagePlanStartAndInternalWakeTurn(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-plan-model-"));
  const originalFetch = globalThis.fetch;
  let phase: "plan" | "supervision" | "simple" = "plan";
  let planCalls = 0;
  globalThis.fetch = (async (_input, init): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ name?: string; function?: { name?: string } }>;
    };
    const messages = body.messages ?? [];
    const system = textContent(messages[0]?.content);
    const lastText = textContent(messages.at(-1)?.content);
    const names = new Set((body.tools ?? []).flatMap((tool) => tool.name ?? tool.function?.name ?? []));
    if (system.includes("tool search assistant")) return streamText('{"tools":["PlanStart"]}');
    if (system.includes("选择需要的工具")) return streamText('{"tools":[]}');
    if (system.includes("选择需要的技能")) return streamText('{"skillIds":[]}');
    if (phase === "plan" && !names.has("PlanStart")) return streamToolCall("find-plan", "ToolSearch", { query: "PlanStart" });
    if (phase === "plan" && planCalls === 0) {
      planCalls += 1;
      return streamToolCall("start-plan", "PlanStart", {
        objective: "完成两个有依赖且可验收的步骤",
        constraints: ["不得跳过验收"],
        nodes: [
          { key: "prepare", task: "prepare artifact", verification: publicContract() },
          { key: "verify", task: "verify artifact", dependencies: ["prepare"], verification: publicContract() }
        ]
      });
    }
    if (phase === "supervision") {
      assert.equal(names.has("PlanStatus"), true);
      assert.equal(names.has("PlanUpdate"), true);
      assert.match(lastText, /Supervise durable plan/u);
      return streamText("supervision delivered");
    }
    if (phase === "simple") return streamText("普通回答");
    return streamText("plan started");
  }) as typeof fetch;

  try {
    const configStore: AgentConfigStore = { load: async () => config(), save: async () => undefined };
    const commands = await createCommandRuntime(root, { configStore });
    const runtime = new InteractiveAgentRuntime(commands);
    const sessionId = commands.agent.getInfo().sessionId;
    const outcome = await runtime.submitPrompt("请执行一个需要先准备再验收、并且重启后还能继续的长程任务。").completion;
    assert.equal(outcome.status, "completed");
    assert.equal(planCalls, 1);
    const graphs = commands.graphs.listGraphs();
    assert.equal(graphs.length, 1);
    assert.equal(graphs[0]?.mode, "supervised");
    assert.equal(graphs[0]?.supervisorSessionId, sessionId);
    assert.equal(graphs[0]?.nodes.length, 2);
    assert.equal(commands.graphs.listGoals().length, 0, "a plan must not create a second objective ledger");

    const before = await readSessionEvents(sessionFilePath(root, sessionId));
    const beforeUsers = before.filter((event) => event.type === "user_message").length;
    phase = "supervision";
    const internal = await runtime.submitSupervisionTurn!(
      `Supervise durable plan ${graphs[0]!.graphId} at settled revision ${String(graphs[0]!.revision)}.`,
      { runId: "internal-supervision", turnId: "internal-supervision", parentRunId: `graph:${graphs[0]!.graphId}` }
    ).completion;
    assert.equal(internal.status, "completed");
    const after = await readSessionEvents(sessionFilePath(root, sessionId));
    assert.equal(after.filter((event) => event.type === "user_message").length, beforeUsers, "supervision input must not become a user message");
    assert.ok(after.some((event) => event.type === "assistant_message" && event.content.includes("supervision delivered")));

    phase = "simple";
    await runtime.submitPrompt("你好").completion;
    assert.equal(commands.graphs.listGraphs().length, 1, "ordinary chat must not create another graph");
    await runtime.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
}

/** 真实 Host/会话/工具/文件与审批链路，仅替换不稳定的模型协议边界。 */
async function testHostPlanApprovalRestartAndDelivery(planning = false, independent = false): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-plan-host-"));
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, ".agent-test");
  let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
  let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
  let commands: CommandRuntime;
  let sessionId: string | undefined;
  let graphId = "";
  let planStarted = false;
  const workerWrites: string[] = [];
  const reports: string[] = [];
  const schedulingEvents: string[] = [];
  const evidenceTaskIds: string[] = [];
  const check = (file: string) => `node -e "const fs=require('node:fs');if(fs.readFileSync('${file}','utf8')!=='good')process.exit(1);fs.appendFileSync('.verification-state/checks','${file}\\n')"`;
  const nodeContract = (file: string) => ({
    objective: `${file} contains good`,
    checks: [{ id: file, command: check(file), cwd: ".", definitionPaths: [] }],
    artifactPaths: [file], allowedRepairPaths: [file], maxAttempts: 1
  });
  globalThis.fetch = (async (_input, init): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const system = textContent(body.messages[0]?.content);
    const last = body.messages.at(-1)!;
    const lastText = textContent(last.content);
    if (system.includes("tool search assistant")) return streamText(JSON.stringify({ tools: [planning ? "PlanDraft" : "PlanStart"] }));
    if (system.includes("选择需要的工具")) return streamText('{"tools":[]}');
    if (system.includes("选择需要的技能")) return streamText('{"skillIds":[]}');
    if (system.includes("focused, bounded worker inside Biny")) {
      const admission = await client!.submitRunForSession(sessionId!, "This must not create a second writer during plan work.");
      assert.equal(admission.accepted, false, "a graph Worker holds the original session writer");
      const packet = body.messages.map((message) => textContent(message.content)).join("\n");
      if (packet.includes('"kind":"review"')) {
        assert.ok(!body.tools?.some((tool) => ["Write", "Bash", "Task"].includes(tool.function?.name ?? "")), "review must expose read-only tools");
        if (last.role !== "tool") return streamToolCall("read-candidate", "Read", { path: "first.txt" });
        return streamText(JSON.stringify({ verdict: "passed", summary: "read candidate", evidenceReferences: ["first.txt"], findings: [] }));
      }
      if (last.role === "tool") return streamText("candidate ready");
      const file = JSON.stringify(body.messages).includes("consume-node") ? "second.txt" : "first.txt";
      workerWrites.push(file);
      schedulingEvents.push(`worker:${file}`);
      return streamToolCall(`write-${file}`, "Write", { path: file, content: "good" });
    }
    if (last.role === "user" && lastText.includes("Supervise durable plan ") && body.tools?.some((tool) => tool.function?.name === "PlanStatus")) {
      return streamToolCall("inspect-plan", "PlanStatus", { graphId });
    }
    if (last.role === "tool" && last.tool_call_id === "inspect-plan") {
      if (lastText.includes('"approvalId"')) {
        reports.push(lastText);
        schedulingEvents.push("approval-report");
        return streamText(`等待审批：${lastText}`);
      }
      assert.match(lastText, /settled/u);
      const status = JSON.parse(lastText) as { nodes: Array<{ taskRunId: string }> };
      evidenceTaskIds.push(...status.nodes.map((node) => node.taskRunId));
      return streamToolCall(`inspect-evidence-${evidenceTaskIds.length}`, "TaskStatus", { taskRunId: evidenceTaskIds.shift()! });
    }
    if (last.role === "tool" && last.tool_call_id?.startsWith("inspect-evidence-")) {
      assert.match(lastText, /passed/u);
      if (evidenceTaskIds.length) return streamToolCall(`inspect-evidence-${evidenceTaskIds.length}`, "TaskStatus", { taskRunId: evidenceTaskIds.shift()! });
      return streamToolCall("finish-plan", "PlanUpdate", { graphId, action: "finish", outcome: "completed", summary: "两个节点已通过真实验收" });
    }
    if (last.role === "tool" && last.tool_call_id === "finish-plan") {
      assert.match(lastText, /completed/u);
      return streamText("计划验收通过，交付两个文件。");
    }
    if (!planStarted) {
      const planTool = planning ? "PlanDraft" : "PlanStart";
      if (!body.tools?.some((tool) => tool.function?.name === planTool)) {
        return streamToolCall("discover-plan", "ToolSearch", { query: planTool });
      }
      planStarted = true;
      return streamToolCall("start-plan", planTool, {
        objective: "顺序生成并验收两个文件", constraints: ["保留每步验收"],
        nodes: [
          { key: "prepare", task: "prepare-node: create first.txt", verification: nodeContract("first.txt"), review: planning ? "Read first.txt and independently review correctness." : undefined },
          { key: "consume", task: "consume-node: create second.txt", dependencies: independent ? [] : ["prepare"], verification: nodeContract("second.txt") }
        ]
      });
    }
    return streamText("计划已开始");
  }) as typeof fetch;
  const testConfig = config();
  testConfig.permission = { ...testConfig.permission, mode: "ask", criticalAlwaysAsk: true };
  testConfig.extensions.subagent.maxSteps = 4;
  testConfig.workspace.ignore = [...testConfig.workspace.ignore, ".verification-state", ".agent-test"];
  let storedConfig = structuredClone(testConfig);
  let configRevision = 0;
  const configStore: AgentConfigStore = {
    load: async () => structuredClone(storedConfig),
    save: async (config) => { storedConfig = structuredClone(config); configRevision++; },
    loadVersioned: async () => ({ config: structuredClone(storedConfig), revision: String(configRevision) }),
    saveVersioned: async (config, revision) => {
      assert.equal(revision, String(configRevision));
      storedConfig = structuredClone(config); configRevision++;
      return { config: structuredClone(storedConfig), revision: String(configRevision) };
    }
  };
  const factory = async () => {
    const existingSessionId = sessionId;
    commands = await createCommandRuntime(root, { sessionId, configStore });
    sessionId = commands.agent.getInfo().sessionId;
    const runtime = new InteractiveAgentRuntime(commands);
    if (existingSessionId) await runtime.resumeSession(existingSessionId);
    runtime.subscribe((update) => {
      if (update.event?.type === "permission.requested") {
        runtime.answerPermission(update.event.requestId, { approved: true, action: "allow_once", scope: "once", confirmation: "yes" });
      }
      graphId = commands.graphs.listGraphs()[0]?.graphId ?? graphId;
    });
    return { commands, runtime };
  };
  try {
    await mkdir(path.join(root, ".verification-state"));
    host = await startRuntimeHost(root, factory);
    client = await connectRuntimeHost(root, { clientId: "plan-test", surface: "cli" });
    if (planning) await client.setPlanning(sessionId!, true);
    const outcome = await client.submitPrompt(independent
      ? "请在后台分别生成并验收两个独立文件，遇到审批及时告诉我。"
      : "请先生成第一个文件并验收，再生成第二个文件；后台继续，最后在这里交付。").completion;
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    if (planning) {
      const draft = (await client.planList(sessionId!))[0]!;
      assert.equal(draft.status, "draft");
      assert.equal(commands!.taskRuns.list().tasks.length, 0, "draft never dispatches workers");
      assert.deepEqual(workerWrites, []);
      await assert.rejects(client.graphStart(draft.graphId), /Planning mode/u);
      await client.close(); client = undefined;
      await host.close(); host = undefined;
      host = await startRuntimeHost(root, factory);
      client = await connectRuntimeHost(root, { clientId: "plan-draft-restarted", surface: "cli" });
      assert.equal(commands!.agent.getInfo().planning, true, "planning survives Host restart");
      await assert.rejects(client.startPlanDraft(sessionId!, draft.graphId, draft.revision + 1), /stale/u);
      await client.setPermissionMode("read-only");
      await assert.rejects(client.startPlanDraft(sessionId!, draft.graphId, draft.revision), /read.only/iu);
      assert.equal(commands!.agent.getInfo().planning, true, "denied start restores planning mode");
      assert.equal(commands!.graphs.inspectGraph(draft.graphId).status, "draft");
      await client.setPermissionMode("ask");
      await client.startPlanDraft(sessionId!, draft.graphId, draft.revision);
      assert.equal(commands!.agent.getInfo().planning, false);
      await assert.rejects(client.startPlanDraft(sessionId!, draft.graphId, draft.revision), /stale|busy/u);
    }
    await waitUntil(() => reports.length >= 1, 15_000).catch((error: unknown) => {
      throw new Error(JSON.stringify({ graphs: commands!.graphs.listGraphs(), tasks: commands!.taskRuns.list({ limit: 20 }), workerWrites }), { cause: error });
    });
    if (independent) {
      // Given 第一项等待审批且另一项独立工作可运行；When Host 继续扫描；
      // Then 先把准确审批对象报告给原会话，再执行独立工作，不让工作队列饿死监督通知。
      await waitUntil(() => workerWrites.includes("second.txt"), 15_000);
      assert.ok(schedulingEvents.indexOf("approval-report") < schedulingEvents.indexOf("worker:second.txt"), JSON.stringify(schedulingEvents));
      assert.ok(reports[0]!.includes(JSON.stringify(check("first.txt")).slice(1, -1)));
      await waitUntil(() => reports.length >= 2, 15_000);
      await client.waitForIdle();
      assert.deepEqual(workerWrites, ["first.txt", "second.txt"]);
      await client.graphCancel(graphId);
      assert.equal(commands!.graphs.inspectGraph(graphId).status, "cancelled");
      return;
    }
    const first = commands!.taskRuns.list({ limit: 20 }).tasks[0]!;
    const approval = pendingTaskVerificationApproval(first.attempts[0]?.verification)!;
    assert.ok(approval);
    assert.match(reports[0]!, new RegExp(approval.approvalId));
    assert.ok(reports[0]!.includes(JSON.stringify(check("first.txt")).slice(1, -1)), reports[0]);
    await client.waitForIdle();
    await client.close();
    client = undefined;
    await host.close();
    host = undefined;

    // 重新装配 Host 和所有 stores，从同一持久 Session 恢复等待审批的节点。
    host = await startRuntimeHost(root, factory);
    client = await connectRuntimeHost(root, { clientId: "plan-test-restarted", surface: "cli" });
    assert.equal(commands!.taskRuns.get(first.taskRunId)?.status, "needs_approval");
    assert.equal((await client.taskApprove(first.taskRunId, approval.approvalId)).accepted, true);
    await waitUntil(() => reports.length === 2, 15_000).catch((error: unknown) => {
      throw new Error(JSON.stringify({ graphs: commands!.graphs.listGraphs(), tasks: commands!.taskRuns.list({ limit: 20 }), workerWrites, reports }), { cause: error });
    });
    const second = commands!.taskRuns.list({ limit: 20 }).tasks.find((task) => readTaskDefinition(task.task).verification?.artifactPaths.includes("second.txt"))!;
    const secondApproval = pendingTaskVerificationApproval(second.attempts[0]?.verification)!;
    assert.ok(secondApproval);
    await client.waitForIdle();
    assert.equal((await client.taskApprove(second.taskRunId, secondApproval.approvalId)).accepted, true);
    await waitUntil(() => commands!.graphs.inspectGraph(graphId).status === "completed", 15_000);
    await client.waitForIdle();
    assert.deepEqual(workerWrites, ["first.txt", "second.txt"], "approval and restart must not repeat a Worker");
    assert.equal(await readFile(path.join(root, ".verification-state/checks"), "utf8"), "first.txt\nsecond.txt\n");
    assert.equal(commands!.taskRuns.get(first.taskRunId)?.attempts.length, 1);
    assert.equal(commands!.taskRuns.get(second.taskRunId)?.attempts.length, 1);
    const events = await readSessionEvents(sessionFilePath(root, sessionId!));
    assert.equal(events.filter((event) => event.type === "user_message" && !event.auditOnly).length, 1);
    assert.ok(events.some((event) => event.type === "assistant_message" && event.content.includes("计划验收通过")));
  } finally {
    await client?.close();
    await host?.close();
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

/** 从自然语言建草稿、重启、确认执行到报告交付；只有模型 HTTP 协议边界使用 fake。 */
async function testHostReadOnlyReportPlan(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-plan-reports-host-"));
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, ".agent-test");
  let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
  let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
  let commands: CommandRuntime;
  let sessionId: string | undefined;
  let graphId = "";
  let drafted = false;
  const workerReports: string[] = [];
  const testConfig = config();
  testConfig.extensions.subagent.maxSteps = 4;
  globalThis.fetch = (async (_input, init): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const system = textContent(body.messages[0]?.content);
    const last = body.messages.at(-1)!;
    const names = (body.tools ?? []).map((tool) => tool.function?.name);
    if (system.includes("tool search assistant")) return streamText('{"tools":["PlanDraft"]}');
    if (system.includes("选择需要的工具")) return streamText('{"tools":[]}');
    if (system.includes("选择需要的技能")) return streamText('{"skillIds":[]}');
    if (system.includes("focused, bounded worker inside Biny")) {
      assert.ok(!names.some((name) => ["Write", "Edit", "Bash", "Task"].includes(name ?? "")));
      const packet = body.messages.map((message) => textContent(message.content)).join("\n");
      assert.match(packet, /"kind":"report"/u);
      if (last.role !== "tool") return streamToolCall("read-report-source", "Read", { path: "source.txt" });
      assert.match(textContent(last.content), /source fact/u);
      const report = packet.includes("synthesize-report") ? "Conclusion from source.txt and upstream report: source fact; not independently verified." : "Observation in source.txt: source fact.";
      if (packet.includes("synthesize-report")) assert.match(packet, /Observation in source.txt/u);
      workerReports.push(report);
      return streamText(report);
    }
    if (last.role === "user" && textContent(last.content).includes("Supervise durable plan ")) return streamToolCall("read-report-plan", "PlanStatus", { graphId });
    if (last.role === "tool" && last.tool_call_id === "read-report-plan") {
      const status = JSON.parse(textContent(last.content)) as { checkpoint: string; nodes: Array<{ completionBasis: string; report: { output: string; verification?: unknown } }> };
      assert.equal(status.checkpoint, "settled");
      assert.equal(status.nodes.length, 2);
      for (const node of status.nodes) {
        assert.equal(node.completionBasis, "report");
        assert.match(node.report.output, /source.txt/u);
        assert.equal(node.report.verification, undefined);
      }
      return streamToolCall("finish-reports", "PlanUpdate", { graphId, action: "finish", outcome: "completed", summary: "已读取两份报告并核对验收标准，结论未经过独立命令验证。" });
    }
    if (last.role === "tool" && last.tool_call_id === "finish-reports") return streamText("分析交付：source.txt 包含 source fact；这是只读分析结论，不是测试通过证明。");
    if (!drafted) {
      if (!names.includes("PlanDraft")) return streamToolCall("find-report-plan", "ToolSearch", { query: "PlanDraft" });
      drafted = true;
      return streamToolCall("draft-reports", "PlanDraft", {
        objective: "在后台分析本地来源并综合结论，允许重启后继续",
        nodes: [
          { key: "inspect", task: "Inspect source.txt and return observations", acceptance: ["Cite source.txt and its actual content"] },
          { key: "synthesize", task: "synthesize-report: interpret upstream observations", acceptance: ["Distinguish observations from unverified conclusions"], dependencies: ["inspect"] }
        ]
      });
    }
    return streamText("草稿已保存，等待确认。");
  }) as typeof fetch;
  const factory = async () => {
    const existingSession = sessionId;
    commands = await createCommandRuntime(root, { sessionId, configStore: { load: async () => testConfig, save: async () => undefined } });
    sessionId = commands.agent.getInfo().sessionId;
    const runtime = new InteractiveAgentRuntime(commands);
    if (existingSession) await runtime.resumeSession(existingSession);
    return { commands, runtime };
  };
  try {
    await writeFile(path.join(root, "source.txt"), "source fact");
    host = await startRuntimeHost(root, factory);
    client = await connectRuntimeHost(root, { clientId: "report-test", surface: "cli" });
    await client.setPlanning(sessionId!, true);
    assert.equal((await client.submitPrompt("请先规划一个可在后台持续、重启后恢复的本地资料分析任务：读取来源，再综合结论，不修改文件。").completion).status, "completed");
    const draft = (await client.planList(sessionId!))[0]!;
    graphId = draft.graphId;
    assert.equal(draft.status, "draft");
    assert.equal(commands!.taskRuns.list().tasks.length, 0);
    await client.close(); client = undefined;
    await host.close(); host = undefined;
    host = await startRuntimeHost(root, factory);
    client = await connectRuntimeHost(root, { clientId: "report-restarted", surface: "cli" });
    await client.startPlanDraft(sessionId!, graphId, draft.revision);
    await waitUntil(() => commands!.graphs.inspectGraph(graphId).status === "completed", 15_000);
    await client.waitForIdle();
    assert.equal(workerReports.length, 2);
    assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "source fact");
    const plan = (await client.planList(sessionId!))[0]!;
    assert.deepEqual(plan.pendingApprovals, []);
    for (const node of plan.nodes) {
      const task = commands!.taskRuns.get(node.taskRunId!)!;
      assert.equal(task.attempts.length, 1);
      assert.equal(task.attempts[0]!.verification, undefined);
      const reused = await commands!.startTaskRun(task.taskRunId);
      assert.match((await reused.completion).output!, /source.txt/u);
    }
    assert.equal(workerReports.length, 2, "reading completed reports must not dispatch workers again");
    const events = await readSessionEvents(sessionFilePath(root, sessionId!));
    assert.equal(events.filter((event) => event.type === "user_message" && !event.auditOnly).length, 1);
    assert.ok(events.some((event) => event.type === "assistant_message" && event.content.includes("分析交付")));
    assert.ok(events.some((event) => event.type === "tool_call" && event.tool === "PlanStatus"));
    assert.ok(events.some((event) => event.type === "tool_result"));
  } finally {
    await client?.close(); await host?.close();
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

function node(key: string, dependencies: string[]): { nodeKey: string; prompt: string; dependencies: string[]; verification: TaskVerificationContract } {
  return { nodeKey: key, prompt: `work ${key}`, dependencies, verification: contract };
}

function publicContract(): Record<string, unknown> {
  return {
    objective: contract.objective,
    checks: contract.checks,
    artifactPaths: contract.artifactPaths,
    allowedRepairPaths: contract.allowedRepairPaths,
    maxAttempts: contract.maxAttempts
  };
}

function config(): AgentConfig {
  return {
    ...defaultConfig,
    defaultModel: "plan-execute-test",
    providers: { test: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "test-key" } },
    models: {
      "plan-execute-test": {
        ...defaultConfig.models["deepseek-v4-flash"],
        provider: "test",
        model: "plan-execute-test",
        displayName: "Plan Execute Test"
      }
    },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
    checkpoints: { enabled: false },
    extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true, maxSteps: 2 } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  };
}

function streamToolCall(id: string, name: string, args: Record<string, unknown>): Response {
  return stream([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ]);
}

function streamText(content: string): Response {
  return stream([
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ]);
}

function stream(parts: unknown[]): Response {
  return new Response([...parts.map((part) => `data: ${JSON.stringify(part)}`), "data: [DONE]"].join("\n\n") + "\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "object" && part !== null && "text" in part ? String(part.text) : "").join("");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for plan state.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function executeTool(tool: ReturnType<typeof createPlanTools>[number], args: unknown, context: { toolCallId: string; operationId: string; sessionId: string; runId: string; turnId: string }): Promise<unknown> {
  const execution = await tool.resolveExecution(args);
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return await execution.execute(context);
}
