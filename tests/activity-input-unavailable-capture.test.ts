/** 输入监听缺失时，独立权限与前台检查保护截图降级链路。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-no-input-"));
const callbacks = new Map<number, () => void>();
let frontmost: string | undefined = "test.editor.app";
let permission = true;
let foregroundFails = false;
let frontmostReads = 0;
let holdDesktop: (() => Promise<void>) | undefined;
const settings = {
  ...defaultActivitySettings,
  outputDirectory: path.join(root, "records"),
  captureDebounceMs: 0,
  ocrEnabled: false,
  sensitiveApplications: ["test.private.app"]
};
const service = new ActivityRecorderService({
  agentDir: root,
  inputMonitorPath: path.join(root, "missing-activity-input-monitor"),
  configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
  readFrontmostBundle: async () => {
    frontmostReads++;
    if (foregroundFails) throw new Error("frontmost lookup failed");
    return frontmost;
  },
  hasScreenRecordingPermission: async () => permission,
  captureDesktopScreen: async () => {
    if (holdDesktop) await holdDesktop();
    return Buffer.from("desktop-jpeg");
  },
  encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
  captureTimers: {
    setInterval: ((callback: () => void, ms: number) => { callbacks.set(ms, callback); return { unref() {} }; }) as unknown as typeof setInterval,
    clearInterval: () => undefined
  }
});
let database: DatabaseSync | undefined;
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("input-unavailable capture did not reach expected persisted state");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};
try {
  await service.initialize();
  database = new DatabaseSync(path.join(root, "agent.sqlite"));
  const snapshots = () => Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n);
  const heartbeat = callbacks.get(settings.heartbeatMs);
  assert.ok(heartbeat, "截图心跳不应依赖输入监听可执行文件");
  heartbeat();
  await waitFor(() => snapshots() === 1);
  await waitFor(() => /仅屏幕截图/u.test(service.snapshot().error ?? ""));
  assert.equal(service.snapshot().state, "error", "缺失输入监听应显示降级，而非完整运行");
  assert.match(service.snapshot().error ?? "", /仅屏幕截图/u);
  assert.equal(service.snapshot().screenRecordingGranted, true);

  const lockedSessionId = service.snapshot().currentSessionId;
  assert.ok(lockedSessionId);
  service.handlePowerEvent("lock-screen");
  await waitFor(() => service.snapshot().screenLocked && service.snapshot().currentSessionId === undefined);
  const lockEvents = database.prepare("SELECT data FROM activity_events WHERE session_id=? AND kind='lock'").all(lockedSessionId);
  assert.equal(lockEvents.length, 1, "powerMonitor lock must persist before ending a screenshot session");
  assert.equal((JSON.parse(String(lockEvents[0]!.data)) as {via?: string}).via, "powerMonitor");
  assert.ok(database.prepare("SELECT ended_at FROM activity_sessions WHERE id=?").get(lockedSessionId)?.ended_at);
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots(), 1);
  service.handlePowerEvent("unlock-screen");

  permission = false;
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots(), 1, "撤销屏幕权限后不能继续截图");
  assert.equal(service.snapshot().screenRecordingGranted, false);
  permission = true;
  frontmost = "test.private.app";
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots(), 1, "敏感前台不能被无输入监听的降级路径绕过");
  frontmost = undefined;
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots(), 1, "前台 bundle 未知时 fail closed");
  foregroundFails = true;
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots(), 1, "前台查询失败时 fail closed");
  foregroundFails = false;
  frontmost = "test.editor.app";
  heartbeat();
  await waitFor(() => snapshots() === 2);

  let desktopEntered = false;
  let releaseDesktop!: () => void;
  const desktopRelease = new Promise<void>(resolve => { releaseDesktop = resolve; });
  holdDesktop = async () => { desktopEntered = true; await desktopRelease; };
  // SQLite 行可先于上一轮 capture 的 finally 可见；重试心跳直到新帧真正进入截图入口。
  await waitFor(() => { if (!desktopEntered) heartbeat(); return desktopEntered; });
  const readsBeforeRelease = frontmostReads;
  frontmost = "test.private.app";
  releaseDesktop();
  await waitFor(() => frontmostReads > readsBeforeRelease);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(snapshots(), 2, "帧采集期间切入敏感应用必须丢弃晚到的截图");

  await service.stop();
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots(), 2);
} finally {
  await service.stop();
  database?.close();
  await rm(root, { recursive: true, force: true });
}

console.log("activity missing input capture tests passed");
