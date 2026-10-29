import { spawn } from "node:child_process";
import { BrowserWindow } from "electron";
import { desktopCaptureSchedule } from "../../../computer/captureSchedule.js";

type Rect = { x: number; y: number; width: number; height: number };
type SourceFrame = { x: number; y: number; w: number; h: number };
const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;overflow:hidden;background:transparent}#shot{position:absolute;opacity:0;transform-origin:center;pointer-events:none}#image{width:100%;height:100%;object-fit:fill;border-radius:14px;box-shadow:0 10px 32px rgba(0,0,0,.25)}#badge{position:absolute;left:50%;bottom:0;width:22%;max-width:96px;min-width:44px;aspect-ratio:1;transform:translate(-50%,50%);border-radius:50%;box-shadow:0 0 0 4px rgba(255,255,255,.95),0 8px 24px rgba(0,0,0,.35);background:rgba(20,20,20,.6)}#badge[hidden]{display:none}</style></head><body><div id="shot"><img id="image" alt=""><img id="badge" alt="" hidden></div></body></html>`;

export class AppshotFeedback {
  private readonly windows = new Set<{ window: BrowserWindow; timer: ReturnType<typeof setTimeout>; release: () => void }>();
  private closed = false;

  sound(): void {
    if (this.closed || process.platform !== "darwin") return;
    try {
      const child = spawn("/usr/bin/afplay", ["-v", "0.7", "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Shutter.aif"], { stdio: "ignore", detached: true });
      child.on("error", () => undefined); child.unref();
    } catch { /* Feedback cannot prevent capture. */ }
  }

  async animate(main: BrowserWindow, frame: SourceFrame, bytes: Buffer, icon?: string, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || main.isDestroyed() || signal?.aborted) return false;
    const image = bytes.toString("base64");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let composer: { x: number; y: number; width: number; height: number } | null = null;
    try {
      composer = await Promise.race([
        main.webContents.executeJavaScript("(() => { const form=document.querySelector('form.biny-composer'); if(!form)return null; const r=form.getBoundingClientRect(); if(r.width<80||r.height<40)return null; const list=form.querySelector('.biny-composer-attachments'); const last=list?.lastElementChild?.getBoundingClientRect(); if(list&&last){const area=list.getBoundingClientRect();let x=last.right+15,y=last.top+9;if(x+240>area.right){x=area.left+9;y=last.bottom+15}return {x,y,width:40,height:40}}const shift=window.innerHeight-r.bottom<80?69:34; return {x:r.left+21,y:r.top-shift+21,width:40,height:40}; })()") as Promise<Rect | null>,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 300); })
      ]);
    } catch { /* The attachment can still be delivered without a measured composer. */ }
    finally { if (timer) clearTimeout(timer); }
    if (this.closed || main.isDestroyed() || signal?.aborted) return false;
    const parent = main.getContentBounds();
    const validComposer = composer && [composer.x, composer.y, composer.width, composer.height].every(Number.isFinite) && composer.width > 0 && composer.height > 0;
    const destination = validComposer && composer
      ? { x: parent.x + composer.x, y: parent.y + composer.y, width: composer.width, height: composer.height }
      : { x: parent.x + parent.width - 144, y: parent.y + parent.height - 144, width: 56, height: 56 };
    const padding = 128;
    const x = Math.floor(Math.min(frame.x, destination.x)) - padding, y = Math.floor(Math.min(frame.y, destination.y)) - padding;
    const width = Math.ceil(Math.max(frame.x + frame.w, destination.x + destination.width) - x) + padding;
    const height = Math.ceil(Math.max(frame.y + frame.h, destination.y + destination.height) - y) + padding;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 16_384 || height > 16_384 || width * height > 67_108_864) return false;
    const window = new BrowserWindow({ x, y, width, height, frame: false, transparent: true, show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const release = desktopCaptureSchedule.retainPreview();
    const entry = { window, release, timer: setTimeout(() => this.tryRemove(entry), 3000) };
    let ended!: () => void;
    const closed = new Promise<false>(resolve => { ended = () => resolve(false); });
    this.windows.add(entry);
    const abort = (): void => this.tryRemove(entry);
    signal?.addEventListener("abort", abort, { once: true });
    window.once("closed", () => { signal?.removeEventListener("abort", abort); clearTimeout(entry.timer); this.windows.delete(entry); release(); ended(); });
    try {
      window.setIgnoreMouseEvents(true);
      if (process.platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.setAlwaysOnTop(true, "screen-saver");
      const loaded = await Promise.race([window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => true), closed]);
      if (!loaded || this.closed || window.isDestroyed() || signal?.aborted) return false;
      const source = { x: frame.x - x, y: frame.y - y, width: frame.w, height: frame.h };
      const target = { x: destination.x - x, y: destination.y - y, width: destination.width, height: destination.height };
      window.showInactive();
      const duration = await Promise.race([window.webContents.executeJavaScript(`(async()=>{const shot=document.getElementById('shot'),image=document.getElementById('image'),badge=document.getElementById('badge'),s=${JSON.stringify(source)},d=${JSON.stringify(target)},icon=${JSON.stringify(icon ?? null)};shot.style.cssText='left:'+s.x+'px;top:'+s.y+'px;width:'+s.width+'px;height:'+s.height+'px';image.src='data:image/jpeg;base64,'+${JSON.stringify(image)};await image.decode();if(icon){badge.src=icon;try{await badge.decode();badge.hidden=false}catch{badge.hidden=true}}await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const dx=d.x+d.width/2-s.x-s.width/2,dy=d.y+d.height/2-s.y-s.height/2,sx=d.width/s.width,sy=d.height/s.height,reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;shot.animate([{opacity:0,transform:'translate(0,0) scale(1)',offset:0},{opacity:1,transform:'translate(0,0) scale(1)',offset:.06},{opacity:1,transform:'translate(0,-80px) scale(.36)',offset:.32},{opacity:1,transform:'translate(0,-80px) scale(.36)',offset:.4},{opacity:1,transform:'translate('+dx+'px,'+dy+'px) scale('+sx+','+sy+')',offset:.85},{opacity:1,transform:'translate('+dx+'px,'+dy+'px) scale('+sx*.92+','+sy*.92+')',offset:.91},{opacity:1,transform:'translate('+dx+'px,'+dy+'px) scale('+sx*1.06+','+sy*1.06+')',offset:.95},{opacity:1,transform:'translate('+dx+'px,'+dy+'px) scale('+sx+','+sy+')',offset:.98},{opacity:0,transform:'translate('+dx+'px,'+dy+'px) scale('+sx+','+sy+')',offset:1}],{duration:reduced?1:1100,easing:'linear',fill:'forwards'});return reduced?1:1100;})()`), closed]);
      if (!duration || this.closed || window.isDestroyed() || signal?.aborted) { this.tryRemove(entry); return false; }
      clearTimeout(entry.timer); entry.timer = setTimeout(() => this.tryRemove(entry), duration === 1 ? 50 : 1100);
      return duration !== 1;
    } catch { this.tryRemove(entry); return false; }
  }

  private remove(entry: { window: BrowserWindow; timer: ReturnType<typeof setTimeout>; release: () => void }): void {
    clearTimeout(entry.timer);
    if (!entry.window.isDestroyed()) entry.window.destroy();
    else if (this.windows.delete(entry)) entry.release();
  }

  private tryRemove(entry: { window: BrowserWindow; timer: ReturnType<typeof setTimeout>; release: () => void }): void {
    try { this.remove(entry); } catch { console.error("Unable to close Appshot feedback window"); }
  }

  close(): void {
    this.closed = true;
    const errors: unknown[] = [];
    for (const entry of [...this.windows]) { try { this.remove(entry); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Appshot feedback cleanup failed");
  }
}
