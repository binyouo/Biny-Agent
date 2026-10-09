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

test("首屏从配置返回实际模型与思考档位；缺少凭据仍可浏览历史", async () => {
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
    // 新契约：首屏为当前项目在后台预热 Host，不把首屏冻结在冷启动上；预热完成前
    // runtime 暂为 undefined，消费入口复用同一次初始化（覆盖见 desktop-runtime-prewarm.test.ts）。
    assert.equal(ready.runtimeError, undefined);
    assert.equal(ready.pickerModels[0]?.alias, "selected");
    assert.equal(ready.pickerModels[0]?.defaultThinking, "off");
    assert.equal(ready.models.find((model) => model.alias === "selected")?.contextWindow, 128_000);
    assert.ok(ready.sessions.some((session) => session.id === recorder.sessionId));
    assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, recorder.sessionId)), before, "首屏准备不得恢复或改写旧回合");
    // 等待后台预热就绪后，运行时快照经只读入口可见，且不需要发送消息。
    const warmed = await manager.retryRuntime(project.id);
    assert.ok(warmed.workspace.runtime, "首屏预热为当前项目启动 Host，不等待第一条消息");
    assert.equal(warmed.workspace.runtimeError, undefined);

    await manager.closeAll();
    await configStore.save({
      ...config,
      providers: { local: { type: "openai-compatible", baseUrl: "https://missing-credentials.invalid/v1" } }
    });
    manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const failed = await manager.retryRuntime(project.id);
    assert.equal(failed.workspace.runtime, undefined);
    assert.equal(failed.workspace.requiresModelConfiguration, true);
    assert.ok(failed.workspace.runtimeError, "后台启动失败不能隐藏，历史和模型设置仍可读取");
    assert.ok(failed.workspace.sessions.some((session) => session.id === recorder.sessionId));
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
