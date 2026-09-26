/** 首屏准备走真实配置、Runtime Host 和本地会话存储，不调用模型 API。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs, sessionFilePath } from "../src/session/store.js";

test("首屏返回时已带实际模型与上下文信息；初始化失败仍返回可读历史和错误", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-bootstrap-"));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const configStore = createFileConfigStore(path.join(root, "config"), { globalDir: path.join(root, "config") });
  configStore.supportsDetachedRuntimeHost = false;
  const projects = new DesktopProjectService(state, storage, configStore);
  let manager: DesktopAgentManager | undefined;
  try {
    await state.load();
    await storage.initialize();
    const config = {
      ...defaultConfig,
      defaultModel: "selected",
      providers: { local: { type: "ollama" as const, baseUrl: "http://127.0.0.1:1" } },
      models: {
        first: { provider: "local", model: "first", contextWindow: 32_000 },
        selected: { provider: "local", model: "selected", contextWindow: 128_000 }
      },
      thinking: { enabled: false, effort: "high" as const }
    };
    await configStore.save(config);
    const project = await projects.createProject(root);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const recorder = new SessionRecorder(dataRoot, "persisted-history");
    recorder.record({ type: "user_message", content: "保留的历史请求" });
    await recorder.close();
    const before = await readSessionEvents(sessionFilePath(dataRoot, recorder.sessionId));
    manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
    assert.equal((await manager.workspaceSnapshot(project.id)).runtime, undefined);

    const ready = await manager.prepareWorkspace(project.id);
    assert.equal(ready.runtime?.info.modelAlias, "selected");
    assert.equal(ready.runtime?.info.thinking, "off");
    assert.equal(ready.runtime?.state.kind, "idle");
    assert.equal(ready.runtimeError, undefined);
    assert.equal(ready.models.find((model) => model.alias === "selected")?.contextWindow, 128_000);
    assert.ok(ready.sessions.some((session) => session.id === recorder.sessionId));
    assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, recorder.sessionId)), before, "首屏准备不得恢复或改写旧回合");

    await manager.closeAll();
    await configStore.save({
      ...config,
      providers: { local: { type: "openai-compatible", baseUrl: "https://missing-credentials.invalid/v1" } }
    });
    manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const failed = await manager.prepareWorkspace(project.id);
    assert.equal(failed.runtime, undefined);
    assert.equal(failed.requiresModelConfiguration, true);
    assert.ok(failed.runtimeError);
    assert.ok(failed.sessions.some((session) => session.id === recorder.sessionId));
    assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, recorder.sessionId)), before);
  } finally {
    await manager?.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("启动已刷新项目后，侧栏读取不重复启动 Git 检查或其他项目 Runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-sidebar-bootstrap-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sidebar-other-"));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const configStore = createFileConfigStore(path.join(root, "config"), { globalDir: path.join(root, "config") });
  const projects = new DesktopProjectService(state, storage, configStore);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  try {
    await state.load(); await storage.initialize();
    const project = await projects.createProject(root);
    const other = await projects.createProject(otherRoot);
    const recorder = new SessionRecorder(await projects.dataRoot(other), "sidebar-history");
    recorder.record({ type: "user_message", content: "历史" }); await recorder.close();
    await projects.refreshAllProjects();
    const workspace = await manager.workspaceSnapshot(project.id);
    projects.inspectProject = async () => { throw new Error("侧栏不应重复运行 Git 状态检查"); };
    const sessions = await manager.sidebarSessions(workspace);
    assert.ok(sessions.some((session) => session.id === recorder.sessionId && session.projectId === other.id));
    assert.equal(manager.hasRunningTasks(), false);
  } finally {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true }); await rm(otherRoot, { recursive: true, force: true });
  }
});

test("时间线索读取一次性任务不加载模型、工具或启动 Runtime", async () => {
  const { AutomationStore } = await import("../src/runtime/AutomationScheduler.js");
  const { RuntimeEventAuthority } = await import("../src/runtime/RuntimeAuthority.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-scheduled-read-"));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const configStore = createFileConfigStore(path.join(root, "config"), { globalDir: path.join(root, "config") });
  const projects = new DesktopProjectService(state, storage, configStore);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  try {
    await state.load(); await storage.initialize();
    const project = await projects.createProject(root);
    const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const store = await AutomationStore.open(root, authority);
    const record = store.create({ name: "本地提醒", triggerType: "once", schedule: { at: "2026-10-01T01:00:00Z" }, executionTemplate: { prompt: "提醒" } });
    store.close(); authority.close();
    configStore.supportsDetachedRuntimeHost = false;
    configStore.load = async () => { throw new Error("只读任务列表不应加载 Provider 配置"); };
    const entries = await manager.scheduledAutomations(project.id);
    assert.deepEqual(entries.map((entry) => entry.automationId), [record.automationId]);
    assert.equal(entries[0]?.fireCount, 0);
  } finally { await manager.closeAll(); await rm(root, { recursive: true, force: true }); }
});
