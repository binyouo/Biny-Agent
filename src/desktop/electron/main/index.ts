/**
 * Electron 主进程入口。
 *
 * 按依赖顺序装配各服务（用户数据 → 状态 → 配置 → 项目 → agent 管理器），注册 IPC 和菜单，
 * 最后创建窗口。只负责装配和生命周期，业务逻辑都在各自的服务里。
 *
 * 单实例锁：第二个实例直接退出，因为多个进程同时读写同一份桌面状态和 session 会互相覆盖。
 */
import { permissionPresentation } from "../../../permission/presentation.js";
import path from "node:path";
import { app, BrowserWindow, dialog, globalShortcut, nativeImage, net, Notification, shell } from "electron";
import type { DesktopBootstrap, DesktopSessionHandoff } from "../../protocol.js";
import { desktopIpc } from "../../protocol.js";
import { DesktopAgentManager } from "./DesktopAgentManager.js";
import { ActivityRecorderService, defaultActivitySidecarPath } from "./ActivityRecorderService.js";
import { captureActivityDesktopScreen } from "./activityCapture.js";
import { DesktopBrowserService } from "./DesktopBrowserService.js";
import { DesktopConfigStore } from "./DesktopConfigStore.js";
import { DesktopMcpService } from "./DesktopMcpService.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopSkillService } from "./DesktopSkillService.js";
import { DesktopCrystalService } from "./DesktopCrystalService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { DesktopSettingsCloseCoordinator } from "./DesktopSettingsCloseCoordinator.js";
import { DesktopSettingsTransaction } from "./DesktopSettingsTransaction.js";
import { DesktopTerminalManager } from "./DesktopTerminalManager.js";
import { DesktopUserDataStore } from "./DesktopUserDataStore.js";
import { globalAgentDir, globalConfigDir } from "../../../config/paths.js";
import { LocalEmbeddingManager } from "../../../llm/embedding/LocalEmbeddingRuntime.js";
import { createActivityMemoryPipeline } from "../../../activity/memoryPipeline.js";
import { registerDesktopIpc } from "./ipc.js";
import { installApplicationMenu } from "./menu.js";
import { QuickChatContextService } from "./QuickChatContextService.js";
import { createQuickChatWindow, type QuickChatWindowController } from "./quickChatWindow.js";
import { createDesktopWindow, type WindowCloseDecision } from "./window.js";

app.setName("Biny");
app.setAboutPanelOptions({
  applicationName: "Biny",
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
  copyright: "Biny local agent"
});

const initialHandoff = parseDesktopLaunchHandoff(process.argv);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void startDesktopApplication().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    dialog.showErrorBox("Biny 无法启动", message);
    app.quit();
  });
}

async function startDesktopApplication(): Promise<void> {
  await app.whenReady();
  // Desktop 默认在主进程内运行 Agent；CLI/TUI 等可独立启动的入口仍复用这个 Node Host 入口。
  process.env.BINY_RUNTIME_HOST_ENTRY ??= path.join(
    app.getAppPath(),
    app.isPackaged ? "dist/runtime/hostProcess.js" : "src/runtime/hostProcess.ts"
  );
  setDesktopIcon();
  const userDataRoot = app.getPath("userData");
  const desktopRoot = path.join(userDataRoot, "workspaces", "default");
  const storage = new DesktopUserDataStore(desktopRoot);
  await storage.initialize();
  await storage.ensureGlobalData();
  const state = new DesktopStateStore(path.join(desktopRoot, "desktop-state.json"));
  await state.load();
  // 模型配置与 CLI/TUI 共用全局目录；桌面端凭据由 DesktopSafeStorageCredentialStore 接管
  // （safeStorage 加密落自管文件），不走 `security` CLI，避免保存时授权卡死。
  const configStore = new DesktopConfigStore(globalConfigDir());
  const projects = new DesktopProjectService(state, storage, configStore);
  const crystals = new DesktopCrystalService(configStore, async () => await Promise.all(
    state.projects().map(async (project) => await projects.dataRoot(project))
  ));
  const skills = new DesktopSkillService(state, configStore, net.fetch.bind(net) as unknown as typeof globalThis.fetch);
  let mainWindow: BrowserWindow | undefined;
  let preparingQuit = false;
  let quickChatWindow: QuickChatWindowController | undefined;
  const quickChatContext = new QuickChatContextService({
    cacheDirectory: path.join(userDataRoot, "cache", "quick-chat"),
    onContext: (context) => quickChatWindow?.send(desktopIpc.quickChatContext, context)
  });
  // QuickChat 悬浮窗按需创建；窗口本身只负责生命周期，上下文读取由 QuickChatContextService 负责。
  const ensureQuickChatWindow = (): QuickChatWindowController => {
    quickChatWindow ??= createQuickChatWindow(() => state.quickChatSettings(), {
      getBounds: () => state.quickChatBounds(),
      saveBounds: (bounds) => void state.setQuickChatBounds(bounds),
      onClosed: () => { quickChatWindow = undefined; }
    });
    return quickChatWindow;
  };
  const toggleQuickChat = async (): Promise<void> => {
    const window = ensureQuickChatWindow();
    if (window.isVisible()) {
      if (window.isClickThrough()) {
        window.setClickThrough(false);
        window.focus();
        window.focusInput();
      } else {
        window.hide();
      }
      return;
    }
    await quickChatContext.recapture();
    window.show();
  };
  /** 事件回流广播到所有活跃窗口：主窗口 + QuickChat（存在时）。主窗口行为不变，QuickChat 是新增订阅者。 */
  const broadcastToWindows = (channel: string, payload: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    // QuickChat 隐藏时渲染层不消费事件；窗口已创建则无论显隐都推，让它在下次唤醒前攒好状态。
    quickChatWindow?.send(channel, payload);
  };
  const settingsClose = new DesktopSettingsCloseCoordinator();
  // 浏览器控制面先于 Agent Host 启动，这样独立 Runtime Host 也能拿到同一个可见窗口。
  // 回调只在用户/Agent 真的触碰 cookie 或浏览器动作时执行，此时 agents 已完成装配。
  const defaultCookieJarPath = path.join(desktopRoot, "cookies.json");
  const browser = new DesktopBrowserService(
    async () => (await configStore.load()).web.cookies.path ?? defaultCookieJarPath,
    () => agents.assertNoRunningTasks("任务运行期间不能修改 Cookie 或驱动浏览器。")
  );
  const browserAutomation = await browser.startAutomationServer(path.join(desktopRoot, "browser-control.sock"));
  const agents = new DesktopAgentManager(state, projects, configStore, (projectId, update, meta) => {
    broadcastToWindows(desktopIpc.event, { projectId, ...update, ...meta });
    const event = update.event;
    // 只有窗口不在前台时才发系统通知：界面上已经能看到权限询问就不用再打扰一次。
    if (event?.type === "permission.requested" && (!mainWindow || !mainWindow.isFocused() || !mainWindow.isVisible()) && Notification.isSupported()) {
      new Notification({
        title: "Biny 等待权限",
        body: `${permissionPresentation(event.request).title} · ${event.request.tool}`,
        silent: true
      }).show();
    }
    // 任务收尾时窗口在后台，用模型写的通知块作为系统通知正文；前台可见时不打扰。
    if (event && (event.type === "run.completed" || event.type === "run.blocked") && event.notification
      && (!mainWindow || !mainWindow.isFocused() || !mainWindow.isVisible()) && Notification.isSupported()) {
      new Notification({
        title: "Biny",
        body: event.notification,
        silent: true
      }).show();
    }
  }, async (url) => await shell.openExternal(url), undefined, net.fetch.bind(net) as unknown as typeof globalThis.fetch, browserAutomation);
  const mcp = new DesktopMcpService(
    configStore,
    projects,
    agents,
    net.fetch.bind(net) as unknown as typeof globalThis.fetch
  );
  const globalDataRoot = await projects.globalDataRoot();
  // Activity 自己持有本地嵌入运行时；只加载已下载模型，聊天窗口是否驻留不影响后台索引。
  const activityEmbeddingModels = new LocalEmbeddingManager(path.join(globalAgentDir(), "models", "embeddings"));
  const activityMemoryPipeline = await createActivityMemoryPipeline({
    workspaceRoot: globalDataRoot,
    resolveWorkspace: async (projectName) => resolveActivityProject(projectName, state.projects())?.path,
    skipUnknownWorkspace: true,
    indexEntry: async (entry) => await agents.indexActivityMemoryEntry(entry),
    findSimilarEntries: async (query, options) => await agents.findMemorySimilarEntries(query, options),
    requireSemantic: false
  });
  const activity = new ActivityRecorderService({
    configStore,
    captureDesktopScreen: captureActivityDesktopScreen,
    sidecarPath: defaultActivitySidecarPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    }),
    writeMemories: activityMemoryPipeline.writeMemories,
    onAnalyzed: activityMemoryPipeline.onAnalyzed,
    getEmbeddingRuntime: async () => await activityEmbeddingModels.createRuntime("multilingual-e5-small").catch(() => undefined),
    emit: (snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopIpc.activityEvent, snapshot);
    }
  });
  const settings = new DesktopSettingsTransaction(state, agents);
  // 恢复检查必须早于 IPC 注册和窗口开放；无法自动恢复时保留应用可用来展示设置错误，
  // 但同一个 transaction 实例会阻止所有新工作入口。
  await settings.recoverAtStartup();
  const prepareHandoff = async (handoff: DesktopLaunchHandoff): Promise<DesktopSessionHandoff> => {
    const project = await projects.createProject(handoff.workspaceRoot);
    await state.commitSelection(project.id, handoff.sessionId, "chat");
    return { projectId: project.id, sessionId: handoff.sessionId };
  };
  const initialTarget = initialHandoff === undefined ? undefined : await prepareHandoff(initialHandoff);
  const terminals = new DesktopTerminalManager((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopIpc.terminalEvent, event);
  });
  await activity.initialize();
  /** 渲染进程启动时拉取的一次性初始状态：项目列表、当前项目、布局尺寸等。 */
  const bootstrap = async (): Promise<DesktopBootstrap> => {
    const allProjects = await projects.refreshAllProjects();
    let activeProjectId = state.activeProjectId();
    // 上次打开的项目可能已被删除或移走，此时回退到第一个可用项目。
    if (activeProjectId && !allProjects.some((project) => project.id === activeProjectId)) activeProjectId = undefined;
    activeProjectId ??= allProjects.at(0)?.id;
    if (activeProjectId !== state.activeProjectId()) await state.setActiveProject(activeProjectId);
    const workspace = activeProjectId ? await agents.workspaceSnapshot(activeProjectId) : undefined;
    const explicitSessionId = initialTarget !== undefined && initialTarget.projectId === activeProjectId
      ? initialTarget.sessionId
      : undefined;
    const activeView = explicitSessionId === undefined ? state.activeView() : "chat";
    const storedSessionId = activeProjectId === undefined ? undefined : state.selectedSessionId(activeProjectId);
    const restorableSessionId = storedSessionId && workspace?.sessions.some((session) => session.id === storedSessionId)
      ? storedSessionId
      : undefined;
    if (storedSessionId && restorableSessionId === undefined && activeProjectId) {
      await state.setSelectedSession(activeProjectId, undefined);
    }
    const selectedSessionId = explicitSessionId ?? (activeView === "extensions" ? undefined : restorableSessionId);
    const visibleWorkspace = workspace ? { ...workspace, selectedSessionId } : undefined;
    const sidebarSessions = await agents.sidebarSessions(workspace);
    return {
      version: app.getVersion(),
      platform: process.platform,
      projects: state.projects(),
      sidebarSessions,
      activeProjectId,
      selectedSessionId,
      activeView,
      workspace: visibleWorkspace,
      sidebarWidth: state.sidebarWidth(),
      filePanelWidth: state.filePanelWidth(),
      themePreference: state.themePreference(),
      fontPreference: state.fontPreference()
    };
  };

  const decideWindowClose = async (): Promise<WindowCloseDecision> => {
    // 先处理未保存的设置草稿：取消必须发生在中止任务之前，否则用户取消时任务已被停掉。
    const settingsDecision = await settingsClose.request(mainWindow?.webContents, "window");
    if (settingsDecision === "cancel") return "cancel";
    if (!agents.hasRunningTasks()) return "close";
    const response = await showMessage(mainWindow, {
      type: "question",
      title: "任务仍在运行",
      message: "Biny 仍有正在运行或等待权限的任务。",
      detail: "关闭 Biny 会中止当前任务；如果暂时不关闭，请取消此操作。",
      buttons: ["中止并关闭", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response.response === 0) {
      await agents.stopAllForExit();
      return "close";
    }
    return "cancel";
  };

  const createWindow = (): BrowserWindow => {
    settingsClose.reset();
    mainWindow = createDesktopWindow(state, decideWindowClose);
    mainWindow.on("closed", () => {
      mainWindow = undefined;
      // macOS 关闭最后一个窗口默认不会退出进程；这里显式退出，避免下次打开继续复用本次
      // Desktop 进程和 Runtime Host 的运行态。菜单里的“隐藏 Biny”仍保留为显式后台操作。
      if (process.platform === "darwin" && !preparingQuit) app.quit();
    });
    return mainWindow;
  };

  const handleHandoff = async (handoff: DesktopLaunchHandoff): Promise<void> => {
    try {
      const target = await prepareHandoff(handoff);
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send(desktopIpc.sessionHandoff, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("无法打开会话", message);
    }
  };

  registerDesktopIpc({
    crystals,
    state,
    projects,
    agents,
    settings,
    activity,
    terminals,
    browser,
    skills,
    mcp,
    getWindow: () => mainWindow,
    ensureQuickChatWindow,
    getQuickChatWindow: () => quickChatWindow,
    quickChatContext,
    toggleQuickChat,
    bootstrap,
    updateSettingsDraftState: (draftState) => settingsClose.updateState(draftState),
    resolveSettingsCloseRequest: (requestId, response) => settingsClose.resolve(requestId, response)
  });
  installApplicationMenu(() => mainWindow);
  createWindow();

  // 平台约定：macOS 使用 Command+Shift+Space，其它平台使用 Ctrl+Shift+Space。
  // 注册失败（被占用）时降级为静默无快捷键，设置页仍可从调试入口切换。
  const quickChatShortcut = process.platform === "darwin" ? "Command+Shift+Space" : "Ctrl+Shift+Space";
  try {
    globalShortcut.register(quickChatShortcut, () => { void toggleQuickChat(); });
  } catch {
    // 注册失败不阻断启动；只是这次没有快捷键。
  }

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.show();
  });
  app.on("second-instance", (_event, commandLine) => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow?.show();
    mainWindow?.focus();
    const handoff = parseDesktopLaunchHandoff(commandLine);
    if (handoff) void handleHandoff(handoff);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    event.preventDefault();
    if (preparingQuit) return;
    preparingQuit = true;
    void (async () => {
      // 确认阶段（设置草稿、运行中任务）允许取消并还原 preparingQuit；一旦确认退出，
      // 清理链的任何异常都不能让 app.exit 落空，否则应用会永远退不掉。
      let confirmed = false;
      try {
        const settingsDecision = await settingsClose.request(mainWindow?.webContents, "quit");
        if (settingsDecision === "cancel") return;
        const hadRunningTasks = agents.hasRunningTasks();
        if (hadRunningTasks) {
          const response = await showMessage(mainWindow, {
            type: "warning",
            title: "退出 Biny",
            message: "退出会中止所有正在运行的任务。",
            buttons: ["中止并退出", "取消"],
            defaultId: 1,
            cancelId: 1,
            noLink: true
          });
          if (response.response !== 0) return;
        }
        confirmed = true;
        if (hadRunningTasks) await agents.stopAllForExit();
        terminals.disposeAll();
        // 全局快捷键与悬浮窗是真正的资源，退出前必须释放，避免占用快捷键或残留窗口。
        globalShortcut.unregisterAll();
        quickChatWindow?.destroy();
        await activity.stop();
        await activityEmbeddingModels.close();
        activityMemoryPipeline.close();
        await browser.dispose();
        await mcp.dispose();
        mainWindow?.destroy();
        await Promise.race([
          agents.closeAll({ terminateOwnedHosts: true }),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000))
        ]);
      } finally {
        if (confirmed) app.exit(0);
        else preparingQuit = false;
      }
    })().catch(() => undefined);
  });
}

interface DesktopLaunchHandoff {
  workspaceRoot: string;
  sessionId: string;
}

function parseDesktopLaunchHandoff(argv: readonly string[]): DesktopLaunchHandoff | undefined {
  const workspaceIndex = argv.indexOf("--biny-workspace");
  const sessionIndex = argv.indexOf("--biny-session");
  const workspaceRoot = workspaceIndex >= 0 ? argv[workspaceIndex + 1] : undefined;
  const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
  if (!workspaceRoot || !sessionId || sessionId.includes("\0") || sessionId.length > 240) return undefined;
  return { workspaceRoot: path.resolve(workspaceRoot), sessionId };
}

function resolveActivityProject(
  projectName: string | undefined,
  candidates: readonly { name: string; path: string; missing: boolean }[]
): { name: string; path: string; missing: boolean } | undefined {
  const trimmed = projectName?.trim();
  const normalized = trimmed?.toLocaleLowerCase();
  if (!normalized) return undefined;
  const absolute = trimmed?.startsWith("/")
    ? path.resolve(trimmed).toLocaleLowerCase()
    : undefined;
  return candidates.find((project) => !project.missing && (
    project.name.trim().toLocaleLowerCase() === normalized
    || path.basename(project.path).toLocaleLowerCase() === normalized
    || absolute === path.resolve(project.path).toLocaleLowerCase()
  ));
}

function setDesktopIcon(): void {
  if (process.platform !== "darwin") return;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.icns")
    : path.join(app.getAppPath(), "build/icon-master.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}

async function showMessage(
  window: BrowserWindow | undefined,
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  return window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
}
