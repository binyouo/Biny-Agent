import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { ComputerPreviewSurface, type PreviewWindow } from "../src/computer/previewSurface.js";
import { CaptureSchedule, CaptureBusyError } from "../src/computer/captureSchedule.js";

class FixtureWindow extends EventEmitter implements PreviewWindow {
  destroyed = false;
  loading = false;
  rejectDestroy = false;
  paints: string[] = [];
  contents = new EventEmitter();
  webContents = {
    setWindowOpenHandler: () => undefined,
    on: (_event: "will-navigate", _handler: (event: { preventDefault(): void }, url: string) => void) => undefined,
    once: (_event: "did-finish-load", callback: () => void) => this.contents.once("did-finish-load", callback),
    isLoading: () => this.loading,
    executeJavaScript: async (script: string) => { this.paints.push(script); }
  };
  isDestroyed(): boolean { return this.destroyed; }
  showInactive(): void { assert.equal(this.destroyed, false); }
  async loadURL(): Promise<void> {}
  destroy(): void { if (this.rejectDestroy) throw new Error("fixture destroy failed"); this.destroyed = true; this.emit("closed"); }
}
const status = { state: "ready", preview: true, foregroundAllowed: false, lastOutcome: "not-dispatched" } as const;
const frame = { image: { mimeType: "image/png", dataBase64: "aGVsbG8=" }, target: { pid: 42, windowId: "900" }, capturedAt: 0 } as const;
test("preview closed event releases privacy hold; reopen drops old paint and retains new hold", async () => {
  let now = 0; const schedule = new CaptureSchedule(() => now); const windows: FixtureWindow[] = [];
  let closed = 0;
  const preview = new ComputerPreviewSurface(() => { const window = new FixtureWindow(); windows.push(window); return window; }, "fixture", () => undefined, () => { closed++; }, schedule);
  preview.open(); preview.open(); assert.equal(windows.length, 1);
  const first = windows[0]!; first.loading = true;
  preview.update(frame, status); now = 100_000;
  await assert.rejects(schedule.run("activity", async () => Buffer.from("private")), CaptureBusyError);
  first.destroy(); assert.equal(closed, 1);
  assert.equal(await schedule.run("activity", async () => "allowed"), "allowed");
  preview.open(); const second = windows[1]!;
  first.contents.emit("did-finish-load"); assert.deepEqual(first.paints, []); assert.deepEqual(second.paints, []);
  preview.update(frame, status); assert.match(second.paints[0]!, /aGVsbG8=/);
  await assert.rejects(schedule.run("activity", async () => "private"), CaptureBusyError);
  preview.close(); assert.equal(closed, 2); assert.equal(await schedule.run("activity", async () => "allowed"), "allowed");
});
test("failed preview destruction retains the privacy hold", async () => {
  const schedule = new CaptureSchedule(); const window = new FixtureWindow();
  const preview = new ComputerPreviewSurface(() => window, "fixture", () => undefined, () => undefined, schedule);
  preview.open(); window.rejectDestroy = true;
  assert.throws(() => preview.close(), /destroy failed/);
  await assert.rejects(schedule.run("activity", async () => "private"), CaptureBusyError);
  window.rejectDestroy = false; preview.close(); assert.equal(await schedule.run("activity", async () => "allowed"), "allowed");
});
