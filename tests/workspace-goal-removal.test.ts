import { readyHostClient } from "./helpers/readyHostClient.js";
import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
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
import { runtimeCommandOperation } from "../src/runtime/commands.js";

test("workspace goals are absent while session goals and graph execution remain available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-goal-removal-"));
  const authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
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
    const graph = graphs.createSupervisedGraph({ supervisorSessionId: "supervisor", nodes: [{ nodeKey: "inspect", prompt: "Inspect the workspace" }] });
    graphs.startGraph(graph.graphId);
    graphs.claimIntent(graph.graphId, graph.nodes[0]!.nodeId);
    graphs.completeNode(graph.graphId, graph.nodes[0]!.nodeId, "completed", { report: "done" });
    assert.equal(graphs.inspectGraph(graph.graphId).status, "running", "the supervisor decides when the graph is complete");
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
  const server = await startRuntimeHost(root, async () => local, {createRuntime: async () => { throw new Error("Unexpected session runtime creation in this fixture."); },  configDir });
  const client = await readyHostClient(await connectRuntimeHost(root, { spawnOptions: { workspaceRoot: root, configDir } }));

  try {
    assert.ok(client);
    for (const action of ["create", "get", "list", "pause", "resume", "cancel"]) {
      await assert.rejects(client.request(`goal.${action}`, { title: "Removed objective", goalId: "old-goal" }), /Unknown Runtime Host operation/u);
    }
    await assert.rejects(client.request("graph.create", { nodes: [] }), /Unknown Runtime Host operation/u);
    local.commands.graphs.createSupervisedGraph({ supervisorSessionId: "supervisor", nodes: [{ nodeKey: "inspect", prompt: "Inspect without starting a model" }] });
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
    await assert.rejects(execFile(process.execPath, [...process.execArgv, cli, "graph", "create", "--nodes", "[]", "--goal-id", "old-goal"], options), /unknown command/u);
  } finally {
    await client?.close(); await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported runtime schemas are rejected without rewriting stored records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-old-runtime-schema-"));
  const authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  const databasePath = authority.databasePath;
  authority.databaseHandle().exec("PRAGMA user_version = 12;");
  authority.close();
  try {
    await assert.rejects(RuntimeEventAuthority.open(root), /Unsupported runtime schema revision 12/u);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 12); }
    finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
