import { writeFile } from "node:fs/promises";
import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage } from "electron";
import { z } from "zod";
import { drawCapturePrivacy, captureRegion, windowCaptureIpc, type WindowCaptureImage } from "../../windowCapture.js";

const optionsSchema = z.object({
  scope: z.enum(["window", "content"]).default("window"), privacy: z.boolean().default(true),
  rect: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive().finite(), height: z.number().positive().finite() }).strict().optional()
}).strict();

export function createWindowCaptureService(getWindow: () => BrowserWindow | undefined) {
  let capturing = false;
  const requireWindow = (): BrowserWindow => {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error("Biny window is unavailable");
    return window;
  };
  const capture = async (input: unknown): Promise<WindowCaptureImage> => {
    const options = optionsSchema.parse(input);
    if (capturing) throw new Error("A window capture is already in progress");
    const window = requireWindow();
    const contents = window.webContents;
    const throttling = contents.getBackgroundThrottling();
    capturing = true;
    try {
      contents.setBackgroundThrottling(false);
      const surface = await contents.executeJavaScript(`(async () => {
        const style = document.createElement('style'); style.id = 'biny-capture-style';
        style.textContent = '[data-window-capture], [data-window-capture] * { visibility: hidden !important; } [data-window-capture]::backdrop { visibility: hidden !important; background: transparent !important; }' + ${JSON.stringify(options.scope === "content" ? ".biny-inspector-rail-zone, .biny-inspector-rail-zone * { visibility: hidden !important; }" : "")};
        document.head.append(style);
        const privacyRegions = [];
        const activeDialog = Array.from(document.querySelectorAll('dialog[open]:not([data-window-capture])')).at(-1);
        const titles = document.querySelectorAll('.biny-sidebar-session-title, .biny-thread-title-text');
        for (const title of titles) {
          const r = title.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.right < 0 || r.bottom < 0 || r.x >= innerWidth || r.y >= innerHeight || getComputedStyle(title).visibility === 'hidden') continue;
          if (activeDialog && !activeDialog.contains(title)) {
            const dialogRect = activeDialog.getBoundingClientRect();
            if (r.x + r.width > dialogRect.x && r.x < dialogRect.x + dialogRect.width && r.y + r.height > dialogRect.y && r.y < dialogRect.y + dialogRect.height) continue;
          }
          const hit = document.elementFromPoint?.(Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)));
          if (hit && hit !== title && !title.contains(hit)) continue;
          let background = '#202020';
          for (let parent = title; parent; parent = parent.parentElement) {
            const color = getComputedStyle(parent).backgroundColor;
            if (color.startsWith('rgb(') && !color.includes('/')) { background = color; break; }
          }
          privacyRegions.push({ x:r.x, y:r.y, width:r.width, height:r.height, background });
        }
        const target = ${JSON.stringify(options.scope)} === 'content'
          ? document.querySelector('.desktop-settings-dialog[open] .settings-content') || document.querySelector('.biny-chat-scroll')
          : document.documentElement;
        if (!target) throw new Error('No content region is available');
        const rect = target.getBoundingClientRect();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { rect: {x:rect.x,y:rect.y,width:rect.width,height:rect.height}, width:innerWidth, height:innerHeight, privacyRegions };
      })()`);
      // 后台窗口可能仍缓存旧布局；等一次真实重绘，确保区域坐标与像素属于同一画面。
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Window did not repaint for capture")), 3_000);
        const finish = (error?: Error): void => {
          clearTimeout(timer);
          if (!contents.isDestroyed()) contents.endFrameSubscription();
          if (error) reject(error); else resolve();
        };
        try { contents.beginFrameSubscription(false, () => finish()); contents.invalidate(); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      const region = captureRegion(options.rect ?? surface.rect, surface);
      const image = await contents.capturePage(region, { stayHidden: true, stayAwake: true });
      if (image.isEmpty()) throw new Error("Window capture returned an empty image");
      const size = image.getSize();
      const scaleX = size.width / region.width;
      const scaleY = size.height / region.height;
      const privacyRegions = surface.privacyRegions.map((item: { x: number; y: number; width: number; height: number; background: string }) => ({
        x: (item.x - region.x) * scaleX, y: (item.y - region.y) * scaleY,
        width: item.width * scaleX, height: item.height * scaleY, background: item.background
      }));
      let dataUrl = image.toDataURL();
      if (options.privacy && privacyRegions.length) {
        dataUrl = await contents.executeJavaScript(`(async () => {
          const source = new Image();
          source.src = ${JSON.stringify(dataUrl)};
          await source.decode();
          const canvas = document.createElement('canvas');
          canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Unable to redact capture');
          ctx.drawImage(source, 0, 0);
          (${drawCapturePrivacy.toString()})(ctx, ${JSON.stringify(privacyRegions)});
          return canvas.toDataURL('image/png');
        })()`);
      }
      return { dataUrl, ...size, privacyRegions };
    } finally {
      try {
        if (!contents.isDestroyed()) {
          try { await contents.executeJavaScript("document.getElementById('biny-capture-style')?.remove()"); }
          finally { if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttling); }
        }
      } finally { capturing = false; }
    }
  };
  const assertSender = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const window = requireWindow();
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Untrusted window capture sender");
    return window;
  };
  const decode = (value: unknown) => {
    const data = z.string().max(32 * 1024 * 1024).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).parse(value);
    const image = nativeImage.createFromDataURL(data);
    const size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 32_000_000) throw new Error("Invalid capture image");
    return image;
  };
  ipcMain.handle(windowCaptureIpc.capture, async (event, input: unknown) => { assertSender(event); return await capture(input); });
  ipcMain.handle(windowCaptureIpc.copy, (event, input: unknown) => { assertSender(event); clipboard.writeImage(decode(input)); });
  ipcMain.handle(windowCaptureIpc.save, async (event, input: unknown) => {
    const window = assertSender(event);
    const image = decode(input);
    const result = await dialog.showSaveDialog(window, { title: "保存窗口截图", defaultPath: `Biny-${Date.now()}.png`, filters: [{ name: "PNG 图片", extensions: ["png"] }] });
    if (result.canceled || !result.filePath) return undefined;
    await writeFile(result.filePath, image.toPNG());
    return result.filePath;
  });
  return {
    capture,
    exportFile: async (input: unknown) => {
      const args = z.object({ options: optionsSchema, outputPath: z.string().min(1) }).strict().parse(input);
      const image = await capture(args.options);
      await writeFile(args.outputPath, decode(image.dataUrl).toPNG(), { flag: "wx", mode: 0o600 });
      return { path: args.outputPath, width: image.width, height: image.height };
    },
    close: () => { for (const channel of Object.values(windowCaptureIpc)) ipcMain.removeHandler(channel); }
  };
}
