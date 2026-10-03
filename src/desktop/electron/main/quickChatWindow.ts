/**
 * QuickChat 原生窗口生命周期。
 *
 * Quick Chat 不是第二个 renderer 入口，而是主页面的 `#/quick-chat` 路由。这里
 * 只负责窗口几何、显隐、快捷键唤醒后的焦点和点击穿透；上下文读取与聊天状态分别由独立
 * 服务和 renderer 组件处理，避免窗口控制器继续承载业务逻辑。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";
import type { DesktopQuickChatSettings } from "../../protocol.js";
import type { DesktopWindowBounds } from "./DesktopStateStore.js";

const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 400;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 260;
const BOTTOM_GAP = 50;

export interface QuickChatWindowOptions {
  getBounds(): DesktopWindowBounds | undefined;
  saveBounds(bounds: DesktopWindowBounds): void | Promise<void>;
  onClosed?(): void;
}

export interface QuickChatWindowController {
  isVisible(): boolean;
  isClickThrough(): boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  focus(): void;
  focusInput(): void;
  close(): void;
  setClickThrough(enabled: boolean): void;
  send(channel: string, payload: unknown): void;
  applySettings(settings: DesktopQuickChatSettings): void;
  destroy(): void;
}

export function createQuickChatWindow(
  getSettings: () => DesktopQuickChatSettings,
  options: QuickChatWindowOptions
): QuickChatWindowController {
  const settings = getSettings();
  const storedBounds = options.getBounds();
  const window = new BrowserWindow({
    width: clampDimension(storedBounds?.width ?? DEFAULT_WIDTH, MIN_WIDTH),
    height: clampDimension(storedBounds?.height ?? DEFAULT_HEIGHT, MIN_HEIGHT),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    frame: false,
    transparent: process.platform === "darwin",
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#1a1a2e",
    hasShadow: true,
    roundedCorners: true,
    fullscreenable: false,
    focusable: true,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    show: false,
    title: "Biny Quick Chat",
    webPreferences: {
      preload: path.join(fileURLToPath(new URL(".", import.meta.url)), "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  window.setAlwaysOnTop(true, "floating");

  let settingsSnapshot = settings;
  let clickThroughActive = settings.clickThrough;
  let ready = false;
  let requestedVisible = false;
  let destroyed = false;

  const applyClickThrough = (enabled: boolean): void => {
    if (destroyed || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(enabled, { forward: true });
  };

  const positionAtBottomCenter = (): void => {
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    const [windowWidth = DEFAULT_WIDTH, windowHeight = DEFAULT_HEIGHT] = window.getSize();
    const targetX = Math.round(x + (width - windowWidth) / 2);
    const targetY = Math.round(y + height - windowHeight - BOTTOM_GAP);
    if (!destroyed && !window.isDestroyed()) window.setPosition(targetX, targetY);
  };

  const focusInput = (): void => {
    if (destroyed || window.isDestroyed()) return;
    window.webContents.send("desktop:quickchat:focus-input");
  };

  const present = (): void => {
    if (destroyed || window.isDestroyed() || !ready) return;
    positionAtBottomCenter();
    clickThroughActive = false;
    applyClickThrough(false);
    window.show();
    window.focus();
    focusInput();
  };

  const show = (): void => {
    requestedVisible = true;
    present();
  };

  const hide = (): void => {
    requestedVisible = false;
    if (destroyed || window.isDestroyed()) return;
    if (settingsSnapshot.clickThrough) {
      clickThroughActive = true;
      applyClickThrough(true);
    }
    window.hide();
  };

  const toggle = (): void => {
    if (destroyed || window.isDestroyed()) return;
    if (window.isVisible()) {
      if (clickThroughActive) {
        present();
      } else {
        hide();
      }
      return;
    }
    show();
  };

  window.once("ready-to-show", () => {
    ready = true;
    if (requestedVisible) present();
  });

  window.on("resize", () => {
    if (destroyed || window.isDestroyed()) return;
    const [width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT] = window.getSize();
    options.saveBounds({ width, height });
  });

  window.on("blur", () => {
    if (destroyed || window.isDestroyed()) return;
    if (settingsSnapshot.autoHideOnBlur && window.isVisible() && !window.webContents.isDevToolsOpened()) hide();
  });

  window.on("closed", () => {
    destroyed = true;
    requestedVisible = false;
    options.onClosed?.();
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && event.url !== "about:srcdoc" && event.url !== "about:blank") event.preventDefault();
  });
  window.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (url.startsWith("file://") || (developmentUrl !== undefined && url.startsWith(developmentUrl))) return;
    event.preventDefault();
  });

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) {
    void window.loadURL(`${developmentUrl}#/quick-chat`);
  } else {
    void window.loadFile(path.join(fileURLToPath(new URL(".", import.meta.url)), "../renderer/index.html"), {
      hash: "#/quick-chat"
    });
  }

  applyClickThrough(clickThroughActive);

  return {
    isVisible: () => !destroyed && !window.isDestroyed() && window.isVisible(),
    isClickThrough: () => clickThroughActive,
    show,
    hide,
    toggle,
    focus: () => {
      if (destroyed || window.isDestroyed()) return;
      window.show();
      window.focus();
    },
    focusInput,
    close: () => {
      if (destroyed || window.isDestroyed()) return;
      const [width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT] = window.getSize();
      options.saveBounds({ width, height });
      requestedVisible = false;
      window.close();
    },
    setClickThrough: (enabled) => {
      clickThroughActive = enabled;
      applyClickThrough(enabled);
    },
    send: (channel, payload) => {
      if (destroyed || window.isDestroyed()) return;
      window.webContents.send(channel, payload);
    },
    applySettings: (next) => {
      settingsSnapshot = next;
      if (!next.clickThrough) {
        clickThroughActive = false;
        applyClickThrough(false);
      } else if (!window.isVisible()) {
        clickThroughActive = true;
        applyClickThrough(true);
      } else if (!window.isFocused()) {
        clickThroughActive = true;
        applyClickThrough(true);
      }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      if (!window.isDestroyed()) window.destroy();
    }
  };
}

function clampDimension(value: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.round(value)) : minimum;
}
