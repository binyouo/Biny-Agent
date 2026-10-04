import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { readDesktopSession } from "../src/desktop/renderer/src/app/desktopApi.js";
import type { DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import { mergeProjectSessionPage, replaceProjectSessionRoots } from "../src/desktop/renderer/src/app/desktopState.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-navigation-"));
  const configDir = path.join(root, "config");
  const configStore = createFileConfigStore(root, { globalDir: configDir });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save({ ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const dataRoot = await projects.dataRoot(project);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  context.after(async () => {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, project, projects, dataRoot, configDir, configStore, manager };
}

test("复制并打开父会话后保留子树展开能力", { timeout: 10_000 }, async (context) => {
  const { project, dataRoot, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "tree-root");
  recorder.record({ type: "user_message", content: "保留会话树" });
  await recorder.close();
  const copied = await manager.duplicateSession(project.id, recorder.sessionId);
  const childId = copied.selectedSessionId!;
  const page = await manager.listSessionTreePage(project.id, { parentSessionId: recorder.sessionId, includeArchived: true });
  let sidebar = mergeProjectSessionPage(copied.sessionPage!.sessions, project.id, page.sessions);
  const document = await manager.openSession(project.id, recorder.sessionId);
  sidebar = mergeProjectSessionPage(sidebar, project.id, [document.session]);
  assert.equal(sidebar.find((session) => session.id === recorder.sessionId)?.hasChildren, true,
    "opening history must not remove the parent arrow or its loaded subtree");
  assert.equal(sidebar.find((session) => session.id === childId)?.parentSessionId, recorder.sessionId);
});

test("复制已加载的子会话后刷新其子树能力，删除仍清理旧节点", { timeout: 10_000 }, async (context) => {
  const { project, dataRoot, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "nested-root");
  recorder.record({ type: "user_message", content: "多层会话分支" });
  await recorder.close();
  const first = await manager.duplicateSession(project.id, recorder.sessionId);
  const childId = first.selectedSessionId!;
  const children = await manager.listSessionTreePage(project.id, { parentSessionId: recorder.sessionId, includeArchived: true });
  let sidebar = mergeProjectSessionPage(first.sessionPage!.sessions, project.id, children.sessions);
  assert.equal(sidebar.find((session) => session.id === childId)?.hasChildren, false);
  const second = await manager.duplicateSession(project.id, childId);
  sidebar = replaceProjectSessionRoots(sidebar, project.id, second.sessionPage!.sessions, second.sessions);
  assert.equal(sidebar.find((session) => session.id === childId)?.hasChildren, true,
    "a loaded child must acquire an arrow when it becomes a parent");
  const grandchildren = await manager.listSessionTreePage(project.id, { parentSessionId: childId, includeArchived: true });
  sidebar = mergeProjectSessionPage(sidebar, project.id, grandchildren.sessions);
  assert.equal(sidebar.find((session) => session.id === second.selectedSessionId)?.parentSessionId, childId);
  const document = await manager.openSession(project.id, childId);
  sidebar = mergeProjectSessionPage(sidebar, project.id, [document.session]);
  assert.equal(sidebar.find((session) => session.id === childId)?.hasChildren, true);
  const deleted = await manager.deleteSession(project.id, second.selectedSessionId!);
  sidebar = replaceProjectSessionRoots(sidebar, project.id, deleted.sessionPage!.sessions, deleted.sessions);
  assert.equal(sidebar.some((session) => session.id === second.selectedSessionId), false);
  assert.equal(sidebar.find((session) => session.id === childId)?.hasChildren, false);
});

test("项目导航只检查目录存在，不重复执行 Git；显式刷新仍检查 Git", { timeout: 10_000 }, async (context) => {
  const { project, projects, manager } = await fixture(context);
  const inspect = projects.inspectProject.bind(projects);
  projects.inspectProject = async (current, refreshGit) => {
    assert.equal(refreshGit, false, "navigation must not wait for Git status");
    return await inspect(current, refreshGit);
  };
  const snapshot = await manager.workspaceSnapshot(project.id, false);
  assert.equal(snapshot.project.missing, false);
  projects.inspectProject = async (current, refreshGit) => {
    assert.equal(refreshGit, true, "explicit refresh must inspect Git");
    return await inspect(current, refreshGit);
  };
  assert.equal((await manager.workspaceSnapshot(project.id, true)).project.missing, false);
  projects.inspectProject = inspect;
  await rm(project.path, { recursive: true });
  assert.equal((await manager.workspaceSnapshot(project.id, false)).project.missing, true);
});

test("执行者初始化被阻塞时，历史读取仍能独立完成", { timeout: 10_000 }, async (context) => {
  const { project, dataRoot, configStore, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "startup-history");
  recorder.record({ type: "user_message", content: "初始化期间仍可浏览" });
  await recorder.close();
  let enterInitialization!: () => void;
  let releaseInitialization!: () => void;
  const entered = new Promise<void>((resolve) => { enterInitialization = resolve; });
  const gate = new Promise<void>((resolve) => { releaseInitialization = resolve; });
  configStore.load = async () => {
    enterInitialization();
    await gate;
    throw new Error("model configuration deliberately unavailable");
  };
  const submission = manager.sendPrompt(project.id, undefined, "不调用模型", []).catch((error: unknown) => error);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await entered;
    const document = await Promise.race([
      manager.openSession(project.id, recorder.sessionId),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("history waited for blocked executor initialization")), 1_500);
      })
    ]);
    assert.equal(document.session.id, recorder.sessionId);
    assert.equal(document.runtimeError, undefined);
    assert.equal(document.events[0]?.type, "user_message");
  } finally {
    clearTimeout(timeout);
    releaseInitialization();
    assert.ok(await submission instanceof Error);
  }
});

test("轻量项目检查保留已有分支和脏状态", { timeout: 10_000 }, async (context) => {
  const { project, projects } = await fixture(context);
  const current = { ...project, branch: "saved-branch", dirty: true };
  const inspected = await projects.inspectProject(current, false);
  assert.equal(inspected.branch, "saved-branch");
  assert.equal(inspected.dirty, true);
  assert.equal(inspected.missing, false);
});

test("已有 Host 时浏览冷历史不装配目标 Session Runtime，也不改写历史", { timeout: 10_000 }, async (context) => {
  const { project, projects, dataRoot, configDir, configStore, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "cold-history");
  recorder.record({ type: "user_message", content: "历史问题" });
  recorder.record({ type: "assistant_message", content: "历史回答" });
  await recorder.close();
  const before = await readSessionEvents(sessionFilePath(dataRoot, recorder.sessionId));
  const server = await startRuntimeHost(dataRoot, async () => await createInteractiveAgentHost(project.path, {
    configStore, persistenceRoot: dataRoot
  }), {
    configDir,
    createRuntime: async () => { throw new Error("history navigation must not initialize a session runtime"); }
  });
  try {
    await manager.prepareWorkspace(project.id);
    const open = projects.openSession.bind(projects);
    let historyReads = 0;
    projects.openSession = async (...args) => { historyReads += 1; return await open(...args); };
    const document = await manager.openSession(project.id, recorder.sessionId);
    assert.equal(document.runtimeError, undefined);
    assert.equal(document.runtimeSnapshot, undefined);
    assert.deepEqual(document.events, before);
    assert.equal(historyReads, 1, "cold history must only be read once");
    assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, recorder.sessionId)), before);
  } finally {
    await manager.closeAll();
    await server.close();
  }
});

test("跨目录正文加载不等待项目快照，成功后返回同一目标的完整数据", { timeout: 10_000 }, async (context) => {
  const { project, dataRoot, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "parallel-history");
  recorder.record({ type: "user_message", content: "目标项目的历史" });
  await recorder.close();
  let releaseWorkspace!: (snapshot: DesktopWorkspaceSnapshot) => void;
  const workspace = new Promise<DesktopWorkspaceSnapshot>((resolve) => { releaseWorkspace = resolve; });
  let historyRequested = false;
  const pending = readDesktopSession({ openSession: (projectId, sessionId) => {
    historyRequested = true;
    assert.equal(projectId, project.id);
    assert.equal(sessionId, recorder.sessionId);
    return manager.openSession(projectId, sessionId);
  } }, project.id, recorder.sessionId, workspace);
  try {
    assert.equal(historyRequested, true, "history request must start while workspace is still loading");
    releaseWorkspace(await manager.workspaceSnapshot(project.id));
    const result = await pending;
    assert.equal(result.document.session.id, recorder.sessionId);
    assert.equal(result.workspace?.project.id, project.id);
  } finally {
    releaseWorkspace(await manager.workspaceSnapshot(project.id));
    await pending.catch(() => undefined);
  }
});
