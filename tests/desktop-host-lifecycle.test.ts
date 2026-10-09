/** 浏览与执行分离；使用真实配置、目录、历史和 Host，外部模型不参与此测试。 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopMcpService } from "../src/desktop/electron/main/DesktopMcpService.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { runtimeHostPaths, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { TodoStore } from "../src/session/todoStore.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

test("被动读取不创建 Runtime Host；打开历史会话后预热项目 owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-host-browse-"));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save({ ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  });
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined,
    undefined, undefined, undefined, { endpoint: path.join(root, "must-not-connect.sock"), token: "cold-catalog-fixture" });
  try {
    for (let index = 0; index < 3; index += 1) {
      const project = await projects.createEmptyProject(path.join(root, `project-${index}`));
      const dataRoot = await projects.dataRoot(project);
      await ensureAgentDirs(dataRoot);
      const recorder = new SessionRecorder(dataRoot, `history-${index}`);
      recorder.record({ type: "user_message", content: "已有历史" });
      await recorder.close();
      const workspace = await manager.workspaceSnapshot(project.id, false);
      assert.equal(workspace.runtime, undefined, "读取非当前项目不得初始化执行者");
      assert.equal(workspace.requiresModelConfiguration, false);
      const tools = await manager.toolCatalog(project.id);
      assert.ok(tools.some((entry) => entry.name === "Read"), "执行前仍可选择内置工具");
      assert.ok(tools.some((entry) => entry.name === "Bash"));
      assert.deepEqual(tools.filter(entry => entry.name.startsWith("Computer")).map(entry => [entry.name, entry.source]).sort(), [
        ["ComputerAction", "mcp"], ["ComputerLaunch", "mcp"], ["ComputerList", "mcp"], ["ComputerMirror", "mcp"], ["ComputerObserve", "mcp"]
      ], "cold chat selection must list the same Computer MCP tools without contacting Desktop or creating a Runtime");
      assert.deepEqual(tools.filter(entry => entry.name.startsWith("Computer")).map(entry => entry.namespace?.name),
        ["computer-use", "computer-use", "computer-use", "computer-use", "computer-use"],
        "cold MCP selection must retain structured ownership; description parsing cannot identify native tools");
      const todos = new TodoStore(dataRoot, recorder.sessionId);
      await todos.replace([{ content: "保存的清单", status: "pending" }]);
      assert.deepEqual(await manager.planProjection(project.id, recorder.sessionId), {
        sessionId: recorder.sessionId, plans: [], todos: todos.list(), goal: undefined
      });
      const empty = await manager.runtimeProjection(project.id);
      assert.deepEqual(empty.graphs, []);
      assert.deepEqual(empty.tasks, { tasks: [], nextCursor: undefined, hasMore: false });
      await assert.rejects(access(path.join(agentDir(dataRoot), "runtime.sqlite")), { code: "ENOENT" });

      // Given 已落盘的目标和计划，When 冷态查询，Then 返回原事实且不创建执行者或改写数据库。
      const authority = await RuntimeEventAuthority.open(dataRoot, { backfillLegacySessions: false });
      const graphs = await GoalGraphStore.open(dataRoot, authority);
      const goals = await SessionGoalStore.open(dataRoot, authority);
      const tasks = await DurableTaskRunStore.open(dataRoot, authority);
      const task = tasks.create({ sessionId: recorder.sessionId, task: { prompt: "已保存的任务" } });
      const goal = goals.set(recorder.sessionId, "已保存的目标");
      const graph = graphs.createSupervisedGraph({ supervisorSessionId: recorder.sessionId, nodes: [
        { nodeKey: "read", prompt: "读取文件", intent: { prompt: "读取文件" } }
      ], payload: { objective: "已保存的计划" } });
      goals.close();
      tasks.close();
      graphs.close();
      authority.close();
      const before = await readFile(authority.databasePath);
      const projection = await manager.planProjection(project.id, recorder.sessionId);
      assert.deepEqual(JSON.parse(JSON.stringify(projection.goal)), JSON.parse(JSON.stringify(goal)));
      assert.equal(projection.plans[0]?.graphId, graph.graphId);
      assert.deepEqual(projection.todos, todos.list());
      const savedRuntime = await manager.runtimeProjection(project.id);
      assert.deepEqual(savedRuntime.graphs, [graph]);
      assert.deepEqual(savedRuntime.tasks, { tasks: [{ ...task, attempts: [] }], nextCursor: undefined, hasMore: false });
      await assert.rejects(manager.planProjection(project.id, "missing-session"));
      assert.deepEqual(await readFile(authority.databasePath), before, "读取不得迁移或写入运行事实");
      await assert.rejects(access(runtimeHostPaths(dataRoot).registrationPath), { code: "ENOENT" });
      await assert.rejects(access(runtimeHostPaths(dataRoot).lockPath), { code: "ENOENT" });
      const document = await manager.openSession(project.id, recorder.sessionId);
      assert.equal(document.runtimeSnapshot, undefined);
      assert.ok(document.events.some((event) => event.type === "user_message" && event.content === "已有历史"));
      await manager.retryRuntime(project.id);
      await access(runtimeHostPaths(dataRoot).registrationPath);

    }
  } finally {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("进入当前项目即连接 MCP；重复进入复用 Host，历史读取不启动原生输入", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-mcp-connect-"));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save({ ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  });
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const endpoint = path.join(root, "must-not-connect.sock");
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined,
    undefined, undefined, undefined, { endpoint, token: "mcp-connect-fixture" });
  const service = new DesktopMcpService(configStore, projects, manager);
  try {
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const history = new SessionRecorder(dataRoot, "existing-history");
    history.record({ type: "user_message", content: "不能在进入项目时重放" });
    await history.close();
    const historyBefore = await readFile(history.filePath, "utf8");
    assert.equal((await service.snapshot(project.id)).servers.find(server => server.name === "computer-use")?.state, "not-started");
    await manager.prepareWorkspace(project.id);
    const warmed = await manager.retryRuntime(project.id);
    assert.ok(warmed.workspace.runtime, "active workspace must initialize its Host before the first message or explicit MCP reconnect");
    const registration = await readFile(runtimeHostPaths(dataRoot).registrationPath, "utf8");
    await Promise.all([manager.prepareWorkspace(project.id), manager.prepareWorkspace(project.id)]);
    assert.equal(await readFile(runtimeHostPaths(dataRoot).registrationPath, "utf8"), registration, "re-entry must reuse the same owner");
    assert.equal((await service.snapshot(project.id)).servers.find(server => server.name === "computer-use")?.state, "connected");
    assert.deepEqual((await manager.workspaceSnapshot(project.id, false)).sessions.map(session => session.id), [history.sessionId], "warming MCP must not create empty conversation history");
    assert.equal(await readFile(history.filePath, "utf8"), historyBefore);
    const connected = await service.reconnect(project.id, "computer-use");
    assert.equal(connected.state, "connected", "the existing connect action must initialize MCP without model or native input calls");
    assert.deepEqual([...connected.toolNames].sort(), ["ComputerAction", "ComputerLaunch", "ComputerList", "ComputerMirror", "ComputerObserve"]);
    const catalog = await manager.toolCatalog(project.id);
    assert.deepEqual(catalog.filter(tool => tool.name.startsWith("Computer")).map(tool => [tool.name, tool.source, tool.namespace?.name]).sort(), [
      ["ComputerAction", "mcp", "computer-use"], ["ComputerLaunch", "mcp", "computer-use"], ["ComputerList", "mcp", "computer-use"],
      ["ComputerMirror", "mcp", "computer-use"], ["ComputerObserve", "mcp", "computer-use"]
    ], "warm Host IPC must retain the same selection ownership as the cold catalog");
    assert.equal((await service.snapshot(project.id)).servers.find(server => server.name === "computer-use")?.state, "connected");
    await assert.rejects(access(endpoint), { code: "ENOENT" });
  } finally {
    await service.dispose();
    await manager.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("工作区快照读取途中 Host 回收，不得由后续投影查询重新启动", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-host-read-race-"));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const configDir = path.join(root, "config");
  const configStore = createFileConfigStore(root, { globalDir: configDir });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save({ ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  });
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const dataRoot = await projects.dataRoot(project);
  const server = await startRuntimeHost(dataRoot, async () => await createInteractiveAgentHost(project.path, {
    configStore, persistenceRoot: dataRoot
  }), { configDir });
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  const loadConfig = configStore.load.bind(configStore);
  let releaseRead!: () => void;
  let enterRead!: () => void;
  const entered = new Promise<void>((resolve) => { enterRead = resolve; });
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  let snapshot: ReturnType<typeof manager.workspaceSnapshot> | undefined;
  try {
    await manager.prepareWorkspace(project.id);
    assert.ok((await manager.retryRuntime(project.id)).workspace.runtime);
    assert.equal(await server.retireIfIdle(0), false, "current project retains MCP while waiting for a message");
    const other = await projects.createEmptyProject(path.join(root, "other-workspace"));
    await manager.prepareWorkspace(other.id);
    assert.ok((await manager.retryRuntime(other.id)).workspace.runtime);
    configStore.load = async (workspaceRoot) => {
      configStore.load = loadConfig;
      enterRead();
      await gate;
      return await loadConfig(workspaceRoot);
    };
    snapshot = manager.workspaceSnapshot(project.id);
    await entered;
    const deadline = Date.now() + 5_000;
    while (!await server.retireIfIdle(0)) {
      assert.ok(Date.now() < deadline, "idle Host did not retire during the read");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    releaseRead();
    const cold = await snapshot;
    await assert.rejects(access(runtimeHostPaths(dataRoot).registrationPath), { code: "ENOENT" }, "投影查询不得重新创建 owner");
    assert.equal(cold.runtime, undefined);
    assert.equal(cold.runtimeProjection, undefined);
    const projection = await manager.runtimeProjection(project.id);
    assert.ok(Array.isArray(projection.graphs));
    await assert.rejects(access(runtimeHostPaths(dataRoot).registrationPath), { code: "ENOENT" });
  } finally {
    configStore.load = loadConfig;
    releaseRead();
    await snapshot?.catch(() => undefined);
    await manager.closeAll();
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
