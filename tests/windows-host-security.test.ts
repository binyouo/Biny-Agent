import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost } from "../src/runtime/host/bootstrap.js";
import { acquireHostLock, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";

test("endpoint permission failure refuses startup and releases the listening endpoint and owner gate", { timeout: 150_000 }, async (context) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "biny-endpoint-permission-")));
  const paths = runtimeHostPaths(root);
  const configDir = path.join(root, "config");
  const configStore = createFileConfigStore(root, { globalDir: configDir });
  await configStore.save({
    ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
    computer: { ...defaultConfig.computer, enabled: false }
  });
  const denied = new Error("synthetic endpoint permission denial");
  const servers = new Set<net.Server>();
  const realCreateServer = net.createServer;
  const createServer = context.mock.method(net, "createServer", (...args: unknown[]) => {
    const server = Reflect.apply(realCreateServer, net, args) as net.Server;
    servers.add(server);
    return server;
  });
  const realExec = childProcess.execFile;
  const realChmod = fs.chmod;
  const exec = context.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    const options = args[2] as { env?: NodeJS.ProcessEnv };
    if (options?.env?.BINY_IPC_PATH_KIND === "pipe") {
      queueMicrotask(() => (args[3] as (error: Error) => void)(denied));
      return new childProcess.ChildProcess();
    }
    return Reflect.apply(realExec, childProcess, args);
  });
  const chmod = context.mock.method(fs, "chmod", async (...args: Parameters<typeof fs.chmod>) => {
    if (args[0] === paths.endpoint) throw denied;
    return await realChmod(...args);
  });
  syncBuiltinESMExports();
  const probe = net.createServer((socket) => socket.destroy());
  try {
    await assert.rejects(startRuntimeHost(root, (resourceRegistry) => createInteractiveAgentHost(root, { configStore, resourceRegistry }), { configDir }), (error: unknown) => error === denied || error instanceof Error && error.cause === denied);
    await assert.rejects(fs.access(paths.registrationPath), { code: "ENOENT" });
    await assert.rejects(fs.access(paths.lockPath), { code: "ENOENT" });
    const lock = await acquireHostLock(paths, root);
    await lock.close();
    await fs.rm(paths.lockPath);
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(paths.endpoint, resolve); });
  } finally {
    await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    createServer.mock.restore();
    exec.mock.restore(); chmod.mock.restore(); syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
