import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PreviewBounds } from "../../../computer/previewSurface.js";
import { app, BrowserWindow, nativeImage, screen } from "electron";
import { ComputerPreviewSurface } from "../../../computer/previewSurface.js";

export const previewHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{background:transparent;color:#eef0f3;font:12px -apple-system,system-ui;user-select:none}#stage{position:absolute;inset:0;overflow:hidden;-webkit-app-region:drag}#frame{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:top center;opacity:0;transition:opacity .18s ease}#frame[data-loaded="true"]{opacity:1}#frame:not([src]),#frame[src=""]{display:none}#agent-cursor{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;pointer-events:none;border:2px solid rgba(255,255,255,.9);box-shadow:0 0 0 1px rgba(0,0,0,.35),0 1px 6px rgba(0,0,0,.45);transition:left .12s ease,top .12s ease}#agent-cursor::after{content:'';position:absolute;inset:7px;border-radius:50%;background:rgba(255,255,255,.95)}#empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;color:rgba(255,255,255,.6);text-align:center}#empty[hidden],#items[hidden],[data-control][hidden]{display:none}nav{-webkit-app-region:no-drag}#controls,#actions,#items{position:absolute;display:flex;gap:4px;opacity:0;transition:opacity .16s ease}#controls{top:8px;right:8px;gap:5px;transform:translateY(-2px);transition:opacity .16s ease,transform .16s ease}#actions{top:8px;left:8px}#items{left:8px;right:8px;bottom:8px;overflow-x:auto;scrollbar-width:none;transform:translateY(3px);transition:opacity .16s ease,transform .16s ease}#items::-webkit-scrollbar{display:none}body:hover #controls,body:hover #actions,body:hover #items,body:focus-within #controls,body:focus-within #actions,body:focus-within #items{opacity:1}body:hover #controls,body:focus-within #controls,body:hover #items,body:focus-within #items{transform:none}a{display:inline-flex;align-items:center;justify-content:center;flex:none;max-width:148px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eef0f3;text-decoration:none;border:0;border-radius:999px;padding:5px 8px;background:rgba(28,28,30,.75);font-size:11px}a:hover{background:rgba(55,55,58,.95)}a:focus-visible{outline:2px solid #61afef}a[aria-current="true"]{background:rgba(255,255,255,.9);color:#1c1c1e}a svg{display:block;width:14px;height:14px}#controls a{width:24px;height:24px;padding:0;border-radius:7px;background:rgba(28,28,30,.55);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);transition:background .14s ease}#controls a:hover{background:rgba(28,28,30,.8)}#controls a svg{width:13px;height:13px}#items a{gap:4px;padding:3px 8px}#items a svg{width:11px;height:11px;flex:none}#items a span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#status{position:absolute;top:42px;left:8px;right:8px;margin:0;padding:4px 7px;border-radius:6px;background:rgba(28,28,30,.8);color:#eef0f3;font-size:11px;overflow-wrap:anywhere;opacity:0;pointer-events:none}body:hover #status,body:focus-within #status,#status[data-alert="true"]{opacity:1}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
#stage[data-completing="true"] #frame{opacity:0;transform:scale(.94);transform-origin:top center;transition:opacity .38s ease,transform .38s cubic-bezier(.22,1,.36,1)}#stage[data-completing="true"] #empty,#stage[data-completing="true"] #agent-cursor{opacity:0}
@media (prefers-reduced-motion:reduce){#controls,#actions,#items,#frame,#agent-cursor,#stage[data-completing="true"] #frame{transition:none}}
</style></head><body><svg aria-hidden="true" width="0" height="0" style="position:absolute"><defs><symbol id="pip-icon-browser" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></symbol><symbol id="pip-icon-computer" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/></symbol></defs></svg><div id="stage" aria-label="实时预览（3fps）"><p id="empty">正在建立实时画面…</p><img id="frame" data-loaded="false" alt="主动观察帧"><div id="agent-cursor" hidden aria-hidden="true"></div><nav id="controls" aria-label="画中画"><a href="biny-computer:return" aria-label="返回聊天" title="返回聊天"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></a><a href="biny-computer:remove" aria-label="关闭此项" title="关闭此项"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></a></nav><nav id="actions" aria-label="桌面控制"><a data-control href="biny-computer:pause">暂停</a><a data-control href="biny-computer:takeover">人工接管</a><a data-control href="biny-computer:stop">停止</a></nav><p id="status" role="status">正在等待观察目标</p><nav id="items" aria-label="预览项目" hidden></nav><span class="sr-only">预览打开期间，Activity 暂停截图</span></div></body></html>`;
export class ComputerPreviewWindow extends ComputerPreviewSurface {
  constructor(onControl: (control: "pause" | "takeover" | "stop") => void, onClose: () => void, getMainWindow: () => BrowserWindow | undefined) {
    const file = path.join(app.getPath("userData"), "pip-layout.json");
    const layoutSchema = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(220).max(2000), height: z.number().int().min(150).max(1600), displayId: z.number().int() });
    let initialBounds: PreviewBounds | undefined;
    const layout = {
      load(): PreviewBounds | undefined {
        let size: { width: number; height: number };
        try { const bounds = layoutSchema.parse(JSON.parse(readFileSync(file, "utf8"))); size = { width: bounds.width, height: bounds.height }; } catch { size = { width: 380, height: 250 }; }
        const main = getMainWindow();
        const parent = main && !main.isDestroyed() ? main.getBounds() : undefined;
        const area = (parent ? screen.getDisplayMatching(parent) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
        const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height);
        const left = parent ? parent.x + parent.width - width - 16 : area.x + area.width - width - 16;
        const top = parent ? parent.y + parent.height - 140 - 12 - height : area.y + area.height - height - 16;
        initialBounds = { width, height, x: Math.max(area.x + 16, Math.min(left, area.x + area.width - width - 16)), y: Math.max(area.y + 16, Math.min(top, area.y + area.height - height - 16)) };
        return initialBounds;
      },
      save(bounds: PreviewBounds): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify({ ...bounds, displayId: screen.getDisplayMatching(bounds).id }), { mode: 0o600 }); renameSync(`${file}.tmp`, file); }
    };
    super(() => {
      const window = new BrowserWindow({ width: 380, height: 250, title: "Biny 桌面控制 · 实时预览", frame: false, skipTaskbar: true, show: false, alwaysOnTop: true, focusable: true, minWidth: 220, minHeight: 150, vibrancy: "hud", visualEffectState: "active", backgroundColor: "#1c1c1e", webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      if (process.platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.setAlwaysOnTop(true, "floating");
      const main = getMainWindow();
      if (main && !main.isDestroyed()) {
        const original = initialBounds;
        void (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const top = await Promise.race([
              main.webContents.executeJavaScript("(() => { let best = null; for (const form of document.querySelectorAll('form.biny-composer')) { const rect = form.getBoundingClientRect(); if (rect.width && rect.height && (!best || rect.right > best.right)) best = rect; } return best ? best.top : null; })()"),
              new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); timer.unref?.(); })
            ]);
            if (typeof top !== "number" || !Number.isFinite(top) || !original || main.isDestroyed() || window.isDestroyed()) return;
            const bounds = window.getBounds();
            if (bounds.x !== original.x || bounds.y + bounds.height !== original.y + original.height) return;
            const parent = main.getBounds(), area = screen.getDisplayMatching(parent).workArea;
            const y = Math.max(area.y + 16, Math.min(main.getContentBounds().y + Math.round(top) - 12 - bounds.height, area.y + area.height - bounds.height - 16));
            if (y !== bounds.y) window.setBounds({ ...bounds, y });
          } catch { /* Keep the initial position if the composer cannot be measured. */ }
          finally { if (timer) clearTimeout(timer); }
        })();
        let previous = main.getBounds();
        const follow = (): void => {
          if (window.isDestroyed() || main.isDestroyed()) return;
          const current = main.getBounds();
          const deltaX = current.x - previous.x, deltaY = current.y - previous.y;
          previous = current;
          if (deltaX === 0 && deltaY === 0) return;
          const bounds = window.getBounds();
          window.setBounds({ ...bounds, x: bounds.x + deltaX, y: bounds.y + deltaY });
        };
        main.on("move", follow); main.on("moved", follow);
        window.once("closed", () => { main.off("move", follow); main.off("moved", follow); });
      }
      return window;
    }, previewHtml, onControl, onClose, undefined, { layout, fitFrame: (window, frame) => {
      const image = nativeImage.createFromBuffer(Buffer.from(frame.image.dataBase64, "base64"));
      const size = image.getSize();
      if (!size.width || !size.height) return false;
      const bounds = window.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
      const height = Math.max(120, Math.min(Math.round(bounds.width * size.height / size.width), Math.round(area.height / 2)));
      if (Math.abs(height - bounds.height) >= 4) {
        const y = Math.max(area.y + 8, Math.min(bounds.y + bounds.height - height, area.y + area.height - height - 8));
        window.setBounds({ ...bounds, y, height });
      }
      return true;
    }, onError: error => { console.error("PiP surface error", error instanceof Error ? error.message : String(error)); } });
  }
}
