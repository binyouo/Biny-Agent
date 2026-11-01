export type CaptureScope = "window" | "content";
export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface WindowCaptureOptions { scope: CaptureScope; privacy: boolean; rect?: CaptureRect }
export interface CapturePrivacyRegion extends CaptureRect { background: string }
export interface WindowCaptureImage { dataUrl: string; width: number; height: number; privacyRegions: CapturePrivacyRegion[] }
export interface WindowCaptureApi {
  capture(options: WindowCaptureOptions): Promise<WindowCaptureImage>;
  save(dataUrl: string): Promise<string | undefined>;
  copy(dataUrl: string): Promise<void>;
}
export const windowCaptureIpc = { capture: "desktop:capture:image", save: "desktop:capture:save", copy: "desktop:capture:copy" } as const;

export function captureRegion(rect: CaptureRect, viewport: { width: number; height: number }): CaptureRect {
  if (![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) throw new Error("Invalid capture rectangle");
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  if (right <= x || bottom <= y) throw new Error("Capture region is not visible");
  return { x, y, width: right - x, height: bottom - y };
}

/** 预览和导出共用的像素遮盖；不依赖截图时的 DOM 样式或合成器帧。 */
export function drawCapturePrivacy(ctx: Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "beginPath" | "roundRect" | "fill"> & Partial<Pick<CanvasRenderingContext2D, "canvas" | "getImageData">>, regions: readonly CapturePrivacyRegion[], offsetX = 0, offsetY = 0): void {
  for (const region of regions) {
    const x = offsetX + region.x;
    const y = offsetY + region.y;
    ctx.fillStyle = region.background;
    if (ctx.getImageData && ctx.canvas && x >= 3 && y >= 0 && x < ctx.canvas.width && y + region.height / 2 < ctx.canvas.height) {
      const pixel = ctx.getImageData(Math.floor(x) - 2, Math.floor(y + region.height / 2), 1, 1).data;
      if (pixel[3] === 255) ctx.fillStyle = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
    }
    ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(region.width) + 1, Math.ceil(region.height) + 1);
    const barHeight = Math.max(3, region.height * .3);
    ctx.fillStyle = "#737780";
    ctx.beginPath(); ctx.roundRect(x, y + (region.height - barHeight) / 2, Math.min(region.width, region.height * 6), barHeight, barHeight / 2); ctx.fill();
  }
}
