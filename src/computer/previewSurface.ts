import type { ComputerPreview, ComputerStatus } from "./protocol.js";
import { desktopCaptureSchedule, type CaptureSchedule } from "./captureSchedule.js";

export interface PreviewWindow {
  isDestroyed(): boolean;
  showInactive(): void;
  destroy(): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  loadURL(url: string): Promise<unknown>;
  once(event: "closed" | "ready-to-show" | "moved", callback: () => void): unknown;
  webContents: {
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    on(event: "will-navigate", handler: (event: { preventDefault(): void }, url: string) => void): unknown;
    once(event: "did-finish-load", callback: () => void): unknown;
    isLoading(): boolean;
    executeJavaScript(script: string): Promise<unknown>;
  };
}
export class ComputerPreviewSurface {
  private window?: PreviewWindow;
  private revision = 0;
  /**
   * 用户把浮窗拖到哪儿了。
   *
   * PiP 是常驻置顶的，挡到东西时必须能挪开（参照有 `pip/move`，`pip/state` 也返回 `bounds`）。
   * 而窗口是**每次打开都重建**的 —— 不记住位置，用户每挪一次、下次又跳回原点。
   * 现在只在内存里记（同一次运行内有效）；跨重启的持久化留给设置层。
   */
  private lastBounds?: { x: number; y: number; width: number; height: number };
  private releaseCaptureHold?: () => void;
  private readonly onControl: (control: "pause" | "takeover" | "stop") => void;
  private readonly onClose: () => void;
  private readonly createWindow: () => PreviewWindow;
  private readonly html: string;
  private readonly captures: CaptureSchedule;
  constructor(createWindow: () => PreviewWindow, html: string, onControl: (control: "pause" | "takeover" | "stop") => void, onClose: () => void, captures: CaptureSchedule = desktopCaptureSchedule) { this.createWindow = createWindow; this.html = html; this.captures = captures; this.onControl = onControl; this.onClose = onClose; }
  open(): void {
    if (this.window && !this.window.isDestroyed()) { this.window.showInactive(); return; }
    const window = this.createWindow();
    this.window = window;
    // 还原用户上次拖到的位置 —— 窗口是重建的，不还原就会跳回原点。
    if (this.lastBounds) window.setBounds(this.lastBounds);
    // Keep Activity paused for the whole surface lifetime, including frozen frames and paint races.
    // Destroying the surface is the only synchronous proof that none of its pixels can be recorded.
    this.releaseCaptureHold = this.captures.retainPreview();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const control = url.replace(/^biny-computer:/, "");
      if (url === `biny-computer:${control}` && (control === "pause" || control === "takeover" || control === "stop")) this.onControl(control);
    });
    window.once("closed", () => { this.revision++; if (this.window === window) { this.window = undefined; this.releaseCaptureHold?.(); this.releaseCaptureHold = undefined; this.onClose(); } });
    window.once("ready-to-show", () => { if (this.window === window && !window.isDestroyed()) window.showInactive(); });
    // 拖完记下来，下次开窗还原到这儿。失败不该影响窗口本身，所以吞掉。
    window.once("moved", () => { try { this.rememberBounds(); } catch { /* 位置记不住不影响使用 */ } });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.html)}`).catch(() => undefined);
  }
  update(frame: ComputerPreview | undefined, status: ComputerStatus): void {
    const window = this.window; if (!window || window.isDestroyed()) return;
    const revision = ++this.revision;
    const paint = (): void => {
      if (revision !== this.revision || window.isDestroyed() || this.window !== window) return;
      const states = { disabled: "已停止", ready: "已就绪", paused: "已暂停", "taken-over": "人工接管", unknown: "结果未知" };
      const outcomes = { "not-dispatched": "尚未派发", completed: "输入已完成", refused: "已拒绝", unverified: "效果未确认", unknown: "输入结果未知" };
      const text = `${states[status.state]} · ${outcomes[status.lastOutcome]}${frame ? ` · PID ${frame.target.pid} / ${frame.target.windowId} · ${new Date(frame.capturedAt).toLocaleTimeString()}` : " · 正在等待观察目标"}`;
      const src = frame ? `data:${frame.image.mimeType};base64,${frame.image.dataBase64}` : "";
      void window.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(text)}; document.getElementById('frame').src=${JSON.stringify(src)}; const empty=document.getElementById('empty'); if(empty) empty.hidden=${Boolean(frame)};`).catch(() => undefined);
    };
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", paint); else paint();
  }
  /** 把浮窗挪到指定位置并记住；未指定时用上次记住的位置。 */
  move(x?: number, y?: number): { x: number; y: number; width: number; height: number } | undefined {
    const window = this.window;
    if (!window || window.isDestroyed()) return undefined;
    const current = window.getBounds();
    const next = { ...current, x: x ?? this.lastBounds?.x ?? current.x, y: y ?? this.lastBounds?.y ?? current.y };
    window.setBounds(next);
    this.lastBounds = next;
    return next;
  }
  /** 记下用户拖动后的位置（窗口 moved 事件里调）。 */
  rememberBounds(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    this.lastBounds = window.getBounds();
  }
  bounds(): { x: number; y: number; width: number; height: number } | undefined { return this.lastBounds; }
  close(): void { this.revision++; this.window?.destroy(); this.window = undefined; this.releaseCaptureHold?.(); this.releaseCaptureHold = undefined; }
}
