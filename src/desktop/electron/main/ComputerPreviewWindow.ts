import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PreviewBounds } from "../../../computer/previewSurface.js";
import { app, BrowserWindow, screen } from "electron";
import { ComputerPreviewSurface } from "../../../computer/previewSurface.js";

export const previewHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
*{box-sizing:border-box}html,body{height:100%}body{display:flex;flex-direction:column;margin:0;background:rgba(18,20,24,.42);color:#dcdfe4;font:12px -apple-system,system-ui}header{flex-wrap:wrap;gap:8px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid rgba(255,255,255,.12);-webkit-app-region:drag;cursor:default}nav{-webkit-app-region:no-drag}strong{font-size:13px}small{color:rgba(255,255,255,.55)}nav{display:flex;gap:7px;flex-wrap:wrap}#items{flex:none;max-height:72px}#items{padding:8px 12px;overflow:auto;-webkit-app-region:no-drag}dialog::backdrop{background:#0006}a{color:#dcdfe4;text-decoration:none;border:1px solid rgba(255,255,255,.18);border-radius:9px;padding:5px 8px;background:rgba(255,255,255,.08)}a:hover{background:rgba(255,255,255,.16)}a:focus-visible{outline:2px solid #61afef}#status{margin:10px 12px;color:rgba(255,255,255,.6);font-size:11px;overflow-wrap:anywhere}.viewport{flex:1;min-height:60px;margin:0 12px 12px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;overflow:hidden}img{display:block;max-width:100%;max-height:100%;object-fit:contain}#empty{padding:20px;text-align:center;color:rgba(255,255,255,.55);line-height:1.8}img:not([src]),img[src=""]{display:none}footer{padding:0 12px 8px;color:rgba(255,255,255,.5);font-size:10px}
</style></head><body><header><div><strong>Computer Use</strong><br><small>实时画面 · 3fps</small></div><nav><a href="biny-computer:return">返回聊天</a><a href="biny-computer:remove">关闭此项</a><a data-control href="biny-computer:pause">暂停</a><a data-control href="biny-computer:takeover">人工接管</a><a data-control href="biny-computer:stop">停止</a></nav></header><nav id="items" aria-label="预览项目"></nav><p id="status">正在等待观察目标</p><div class="viewport"><p id="empty">正在建立实时画面…<br>当前来源的实时画面将在这里显示</p><img id="frame" alt="主动观察帧"></div><footer>预览打开期间，Activity 暂停截图</footer></body></html>`;
export class ComputerPreviewWindow extends ComputerPreviewSurface {
  constructor(onControl: (control: "pause" | "takeover" | "stop") => void, onClose: () => void) {
    const file = path.join(app.getPath("userData"), "pip-layout.json");
    const layoutSchema = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(320).max(2000), height: z.number().int().min(240).max(1600), displayId: z.number().int() });
    const layout = {
      load(): PreviewBounds | undefined {
        try {
          const bounds = layoutSchema.parse(JSON.parse(readFileSync(file, "utf8")));
          const display = screen.getAllDisplays().find(value => value.id === bounds.displayId) ?? screen.getPrimaryDisplay();
          const area = display.workArea;
          return { width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height), x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)) };
        } catch { return undefined; }
      },
      save(bounds: PreviewBounds): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify({ ...bounds, displayId: screen.getDisplayMatching(bounds).id }), { mode: 0o600 }); renameSync(`${file}.tmp`, file); }
    };
    super(() => { const window = new BrowserWindow({ width: 480, height: 400, title: "Biny 桌面控制 · 实时预览", show: false, alwaysOnTop: true, focusable: true, minWidth: 320, minHeight: 240, vibrancy: "hud", visualEffectState: "active", backgroundColor: "#00000000", webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } }); window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); window.setAlwaysOnTop(true, "floating"); return window; }, previewHtml, onControl, onClose, undefined, { layout, onError: error => { console.error("PiP surface error", error instanceof Error ? error.message : String(error)); } });
  }
}
