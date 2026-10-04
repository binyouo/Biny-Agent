// 辅助功能授权引导浮层。
//
// Alma 的对应物是「权限辅助覆盖」：520×76、定位到目标控件下方、始终置顶、
// 不可聚焦、0.9 透明度、mac 上取 floating 层级，并以 250ms 轮询跟着目标控件走
// （alma-reverse notes/01-main-process.md）。
//
// 它存在的理由：辅助功能授权要去「系统设置」里手动打开，而用户不知道该点哪里。
// 一个不抢焦点、跟着目标跑的小卡片，比一句「请去设置里开启」有用得多。
import { BrowserWindow } from "electron";
import { screen } from "electron";
import {
  PERMISSION_OVERLAY_HEIGHT as HEIGHT,
  PERMISSION_OVERLAY_WIDTH as WIDTH,
  overlayBounds,
  type OverlayRect
} from "./computerPermissionGeometry.js";

export type { OverlayRect, OverlayPoint } from "./computerPermissionGeometry.js";
/** Alma 的跟踪节奏；比它慢就跟不上滚动的列表，比它快是白烧电。 */
const TRACK_INTERVAL_MS = 250;

export const permissionOverlayHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:flex;align-items:center;gap:10px;padding:12px 16px;
  font:13px -apple-system,system-ui;color:#f2f2f7;background:rgba(28,28,32,.92);
  border:1px solid rgba(255,255,255,.16);border-radius:14px}
.pin{flex:0 0 auto;width:8px;height:8px;border-radius:999px;background:#5ac8fa;
  box-shadow:0 0 0 4px rgba(90,200,250,.22)}
.copy{min-width:0}
strong{display:block;font-size:13px;margin-bottom:2px}
small{color:rgba(242,242,247,.72);line-height:1.5}
</style></head><body>
<div class="pin"></div>
<div class="copy">
  <strong>在这里开启「辅助功能」</strong>
  <small>打开下面的开关，Biny 才能读取窗口内容。授权后回到 Biny 即可。</small>
</div>
</body></html>`;

/**
 * 浮层本体。只负责显示与定位；「目标在哪」由调用方通过 track() 提供，
 * 因为找控件位置是观察层的事，不该混进窗口代码。
 */
export class ComputerPermissionOverlay {
  private window?: BrowserWindow;
  private timer?: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;

  constructor(private readonly createWindow: () => BrowserWindow = () => new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    roundedCorners: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 引导窗绝不能抢走焦点：用户正要自己去操作系统设置。
    focusable: false,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  }), options: { intervalMs?: number } = {}) {
    this.intervalMs = options.intervalMs ?? TRACK_INTERVAL_MS;
  }

  /** 目标控件下方居中；越界时收敛回工作区，别飘到屏幕外。 */
  place(rect: OverlayRect): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const area = screen.getDisplayMatching({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }).workArea;
    window.setBounds(overlayBounds(rect, area));
  }

  /** 显示并开始跟踪；locate 返回 undefined 表示目标没了，浮层自行收起。 */
  reveal(locate?: () => Promise<OverlayRect | undefined> | OverlayRect | undefined): void {
    const window = this.window && !this.window.isDestroyed() ? this.window : (this.window = this.createWindow());
    if (window.webContents.isLoading()) void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(permissionOverlayHtml)}`);
    // Alma 的引导窗是 0.9 透明度：要看得见，又不能像正常窗口那样压住底下的设置界面。
    window.setOpacity(0.9);
    window.showInactive();
    if (locate) this.track(locate);
  }

  track(locate: () => Promise<OverlayRect | undefined> | OverlayRect | undefined): void {
    this.untrack();
    // locate 可能比 intervalMs 慢得多（截屏 + OCR 要一秒上下）。
    // 不做重入保护的话每个 tick 都会新起一次，请求叠着请求堆成风暴。
    let running = false;
    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const rect = await locate();
        if (!rect) { this.hide(); return; }
        this.place(rect);
      } finally {
        running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => { void tick(); }, this.intervalMs);
  }

  private untrack(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  hide(): void {
    this.untrack();
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  close(): void {
    this.untrack();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }
}
