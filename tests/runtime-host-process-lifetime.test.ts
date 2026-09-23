/** 真实子进程与 IPC 断连测试；只用本地无网络模型配置，不执行模型请求。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { connectRuntimeHost, runtimeHostPaths, spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { isProcessAlive, terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "process lifecycle deadline elapsed");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

for (const crash of [false, true]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-lifetime-"));
  const configDir = path.join(root, "config");
  await saveConfig(root, {
    ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  }, { globalDir: configDir });
  const launcher = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/runtime-host-launcher.ts", import.meta.url)), root, configDir], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let hostPid: number | undefined;
  let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
  try {
    hostPid = await new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("launcher did not report readiness")), 15_000);
      launcher.once("message", (message) => { clearTimeout(deadline); resolve((message as { pid: number }).pid); });
      launcher.once("error", (error) => { clearTimeout(deadline); reject(error); });
      launcher.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`launcher exited early: ${String(code)}`)); });
    });
    client = await connectRuntimeHost(root, { clientId: "second-client", surface: "tui", spawnOptions: { workspaceRoot: root, configDir } });
    assert.ok(client);
    if (crash) launcher.kill("SIGKILL");
    else launcher.send("exit");
    await waitUntil(() => launcher.exitCode !== null || launcher.signalCode !== null);
    // 必须跨过真实进程的空闲宽限，证明另一个客户端不会随启动者被杀。最长 300ms。
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(isProcessAlive(hostPid), true);
    assert.ok(await client.listSessions());
    await client.close();
    client = undefined;
    await waitUntil(() => !isProcessAlive(hostPid!));
    await assert.rejects(access(runtimeHostPaths(root).lockPath), { code: "ENOENT" });
    await assert.rejects(access(runtimeHostPaths(root).registrationPath), { code: "ENOENT" });

    const service = await spawnRuntimeHost(root, { workspaceRoot: root, configDir, lifecycleMode: "service", idleGraceMs: 10 });
    try {
      await service.client.close();
      // 常驻模式的契约就是跨过空闲窗口仍存活；等待上限 100ms，不以它证明退出成功。
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.equal(isProcessAlive(service.process.pid!), true);
    } finally {
      await terminateSpawnedHost(service.process, 5_000);
    }
  } finally {
    await client?.close();
    await terminateSpawnedHost(launcher);
    if (hostPid && isProcessAlive(hostPid)) process.kill(hostPid, "SIGTERM");
    if (hostPid) await waitUntil(() => !isProcessAlive(hostPid!));
    await rm(root, { recursive: true, force: true });
  }
}
console.log("runtime host process lifetime tests passed");
