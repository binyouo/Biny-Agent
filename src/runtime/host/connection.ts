/**
 * Runtime Host 客户端发现与候选选举。
 *
 * 连接、启动和接管属于客户端控制面；具体 socket 请求由 RuntimeHostClient 负责。
 */
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { RuntimeHostClient } from "./client.js";
import { RuntimeHostProtocolMismatchError } from "./errors.js";
import {
  ensureRuntimeHostDirectory,
  isConnectionRefused,
  isProcessAlive,
  readRegistration,
  registrationMatchesCurrentEnvironment,
  removeStaleRegistration,
  runtimeHostPaths,
  spawnRuntimeHostProcess,
  terminateSpawnedHost,
  waitForHostRegistration
} from "./lifecycle.js";
import { runtimeHostProtocolVersion as protocolVersion } from "./protocol.js";
import type { ConnectedRuntimeHost, HostClientOptions, RuntimeHostSpawnOptions, SpawnedRuntimeHost, SpawnRuntimeHostOptions } from "./types.js";
import { ensureAgentDirs, sessionIdFromFile } from "../../session/store.js";
import { listSessionSummaries } from "../../session/events.js";
import { TurnStore } from "../../session/turnStore.js";

export async function connectRuntimeHost(
  persistenceRoot: string,
  options: HostClientOptions = {}
): Promise<RuntimeHostClient | undefined> {
  if (process.platform === "win32") return undefined;
  const paths = runtimeHostPaths(persistenceRoot);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const registration = await readRegistration(paths);
  if (!registration) return undefined;
  if (registration.protocolVersion !== protocolVersion) {
    if (isProcessAlive(registration.pid)) {
      throw new RuntimeHostProtocolMismatchError(registration.protocolVersion, protocolVersion, registration.pid);
    }
    await removeStaleRegistration(registration);
    return undefined;
  }
  const identityMatches = registrationMatchesCurrentEnvironment(registration, options.spawnOptions ?? { configDir: options.configDir });
  if (!identityMatches && options.spawnOptions === undefined) return undefined;
  try {
    const client = await RuntimeHostClient.connect({
      registration,
      configDir: options.configDir,
      clientId: options.clientId,
      surface: options.surface,
      spawnOptions: options.spawnOptions,
      environmentTakeover: !identityMatches
    });
    if (identityMatches) return client;
    try {
      // 已连接的 owner 来自另一个配置环境时，先通过只读 snapshot 确认空闲，
      // 再沿同一 endpoint 完成接管，保证运行账本始终只有一个 writer。
      await client.restartOwner();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (!isConnectionRefused(error)) throw error;
    if (isProcessAlive(registration.pid)) throw new Error(`Runtime Host PID ${String(registration.pid)} is alive but its endpoint is unavailable. No replacement was started.`);
    await removeStaleRegistration(registration);
    return undefined;
  }
}

export async function connectOrSpawnRuntimeHostWithOwnership(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions
): Promise<ConnectedRuntimeHost | undefined> {
  const spawnOptions = toSpawnOptions(options);
  const attached = await connectRuntimeHost(persistenceRoot, {
    clientId: options.clientId,
    surface: options.surface,
    spawnOptions
  });
  if (attached) return { client: attached };
  try {
    const spawned = await spawnRuntimeHost(persistenceRoot, options);
    return { client: spawned.client, spawnedProcess: spawned.process };
  } catch (error) {
    // 两个 surface 同时启动时，另一个可能刚拿到 Host lock。失败后再 attach 一次，
    // 避免把正常的 owner 竞争误报成 Desktop 初始化失败。
    const raced = await connectRuntimeHost(persistenceRoot, {
      clientId: options.clientId,
      surface: options.surface,
      spawnOptions
    });
    if (raced) return { client: raced };
    throw error;
  }
}

export async function connectOrSpawnRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions
): Promise<RuntimeHostClient | undefined> {
  return (await connectOrSpawnRuntimeHostWithOwnership(persistenceRoot, options))?.client;
}

export async function spawnRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions
): Promise<SpawnedRuntimeHost> {
  if (process.platform === "win32") throw new Error("Runtime Host currently requires Unix domain sockets.");
  const child = spawnRuntimeHostProcess(persistenceRoot, options);
  try {
    const client = await waitForSpawnedRuntimeHost(persistenceRoot, options, child);
    return { process: child, client };
  } catch (error) {
    if (child.exitCode === null) await terminateSpawnedHost(child);
    throw error;
  }
}

export async function findLatestInterruptedSession(persistenceRoot: string): Promise<string | undefined> {
  // Runtime Host 可能是当前工作区第一次启动；在扫描 session 之前先建立全局
  // session 目录，否则 `resumeInterrupted` 会在空工作区被不存在的目录阻断。
  await ensureAgentDirs(persistenceRoot);
  const summaries = await listSessionSummaries(persistenceRoot);
  for (const summary of summaries) {
    const sessionId = sessionIdFromFile(summary.fileName);
    if (await new TurnStore(persistenceRoot, sessionId).load()) return sessionId;
  }
  return undefined;
}

async function waitForSpawnedRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions,
  child: ChildProcess
): Promise<RuntimeHostClient> {
  await waitForHostRegistration(persistenceRoot, child);
  const client = await connectRuntimeHost(persistenceRoot, {
    clientId: options.clientId,
    surface: options.surface,
    spawnOptions: toSpawnOptions(options)
  });
  if (!client) throw new Error("Runtime Host registration disappeared before attach.");
  return client;
}

function toSpawnOptions(options: SpawnRuntimeHostOptions): RuntimeHostSpawnOptions {
  return {
    lifecycleMode: options.lifecycleMode,
    idleGraceMs: options.idleGraceMs,
    workspaceRoot: options.workspaceRoot,
    configDir: options.configDir,
    attachmentRoot: options.attachmentRoot,
    sessionId: options.sessionId,
    resumeInterrupted: options.resumeInterrupted,
    entryPath: options.entryPath,
    browserAutomation: options.browserAutomation
  };
}
