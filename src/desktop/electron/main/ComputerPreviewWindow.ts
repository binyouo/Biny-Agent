import { BrowserWindow } from "electron";
import { ComputerPreviewSurface } from "../../../computer/previewSurface.js";

const previewHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
*{box-sizing:border-box}body{margin:0;background:#282c34;color:#dcdfe4;font:12px -apple-system,system-ui}header{display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid #3e4451}strong{font-size:13px}small{color:#8b92a4}nav{display:flex;gap:7px}a{color:#dcdfe4;text-decoration:none;border:1px solid #4b5363;border-radius:9px;padding:5px 8px;background:#2d333d}a:hover{background:#363d48}a:focus-visible{outline:2px solid #61afef}#status{margin:10px 12px;color:#8b92a4;font-size:11px;overflow-wrap:anywhere}.viewport{height:275px;margin:0 12px 12px;border:1px solid #3e4451;border-radius:12px;background:#21252b;display:flex;align-items:center;justify-content:center;overflow:hidden}img{display:block;max-width:100%;max-height:100%;object-fit:contain}#empty{padding:20px;text-align:center;color:#8b92a4;line-height:1.8}img:not([src]),img[src=""]{display:none}footer{padding:0 12px 8px;color:#8b92a4;font-size:10px}
</style></head><body><header><div><strong>Computer Use</strong><br><small>主动观察 · 动作后更新</small></div><nav><a href="biny-computer:pause">暂停</a><a href="biny-computer:takeover">人工接管</a><a href="biny-computer:stop">停止</a></nav></header><p id="status">等待新的主动观察</p><div class="viewport"><p id="empty">尚无主动观察帧<br>此预览不连续录屏、不回显输入文本</p><img id="frame" alt="主动观察帧"></div><footer>预览打开期间，Activity 暂停截图</footer></body></html>`;
export class ComputerPreviewWindow extends ComputerPreviewSurface {
  constructor(onControl: (control: "pause" | "takeover" | "stop") => void, onClose: () => void) {
    super(() => new BrowserWindow({ width: 480, height: 400, title: "Biny 桌面控制 · 动作后预览", show: false, alwaysOnTop: true, focusable: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } }), previewHtml, onControl, onClose);
  }
}
