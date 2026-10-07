import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { ComputerPreviewSurface, type PreviewWindow } from "../src/computer/previewSurface.js";
import { CaptureSchedule, CaptureBusyError } from "../src/computer/captureSchedule.js";

class FixtureWindow extends EventEmitter implements PreviewWindow {
  destroyed = false;
  loading = false;
  rejectDestroy = false;
  presentations = 0;
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
  showInactive(): void { assert.equal(this.destroyed, false); this.presentations++; }
  private rect = { x: 100, y: 100, width: 480, height: 400 };
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void { this.rect = { ...bounds }; }
  getBounds(): { x: number; y: number; width: number; height: number } { return { ...this.rect }; }
  async loadURL(): Promise<void> {}
  destroy(): void { if (this.rejectDestroy) throw new Error("fixture destroy failed"); this.destroyed = true; this.emit("closed"); }
}
const status = { state: "ready", preview: true, foregroundAllowed: false, lastOutcome: "not-dispatched" } as const;
const frame = { image: { mimeType: "image/png", dataBase64: "aGVsbG8=" }, target: { pid: 42, windowId: "900" }, capturedAt: 0 } as const;
test("refreshing preview pixels never re-presents a window the user has put behind another app", () => {
  const window = new FixtureWindow();
  const surface = new ComputerPreviewSurface(() => window, "fixture", () => undefined, () => undefined, new CaptureSchedule());
  try {
    surface.present({ id: "computer", label: "电脑", frame, status });
    window.emit("ready-to-show");
    assert.equal(window.presentations, 1);
    surface.present({ id: "computer", label: "电脑", frame: { ...frame, capturedAt: 10 }, status });
    surface.present({ id: "browser:tab", label: "浏览器", frame, status });
    surface.select("browser:tab");
    assert.equal(window.presentations, 1, "frame-only tests did not catch repeated showInactive raising the preview on each refresh");
    assert.match(window.paints.at(-2)!, /aGVsbG8=/);
  } finally { surface.close(); }
});
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
  preview.close(); assert.equal(closed, 1); assert.equal(await schedule.run("activity", async () => "allowed"), "allowed");
});
test("failed preview destruction retains the privacy hold", async () => {
  const schedule = new CaptureSchedule(); const window = new FixtureWindow();
  const preview = new ComputerPreviewSurface(() => window, "fixture", () => undefined, () => undefined, schedule);
  preview.open(); window.rejectDestroy = true;
  assert.throws(() => preview.close(), /destroy failed/);
  await assert.rejects(schedule.run("activity", async () => "private"), CaptureBusyError);
  window.rejectDestroy = false; preview.close(); assert.equal(await schedule.run("activity", async () => "allowed"), "allowed");
});

// Alma 设计：PiP 是 3fps 的「可注视」画面，而非仅在动作后刷新一帧。
test("preview drives a repeating 3fps refresh and stops when disabled", async () => {
  let refreshes = 0;
  const driver = {
    start: async () => {}, stop: async () => {},
    list: async () => ({ data: { apps: [] }, images: [] }),
    observe: async () => ({ data: {}, images: [] }),
    act: async () => ({ data: {}, images: [] }),
  };
  const { ComputerUseController } = await import("../src/computer/controller.js");
  const controller = new ComputerUseController(driver as never, {
    enabled: true,
    refreshPreview: async () => { refreshes += 1; }
  });
  controller.setPreview(true);
  await new Promise(resolve => setTimeout(resolve, 360));
  controller.setPreview(false);
  const afterStop = refreshes;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(refreshes >= 1, `frame pump should fire at least once, got ${refreshes}`);
  assert.equal(refreshes, afterStop, "frame pump must stop once preview is disabled");
});

// PiP 是常驻置顶的，挡到东西时必须能挪开（参照有 pip/move，state 也返回 bounds）。
// 而窗口每次打开都重建 —— 不记住位置，用户挪一次、下次又跳回原点。
test("the preview window can be moved, and reopens where it was left", () => {
  const windows: FixtureWindow[] = [];
  const preview = new ComputerPreviewSurface(() => { const window = new FixtureWindow(); windows.push(window); return window; }, "fixture", () => undefined, () => undefined, new CaptureSchedule(() => 0));

  preview.open();
  // 用户拖到别处
  assert.deepEqual(preview.move(320, 180), { x: 320, y: 180, width: 480, height: 400 });
  assert.deepEqual(preview.bounds(), { x: 320, y: 180, width: 480, height: 400 });

  // 关掉再开：新窗口应当落在上次那个位置，而不是回到原点
  preview.close();
  preview.open();
  assert.deepEqual(windows.at(-1)!.getBounds(), { x: 320, y: 180, width: 480, height: 400 }, "重开的浮窗要回到用户放的地方");

  // 没给坐标的 move 也用记住的位置（参照 pip/move 允许只更新其一）
  assert.deepEqual(preview.move(400, undefined), { x: 400, y: 180, width: 480, height: 400 });
  preview.close();
});

test("layout records every move and resize through the persistent store", () => {
  let persisted: { x: number; y: number; width: number; height: number } | undefined;
  const windows: FixtureWindow[] = [];
  const preview = new ComputerPreviewSurface(() => { const window = new FixtureWindow(); windows.push(window); return window; }, "fixture", () => undefined, () => undefined, new CaptureSchedule(), { layout: { load: () => persisted, save: value => { persisted = value; } } });
  preview.open(); const first = windows[0]!;
  first.setBounds({ x: 200, y: 300, width: 480, height: 400 }); first.emit("moved");
  first.setBounds({ x: 400, y: 500, width: 640, height: 480 }); first.emit("moved"); first.emit("resized");
  preview.close();
  const recreated = new ComputerPreviewSurface(() => { const window = new FixtureWindow(); windows.push(window); return window; }, "fixture", () => undefined, () => undefined, new CaptureSchedule(), { layout: { load: () => persisted, save: value => { persisted = value; } } });
  recreated.open(); assert.deepEqual(windows[1]!.getBounds(), { x: 400, y: 500, width: 640, height: 480 }); recreated.close();
});

test("browser and window frames share one surface and close independently", async () => {
  const windows: FixtureWindow[] = []; let closed = 0;
  const surface = new ComputerPreviewSurface(() => { const window = new FixtureWindow(); windows.push(window); return window; }, "fixture", () => undefined, () => undefined, new CaptureSchedule());
  surface.present({ id: "computer", label: "Notes", frame, status, onClose: () => { closed++; } });
  surface.present({ id: "browser", label: "Browser", frame: { ...frame, image: { mimeType: "image/png", dataBase64: "YnJvd3Nlcg==" } }, status });
  assert.equal(windows.length, 1); surface.select("browser"); assert.equal(surface.activeItem(), "browser");
  assert.match(windows[0]!.paints.slice(-2).join("\n"), /YnJvd3Nlcg==/);
  surface.remove("computer"); assert.equal(windows[0]!.isDestroyed(), false); assert.equal(closed, 0);
  surface.remove("browser"); assert.equal(windows[0]!.isDestroyed(), true);
});
