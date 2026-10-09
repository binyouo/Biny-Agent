/**
 * 主窗口创建。
 *
 * 负责窗口尺寸的恢复与持久化、主题背景色同步、关闭前确认以及导航限制。
 *
 * 安全相关的三项配置是刻意的：contextIsolation + sandbox 打开、nodeIntegration 关闭，渲染
 * 进程只能通过 preload 暴露的接口访问系统能力；同时禁止开新窗口、禁止导航到本地页面之外的
 * 地址，避免页面被引导到外部站点。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, nativeTheme, screen } from "electron";
import type { DesktopThemePreference } from "../../protocol.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { resolveAppearance } from "../../../appearance/resolve.js";
import type { AppearanceSnapshot } from "../../../appearance/types.js";

export type WindowCloseDecision = "close" | "cancel";

/** 窗口底色要和渲染层主体色一致，否则加载过程中会闪一下异色底。 */
function themeBackgroundColor(preference: DesktopThemePreference = "system"): string {
  const dark = preference === "dark" || (preference === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#1a1a1a" : "#f5f5f5";
}

export function createDesktopWindow(
  state: DesktopStateStore,
  decideClose: () => Promise<WindowCloseDecision>,
  getAppearance: () => AppearanceSnapshot = () => ({ themePreference: state.themePreference(), appearancePreference: state.appearancePreference(), fontPreference: state.fontPreference() })
): BrowserWindow {
  const preference = state.themePreference();
  nativeTheme.themeSource = preference;
  const appearance = resolveAppearance(state.appearancePreference(), preference, nativeTheme.shouldUseDarkColors);
  const savedBounds = visibleBounds(state.windowBounds());
  // macOS 从创建起使用透明底，由渲染层绘制圆角与主题底板。
  const window = new BrowserWindow({
    width: savedBounds?.width ?? 1480,
    height: savedBounds?.height ?? 920,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    transparent: process.platform === "darwin",
    backgroundColor: process.platform === "darwin" ? "#00000000" : appearance.variables["--background"] ?? themeBackgroundColor(preference),
    roundedCorners: appearance.skin !== "win98",
    title: "Biny",
    titleBarStyle: "hidden",
    // macOS 不使用系统 vibrancy，窗口底色固定跟随主题；局部浮层仍由渲染层 CSS 自己处理。
    visualEffectState: process.platform === "darwin" ? "active" : undefined,
    // overlay 必须保持开启：Electron 只在 titleBarOverlay 启用时才应用 trafficLightPosition，
    // 关掉或省略后红绿灯会落回系统默认高位，与侧栏按钮行错开。
    titleBarOverlay: process.platform === "darwin" ? true : undefined,
    trafficLightPosition: process.platform === "darwin" ? { x: 20, y: 24 } : undefined,
    webPreferences: {
      preload: path.join(fileURLToPath(new URL(".", import.meta.url)), "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  const syncBackgroundColor = (): void => {
    if (window.isDestroyed()) return;
    const snapshot = getAppearance();
    const current = resolveAppearance(snapshot.appearancePreference, snapshot.themePreference, nativeTheme.shouldUseDarkColors);
    window.setBackgroundColor(process.platform === "darwin" ? "#00000000" : current.variables["--background"] ?? themeBackgroundColor(snapshot.themePreference));
  };
  nativeTheme.on("updated", syncBackgroundColor);
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    nativeTheme.off("updated", syncBackgroundColor);
  });

  let allowClose = false;
  let closePromptOpen = false;
  let boundsTimer: ReturnType<typeof setTimeout> | undefined;
  const saveBounds = (): void => {
    // 最大化/全屏时的尺寸不能存：还原后会变成占满屏幕的「普通窗口」。
    if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
    // 拖动和缩放会高频触发，防抖后再落盘。
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!window.isDestroyed()) void state.setWindowBounds(window.getBounds());
    }, 180);
  };
  window.on("move", saveBounds);
  window.on("resize", saveBounds);
  // 关闭要先问过上层（可能有任务在跑）：默认拦住，等决策回来再真正关闭或取消。
  // `allowClose` 用来放行决策后自己调的那次 close，`closePromptOpen` 防止反复弹询问。
  window.on("close", (event) => {
    if (allowClose) return;
    if (closePromptOpen) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closePromptOpen = true;
    void decideClose().then((decision) => {
      closePromptOpen = false;
      if (window.isDestroyed()) return;
      if (decision === "close") {
        allowClose = true;
        window.close();
      }
    }, () => {
      // 决策异常不能卡住关闭流程：重置状态并放行关闭，否则窗口永远关不掉。
      closePromptOpen = false;
      if (window.isDestroyed()) return;
      allowClose = true;
      window.close();
    });
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && event.url !== "about:srcdoc" && event.url !== "about:blank") event.preventDefault();
  });
  window.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (url.startsWith("file://") || (developmentUrl && url.startsWith(developmentUrl))) return;
    event.preventDefault();
  });

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  // 把主题偏好经启动参数传给渲染层：index.html 的内联脚本在 CSS 加载前读取它写
  // data-theme，避免首帧用浅色 fallback 刷白。
  if (developmentUrl) {
    const joiner = developmentUrl.includes("?") ? "&" : "?";
    void window.loadURL(`${developmentUrl}${joiner}theme=${encodeURIComponent(preference)}`);
  } else {
    void window.loadFile(path.join(fileURLToPath(new URL(".", import.meta.url)), "../renderer/index.html"), {
      query: { theme: preference }
    });
  }
  return window;
}

/**
 * 校验保存的窗口位置在当前显示器布局下仍然可见：外接屏拔掉后，旧坐标可能整块落在屏幕外，
 * 窗口就再也找不回来了。要求与某个显示器至少有 120x80 的交集，否则丢弃坐标改用默认居中。
 */
function visibleBounds(bounds: ReturnType<DesktopStateStore["windowBounds"]>): ReturnType<DesktopStateStore["windowBounds"]> {
  if (!bounds) return undefined;
  const intersects = screen.getAllDisplays().some((display) => {
    const left = Math.max(bounds.x ?? 0, display.bounds.x);
    const top = Math.max(bounds.y ?? 0, display.bounds.y);
    const right = Math.min((bounds.x ?? 0) + bounds.width, display.bounds.x + display.bounds.width);
    const bottom = Math.min((bounds.y ?? 0) + bounds.height, display.bounds.y + display.bounds.height);
    return right - left >= 120 && bottom - top >= 80;
  });
  return intersects ? bounds : undefined;
}
