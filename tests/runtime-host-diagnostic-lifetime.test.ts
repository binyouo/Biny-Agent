import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { runtimeHostPaths, spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { readRegistration, removeStaleRegistration, terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-diagnostic-"));
const configDir = path.join(root, "config");
let host: Awaited<ReturnType<typeof spawnRuntimeHost>> | undefined;
try {
  await saveConfig(root, {
    ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  }, { globalDir: configDir });
  host = await spawnRuntimeHost(root, {
    workspaceRoot: root, configDir,
    entryPath: fileURLToPath(new URL("./fixtures/runtime-host-diagnostics.ts", import.meta.url))
  });
  const stderr = host.process.stderr!;
  const closed = once(stderr, "close");
  stderr.destroy();
  await closed;
  const child = host.process;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Host diagnostic did not complete")), 5_000);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown): void => { if (message === "diagnostic-complete") finish(); };
    const onExit = (code: number | null): void => finish(new Error(`Host exited on a closed diagnostic pipe: ${String(code)}`));
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send("diagnostic", error => { if (error) finish(error); });
  });
  assert.ok((await host.client.listRuntimeSessions()).length > 0, "diagnostic pipe loss must not interrupt connected clients");
  assert.equal(host.process.exitCode, null);
  await host.client.close();
  child.ref();
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.send("diagnostic-error");
  assert.deepEqual(await exited, [1, null], "other diagnostic IO errors must remain failures");
  console.log("runtime host diagnostic lifetime tests passed");
} finally {
  await host?.client.close();
  if (host) await terminateSpawnedHost(host.process);
  const registration = await readRegistration(runtimeHostPaths(root));
  if (registration) await removeStaleRegistration(registration);
  await rm(root, { recursive: true, force: true });
}
