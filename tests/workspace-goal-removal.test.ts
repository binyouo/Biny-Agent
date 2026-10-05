import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost, connectRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { runtimeCommandOperation } from "../src/runtime/commands.js";

test("workspace goals are absent while session goals and graph execution remain available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-goal-removal-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const graphs = await GoalGraphStore.open(root, authority);
  const goals = await SessionGoalStore.open(root, authority);
  try {
    assert.equal(authority.databaseHandle().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'goals'").get(), undefined);
    assert.equal("createGoal" in graphs, false);
    assert.equal("getGoal" in graphs, false);
    for (const input of ["/goal get old-id", "/goal pause old-id", "/goal resume old-id", "/goal cancel old-id"]) {
      assert.equal(runtimeCommandOperation(input), undefined);
    }
    assert.equal(runtimeCommandOperation("/goal pause"), "session.goal.pause");
    const goal = goals.set("session-a", "Finish the current objective");
    assert.equal(goals.get("session-a")?.goalId, goal.goalId);
    const graph = graphs.createGraph([{ nodeKey: "inspect", prompt: "Inspect the workspace" }]);
    graphs.startGraph(graph.graphId);
    graphs.claimIntent(graph.graphId, graph.nodes[0]!.nodeId);
    graphs.completeNode(graph.graphId, graph.nodes[0]!.nodeId, "completed", { report: "done" });
    assert.equal(graphs.inspectGraph(graph.graphId).status, "completed");
    assert.equal(goals.get("session-a")?.status, "active", "graph completion does not finish a session objective");
  } finally {
    goals.close(); graphs.close(); authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host and CLI reject workspace goal operations and expose independent graphs", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-goal-host-"));
  const configDir = path.join(root, "config");
  await saveConfig(root, {
    ...structuredClone(defaultConfig),
    defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  }, { globalDir: configDir });
  const local = await createInteractiveAgentHost(root, { configStore: createFileConfigStore(root, { globalDir: configDir }) });
  const server = await startRuntimeHost(root, async () => local, { configDir });
  const client = await connectRuntimeHost(root, { spawnOptions: { workspaceRoot: root, configDir } });
  try {
    assert.ok(client);
    for (const action of ["create", "get", "list", "pause", "resume", "cancel"]) {
      await assert.rejects(client.request(`goal.${action}`, { title: "Removed objective", goalId: "old-goal" }), /Unknown Runtime Host operation/u);
    }
    const created = await client.graphCreate({ nodes: [{ nodeKey: "inspect", prompt: "Inspect without starting a model" }] });
    assert.equal(created.accepted, true);
    const graphs = await client.graphList() as Array<{ graphId: string }>;
    assert.equal(graphs.length, 1);
    assert.equal(local.commands.graphs.inspectGraph(graphs[0]!.graphId).nodes.length, 1);
    await assert.rejects(client.executeCommand("/goal get old-goal", "cli"), /Usage:/u);

    const execFile = promisify(execFileCallback);
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const options = { cwd: root, timeout: 5_000 };
    const help = await execFile(process.execPath, [...process.execArgv, cli, "goal", "--help"], options);
    assert.match(help.stdout, /show|set|pause|resume|clear/u);
    assert.doesNotMatch(help.stdout, /create|cancel|workspace|list/u);
    await assert.rejects(execFile(process.execPath, [...process.execArgv, cli, "goal", "create", "old-goal"], options), /unknown command/u);
    await assert.rejects(execFile(process.execPath, [...process.execArgv, cli, "graph", "create", "--nodes", "[]", "--goal-id", "old-goal"], options), /unknown option/u);
  } finally {
    await client?.close(); await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("schema 12 upgrade removes workspace goal data and linkage while preserving graphs, session objectives and audit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-goal-migration-"));
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  try {
    const graphs = await GoalGraphStore.open(root, authority);
    const goals = await SessionGoalStore.open(root, authority);
    const graph = graphs.createGraph([{ nodeKey: "inspect", prompt: "Inspect the workspace" }]);
    graphs.startGraph(graph.graphId);
    graphs.pauseGraph(graph.graphId);
    const goal = goals.set("session-a", "Keep this complete session objective");
    const tasks = await DurableTaskRunStore.open(root, authority);
    const createdTask = tasks.create({ sessionId: "session-a", task: "Keep this admitted task record" });
    const task = tasks.get(createdTask.taskRunId)!;
    authority.appendEvent({
      eventId: "old-goal-created", sessionId: "goal:old-goal", invocationId: "old-goal",
      runId: "goal:old-goal", turnId: "goal:old-goal", eventType: "goal.created",
      payload: { title: "Workspace objective" }
    });
    const eventsBefore = authority.readEvents({ limit: 100 }).events;
    const database = authority.databaseHandle();
    database.exec("CREATE TABLE goals (goal_id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, status TEXT); ALTER TABLE graphs ADD COLUMN goal_id TEXT; PRAGMA user_version = 12;");
    database.prepare("INSERT INTO goals VALUES (?, ?, ?, ?)").run("old-goal", authority.workspaceId, "Workspace objective", "active");
    database.prepare("UPDATE graphs SET goal_id = ? WHERE graph_id = ?").run("old-goal", graph.graphId);
    tasks.close(); graphs.close(); goals.close(); authority.close();

    authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const migratedGraphs = await GoalGraphStore.open(root, authority);
    const migratedGoals = await SessionGoalStore.open(root, authority);
    assert.equal(authority.schemaRevision(), 13);
    assert.equal(authority.databaseHandle().prepare("SELECT name FROM sqlite_master WHERE name = 'goals'").get(), undefined);
    const columns = authority.databaseHandle().prepare("PRAGMA table_info(graphs)").all() as Array<{ name: string }>;
    assert.equal(columns.some(column => column.name === "goal_id"), false);
    const preserved = migratedGraphs.inspectGraph(graph.graphId);
    assert.equal(preserved.status, "paused");
    assert.deepEqual(preserved.nodes, graph.nodes);
    assert.equal("goalId" in preserved, false);
    assert.deepEqual(migratedGoals.get("session-a"), goal);
    const migratedTasks = await DurableTaskRunStore.open(root, authority);
    assert.deepEqual(migratedTasks.get(task.taskRunId), task);
    assert.deepEqual(authority.readEvents({ limit: 100 }).events, eventsBefore);
    migratedGraphs.resumeGraph(graph.graphId);
    assert.equal(migratedGraphs.readyNodes(graph.graphId).length, 1);
    migratedTasks.close(); migratedGraphs.close(); migratedGoals.close();
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});
