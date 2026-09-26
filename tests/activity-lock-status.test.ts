/** 真实输入子进程与 SQLite 验证外部锁屏优先于晚到的状态报文。 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-lock-status-"));
const inputMonitorPath = path.join(root, "activity-input-monitor");
await writeFile(inputMonitorPath, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\ncreateInterface({input:process.stdin}).on('line', line => { const command = JSON.parse(line); if (command.type === 'start') { console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true,screenLocked:false,currentApplication:'First'})); setTimeout(() => console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true,screenLocked:false,currentApplication:'Late'})), 60); } if (command.type === 'stop') process.exit(0); });\n`, {mode: 0o700});
const callbacks = new Map<number, () => void>();
const settings = {...defaultActivitySettings, outputDirectory: path.join(root, "records"), captureDebounceMs: 0};
const service = new ActivityRecorderService({
  agentDir: root,
  inputMonitorPath,
  configStore: {load: async () => ({...defaultConfig, activity: settings})} as AgentConfigStore,
  captureDesktopScreen: async () => Buffer.from("jpeg"),
  encodeFrame: async jpeg => ({jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255])}),
  captureTimers: {
    setInterval: ((callback: () => void, ms: number) => { callbacks.set(ms, callback); return {unref() {}}; }) as unknown as typeof setInterval,
    clearInterval: () => undefined
  }
});
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("lock status fixture timed out");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
};
let database: DatabaseSync | undefined;
try {
  await service.initialize();
  database = new DatabaseSync(path.join(root, "agent.sqlite"));
  const snapshots = () => Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n);
  await waitFor(() => service.snapshot().currentApplication === "First");
  service.handlePowerEvent("lock-screen");
  await waitFor(() => service.snapshot().currentApplication === "Late");
  assert.equal(service.snapshot().screenLocked, true, "晚到状态不能覆盖 Electron 锁屏");
  callbacks.get(settings.heartbeatMs)!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(snapshots(), 0);
  service.handlePowerEvent("unlock-screen");
  await waitFor(() => !service.snapshot().screenLocked);
  callbacks.get(settings.heartbeatMs)!();
  await waitFor(() => snapshots() === 1);
} finally {
  await service.stop();
  database?.close();
  await rm(root, {recursive: true, force: true});
}
console.log("activity lock status tests passed");
