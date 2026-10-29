/**
 * Runtime Host owner 启动入口。
 *
 * 这里只完成 lock、registration 和 Server 装配；业务 composition 不在 CLI/Desktop 入口复制。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { globalAgentDir, globalConfigDir } from "../../config/paths.js";
import type { InteractiveAgentHost } from "../InteractiveAgentRuntime.js";
import { issueRuntimeHostAccessCredential } from "./credentials.js";
import { acquireHostLock, ensureRuntimeHostDirectory, removeSocketIfStale, runtimeHostPaths, writeRegistration } from "./lifecycle.js";
import { runtimeHostProtocolVersion as protocolVersion } from "./protocol.js";
import type { RuntimeHostResourceRegistry } from "./resources.js";
import { RuntimeHostServer } from "./server.js";
import type { HostRegistration, RuntimeHostStartOptions } from "./types.js";

export async function startRuntimeHost(
  persistenceRoot: string,
  createInitialRuntime: (resourceRegistry: RuntimeHostResourceRegistry, signal: AbortSignal) => Promise<InteractiveAgentHost>,
  options: RuntimeHostStartOptions
): Promise<RuntimeHostServer> {
  const paths = runtimeHostPaths(persistenceRoot);
  await ensureRuntimeHostDirectory(path.dirname(paths.registrationPath));
  const lock = await acquireHostLock(paths, persistenceRoot);
  const hostEpoch = randomUUID();
  const token = issueRuntimeHostAccessCredential().secret;
  const registration: HostRegistration = {
    protocolVersion,
    endpoint: paths.endpoint,
    registrationPath: paths.registrationPath,
    lockPath: paths.lockPath,
    rootHash: paths.rootHash,
    persistenceRoot: path.resolve(persistenceRoot),
    configRoot: path.resolve(options.configDir ?? globalConfigDir()),
    agentRoot: path.resolve(globalAgentDir()),
    hostEpoch,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  const server = new RuntimeHostServer(undefined, undefined, registration, lock, options.createRuntime, options);
  try {
    await removeSocketIfStale(paths.endpoint);
    await server.listen();
    await writeRegistration(registration);
    void server.initialize(createInitialRuntime).then(() => {
      server.startAutomationScheduler();
    }).catch(() => undefined);
    return server;
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}
