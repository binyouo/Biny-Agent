import { BrowserWindow, screen, type NativeImage } from "electron";
import { sampleWindowTrail, type TrailBounds } from "../../windowTrail.js";

const trailPage = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}canvas{display:block}</style><canvas></canvas><script>
const canvas=document.querySelector('canvas');const context=canvas.getContext('2d');let image;let origin=[0,0];let stamps=[];let generation=0;
function redraw(){context.clearRect(0,0,canvas.width,canvas.height);for(const stamp of stamps)context.drawImage(image,...stamp);}
window.trail={init(source,x,y,width,height,scale){generation++;origin=[x,y];stamps=[];canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);canvas.style.width=width+'px';canvas.style.height=height+'px';context.setTransform(scale,0,0,scale,0,0);image=new Image();image.src=source;},stamp(points,width,height){if(!image||!image.complete)return;for(const point of points){const stamp=[point[0]-origin[0],point[1]-origin[1],width,height];context.drawImage(image,...stamp);stamps.push(stamp);}if(stamps.length>128){stamps=stamps.slice(-128);redraw();}},clear(){const expected=++generation;const amount=Math.max(1,Math.ceil(stamps.length/24));return new Promise(resolve=>{function erase(){if(expected!==generation){resolve();return;}stamps.splice(0,amount);redraw();if(stamps.length)setTimeout(erase,28);else resolve();}erase();});}};
</script>`;

export function attachWindowTrail(window: BrowserWindow, enabled: () => boolean): () => void {
  let overlay: BrowserWindow | undefined;
  let previous: TrailBounds | undefined;
  let ready = false;
  let generation = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let erase: ReturnType<typeof setTimeout> | undefined;
  let load: Promise<void> | undefined;
  let capture: Promise<NativeImage> | undefined;
  const report = (error: unknown): void => console.warn("Window trail failed:", error instanceof Error ? error.message : String(error));
  const execute = async (code: string): Promise<void> => { if (overlay && !overlay.isDestroyed()) await overlay.webContents.executeJavaScript(code); };
  const finish = (): void => {
    previous = undefined; ready = false;
    const expected = ++generation;
    if (idle) clearTimeout(idle);
    if (erase) clearTimeout(erase);
    erase = setTimeout(() => {
      void execute("window.trail.clear()").catch(report).finally(() => { if (generation === expected && overlay && !overlay.isDestroyed()) overlay.hide(); });
    }, 700);
  };
  const start = async (bounds: TrailBounds, expected: number): Promise<void> => {
    const display = screen.getDisplayMatching(bounds);
    if (!overlay || overlay.isDestroyed()) {
      overlay = new BrowserWindow({ width: 100, height: 100, show: false, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, hasShadow: false, fullscreenable: false, hiddenInMissionControl: true, title: "Window trail", webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false } });
      overlay.setIgnoreMouseEvents(true);
      overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      load = overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(trailPage)}`);
    }
    await load;
    if (window.isDestroyed() || expected !== generation || !enabled()) return;
    capture ??= window.webContents.capturePage().finally(() => { capture = undefined; });
    const captured = await capture;
    if (window.isDestroyed() || expected !== generation || !enabled() || !overlay || overlay.isDestroyed()) return;
    const screenshot = captured.getSize().width > 1600 ? captured.resize({ width: 1600 }) : captured;
    overlay.setBounds(display.bounds);
    const scale = Math.min(display.scaleFactor, Math.sqrt(8_000_000 / (display.bounds.width * display.bounds.height)));
    await execute(`window.trail.init(${JSON.stringify(screenshot.toDataURL())},${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height},${scale})`);
    if (expected !== generation) return;
    overlay.showInactive();
    window.moveAbove(overlay.getMediaSourceId());
    ready = true;
  };
  const moved = (): void => {
    if (window.isDestroyed() || !enabled() || window.isFullScreen() || window.isMaximized()) { if (previous) finish(); return; }
    const bounds = window.getBounds();
    if (!previous) {
      previous = bounds; ready = false; const expected = ++generation;
      if (erase) clearTimeout(erase);
      void start(bounds, expected).catch(error => { report(error); if (expected === generation) finish(); });
    } else if (bounds.width !== previous.width || bounds.height !== previous.height) { finish(); return; }
    else if (ready) {
      const points = sampleWindowTrail(previous, bounds);
      if (points.length) { previous = bounds; void execute(`window.trail.stamp(${JSON.stringify(points)},${bounds.width},${bounds.height})`).catch(report); }
    }
    if (idle) clearTimeout(idle);
    idle = setTimeout(finish, 250);
  };
  const dispose = (): void => { generation++; if (idle) clearTimeout(idle); if (erase) clearTimeout(erase); window.removeListener("move", moved); if (overlay && !overlay.isDestroyed()) overlay.destroy(); overlay = undefined; };
  window.on("move", moved); window.once("closed", dispose);
  return dispose;
}
