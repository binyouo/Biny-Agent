/** 真实 detached 子进程验证：观察连接允许回收，客户端不反复拉起空闲 Host。 */
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { connectOrSpawnRuntimeHostWithOwnership, connectRuntimeHost, runtimeHostPaths } from "../src/runtime/RuntimeHost.js";
import { isProcessAlive, terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-observer-lifetime-"));
const configDir = path.join(root, "config");
await saveConfig(root, {
  ...structuredClone(defaultConfig), defaultModel: "local-test",
  providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
  models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }
}, { globalDir: configDir });
const options = { workspaceRoot: root, configDir, surface: "desktop" as const, keepAlive: false, idleGraceMs: 150 };
let owner: Awaited<ReturnType<typeof connectOrSpawnRuntimeHostWithOwnership>>;
try {
  owner = await connectOrSpawnRuntimeHostWithOwnership(root, options);
  assert.ok(owner?.spawnedProcess?.pid);
  const firstEpoch = owner.client.hostInfo?.hostEpoch;
  const firstPid = owner.spawnedProcess.pid;
  await waitFor(() => owner!.client.isRetired && !isProcessAlive(firstPid));
  await assert.rejects(access(runtimeHostPaths(root).registrationPath), { code: "ENOENT" });
  // 覆盖客户端真实重连定时器的首个窗口；只用于证明没有自动 respawn，最长 600ms。
  await new Promise<void>((resolve) => setTimeout(resolve, 600));
  assert.equal(await connectRuntimeHost(root, { configDir }), undefined);
  await owner.client.close();

  owner = await connectOrSpawnRuntimeHostWithOwnership(root, options);
  assert.ok(owner?.spawnedProcess?.pid);
  assert.notEqual(owner.client.hostInfo?.hostEpoch, firstEpoch, "新的显式操作应取得新的 owner epoch");
  assert.notEqual(owner.spawnedProcess.pid, firstPid);
  assert.ok((await owner.client.listRuntimeSessions()).length > 0);
  await waitFor(() => owner!.client.isRetired && !isProcessAlive(owner!.spawnedProcess!.pid!));
  console.log("runtime host observer lifetime tests passed");
} finally {
  await owner?.client.close();
  if (owner?.spawnedProcess) await terminateSpawnedHost(owner.spawnedProcess);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "observer Host lifecycle deadline elapsed");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
