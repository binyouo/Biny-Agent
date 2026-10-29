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
  fitFrame?: (window: PreviewWindow, frame: ComputerPreview) => boolean;
  onError?: (error: unknown) => void;
}
export interface PreviewItem { id: string; label: string; frame?: ComputerPreview; status: ComputerStatus; onReturn?(): void; onClose?(completing?: boolean): void }
export class ComputerPreviewSurface {
  private readonly items = new Map<string, PreviewItem>();
  private readonly retiring = new Map<string, ReturnType<typeof setTimeout>>();
  private selected?: string;
  private fittedTarget?: ComputerPreview["target"];
  private closing = false;
  private ageTimer?: ReturnType<typeof setInterval>;
  activeItem(): string | undefined { return this.selected; }
  itemIds(): string[] { return [...this.items.keys()]; }
  isRetiring(id: string): boolean { return this.retiring.has(id); }
  present(item: PreviewItem): void {
    const retirement = this.retiring.get(item.id);
    if (retirement) { clearTimeout(retirement); this.retiring.delete(item.id); }
    const isNew = !this.items.has(item.id);
    if (isNew && this.items.size >= 16) { const finishing = this.retiring.keys().next().value; if (finishing !== undefined) this.remove(finishing); }
    if (isNew && this.items.size >= 16) throw new Error("preview_item_limit");
    this.items.set(item.id, item); if (isNew) { this.selected = item.id; this.fittedTarget = undefined; }
    this.open(); this.paintSelection();
  }
  select(id: string): void { if (!this.items.has(id)) return; if (this.selected !== id) this.fittedTarget = undefined; this.selected = id; this.paintSelection(); }
  retire(id: string): void {
    if (!this.items.has(id) || this.retiring.has(id)) return;
    const timer = setTimeout(() => { this.retiring.delete(id); try { this.remove(id); } catch (error) { if (this.items.has(id)) this.paintSelection(); this.options.onError?.(error); } }, 420);
    timer.unref?.(); this.retiring.set(id, timer);
    if (this.selected === id) this.paintSelection();
  }
  remove(id: string): void {
    const retirement = this.retiring.get(id);
    if (retirement) { clearTimeout(retirement); this.retiring.delete(id); }
    if (this.items.size === 1 && this.items.has(id)) { this.close(); this.items.delete(id); this.selected = undefined; return; }
    this.items.delete(id); if (this.selected === id) { this.selected = [...this.items.keys()].at(-1); this.fittedTarget = undefined; }
    if (!this.items.size) this.close(); else this.paintSelection();
  }
  private paintSelection(): void {
    const selected = this.selected && this.items.get(this.selected); if (!selected) return;
    const current = this.window;
    if (selected.frame && current && !current.isDestroyed() && this.options.fitFrame && (selected.frame.target.pid !== this.fittedTarget?.pid || selected.frame.target.windowId !== this.fittedTarget?.windowId)) {
      try { if (this.options.fitFrame(current, selected.frame)) this.fittedTarget = { ...selected.frame.target }; }
      catch (error) { this.fittedTarget = { ...selected.frame.target }; this.options.onError?.(error); }
    }
    this.update(selected.frame, selected.status);
    const window = this.window; if (!window || window.isDestroyed()) return;
    const entries = [...this.items.values()].map(item => ({ id: item.id, label: item.label, kind: item.id.startsWith("browser:") || item.id.startsWith("relay:") ? "browser" : "computer" }));
    const selectedId = this.selected;
    const renderKey = JSON.stringify({ entries, selectedId });
    const paint = (): void => { if (this.window !== window || window.isDestroyed()) return;
      void window.webContents.executeJavaScript(`(()=>{const list=document.getElementById('items'); if(list&&list.dataset.renderKey!==${JSON.stringify(renderKey)}){list.dataset.renderKey=${JSON.stringify(renderKey)};const active=document.activeElement,focused=list.contains(active)?active?.dataset?.sourceId:undefined;let restore;list.replaceChildren();list.hidden=${entries.length <= 1};for(const item of ${JSON.stringify(entries)}){const link=document.createElement('a'),icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use'),label=document.createElement('span');link.dataset.kind=item.kind;link.dataset.sourceId=item.id;if(item.id===focused)restore=link;link.title=item.label;link.href='biny-computer:select:'+encodeURIComponent(item.id);link.setAttribute('aria-current',String(item.id===${JSON.stringify(selectedId)}));icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');use.setAttribute('href',item.kind==='browser'?'#pip-icon-browser':'#pip-icon-computer');icon.append(use);label.textContent=item.label;link.append(icon,label);list.append(link);} if(restore&&!list.hidden)restore.focus(); }})()`).catch(error => this.options.onError?.(error));
    };
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", paint); else paint();
  }

  private window?: PreviewWindow;
  private revision = 0;
  private lastBounds?: { x: number; y: number; width: number; height: number };
  private releaseCaptureHold?: () => void;
  private readonly onControl: (control: "pause" | "takeover" | "stop") => void;
  private readonly onClose: () => void;
  private readonly createWindow: () => PreviewWindow;
  private readonly html: string;
  private readonly captures: CaptureSchedule;
  constructor(createWindow: () => PreviewWindow, html: string, onControl: (control: "pause" | "takeover" | "stop") => void, onClose: () => void, captures: CaptureSchedule = desktopCaptureSchedule, private readonly options: PreviewSurfaceOptions = {}) { this.createWindow = createWindow; this.html = html; this.captures = captures; this.onControl = onControl; this.onClose = onClose; }
  open(): void {
    if (this.window && !this.window.isDestroyed()) return;
    if (this.options.layout) this.lastBounds = this.options.layout.load() ?? this.lastBounds;
    const window = this.createWindow();
    this.window = window;
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
      if (command === "remove") { const item = this.selected && this.items.get(this.selected); if (item) { this.retire(item.id); item.onClose?.(true); } return; }
      if (url === `biny-computer:${command}` && (command === "pause" || command === "takeover" || command === "stop")) this.onControl(command);
    });
    window.once("closed", () => { this.revision++; if (this.window === window) { this.window = undefined; this.fittedTarget = undefined; for (const timer of this.retiring.values()) clearTimeout(timer); this.retiring.clear(); if (this.ageTimer) clearInterval(this.ageTimer); this.ageTimer = undefined; this.releaseCaptureHold?.(); this.releaseCaptureHold = undefined; if (!this.closing) { for (const item of this.items.values()) item.onClose?.(); this.items.clear(); this.selected = undefined; this.onClose(); } } });
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
      const stale = frame ? Date.now() - frame.capturedAt >= 2_000 : false;
      const attention = !browser && (status.state !== "ready" || ["refused", "unverified", "unknown"].includes(status.lastOutcome));
      const text = browser ? `浏览器画面${status.diagnostic ? ` · ${status.diagnostic}` : ""}${frame ? ` · ${Math.max(0, Math.floor((Date.now() - frame.capturedAt) / 1000))} 秒前更新` : " · 正在建立预览"}` : `${states[status.state]} · ${outcomes[status.lastOutcome]}${status.diagnostic ? ` · ${status.diagnostic}` : ""}${frame ? ` · PID ${frame.target.pid} / ${frame.target.windowId} · ${Math.max(0, Math.floor((Date.now() - frame.capturedAt) / 1000)) >= 2 ? `画面已停留 ${Math.max(0, Math.floor((Date.now() - frame.capturedAt) / 1000))} 秒` : "实时画面"}` : " · 正在等待观察目标"}`;
      const src = frame ? `data:${frame.image.mimeType};base64,${frame.image.dataBase64}` : "";
      const point = frame?.cursor && frame.cursor.expiresAt > Date.now() ? { x: frame.cursor.x, y: frame.cursor.y } : null;
      void window.webContents.executeJavaScript(`(()=>{document.getElementById('stage').dataset.completing=${JSON.stringify(Boolean(this.selected && this.retiring.has(this.selected)))};document.querySelectorAll('[data-control]').forEach(button=>button.hidden=${Boolean(browser)}); const status=document.getElementById('status'); status.textContent=${JSON.stringify(text)}; status.dataset.alert=${JSON.stringify(Boolean(status.diagnostic || stale || attention))}; const image=document.getElementById('frame'), cursor=document.getElementById('agent-cursor'), point=${JSON.stringify(point)}, src=${JSON.stringify(src)}; const position=()=>{cursor.hidden=!point||!image.complete||!image.naturalWidth||!image.naturalHeight;if(cursor.hidden)return;const scale=Math.min(image.clientWidth/image.naturalWidth,image.clientHeight/image.naturalHeight),width=image.naturalWidth*scale,height=image.naturalHeight*scale;cursor.style.left=((image.clientWidth-width)/2+point.x*width)+'px';cursor.style.top=(point.y*height)+'px'};image.onload=()=>{image.dataset.loaded='true';position()};window.onresize=position;if(image.getAttribute('src')!==src){cursor.hidden=true;if(!src)image.dataset.loaded='false';image.src=src}else{if(!src)image.dataset.loaded='false';position()} const empty=document.getElementById('empty'); if(empty) empty.hidden=${Boolean(frame)};})()`).catch(() => undefined);
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
    for (const timer of this.retiring.values()) clearTimeout(timer); this.retiring.clear();
    this.window = undefined; this.fittedTarget = undefined; this.releaseCaptureHold?.(); this.releaseCaptureHold = undefined;
    if (this.ageTimer) clearInterval(this.ageTimer); this.ageTimer = undefined;
  }
}
