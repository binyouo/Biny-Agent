/**
 * Runtime Host 的本地生命周期与文件系统边界。
 *
 * 这里负责 endpoint、registration、owner lock 和候选进程，不装配 Agent 业务，也不处理请求协议。
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalAgentDir, globalConfigDir } from "../../config/paths.js";
import { asRecord } from "./protocol.js";
import {
  runtimeHostDirectoryName,
  runtimeHostMaxUnixSocketPathLength as maxUnixSocketPathLength,
  runtimeHostProtocolVersion as protocolVersion,
  runtimeHostStartupTimeoutMs as hostStartupTimeoutMs
} from "./protocol.js";
import { runtimeHostSpawnCircuitFor } from "./reconnect.js";
import { RuntimeHostProtocolMismatchError, RuntimeHostStartupError } from "./errors.js";
import type {
  HostRegistration,
  RuntimeHostLock,
  RuntimeHostPaths,
  RuntimeHostSpawnOptions
} from "./types.js";

export function runtimeHostPaths(persistenceRoot: string): RuntimeHostPaths {
  const resolvedRoot = path.resolve(persistenceRoot);
  const rootHash = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 24);
  const baseName = `biny-${rootHash}`;
  const temporaryRoot = os.tmpdir();
  const preferredDirectory = path.join(temporaryRoot, runtimeHostDirectoryName);
  const fallbackDirectory = path.join("/tmp", runtimeHostDirectoryName);
  const preferred = path.join(preferredDirectory, `${baseName}.sock`);
  // macOS 的临时目录有时很深，Unix socket 路径过长会直接返回 ENAMETOOLONG。
  const directory = preferred.length <= maxUnixSocketPathLength ? preferredDirectory : fallbackDirectory;
  const endpoint = path.join(directory, `${baseName}.sock`);
  return {
    endpoint,
    registrationPath: `${endpoint}.json`,
    lockPath: `${endpoint}.lock`,
    rootHash
  };
}

export function spawnRuntimeHostProcess(
  persistenceRoot: string,
  options: RuntimeHostSpawnOptions
): ChildProcess {
  // spawn 熔断：同一 workspace 连续即死达上限后拒绝再起新进程，把风暴拦在 spawn 之前。
  const endpoint = runtimeHostPaths(persistenceRoot).endpoint;
  const circuitError = runtimeHostSpawnCircuitFor(endpoint).failureError();
  if (circuitError) throw circuitError;
  const plan = runtimeHostLaunchPlan(persistenceRoot, options);
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const child = spawn(plan.executable, plan.args, {
    cwd: moduleRoot,
    detached: true,
    // 控制 socket 可以重连；这条 IPC 仅代表启动者寿命，不能与业务连接混为一谈。
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: plan.env
  });
  if (options.browserAutomation !== undefined) {
    child.send({ type: "biny.runtime-host.bootstrap", browserAutomation: options.browserAutomation }, (error) => {
      if (error) void terminateSpawnedHost(child);
    });
  }
  child.unref();
  child.channel?.unref();
  return child;
}

export interface RuntimeHostLaunchPlan {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** 共享可验证的启动边界；浏览器令牌只经私有 IPC，不进入 argv 或继承环境。 */
export function runtimeHostLaunchPlan(
  persistenceRoot: string,
  options: RuntimeHostSpawnOptions,
  environment: Pick<NodeJS.Process, "platform" | "execPath"> = process
): RuntimeHostLaunchPlan {
  const entryPath = options.entryPath ?? process.env.BINY_RUNTIME_HOST_ENTRY ?? runtimeHostEntryPath();
  const nodeArgs = entryPath.endsWith(".ts") ? ["--import", "tsx", entryPath] : [entryPath];
  const hostArgs = [
    "--workspace-root",
    path.resolve(options.workspaceRoot),
    "--persistence-root",
    path.resolve(persistenceRoot),
    "--lifecycle-mode", options.lifecycleMode ?? "ephemeral",
    "--idle-grace-ms", String(options.idleGraceMs ?? 30_000),
    ...(options.configDir === undefined ? [] : ["--config-dir", path.resolve(options.configDir)]),
    ...(options.attachmentRoot === undefined ? [] : ["--attachment-root", path.resolve(options.attachmentRoot)]),
    ...(options.sessionId === undefined ? [] : ["--session-id", options.sessionId]),
    ...(options.resumeInterrupted === true ? ["--resume-interrupted"] : []),
    ...(options.browserAutomation === undefined ? [] : ["--browser-automation-bootstrap"])
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BINY_BROWSER_CONTROL_ENDPOINT;
  delete env.BINY_BROWSER_CONTROL_TOKEN;
  delete env.BINY_BROWSER_PROJECT_ID;
  if (options.electronAppPath !== undefined) {
    delete env.ELECTRON_RUN_AS_NODE;
    const executableName = path.basename(environment.execPath);
    return {
      executable: environment.platform === "darwin"
        ? path.resolve(path.dirname(environment.execPath), "../Frameworks", `${executableName} Helper.app`, "Contents/MacOS", `${executableName} Helper`)
        : environment.execPath,
      args: [path.resolve(options.electronAppPath), "--biny-runtime-host", ...hostArgs],
      env
    };
  }
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = "1";
  return { executable: environment.execPath, args: [...nodeArgs, ...hostArgs], env };
}

export function runtimeHostEntryPath(): string {
  const current = fileURLToPath(import.meta.url);
  return path.join(path.dirname(current), `../hostProcess${current.endsWith(".ts") ? ".ts" : ".js"}`);
}

export async function waitForHostRegistration(
  persistenceRoot: string,
  child: ChildProcess,
  timeoutMs = hostStartupTimeoutMs
): Promise<HostRegistration> {
  const circuit = runtimeHostSpawnCircuitFor(runtimeHostPaths(persistenceRoot).endpoint);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      // 进程起来后立刻退出（spawn-即死）：计入熔断，越限即抛终结错误停止 respawn。
      circuit.recordFailure();
      const circuitError = circuit.failureError();
      if (circuitError) throw circuitError;
      throw new RuntimeHostStartupError("process_exit", child.exitCode);
    }
    const registration = await readRegistration(runtimeHostPaths(persistenceRoot));
    if (registration) {
      if (isProcessAlive(registration.pid)) {
        // host 真正 ready：清零连续失败计数。
        circuit.recordSuccess();
        return registration;
      }
      await removeStaleRegistration(registration);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode !== null) {
    circuit.recordFailure();
    const circuitError = circuit.failureError();
    if (circuitError) throw circuitError;
    throw new RuntimeHostStartupError("process_exit", child.exitCode);
  }
  // 候选进程可能仍存活但已经失去注册能力（例如加载 provider 卡死）。超时后必须回收
  // 这个候选，否则每次重连都会留下一个 detached Host，最终与 launchd KeepAlive 叠加成进程风暴。
  const finalRegistration = await readRegistration(runtimeHostPaths(persistenceRoot));
  if (finalRegistration && isProcessAlive(finalRegistration.pid)) {
    circuit.recordSuccess();
    return finalRegistration;
  }
  await terminateSpawnedHost(child);
  circuit.recordFailure();
  const circuitError = circuit.failureError();
  if (circuitError) throw circuitError;
  throw new RuntimeHostStartupError("timeout", timeoutMs);
}

/** 超时候选只允许短暂优雅退出，随后强制回收；不会触碰 registration 中的其他 owner。 */
export async function terminateSpawnedHost(child: ChildProcess, graceMs = 250): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      child.off("exit", finish);
      child.off("error", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // 子进程可能恰好在 kill 前退出；exit/error 事件会完成收尾。
        }
      }
    }, graceMs);
    // 正常情况下 SIGTERM/SIGKILL 很快产生 exit；最坏情况下也不能让候选回收阻塞主流程。
    const hardTimer = setTimeout(finish, Math.max(graceMs + 1_000, 1_000));
    child.once("exit", finish);
    child.once("error", finish);
    if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(finish);
  });
}

export async function waitForHostExit(paths: RuntimeHostPaths, registration: HostRegistration): Promise<void> {
  const deadline = Date.now() + hostStartupTimeoutMs;
  while (Date.now() < deadline) {
    const current = await readRegistration(paths);
    if (!isProcessAlive(registration.pid)) return;
    if (current && current.hostEpoch !== registration.hostEpoch && current.pid !== registration.pid) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Runtime Host process ${String(registration.pid)} did not stop within ${String(hostStartupTimeoutMs)}ms.`);
}

export function currentRuntimeHostIdentity(options?: Pick<RuntimeHostSpawnOptions, "configDir">): { configRoot: string; agentRoot: string } {
  return {
    configRoot: path.resolve(options?.configDir ?? globalConfigDir()),
    agentRoot: path.resolve(globalAgentDir())
  };
}

export function registrationMatchesCurrentEnvironment(
  registration: HostRegistration,
  options?: Pick<RuntimeHostSpawnOptions, "configDir">
): boolean {
  const identity = currentRuntimeHostIdentity(options);
  return registration.configRoot === identity.configRoot && registration.agentRoot === identity.agentRoot;
}

export async function readRegistration(paths: RuntimeHostPaths): Promise<HostRegistration | undefined> {
  try {
    const raw = await readPrivateHostFile(paths.registrationPath);
    if (raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    const registration = asRecord(parsed);
    if (
      !Number.isSafeInteger(registration.protocolVersion)
      || registration.endpoint !== paths.endpoint
      || registration.rootHash !== paths.rootHash
      || typeof registration.token !== "string"
      || typeof registration.hostEpoch !== "string"
      || typeof registration.persistenceRoot !== "string"
      || !Number.isSafeInteger(registration.pid)
    ) return undefined;
    return {
      protocolVersion: registration.protocolVersion as number,
      endpoint: paths.endpoint,
      registrationPath: paths.registrationPath,
      lockPath: paths.lockPath,
      rootHash: paths.rootHash,
      persistenceRoot: registration.persistenceRoot,
      configRoot: typeof registration.configRoot === "string" ? path.resolve(registration.configRoot) : undefined,
      agentRoot: typeof registration.agentRoot === "string" ? path.resolve(registration.agentRoot) : undefined,
      hostEpoch: registration.hostEpoch,
      token: registration.token,
      pid: registration.pid as number,
      createdAt: typeof registration.createdAt === "string" ? registration.createdAt : ""
    };
  } catch {
    return undefined;
  }
}

export async function writeRegistration(registration: HostRegistration): Promise<void> {
  const temporary = `${registration.registrationPath}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, hostWriteNewFlags(), 0o600);
    await handle.writeFile(`${JSON.stringify(registration)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await fs.rename(temporary, registration.registrationPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

class RuntimeHostLockBusyError extends Error {}

export async function acquireHostLock(paths: RuntimeHostPaths, persistenceRoot: string): Promise<RuntimeHostLock> {
  const ownerLock = await acquireHostLockGate(paths, persistenceRoot);
  try {
    const registration = await readRegistration(paths);
    const lockStat = await statIfPresent(paths.lockPath);
    const lockPid = lockStat ? await readLockPid(paths.lockPath) : undefined;

    if (registration && isProcessAlive(registration.pid)) {
      if (registration.protocolVersion !== protocolVersion) {
        throw new RuntimeHostProtocolMismatchError(registration.protocolVersion, protocolVersion, registration.pid);
      }
      throw alreadyRunningError(persistenceRoot);
    }
    if (lockStat && lockPid === undefined) {
      // An absent/partial PID can mean that another process has just created the
      // legacy marker and has not published its identity yet. Never infer staleness.
      throw new Error("Runtime Host lock exists without a valid owner PID; refusing to remove it.");
    }
    if (lockPid !== undefined && isProcessAlive(lockPid)) throw alreadyRunningError(persistenceRoot);

    if (registration || lockStat) {
      await removeStaleRegistrationArtifacts(registration ?? registrationForPaths(paths, persistenceRoot));
    }
    await removeAbandonedHostLockTemps(paths);
    await publishHostLock(paths.lockPath, process.pid);
    return ownerLock;
  } catch (error) {
    await ownerLock.close().catch(() => undefined);
    throw error;
  }
}

function alreadyRunningError(persistenceRoot: string): Error {
  return new Error(`Runtime Host is already running or starting for ${path.resolve(persistenceRoot)}.`);
}

/** The SQLite write transaction is the kernel-released, process-wide owner election gate. */
async function acquireHostLockGate(paths: RuntimeHostPaths, persistenceRoot: string): Promise<RuntimeHostLock> {
  const databasePath = `${paths.lockPath}.authority.sqlite`;
  await ensurePrivateHostLockDatabase(databasePath);
  const database = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec("PRAGMA user_version = 1");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* BEGIN may not have succeeded. */ }
    database.close();
    if (isSqliteBusy(error)) throw new RuntimeHostLockBusyError(alreadyRunningError(persistenceRoot).message);
    throw error;
  }
  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    }
  };
}

async function ensurePrivateHostLockDatabase(databasePath: string): Promise<void> {
  try {
    const handle = await fs.open(
      databasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | hostNoFollowFlag(),
      0o600
    );
    await handle.close();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const stat = await fs.lstat(databasePath);
  if (!isPrivateHostFile(stat)) throw new Error("Runtime Host lock authority must be a private, owned file.");
  await fs.chmod(databasePath, 0o600);
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database (?:table )?is locked/u.test(error.message);
}

async function publishHostLock(lockPath: string, pid: number): Promise<void> {
  const temporaryPath = `${lockPath}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, hostWriteNewFlags(), 0o600);
    await handle.writeFile(`${String(pid)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    // link() publishes a fully written file and fails atomically if another
    // implementation wins the legacy lock path while this owner is starting.
    await fs.link(temporaryPath, lockPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function removeAbandonedHostLockTemps(paths: RuntimeHostPaths): Promise<void> {
  const prefix = `${path.basename(paths.lockPath)}.`;
  const entries = await fs.readdir(path.dirname(paths.lockPath));
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !/^[0-9a-f-]{36}\.tmp$/u.test(entry.slice(prefix.length))) continue;
    const temporaryPath = path.join(path.dirname(paths.lockPath), entry);
    const stat = await statIfPresent(temporaryPath);
    if (stat?.isFile() && stat.nlink <= 2 && (stat.mode & 0o077) === 0 && isOwnedByCurrentUser(stat)) {
      await fs.rm(temporaryPath, { force: true });
    }
  }
}

/** lock 文件内容是 owner pid；可见的空文件不等于 stale，调用方必须 fail closed。 */
export async function readLockPid(lockPath: string): Promise<number | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(lockPath, constants.O_RDONLY | hostNoFollowFlag());
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.nlink !== 1 && stat.nlink !== 2)
      || (stat.mode & 0o077) !== 0
      || !isOwnedByCurrentUser(stat)
    ) return undefined;
    const pid = Number((await handle.readFile("utf8")).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function statIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function removeStaleRegistration(registration: HostRegistration): Promise<void> {
  const paths: RuntimeHostPaths = {
    endpoint: registration.endpoint,
    registrationPath: registration.registrationPath,
    lockPath: registration.lockPath,
    rootHash: registration.rootHash
  };
  let ownerLock: RuntimeHostLock;
  try {
    ownerLock = await acquireHostLockGate(paths, registration.persistenceRoot);
  } catch (error) {
    if (error instanceof RuntimeHostLockBusyError) return;
    throw error;
  }
  try {
    const current = await readRegistration(paths);
    if (current && current.hostEpoch !== registration.hostEpoch) return;
    if (current && isProcessAlive(current.pid)) return;
    const lockStat = await statIfPresent(paths.lockPath);
    if (lockStat) {
      const lockPid = await readLockPid(paths.lockPath);
      if (lockPid === undefined || isProcessAlive(lockPid)) return;
    }
    await removeStaleRegistrationArtifacts(current ?? registration);
    await removeAbandonedHostLockTemps(paths);
  } finally {
    await ownerLock.close();
  }
}

async function removeStaleRegistrationArtifacts(registration: HostRegistration): Promise<void> {
  await fs.rm(registration.registrationPath, { force: true });
  await removeSocketIfStale(registration.endpoint);
  await fs.rm(registration.lockPath, { force: true });
}

function registrationForPaths(paths: RuntimeHostPaths, persistenceRoot: string): HostRegistration {
  return {
    protocolVersion,
    endpoint: paths.endpoint,
    registrationPath: paths.registrationPath,
    lockPath: paths.lockPath,
    rootHash: paths.rootHash,
    persistenceRoot: path.resolve(persistenceRoot),
    configRoot: undefined,
    agentRoot: undefined,
    hostEpoch: "",
    token: "",
    pid: 0,
    createdAt: ""
  };
}

export async function removeRegistration(registration: HostRegistration): Promise<void> {
  const current = await readRegistration({
    endpoint: registration.endpoint,
    registrationPath: registration.registrationPath,
    lockPath: registration.lockPath,
    rootHash: registration.rootHash
  });
  // registration/lock/socket 都可能已被新 owner 接管；只删除仍能证明归属自己的文件，
  // 否则旧 owner 退出时会删掉新 owner 的 endpoint，造成双 owner 之外的另一种断连。
  const ownsRegistration = current?.hostEpoch === registration.hostEpoch;
  const lockPid = await readLockPid(registration.lockPath);
  const ownsLock = lockPid === undefined || lockPid === registration.pid;
  if (ownsRegistration) await fs.rm(registration.registrationPath, { force: true });
  if (ownsRegistration || (current === undefined && ownsLock)) await removeSocketIfStale(registration.endpoint);
  if (ownsLock) await fs.rm(registration.lockPath, { force: true });
}

export async function removeSocketIfStale(endpoint: string): Promise<void> {
  try {
    const stat = await fs.lstat(endpoint);
    if (stat.isSymbolicLink()) {
      await fs.unlink(endpoint);
      return;
    }
    if (!stat.isSocket() || !isOwnedByCurrentUser(stat)) {
      throw new Error("Runtime Host endpoint must be an owned Unix socket.");
    }
    await fs.unlink(endpoint);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function ensureRuntimeHostDirectory(directory: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(directory);
  }
  const realParent = await fs.realpath(path.dirname(directory));
  const realDirectory = await fs.realpath(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realDirectory !== path.join(realParent, path.basename(directory))) {
    throw new Error("Runtime Host directory must be a real directory.");
  }
  if (!isOwnedByCurrentUser(stat)) throw new Error("Runtime Host directory is not owned by the current user.");
  await fs.chmod(directory, 0o700);
}

export async function readPrivateHostFile(filePath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | hostNoFollowFlag());
    const stat = await handle.stat();
    if (!isPrivateHostFile(stat)) return undefined;
    return await handle.readFile("utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function secureRuntimeSocket(endpoint: string): Promise<void> {
  const stat = await fs.lstat(endpoint);
  if (!stat.isSocket() || !isOwnedByCurrentUser(stat)) {
    throw new Error("Runtime Host endpoint must be an owned Unix socket.");
  }
  await fs.chmod(endpoint, 0o600);
}

export function hostWriteNewFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | hostNoFollowFlag();
}

export function hostNoFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

export function isPrivateHostFile(stat: Stats): boolean {
  return stat.isFile()
    && stat.nlink === 1
    && (stat.mode & 0o077) === 0
    && isOwnedByCurrentUser(stat);
}

export function isOwnedByCurrentUser(stat: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stat.uid === uid;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export function isConnectionRefused(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "EPIPE";
}

export function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ESRCH";
}

export function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} contains unsupported field: ${unexpected}.`);
}

export function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
