/** 真实 Activity 宿主与截图入口验证无输入时的视觉轮询节流。 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-visual-idle-"));
const callbacks = new Map<number, () => void>();
let now = Date.now() + 60_000_000;
let desktopReads = 0;
const settings = { ...defaultActivitySettings, outputDirectory: path.join(root, "records"), ocrEnabled: false, browserPollIntervalMs: 0 };
const service = new ActivityRecorderService({
  agentDir: root,
  inputMonitorPath: undefined,
  configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
  now: () => now,
  readFrontmostBundle: async () => "test.editor.app",
  hasScreenRecordingPermission: async () => true,
  captureDesktopScreen: async () => { desktopReads++; return Buffer.from("jpeg"); },
  encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
  captureTimers: {
    setInterval: ((callback: () => void, ms: number) => {
      callbacks.set(ms, callback);
      return { unref() {} };
    }) as unknown as typeof setInterval,
    clearInterval: () => undefined
  }
});
const settle = async () => {
  for (let index = 0; index < 4; index++) await new Promise<void>(resolve => setImmediate(resolve));
};

try {
  await service.initialize();
  const tick = () => {
    const callback = callbacks.get(settings.visualPollMs);
    assert.ok(callback);
    callback();
    now += settings.visualPollMs;
  };
  for (let index = 0; index < 4; index++) { tick(); await settle(); }
  assert.equal(desktopReads, 0, "尚无输入的前四次视觉轮询应节流");
  tick();
  await settle();
  assert.equal(desktopReads, 2, "第五次视觉轮询尝试缩略图及完整截图");

  await service.stop();
  await service.initialize();
  desktopReads = 0;
  for (let index = 0; index < 4; index++) { tick(); await settle(); }
  assert.equal(desktopReads, 0, "重启后视觉轮询节流计数从头开始");
  tick();
  await settle();
  assert.equal(desktopReads, 2);
} finally {
  await service.stop();
  await rm(root, { recursive: true, force: true });
}
// 首次真实输入后，视觉轮询回到每个 tick 检查变化。
const activeRoot = await mkdtemp(path.join(os.tmpdir(), "biny-activity-visual-active-"));
const inputMonitorPath = path.join(activeRoot, "activity-input-monitor");
const activeNow = Date.now() + 60_000_000;
await writeFile(inputMonitorPath, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\ncreateInterface({input:process.stdin}).on('line', line => {const command=JSON.parse(line);if(command.type==='start'){console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));console.log(JSON.stringify({type:'event',eventType:'keypress',occurredAt:${JSON.stringify(new Date(activeNow).toISOString())},application:'Editor',bundleId:'test.editor.app',keyCode:65}));}if(command.type==='stop')process.exit(0)});\n`, { mode: 0o700 });
const activeCallbacks = new Map<number, () => void>();
let activeReads = 0;
const activeSettings = { ...settings, outputDirectory: path.join(activeRoot, "records") };
const activeService = new ActivityRecorderService({
  agentDir: activeRoot,
  inputMonitorPath,
  configStore: { load: async () => ({ ...defaultConfig, activity: activeSettings }) } as AgentConfigStore,
  now: () => activeNow,
  captureDesktopScreen: async () => { activeReads++; return Buffer.from("jpeg"); },
  encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
  captureTimers: {
    setInterval: ((callback: () => void, ms: number) => {
      activeCallbacks.set(ms, callback);
      return { unref() {} };
    }) as unknown as typeof setInterval,
    clearInterval: () => undefined
  }
});
try {
  await activeService.initialize();
  const deadline = Date.now() + 5_000;
  while (!activeService.snapshot().currentSessionId) {
    if (Date.now() > deadline) assert.fail("input fixture did not create a session");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  activeCallbacks.get(settings.visualPollMs)!();
  const captureDeadline = Date.now() + 5_000;
  while (activeReads < 2) {
    if (Date.now() > captureDeadline) assert.fail("recent input did not enable next visual poll");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  assert.equal(activeReads, 2);
} finally {
  await activeService.stop();
  await rm(activeRoot, { recursive: true, force: true });
}
console.log("activity visual idle tests passed");
