import { drawCapturePrivacy, type CaptureRect, type CapturePrivacyRegion } from "../../../../windowCapture.js";
export const captureBackgrounds = [
  { value: "sea", label: "海岸", src: "./capture-backgrounds/sea.jpg" },
  { value: "canyon", label: "峡谷", src: "./capture-backgrounds/canyon.jpg" },
  { value: "highland", label: "山野", src: "./capture-backgrounds/highland.jpg" },
  { value: "forest", label: "薄雾", src: "./capture-backgrounds/mist.jpg" },
  { value: "ocean", label: "地球", src: "./capture-backgrounds/ocean.jpg" },
  { value: "mist", label: "银灰", colors: ["#eef0f3", "#cbd4e1"] },
  { value: "azure", label: "蔚蓝", colors: ["#638ae1", "#123aa4"] },
  { value: "indigo", label: "靛青", colors: ["#7962bf", "#241958"] },
  { value: "ember", label: "暖橙", colors: ["#e3b68a", "#a84e4b"] },
  { value: "graphite", label: "石墨", colors: ["#4c525b", "#20242a"] }
] as const;
export interface CaptureComposition { privacyRegions?: CapturePrivacyRegion[]; crop: CaptureRect; regions: CaptureRect[]; padding: number; background: string; backgroundImage?: HTMLImageElement; shadow: boolean }

export async function loadCaptureImage(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve(); image.onerror = () => reject(new Error("图片读取失败")); image.src = source;
  });
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32_000_000) throw new Error("图片尺寸无效或超过 3200 万像素");
  return image;
}

export function composeCapture(image: HTMLImageElement, options: CaptureComposition): HTMLCanvasElement {
  const { crop, regions, padding, background, backgroundImage, shadow, privacyRegions = [] } = options;
  const canvas = document.createElement("canvas");
  canvas.width = crop.width + padding * 2;
  canvas.height = crop.height + padding * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建截图画布");
  if (background !== "transparent") {
    const preset = captureBackgrounds.find(item => item.value === background);
    if (backgroundImage) {
      const scale = Math.max(canvas.width / backgroundImage.naturalWidth, canvas.height / backgroundImage.naturalHeight);
      const width = canvas.width / scale;
      const height = canvas.height / scale;
      ctx.drawImage(backgroundImage, (backgroundImage.naturalWidth - width) / 2, (backgroundImage.naturalHeight - height) / 2, width, height, 0, 0, canvas.width, canvas.height);
    } else if (preset && "colors" in preset) {
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, preset.colors[0]); gradient.addColorStop(1, preset.colors[1]); ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      if (!/^#[0-9a-f]{6}$/i.test(background)) throw new Error("背景图片尚未就绪");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
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
