/** Desktop 采集宿主经认证 REST 复用真实配置与运行态。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { startActivityHttpEndpoint } from "../src/activity/httpEndpoint.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { createDesktopActivityHttpDependencies } from "../src/desktop/electron/main/activityHttpApi.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-desktop-http-"));
const configStore = createFileConfigStore(root, { globalDir: root });
const activity = new ActivityRecorderService({ agentDir: root, configStore, inputMonitorPath: undefined });
const openedPanes: string[] = [];
let screenRecording: "denied" | "granted" = "denied";
let accessibility = false;
let permissionError = false;
let endpoint: Awaited<ReturnType<typeof startActivityHttpEndpoint>> | undefined;
try {
  await configStore.save({ ...defaultConfig, activity: { ...defaultActivitySettings, enabled: false, outputDirectory: path.join(root, "snapshots") } });
  await activity.initialize();
  endpoint = await startActivityHttpEndpoint(createDesktopActivityHttpDependencies({
    agentDir: root, activity, configStore, openPermissions: async (pane) => { openedPanes.push(pane); },
    getPermissions: () => {
      if (permissionError) throw new Error("permission reader unavailable");
      return { platform: "darwin", screenRecording, accessibility, openSettingsCapable: true };
    }
  }));
  const { host, port, token } = JSON.parse(await readFile(endpoint.discoveryPath, "utf8")) as { host: string; port: number; token: string };
  const call = async (route: string, init: RequestInit = {}): Promise<Response> => await fetch(`http://${host}:${port}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers }
  });

  const config = await call("/api/activity-recorder/config");
  assert.equal(config.status, 200);
  const initialConfig = await config.json() as Record<string, unknown>;
  assert.equal(initialConfig.enabled, false);
  assert.equal(initialConfig.outputDir, path.join(root, "snapshots"));
  assert.equal(initialConfig.snapshotDebounceMs, defaultActivitySettings.captureDebounceMs);
  assert.equal(initialConfig.maxStorageBytes, defaultActivitySettings.maxStorageMb * 1024 * 1024);
  assert.equal("captureDebounceMs" in initialConfig, false, "REST 配置使用自身字段名，IPC 配置不受影响");
  const updated = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jpegQuality: 60, snapshotDebounceMs: 5_000 })
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json() as { jpegQuality: number }).jpegQuality, 60);
  assert.equal((await call("/api/activity-recorder/config").then((response) => response.json()) as { snapshotDebounceMs: number }).snapshotDebounceMs, 5_000);
  assert.equal((await call("/api/activity-recorder/config").then((response) => response.json()) as { jpegQuality: number }).jpegQuality, 60);
  assert.equal((await configStore.load()).activity.jpegQuality, defaultActivitySettings.jpegQuality);
  const unsupported = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nativeCaptureMac: false })
  });
  assert.equal(unsupported.status, 400, "不能假装支持尚无设置入口的原生截图开关");
  const internalName = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ captureDebounceMs: 6_000 })
  });
  assert.equal(internalName.status, 400, "REST 只接受对外配置字段，内部命名由 IPC 保留");
  const invalid = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jpegQuality: 500 })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await configStore.load()).activity.jpegQuality, defaultActivitySettings.jpegQuality);

  const started = await call("/api/activity-recorder/start", { method: "POST" });
  assert.equal(started.status, 200);
  const startedBody = await started.json();
  const statusAfterStart = await call("/api/activity-recorder/status");
  assert.equal(statusAfterStart.status, 200);
  assert.deepEqual(startedBody, await statusAfterStart.json());
  assert.deepEqual(Object.keys(startedBody as Record<string, unknown>).sort(), [
    "running", "currentSessionId", "screenLocked", "frontmost", "config", "outputDir", "totalBytes", "sessionCount"
  ].sort());
  assert.equal((startedBody as {running:boolean}).running, false, "采集器不可用不能报告为运行中");
  assert.deepEqual((startedBody as {frontmost:unknown}).frontmost, {bundleId:null,appName:null});
  assert.equal((await call("/api/activity-recorder/config").then((response) => response.json()) as { enabled: boolean }).enabled, false,
    "显式 start 只改变当前运行状态，不改 REST 配置的 enabled");
  assert.equal((await configStore.load()).activity.enabled, false);
  const reconfiguredWithDisabledConfig = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jpegQuality: 61 })
  });
  assert.equal(reconfiguredWithDisabledConfig.status, 200);
  assert.equal((await call("/api/activity-recorder/status").then((response) => response.json()) as { running: boolean }).running, false,
    "显式启动后配置仍为 disabled，下一次 PUT 应停止而非继续采集");
  const permissions = await call("/api/activity-recorder/permissions");
  assert.equal(permissions.status, 200);
  assert.deepEqual(await permissions.json(), {
    platform: "darwin", screenRecording: "denied", accessibility: false, openSettingsCapable: true
  });
  screenRecording = "granted";
  accessibility = true;
  const refreshedPermissions = await call("/api/activity-recorder/permissions");
  assert.equal(refreshedPermissions.status, 200);
  assert.deepEqual(await refreshedPermissions.json(), {
    platform: "darwin", screenRecording: "granted", accessibility: true, openSettingsCapable: true
  });
  permissionError = true;
  const failedPermissions = await call("/api/activity-recorder/permissions");
  assert.equal(failedPermissions.status, 500);
  assert.match((await failedPermissions.json() as { error: string }).error, /permission reader unavailable/);
  permissionError = false;
  const invalidPane = await call("/api/activity-recorder/permissions/open?which=unknown", { method: "POST" });
  assert.equal(invalidPane.status, 400);
  const opened = await call("/api/activity-recorder/permissions/open?which=accessibility", { method: "POST" });
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { ok: true });
  assert.deepEqual(openedPanes, ["accessibility"]);
  const stopped = await call("/api/activity-recorder/stop", { method: "POST" });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { running: false });
  assert.equal((await configStore.load()).activity.enabled, false);
  assert.equal((await call("/api/activity-recorder/config").then((response) => response.json()) as { enabled: boolean }).enabled, false);

  const configuredWhileStopped = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true })
  });
  assert.equal(configuredWhileStopped.status, 200);
  assert.equal((await configuredWhileStopped.json() as { enabled: boolean }).enabled, true);
  assert.equal((await call("/api/activity-recorder/status").then((response) => response.json()) as { running: boolean }).running, false,
    "已停止时更新配置不隐式启动采集");
  const startedAfterConfig = await call("/api/activity-recorder/start", { method: "POST" });
  assert.equal(startedAfterConfig.status, 200);
  assert.equal((await startedAfterConfig.json() as { running: boolean }).running, false,
    "无采集硬件装配时应报告实际不可用，而非仅由 enabled 推断正在运行");
  const reconfiguredWhileRunning = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jpegQuality: 62 })
  });
  assert.equal(reconfiguredWhileRunning.status, 200);
  assert.equal((await call("/api/activity-recorder/status").then((response) => response.json()) as { running: boolean }).running, false,
    "无采集硬件装配时 PUT 不得报告虚假运行状态");
  await call("/api/activity-recorder/stop", { method: "POST" });
  assert.equal((await call("/api/activity-recorder/config").then((response) => response.json()) as { enabled: boolean }).enabled, true,
    "显式 stop 保留 REST 配置值");

  const persisted = await activity.settingsSnapshot();
  await activity.updateSettings({ enabled: true }, persisted.configRevision);
  assert.equal((await configStore.load()).activity.enabled, true);
  assert.equal((await call("/api/activity-recorder/config").then((response) => response.json()) as { enabled: boolean; jpegQuality: number }).jpegQuality, defaultActivitySettings.jpegQuality);
  assert.equal((await call("/api/activity-recorder/config").then((response) => response.json()) as { enabled: boolean }).enabled, true);
  const stoppedPersisted = await call("/api/activity-recorder/stop", { method: "POST" });
  assert.equal(stoppedPersisted.status, 200);
  assert.equal((await configStore.load()).activity.enabled, true);
  assert.equal((await call("/api/activity-recorder/config").then((response) => response.json()) as { enabled: boolean }).enabled, true,
    "显式 stop 不覆盖 Desktop 已保存并重载的配置");
  const restarted = new ActivityRecorderService({ agentDir: root, configStore, inputMonitorPath: undefined });
  try {
    await restarted.initialize();
    assert.equal(restarted.snapshot().state, "unavailable");
  } finally {
    await restarted.stop();
  }
} finally {
  await endpoint?.close();
  await activity.stop();
  await rm(root, { recursive: true, force: true });
}
