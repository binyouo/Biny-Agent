/** 浏览与执行分离；使用真实配置、目录、历史和 Host，外部模型不参与此测试。 */
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { runtimeHostPaths, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

test("浏览多个项目、工具目录和历史不创建 Runtime Host", async () => {
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
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  try {
    for (let index = 0; index < 3; index += 1) {
      const project = await projects.createEmptyProject(path.join(root, `project-${index}`));
      const dataRoot = await projects.dataRoot(project);
      await ensureAgentDirs(dataRoot);
      const recorder = new SessionRecorder(dataRoot, `history-${index}`);
      recorder.record({ type: "user_message", content: "已有历史" });
      await recorder.close();
      const workspace = await manager.prepareWorkspace(project.id);
      assert.equal(workspace.runtime, undefined, "进入目录不得初始化执行者");
      assert.equal(workspace.requiresModelConfiguration, false);
      const tools = await manager.toolCatalog(project.id);
      assert.ok(tools.some((entry) => entry.name === "Read"), "执行前仍可选择内置工具");
      assert.ok(tools.some((entry) => entry.name === "Bash"));
      const document = await manager.openSession(project.id, recorder.sessionId);
      assert.equal(document.runtimeSnapshot, undefined);
      assert.ok(document.events.some((event) => event.type === "user_message" && event.content === "已有历史"));
      await assert.rejects(access(runtimeHostPaths(dataRoot).registrationPath), { code: "ENOENT" });
      await assert.rejects(access(runtimeHostPaths(dataRoot).lockPath), { code: "ENOENT" });
    }
  } finally {
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
    assert.ok((await manager.prepareWorkspace(project.id)).runtime);
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
  } finally {
    configStore.load = loadConfig;
    releaseRead();
    await snapshot?.catch(() => undefined);
    await manager.closeAll();
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
