import type { ComputerPreview, ComputerStatus } from "./protocol.js";
import { desktopCaptureSchedule, type CaptureSchedule } from "./captureSchedule.js";

export interface PreviewWindow {
  isDestroyed(): boolean;
  showInactive(): void;
  destroy(): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  loadURL(url: string): Promise<unknown>;
  on(event: "moved" | "resized", callback: () => void): unknown;
  once(event: "closed" | "ready-to-show" | "moved", callback: () => void): unknown;
  webContents: {
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    on(event: "will-navigate", handler: (event: { preventDefault(): void }, url: string) => void): unknown;
    once(event: "did-finish-load", callback: () => void): unknown;
    isLoading(): boolean;
    executeJavaScript(script: string): Promise<unknown>;
  };
}
export type PreviewBounds = { x: number; y: number; width: number; height: number };
export interface PreviewSurfaceOptions {
  layout?: { load(): PreviewBounds | undefined; save(bounds: PreviewBounds): void };
  onCommand?: (command: string) => void;
  onError?: (error: unknown) => void;
}
export interface PreviewItem { id: string; label: string; frame?: ComputerPreview; status: ComputerStatus; onReturn?(): void; onClose?(): void }
export class ComputerPreviewSurface {
  private readonly items = new Map<string, PreviewItem>();
  private selected?: string;
  private closing = false;
  private ageTimer?: ReturnType<typeof setInterval>;
  activeItem(): string | undefined { return this.selected; }
  present(item: PreviewItem): void {
    if (!this.items.has(item.id) && this.items.size >= 16) throw new Error("preview_item_limit");
    this.items.set(item.id, item); this.selected ??= item.id;
    this.open(); this.paintSelection();
  }
  select(id: string): void { if (!this.items.has(id)) return; this.selected = id; this.paintSelection(); }
  remove(id: string): void {
    this.items.delete(id); if (this.selected === id) this.selected = this.items.keys().next().value;
    if (!this.items.size) this.close(); else this.paintSelection();
  }
  private paintSelection(): void {
    const selected = this.selected && this.items.get(this.selected); if (!selected) return;
    this.update(selected.frame, selected.status);
    const window = this.window; if (!window || window.isDestroyed()) return;
    const entries = [...this.items.values()].map(item => ({ id: item.id, label: item.label }));
    const paint = (): void => { if (this.window !== window || window.isDestroyed()) return;
      void window.webContents.executeJavaScript(`const list=document.getElementById('items'); if(list){list.replaceChildren();for(const item of ${JSON.stringify(entries)}){const link=document.createElement('a');link.textContent=item.label;link.href='biny-computer:select:'+encodeURIComponent(item.id);link.setAttribute('aria-current',String(item.id===${JSON.stringify(this.selected)}));list.append(link);} }`).catch(error => this.options.onError?.(error));
    };
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", paint); else paint();
  }

  private window?: PreviewWindow;
  private revision = 0;
  /** 窗口重建和重新启动时恢复用户最后一次布局。 */
  private lastBounds?: { x: number; y: number; width: number; height: number };
  private releaseCaptureHold?: () => void;
  private readonly onControl: (control: "pause" | "takeover" | "stop") => void;
  private readonly onClose: () => void;
  private readonly createWindow: () => PreviewWindow;
  private readonly html: string;
  private readonly captures: CaptureSchedule;
  constructor(createWindow: () => PreviewWindow, html: string, onControl: (control: "pause" | "takeover" | "stop") => void, onClose: () => void, captures: CaptureSchedule = desktopCaptureSchedule, private readonly options: PreviewSurfaceOptions = {}) { this.createWindow = createWindow; this.html = html; this.captures = captures; this.onControl = onControl; this.onClose = onClose; }
  open(): void {
    if (this.window && !this.window.isDestroyed()) { this.window.showInactive(); return; }
    this.lastBounds ??= this.options.layout?.load();
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
      const command = url.replace(/^biny-computer:/, "");
      if (url.startsWith("biny-computer:select:")) { this.select(decodeURIComponent(command.slice(7))); return; }
      if (command === "return") { const item = this.selected && this.items.get(this.selected); if (item) item.onReturn?.(); return; }
      if (command === "remove") { const item = this.selected && this.items.get(this.selected); if (item) { this.remove(item.id); item.onClose?.(); } return; }
      this.options.onCommand?.(command);
      const control = url.replace(/^biny-computer:/, "");
      if (url === `biny-computer:${control}` && (control === "pause" || control === "takeover" || control === "stop")) this.onControl(control);
    });
    window.once("closed", () => { this.revision++; if (this.window === window) { this.window = undefined; if (this.ageTimer) clearInterval(this.ageTimer); this.ageTimer = undefined; this.releaseCaptureHold?.(); this.releaseCaptureHold = undefined; if (!this.closing) { for (const item of this.items.values()) item.onClose?.(); this.items.clear(); this.selected = undefined; this.onClose(); } } });
    window.once("ready-to-show", () => { if (this.window === window && !window.isDestroyed()) window.showInactive(); });
    for (const event of ["moved", "resized"] as const) window.on(event, () => { try { this.rememberBounds(); } catch (error) { this.options.onError?.(error); } });
    this.ageTimer ??= setInterval(() => { if (this.items.size) this.paintSelection(); }, 1000);
    this.ageTimer.unref?.();
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.html)}`).catch(() => undefined);
  }
  update(frame: ComputerPreview | undefined, status: ComputerStatus): void {
    const window = this.window; if (!window || window.isDestroyed()) return;
    const revision = ++this.revision;
    const paint = (): void => {
      if (revision !== this.revision || window.isDestroyed() || this.window !== window) return;
      const states = { disabled: "已停止", ready: "已就绪", paused: "已暂停", "taken-over": "人工接管", unknown: "结果未知" };
      const outcomes = { "not-dispatched": "尚未派发", completed: "输入已完成", refused: "已拒绝", unverified: "效果未确认", unknown: "输入结果未知" };
      const browser = this.selected?.startsWith("browser:") || this.selected?.startsWith("relay:");
      const text = browser ? `浏览器画面${status.diagnostic ? ` · ${status.diagnostic}` : ""}${frame ? ` · ${Math.max(0, Math.floor((Date.now() - frame.capturedAt) / 1000))} 秒前更新` : " · 正在建立预览"}` : `${states[status.state]} · ${outcomes[status.lastOutcome]}${status.diagnostic ? ` · ${status.diagnostic}` : ""}${frame ? ` · PID ${frame.target.pid} / ${frame.target.windowId} · ${Math.max(0, Math.floor((Date.now() - frame.capturedAt) / 1000)) >= 2 ? `画面已停留 ${Math.max(0, Math.floor((Date.now() - frame.capturedAt) / 1000))} 秒` : "实时画面"}` : " · 正在等待观察目标"}`;
      const src = frame ? `data:${frame.image.mimeType};base64,${frame.image.dataBase64}` : "";
      void window.webContents.executeJavaScript(`document.querySelectorAll('[data-control]').forEach(button=>button.hidden=${Boolean(browser)}); document.getElementById('status').textContent=${JSON.stringify(text)}; document.getElementById('frame').src=${JSON.stringify(src)}; const empty=document.getElementById('empty'); if(empty) empty.hidden=${Boolean(frame)};`).catch(() => undefined);
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
    this.lastBounds = next; this.options.layout?.save(next);
    return next;
  }
  /** 记下用户拖动后的位置（窗口 moved 事件里调）。 */
  rememberBounds(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    this.lastBounds = window.getBounds(); this.options.layout?.save(this.lastBounds);
  }
  bounds(): { x: number; y: number; width: number; height: number } | undefined { return this.lastBounds; }
  close(): void {
    this.revision++; this.closing = true;
    try { this.window?.destroy(); } finally { this.closing = false; }
    this.window = undefined; this.releaseCaptureHold?.(); this.releaseCaptureHold = undefined;
    if (this.ageTimer) clearInterval(this.ageTimer); this.ageTimer = undefined;
  }
}
