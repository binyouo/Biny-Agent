/** Shared admission only. Passive Activity images never become native observations. */
import { readNativeMirrorPrivacy, type NativeMirrorPrivacy } from "./nativeMirrorPrivacy.js";
export class CaptureBusyError extends Error { constructor() { super("computer_capture_busy"); } }
export class CaptureSchedule {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;
  private previews = 0;
  private privacyEpoch = 0;
  private lastActive = -Infinity;
  private readonly now: () => number;
  constructor(now: () => number = Date.now, private readonly nativePrivacy: () => Promise<NativeMirrorPrivacy> = readNativeMirrorPrivacy) { this.now = now; }
  /** A visible preview can re-expose a filtered window in an otherwise allowed display capture. */
  retainPreview(): () => void {
    this.previews++; this.privacyEpoch++;
    let released = false;
    return () => { if (!released) { released = true; this.previews--; this.privacyEpoch++; } };
  }
  activityEpoch(): number { return this.privacyEpoch; }
  canPersistActivity(epoch: number): boolean { return this.previews === 0 && epoch === this.privacyEpoch; }
  async run<T>(kind: "active" | "activity", operation: () => Promise<T>): Promise<T> {
    if (kind === "activity" && (this.previews > 0 || this.active > 0 || this.now() - this.lastActive < 1500)) throw new CaptureBusyError();
    if (kind === "active") this.active++;
    const epoch = this.privacyEpoch;
    const run = this.tail.then(async () => {
      if (kind === "activity" && (this.previews > 0 || this.active > 0)) throw new CaptureBusyError();
      const native = kind === "activity" ? await this.nativePrivacy() : undefined;
      if (native?.active) throw new CaptureBusyError();
      const result = await operation();
      if (kind === "activity" && !this.canPersistActivity(epoch)) throw new CaptureBusyError();
      if (native) {
        const after = await this.nativePrivacy();
        if (after.active || after.epoch !== native.epoch) throw new CaptureBusyError();
      }
      return result;
    });
    this.tail = run.then(() => undefined, () => undefined);
    try { return await run; }
    finally { if (kind === "active") { this.active--; this.lastActive = this.now(); } }
  }
}
export const desktopCaptureSchedule = new CaptureSchedule();
