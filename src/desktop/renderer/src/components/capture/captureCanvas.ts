import { drawCapturePrivacy, type CaptureRect, type CapturePrivacyRegion } from "../../../../windowCapture.js";
export const captureBackgrounds = [
  { value: "mist", label: "雾蓝", colors: ["#d9e1ed", "#8397a6"] },
  { value: "dusk", label: "暮色", colors: ["#b0a6d4", "#50678d"] },
  { value: "sand", label: "暖沙", colors: ["#e5d1b7", "#b18f80"] },
  { value: "#f2f2f2", label: "浅灰" },
  { value: "#24262b", label: "深灰" },
  { value: "transparent", label: "透明" }
] as const;
export interface CaptureComposition { privacyRegions?: CapturePrivacyRegion[]; crop: CaptureRect; regions: CaptureRect[]; padding: number; background: string; shadow: boolean }

export function composeCapture(image: HTMLImageElement, options: CaptureComposition): HTMLCanvasElement {
  const { crop, regions, padding, background, shadow, privacyRegions = [] } = options;
  const canvas = document.createElement("canvas");
  canvas.width = crop.width + padding * 2;
  canvas.height = crop.height + padding * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建截图画布");
  if (background !== "transparent") {
    const preset = captureBackgrounds.find(item => item.value === background);
    if (preset && "colors" in preset) {
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, preset.colors[0]); gradient.addColorStop(1, preset.colors[1]); ctx.fillStyle = gradient;
    } else ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.save();
  if (shadow && padding > 0) { ctx.shadowColor = "rgba(0,0,0,.3)"; ctx.shadowBlur = padding / 2; ctx.shadowOffsetY = padding / 5; }
  ctx.fillStyle = "#202020";
  ctx.beginPath(); ctx.roundRect(padding, padding, crop.width, crop.height, 12); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.roundRect(padding, padding, crop.width, crop.height, 12); ctx.clip();
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, padding, padding, crop.width, crop.height);
  drawCapturePrivacy(ctx, privacyRegions, padding - crop.x, padding - crop.y);
  // 遮盖直接写入导出位图，不依赖预览层或可移除的网页样式。
  ctx.fillStyle = "#252525";
  for (const region of regions) ctx.fillRect(padding + region.x - crop.x, padding + region.y - crop.y, region.width, region.height);
  ctx.restore();
  return canvas;
}
