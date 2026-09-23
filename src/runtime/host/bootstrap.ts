/**
 * Runtime Host owner 启动入口。
 *
 * 这里只完成 lock、registration 和 Server 装配；业务 composition 不在 CLI/Desktop 入口复制。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { globalAgentDir, globalConfigDir } from "../../config/paths.js";
import type { InteractiveAgentHost } from "../InteractiveAgentRuntime.js";
import { RuntimeHostServer } from "./server.js";
import { issueRuntimeHostAccessCredential } from "./credentials.js";
import { CapabilityStore } from "../CapabilityStore.js";
import { RuntimeEventAuthority } from "../RuntimeAuthority.js";
import {
  acquireHostLock,
  ensureRuntimeHostDirectory,
  removeSocketIfStale,
  removeStaleRegistration,
  runtimeHostPaths,
  writeRegistration
} from "./lifecycle.js";
import { runtimeHostProtocolVersion as protocolVersion } from "./protocol.js";
import type { HostRegistration, RuntimeHostStartOptions } from "./types.js";
import { RuntimeHostResourceRegistry } from "./resources.js";

export async function startRuntimeHost(
  persistenceRoot: string,
  createInitialRuntime: (resourceRegistry: RuntimeHostResourceRegistry) => Promise<InteractiveAgentHost>,
  options: RuntimeHostStartOptions = {}
): Promise<RuntimeHostServer> {
  if (process.platform === "win32") throw new Error("Runtime Host currently requires Unix domain sockets.");
  const paths = runtimeHostPaths(persistenceRoot);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
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
  let server: RuntimeHostServer | undefined;
  let initial: InteractiveAgentHost | undefined;
  const resourceRegistry = new RuntimeHostResourceRegistry();
  try {
    await removeSocketIfStale(paths.endpoint);
    // 拿到 workspace 独占锁后先终结上个 owner 留下的在途调用；新 Runtime 接收请求前，
    // 任何旧 offer 重放都必须看到明确的 unknown，而不能被当作一次新执行。
    const authority = await RuntimeEventAuthority.open(persistenceRoot, { backfillLegacySessions: false });
    try {
      const capabilities = await CapabilityStore.open(persistenceRoot, authority);
      try {
        capabilities.recoverUnsettledInvocations("host_restarted");
      } finally {
        capabilities.close();
      }
    } finally {
      authority.close();
    }
    initial = await createInitialRuntime(resourceRegistry);
    server = new RuntimeHostServer(initial.runtime, initial.commands, registration, lock, options.createRuntime, {
      workspaceRoot: options.workspaceRoot,
      sessionRuntimeCacheTarget: options.sessionRuntimeCacheTarget,
      shutdownDrainMs: options.shutdownDrainMs,
      onClosing: options.onClosing,
      resourceRegistry
    });
    await server.initialize();
    await server.listen();
    await writeRegistration(registration);
    server.startAutomationScheduler();
    if (options.resumeInterrupted) await server.resumeInterruptedTurn();
    server.startMemoryMaintenance();
    return server;
  } catch (error) {
    await server?.close().catch(() => undefined);
    if (!server) {
      await initial?.runtime.close().catch(() => undefined);
      await resourceRegistry.close().catch(() => undefined);
      await lock.close().catch(() => undefined);
    }
    await removeStaleRegistration(registration).catch(() => undefined);
    throw error;
  }
}
