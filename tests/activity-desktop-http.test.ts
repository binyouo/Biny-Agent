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
let endpoint: Awaited<ReturnType<typeof startActivityHttpEndpoint>> | undefined;
try {
  await configStore.save({ ...defaultConfig, activity: { ...defaultActivitySettings, enabled: false, outputDirectory: path.join(root, "snapshots") } });
  await activity.initialize();
  endpoint = await startActivityHttpEndpoint(createDesktopActivityHttpDependencies({
    agentDir: root, activity, configStore, openPermissions: async (pane) => { openedPanes.push(pane); }
  }));
  const { host, port, token } = JSON.parse(await readFile(endpoint.discoveryPath, "utf8")) as { host: string; port: number; token: string };
  const call = async (route: string, init: RequestInit = {}): Promise<Response> => await fetch(`http://${host}:${port}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers }
  });

  const config = await call("/api/activity-recorder/config");
  assert.equal(config.status, 200);
  assert.equal((await config.json() as { enabled: boolean }).enabled, false);
  const updated = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jpegQuality: 60 })
  });
  assert.equal(updated.status, 200);
  assert.equal((await configStore.load()).activity.jpegQuality, 60);
  const invalid = await call("/api/activity-recorder/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jpegQuality: 500 })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await configStore.load()).activity.jpegQuality, 60);

  assert.equal((await call("/api/activity-recorder/start", { method: "POST" })).status, 200);
  assert.equal((await configStore.load()).activity.enabled, true);
  const permissions = await call("/api/activity-recorder/permissions");
  assert.equal(permissions.status, 200);
  assert.equal((await permissions.json() as { collectorAvailable: boolean }).collectorAvailable, false);
  const invalidPane = await call("/api/activity-recorder/permissions/open?which=unknown", { method: "POST" });
  assert.equal(invalidPane.status, 400);
  const opened = await call("/api/activity-recorder/permissions/open?which=accessibility", { method: "POST" });
  assert.equal(opened.status, 200);
  assert.deepEqual(openedPanes, ["accessibility"]);
  assert.equal((await call("/api/activity-recorder/stop", { method: "POST" })).status, 200);
  assert.equal((await configStore.load()).activity.enabled, false);
} finally {
  await endpoint?.close();
  await activity.stop();
  await rm(root, { recursive: true, force: true });
}
