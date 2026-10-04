import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { desktopCaptureSchedule } from "../src/computer/captureSchedule.js";
import type { AgentConfigStore } from "../src/config/store.js";

const root = await mkdtemp("/tmp/biny-native-activity-privacy-");
let entered!: () => void; let release!: () => void;
let hold: Promise<void> | undefined;
const settings = { ...defaultActivitySettings, enabled: true, captureDebounceMs: 0, outputDirectory: path.join(root, "records"), ocrEnabled: false };
const service = new ActivityRecorderService({ agentDir: root, inputMonitorPath: undefined,
  configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
  readFrontmostBundle: async () => "fixture.allowed", hasScreenRecordingPermission: async () => true,
  captureDesktopScreen: async () => { entered(); await hold; return Buffer.from("fixture-private-preview"); },
  encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) })
});
// Await the real service capture and its queue, avoiding timing guesses about SQLite visibility.
const fixture = service as unknown as { capture(trigger: string): Promise<void> };
let closePreview: (() => void) | undefined;
try {
  await service.initialize();
  for (const reopen of [false, true]) {
    const reached = new Promise<void>(resolve => { entered = resolve; });
    hold = new Promise<void>(resolve => { release = resolve; });
    const pending = fixture.capture("heartbeat"); await reached;
    closePreview = desktopCaptureSchedule.retainPreview();
    if (reopen) { closePreview(); closePreview = desktopCaptureSchedule.retainPreview(); closePreview(); closePreview = undefined; }
    release(); await pending;
    assert.equal(service.snapshot().fallbackCaptures, 0, "late frame must not reach Activity DB/OCR, including a closed-and-reopened preview");
    assert.equal((await readdir(path.join(root, "records"), { recursive: true })).some(file => String(file).endsWith(".jpg")), false);
    closePreview?.(); closePreview = undefined;
  }
  entered = () => undefined; hold = undefined;
  await fixture.capture("heartbeat");
  assert.equal(service.snapshot().fallbackCaptures, 1, "closing preview restores the original passive recorder");
  console.log("PASS Activity late frame never persisted across PiP privacy epochs; normal capture resumes");
} finally { closePreview?.(); await service.stop(); await rm(root, { recursive: true, force: true }); }
