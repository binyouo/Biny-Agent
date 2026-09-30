import type { ComputerPreview, ComputerStatus } from "./protocol.js";
import { desktopCaptureSchedule, type CaptureSchedule } from "./captureSchedule.js";

export interface PreviewWindow {
  isDestroyed(): boolean;
  showInactive(): void;
  destroy(): void;
  loadURL(url: string): Promise<unknown>;
  once(event: "closed" | "ready-to-show", callback: () => void): unknown;
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
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.html)}`).catch(() => undefined);
  }
  update(frame: ComputerPreview | undefined, status: ComputerStatus): void {
    const window = this.window; if (!window || window.isDestroyed()) return;
    const revision = ++this.revision;
    const paint = (): void => {
      if (revision !== this.revision || window.isDestroyed() || this.window !== window) return;
      const states = { disabled: "已停止", ready: "已就绪", paused: "已暂停", "taken-over": "人工接管", unknown: "结果未知" };
      const outcomes = { "not-dispatched": "尚未派发", completed: "输入已完成", refused: "已拒绝", unverified: "效果未确认", unknown: "输入结果未知" };
      const text = `${states[status.state]} · ${outcomes[status.lastOutcome]}${frame ? ` · PID ${frame.target.pid} / ${frame.target.windowId} · ${new Date(frame.capturedAt).toLocaleTimeString()}` : " · 等待新的主动观察"}`;
      const src = frame ? `data:${frame.image.mimeType};base64,${frame.image.dataBase64}` : "";
      void window.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(text)}; document.getElementById('frame').src=${JSON.stringify(src)}; const empty=document.getElementById('empty'); if(empty) empty.hidden=${Boolean(frame)};`).catch(() => undefined);
    };
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", paint); else paint();
  }
  close(): void { this.revision++; this.window?.destroy(); this.window = undefined; this.releaseCaptureHold?.(); this.releaseCaptureHold = undefined; }
}
