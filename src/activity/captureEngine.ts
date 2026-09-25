/** 主进程截图选择和变化检测。 */
import type { ActivitySettings } from "./settings.js";
export interface ActivityFrame { jpeg: Buffer; width: number; height: number; pixels: Buffer; contentHash?: string; histogramChange?: number; pixelDiff?: number }
export interface ActivityCaptureDependencies {
  now?(): number;
  native(maxWidth: number, quality: number): Promise<Buffer>;
  desktop(maxWidth: number): Promise<Buffer>;
  frame(bytes: Buffer, quality: number): Promise<ActivityFrame>;
}
export class ActivityCaptureEngine {
  private nativeFailed = false;
  private previous?: { pixels: Buffer; hash: number; histogram: number[] };
  private lastAttempt = -Infinity;
  private nextAllowedAt = 0;
  private failures = 0;
  constructor(private readonly deps: ActivityCaptureDependencies) { }
  restart(): void { this.nativeFailed = false; this.lastAttempt = -Infinity; this.nextAllowedAt = 0; this.failures = 0; this.resetBaseline(); }
  get lastAttemptAt(): number { return this.lastAttempt; }
  resetBaseline(): void { this.previous = undefined; }
  async capture(settings: ActivitySettings, trigger: string): Promise<ActivityFrame | undefined> {
    const now = this.deps.now?.() ?? Date.now();
    if (now < this.nextAllowedAt || now - this.lastAttempt < settings.captureDebounceMs) return undefined;
    this.lastAttempt = now;
    try { return await this.captureFrame(settings, trigger); }
    catch (error) {
      this.failures = Math.min(this.failures + 1, 16);
      this.nextAllowedAt = now + Math.min(30000, 500 * 2 ** (this.failures - 1));
      throw error;
    }
  }
  private async readFrame(settings: ActivitySettings, compareOnly: boolean): Promise<ActivityFrame> {
    let bytes: Buffer | undefined;
    const width = compareOnly ? 160 : 2560;
    const quality = compareOnly ? 40 : settings.jpegQuality;
    if (!this.nativeFailed) {
      try { bytes = await this.deps.native(width, quality); }
      catch { this.nativeFailed = true; }
    }
    bytes ??= await this.deps.desktop(width);
    const frame = await this.deps.frame(bytes, quality);
    this.failures = 0; this.nextAllowedAt = 0;
    return frame;
  }
  private async captureFrame(settings: ActivitySettings, trigger: string): Promise<ActivityFrame | undefined> {
    let frame = await this.readFrame(settings, trigger === "visual_change");
    let hash = 2166136261;
    const histogram = Array<number>(32).fill(0);
    for (let i = 0;i < frame.pixels.length;i += 4) {
      const luminance = (77 * frame.pixels[i]! + 150 * frame.pixels[i + 1]! + 29 * frame.pixels[i + 2]!) >>> 8;
      hash = Math.imul(hash ^ luminance, 16777619) >>> 0;
      histogram[Math.min(31, luminance >>> 3)]! += 4 / frame.pixels.length;
    }
    const before = this.previous;
    let histogramChange: number | undefined;
    let pixelDiff: number | undefined;
    if (before && before.pixels.length === frame.pixels.length) {
      if (before.hash === hash) {
        if (trigger !== "heartbeat") return undefined;
        histogramChange = 0; pixelDiff = 0;
      } else {
        histogramChange = Math.sqrt(histogram.reduce((sum, value, i) => sum + (Math.sqrt(value) - Math.sqrt(before.histogram[i]!)) ** 2, 0)) / Math.sqrt(2);
        if (histogramChange < settings.histogramChangeThreshold) {
          let changed = 0;
          for (let i = 0;i < frame.pixels.length;i += 4) {
            if ([0, 1, 2].some(channel => Math.abs(frame.pixels[i + channel]! - before.pixels[i + channel]!) > settings.pixelTolerance)) changed++;
          }
          pixelDiff = changed / (frame.pixels.length / 4);
          if (pixelDiff < settings.pixelDiffThreshold && trigger !== "heartbeat") return undefined;
        }
      }
    }
    const baseline = { pixels: frame.pixels, hash, histogram };
    if (trigger === "visual_change") frame = await this.readFrame(settings, false);
    this.previous = baseline;
    return { ...frame, contentHash: hash.toString(16).padStart(8, "0"), histogramChange, pixelDiff };
  }
}
