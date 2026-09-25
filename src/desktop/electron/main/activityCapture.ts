/** ScreenCaptureKit 失败时的桌面备用截图；只传本机内存，不落临时图、不请求额外权限。 */
import { desktopCapturer, screen, systemPreferences } from "electron";

export async function captureActivityDesktopScreen(maxWidth: number): Promise<Buffer> {
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") throw new Error("未获屏幕录制权限。");
  const display = screen.getPrimaryDisplay();
  const width = Math.min(maxWidth, Math.round(display.size.width * display.scaleFactor));
  const height = Math.max(1, Math.round(width * display.size.height / display.size.width));
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const source = sources.find((item) => item.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error("无法读取主屏幕画面。");
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") throw new Error("屏幕录制权限已撤回。");
  return source.thumbnail.toPNG();
}

/** 图像处理留在 Electron 主进程，采集与分层压缩使用同一个 nativeImage 实现。 */
export async function encodeActivityFrame(bytes: Buffer, quality: number): Promise<import("../../../activity/captureEngine.js").ActivityFrame> {
  const { nativeImage } = await import("electron");
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("截图图像为空");
  const size = image.getSize();
  return { jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : image.toJPEG(quality), ...size, pixels: image.resize({ width: 160, height: 90 }).toBitmap() };
}

export async function recompressActivitySnapshot(file: string, target: { width: number; height: number; quality: number }): Promise<{ data: Buffer; width: number; height: number }> {
  const { nativeImage } = await import("electron");
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error("截图图像无法读取");
  const size = image.getSize();
  const ratio = Math.min(1, target.width / size.width, target.height / size.height);
  const resized = image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: "good" });
  return { data: resized.toJPEG(target.quality), ...resized.getSize() };
}
