export type CaptureScope = "window" | "content";
export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface WindowCaptureOptions { scope: CaptureScope; privacy: boolean; rect?: CaptureRect }
/** kind 为区域来源：title 是会话标题文字，手动补充的遮盖走 regions 不经这里。 */
export interface CapturePrivacyRegion extends CaptureRect { kind: "title" | "account" }
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
export function drawCapturePrivacy(ctx: Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "beginPath" | "roundRect" | "fill" | "getImageData" | "putImageData" | "canvas">, regions: readonly CapturePrivacyRegion[], offsetX = 0, offsetY = 0): void {
  const titles = regions.filter(function (region) { return region.kind === "title"; });
  const others = regions.filter(function (region) { return region.kind !== "title"; });
  // 标题行高随截屏时各行的布局上下浮动，逐块保留会把差异画出来；按中位数归一。
  const heights = titles.map(function (region) { return region.height; }).sort(function (a, b) { return a - b; });
  const lineHeight = heights[Math.floor(heights.length / 2)] || 1;
  for (const region of titles) {
    const height = Math.min(lineHeight * 1.2, Math.max(lineHeight * .8, region.height));
    const x = offsetX + region.x;
    const y = offsetY + region.y + (region.height - height) / 2;
    ctx.fillStyle = "#202329";
    ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(region.width) + 1, Math.ceil(height) + 1);
    const barHeight = Math.max(3, height * .3);
    ctx.fillStyle = "#737780";
    ctx.beginPath(); ctx.roundRect(x, y + (height - barHeight) / 2, Math.min(region.width, height * 6), barHeight, barHeight / 2); ctx.fill();
  }
  // 邮箱区域使用像素模糊；像素不可读时直接遮盖。
  for (const region of others) {
    const x = offsetX + region.x;
    const y = offsetY + region.y;
    const w = Math.ceil(region.width) + 1;
    const h = Math.ceil(region.height) + 1;
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    const width = Math.min(ctx.canvas.width - sx, w);
    const height = Math.min(ctx.canvas.height - sy, h);
    if (width <= 0 || height <= 0) continue;
    try {
      const data = ctx.getImageData(sx, sy, width, height);
      const src = data.data;
      const out = new Uint8ClampedArray(src.length);
      const radius = Math.max(2, Math.round(Math.min(width, height) * .18));
      const weight = 2 * radius + 1;
      // 水平、垂直两次一维盒式模糊，接近高斯且成本只随半径线性增长。
      for (let pass = 0; pass < 2; pass++) {
        const input = pass === 0 ? src : out;
        const target = pass === 0 ? out : src;
        for (let row = 0; row < height; row++) {
          for (let col = 0; col < width; col++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = -radius; k <= radius; k++) {
              const xx = pass === 0 ? Math.min(width - 1, Math.max(0, col + k)) : col;
              const yy = pass === 0 ? row : Math.min(height - 1, Math.max(0, row + k));
              const i = (yy * width + xx) * 4;
              r += input[i]!; g += input[i + 1]!; b += input[i + 2]!; a += input[i + 3]!;
            }
            const i = (row * width + col) * 4;
            target[i] = r / weight; target[i + 1] = g / weight; target[i + 2] = b / weight; target[i + 3] = a / weight;
          }
        }
      }
      ctx.putImageData(data, sx, sy);
    } catch {
      // getImageData 不可用时退化为实底遮盖，不暴露原文。
      ctx.fillStyle = "#202329";
      ctx.fillRect(Math.floor(x), Math.floor(y), w, h);
    }
  }
}
