/**
 * Runtime-owned long-lived process manager.
 *
 * Unlike `Bash`, managed processes have no command deadline. They write
 * directly to a durable log file and stay addressable by an opaque process ID
 * until they exit or the owning runtime closes. Runtime owns every process by
 * default. Callers may explicitly assign lifetime to an enclosing disposable
 * execution environment.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { appendFile, open, realpath, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { agentDir, ensureAgentDirs } from "../session/store.js";
import { bindManagedProcessLog, readManagedProcessLog, type ManagedProcessLogBinding } from "./managedProcessLog.js";

const defaultReadinessTimeoutMs = 30_000;
const defaultReadinessIntervalMs = 250;
const defaultProbeTimeoutMs = 2_000;
const defaultTerminationGraceMs = 2_000;
const defaultKillSettleMs = 1_000;
const maxReadinessLogBytes = 1024 * 1024;

export type ManagedProcessState = "starting" | "running" | "exited" | "failed" | "stopped";

export interface HttpReadinessProbe {
  type: "http";
  url: string;
  expectedStatus?: number;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface TcpReadinessProbe {
  type: "tcp";
  host: string;
  port: number;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface LogReadinessProbe {
  type: "log";
  pattern: string;
  regex?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
}

export type ManagedProcessReadinessProbe = HttpReadinessProbe | TcpReadinessProbe | LogReadinessProbe;
export type ManagedProcessReadinessStatus = "pending" | "ready" | "failed" | "timed_out";

export interface ManagedProcessReadinessResult {
  type: ManagedProcessReadinessProbe["type"];
  status: ManagedProcessReadinessStatus;
  passed: boolean;
  attempts: number;
  checkedAt: string;
  durationMs: number;
  message?: string;
  httpStatus?: number;
}

export interface ManagedProcessCleanupResult {
  status: "pending" | "stopped" | "not_needed" | "failed" | "transferred";
  at?: string;
  reason?: string;
  message?: string;
}

export interface ManagedProcessSnapshot {
  processId: string;
  pid: number;
  processGroupId?: number;
  command: string;
  cwd: string;
  state: ManagedProcessState;
  logPath: string;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  url?: string;
  readiness?: ManagedProcessReadinessResult;
  cleanup: ManagedProcessCleanupResult;
}

export interface StartManagedProcessOptions {
  command: string;
  /** 实际命令经过沙箱包装时，快照仍展示用户批准的原始命令。 */
  displayCommand?: string;
  cwd?: string;
  url?: string;
  readiness?: ManagedProcessReadinessProbe;
  signal?: AbortSignal;
}

export interface ReadManagedProcessOutputOptions {
  offset?: number;
  maxBytes?: number;
  fromEnd?: boolean;
}

export interface ManagedProcessOutput {
  processId: string;
  logPath: string;
  content: string;
  startOffset: number;
  nextOffset: number;
  totalBytes: number;
  omittedBefore: boolean;
  hasMore: boolean;
  /** Unconsumed live UTF-8 prefix; wait for output or exit, then retry nextOffset. */
  pendingUtf8Bytes?: number;
}

export interface ManagedProcessServiceOptions {
  workspaceRoot: string;
  persistenceRoot?: string;
  processLifetime?: ManagedProcessLifetime;
  terminationGraceMs?: number;
  killSettleMs?: number;
}

export type ManagedProcessLifetime = "runtime" | "execution-environment";

interface ManagedProcessRecord {
  snapshot: ManagedProcessSnapshot;
  logBinding: ManagedProcessLogBinding;
  child: ChildProcess;
  stopRequested: boolean;
}

interface ProbeObservation {
  ready: boolean;
  message?: string;
  httpStatus?: number;
}

/** Error returned when a caller references an unknown runtime process ID. */
export class UnknownManagedProcessError extends Error {
  constructor(readonly processId: string) {
    super(`Unknown managed process: ${processId}`);
    this.name = "UnknownManagedProcessError";
  }
}

export class ManagedProcessService {
  private readonly workspaceRoot: string;
  private readonly persistenceRoot: string;
  private readonly processRoot: string;
  private readonly lifecycleLogPath: string;
  private readonly processLifetime: ManagedProcessLifetime;
  private readonly terminationGraceMs: number;
  private readonly killSettleMs: number;
  private readonly records = new Map<string, ManagedProcessRecord>();
  private initialization: Promise<void> | undefined;
  private closePromise: Promise<ManagedProcessCleanupResult[]> | undefined;
  private closing = false;

  constructor(options: ManagedProcessServiceOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    const persistenceRoot = path.resolve(options.persistenceRoot ?? options.workspaceRoot);
    this.persistenceRoot = persistenceRoot;
    this.processRoot = path.join(agentDir(persistenceRoot), "processes");
    this.lifecycleLogPath = path.join(this.processRoot, "lifecycle.jsonl");
    this.processLifetime = options.processLifetime ?? "runtime";
    this.terminationGraceMs = options.terminationGraceMs ?? defaultTerminationGraceMs;
    this.killSettleMs = options.killSettleMs ?? defaultKillSettleMs;
    if (![this.terminationGraceMs, this.killSettleMs].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new RangeError("Managed process grace durations must be non-negative finite numbers.");
    }
  }

  async initialize(): Promise<void> {
    if (!this.initialization) this.initialization = ensureAgentDirs(this.persistenceRoot);
    await this.initialization;
  }

  async start(options: StartManagedProcessOptions): Promise<ManagedProcessSnapshot> {
    if (this.closing) throw new Error("Managed process service is closing.");
    options.signal?.throwIfAborted();
    if (!options.command.trim()) throw new Error("Managed process command must not be empty.");
    validateReadinessProbe(options.readiness);
    await this.initialize();

    const processId = randomUUID();
    const cwd = await resolveManagedCwd(this.workspaceRoot, options.cwd);
    const logPath = path.join(await realpath(this.processRoot), `${processId}.log`);
    const startedAt = new Date().toISOString();
    const logFile = await open(logPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    let record: ManagedProcessRecord;
    let spawned: Promise<void>;
    try {
      await logFile.writeFile(`[biny] ${startedAt} starting managed process ${processId}\n`, "utf8");
      const logBinding = await bindManagedProcessLog(logPath, logFile);
      // Shutdown may have completed while the filesystem preparation was pending.
      if (this.closing) throw new Error("Managed process service is closing.");
      const child = spawn(options.command, {
        cwd,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", logFile.fd, logFile.fd],
        windowsHide: true
      });
      // Closing a FileHandle yields to the event loop; install spawn/error listeners first.
      spawned = waitForSpawn(child, options.signal);
      void spawned.catch(() => undefined);

      const pid = child.pid;
      if (pid === undefined) {
        child.kill();
        throw new Error("Managed process did not receive an operating-system PID.");
      }
      const snapshot: ManagedProcessSnapshot = {
        processId,
        pid,
        processGroupId: process.platform === "win32" ? undefined : pid,
        command: options.displayCommand ?? options.command,
        cwd,
        state: "starting",
        logPath,
        startedAt,
        url: options.url ?? (options.readiness?.type === "http" ? options.readiness.url : undefined),
        readiness: options.readiness
          ? {
              type: options.readiness.type,
              status: "pending",
              passed: false,
              attempts: 0,
              checkedAt: startedAt,
              durationMs: 0
            }
          : undefined,
        cleanup: { status: "pending" }
      };
      // Publish ownership before yielding again so close() cannot miss a spawned child.
      record = { snapshot, logBinding, child, stopRequested: false };
      this.records.set(processId, record);
      this.observeChild(record);
    } finally {
      await logFile.close();
    }

    const { snapshot, child } = record;
    try {
      await spawned;
      if (snapshot.state === "starting") snapshot.state = "running";
      child.unref();
      await this.recordLifecycle("started", snapshot);
      if (options.readiness) {
        snapshot.readiness = await this.waitForReadiness(record, options.readiness, options.signal);
      }
      this.refreshRecord(record);
      await this.recordLifecycle("start_result", snapshot);
      return cloneSnapshot(snapshot);
    } catch (error) {
      if (options.signal?.aborted) {
        await this.stop(processId, "background Bash start aborted").catch(() => undefined);
      } else {
        this.refreshRecord(record);
        if (snapshot.state === "starting") snapshot.state = "failed";
        await this.recordLifecycle("start_failed", snapshot, errorMessage(error));
        // 启动检查失败后仍由 Runtime 回收进程，避免返回错误时留下失去所有权的服务。
        if (isRunningState(snapshot.state)) {
          await this.stop(processId, "readiness probe failed").catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async status(processId: string): Promise<ManagedProcessSnapshot> {
    const record = this.requireRecord(processId);
    this.refreshRecord(record);
    return cloneSnapshot(record.snapshot);
  }

  async list(options: { includeExited?: boolean } = {}): Promise<ManagedProcessSnapshot[]> {
    const snapshots: ManagedProcessSnapshot[] = [];
    for (const record of this.records.values()) {
      this.refreshRecord(record);
      if (options.includeExited === false && !isRunningState(record.snapshot.state)) continue;
      snapshots.push(cloneSnapshot(record.snapshot));
    }
    return snapshots.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  outputPath(processId: string): string {
    return this.requireRecord(processId).logBinding.path;
  }

  async readOutput(processId: string, options: ReadManagedProcessOutputOptions = {}, signal?: AbortSignal): Promise<ManagedProcessOutput> {
    const record = this.requireRecord(processId);
    this.refreshRecord(record);
    // Freeze before any log await: exit after the size snapshot cannot finalize that snapshot.
    const final = !isRunningState(record.snapshot.state);
    return { processId, ...await readManagedProcessLog(record.logBinding, options, signal, { final }) };
  }

  async stop(processId: string, reason = "KillShell requested"): Promise<ManagedProcessSnapshot> {
    const record = this.requireRecord(processId);
    this.refreshRecord(record);
    if (!isRunningState(record.snapshot.state)) {
      if (record.snapshot.cleanup.status === "pending") {
        record.snapshot.cleanup = {
          status: "not_needed",
          at: new Date().toISOString(),
          reason
        };
      }
      await this.recordLifecycle("stop_not_needed", record.snapshot);
      return cloneSnapshot(record.snapshot);
    }

    record.stopRequested = true;
    const trackedPids = new Set<number>([record.snapshot.pid]);
    for (const pid of await descendantProcessIds([record.snapshot.pid])) trackedPids.add(pid);
    await this.recordLifecycle("stopping", record.snapshot, reason);

    let stopped = false;
    let stopMessage: string | undefined;
    try {
      if (process.platform === "win32") {
        await killWindowsProcessTree(record.snapshot.pid, this.terminationGraceMs + this.killSettleMs);
      } else {
        signalTrackedProcesses(trackedPids, "SIGTERM");
        signalProcessGroup(record.snapshot.pid, "SIGTERM");
        stopped = await waitUntilStopped(record.snapshot.pid, trackedPids, this.terminationGraceMs);
        if (!stopped) {
          for (const pid of await descendantProcessIds([...trackedPids])) trackedPids.add(pid);
          signalTrackedProcesses(trackedPids, "SIGKILL");
          signalProcessGroup(record.snapshot.pid, "SIGKILL");
        }
      }
      if (process.platform === "win32") stopped = !pidExists(record.snapshot.pid);
      else if (!stopped) stopped = await waitUntilStopped(record.snapshot.pid, trackedPids, this.killSettleMs);
      else stopped = true;
    } catch (error) {
      stopMessage = errorMessage(error);
    }

    const now = new Date().toISOString();
    if (stopped) {
      record.snapshot.state = "stopped";
      record.snapshot.exitedAt ??= now;
      record.snapshot.cleanup = {
        status: "stopped",
        at: now,
        reason
      };
      await this.recordLifecycle("stopped", record.snapshot);
    } else {
      this.refreshRecord(record);
      record.snapshot.cleanup = {
        status: "failed",
        at: now,
        reason,
        message: stopMessage ?? "Process group remained alive after SIGKILL."
      };
      await this.recordLifecycle("stop_failed", record.snapshot, record.snapshot.cleanup.message);
    }
    return cloneSnapshot(record.snapshot);
  }

  close(): Promise<ManagedProcessCleanupResult[]> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        await this.initialize();
      } catch (error) {
        if (this.records.size === 0) return [];
        throw error;
      }
      return await Promise.all([...this.records.values()].map(async (record): Promise<ManagedProcessCleanupResult> => {
        this.refreshRecord(record);
        if (!isRunningState(record.snapshot.state)) {
          if (record.snapshot.cleanup.status === "pending") {
            record.snapshot.cleanup = {
              status: "not_needed",
              at: new Date().toISOString(),
              reason: "runtime close"
            };
            await this.recordLifecycle("cleanup_not_needed", record.snapshot);
          }
          return { ...record.snapshot.cleanup };
        }
        if (this.processLifetime === "execution-environment") {
          const at = new Date().toISOString();
          record.child.unref();
          record.snapshot.cleanup = {
            status: "transferred",
            at,
            reason: "execution environment owns process lifetime"
          };
          await this.recordLifecycle("process_ownership_transferred", record.snapshot);
          return { ...record.snapshot.cleanup };
        }
        const stopped = await this.stop(record.snapshot.processId, "runtime close");
        return { ...stopped.cleanup };
      }));
    })();
    return this.closePromise;
  }

  private requireRecord(processId: string): ManagedProcessRecord {
    const record = this.records.get(processId);
    if (!record) throw new UnknownManagedProcessError(processId);
    return record;
  }

  private observeChild(record: ManagedProcessRecord): void {
    record.child.once("error", (error) => {
      record.snapshot.state = "failed";
      record.snapshot.exitedAt = new Date().toISOString();
      record.snapshot.cleanup = {
        status: "not_needed",
        at: record.snapshot.exitedAt,
        message: error.message
      };
      void this.recordLifecycle("process_error", record.snapshot, error.message);
    });
    record.child.once("exit", (code, signal) => {
      const groupAlive = process.platform !== "win32" && processGroupExists(record.snapshot.pid);
      if (groupAlive) {
        record.snapshot.state = "running";
        return;
      }
      record.snapshot.exitCode = code ?? undefined;
      record.snapshot.signal = signal ?? undefined;
      record.snapshot.exitedAt = new Date().toISOString();
      record.snapshot.state = record.stopRequested ? "stopped" : code === 0 ? "exited" : "failed";
      if (record.snapshot.cleanup.status === "pending" && !record.stopRequested) {
        record.snapshot.cleanup = {
          status: "not_needed",
          at: record.snapshot.exitedAt,
          reason: "process exited"
        };
      }
      void this.recordLifecycle("exited", record.snapshot);
    });
  }

  private refreshRecord(record: ManagedProcessRecord): void {
    if (isRunningState(record.snapshot.state) && !managedProcessExists(record.snapshot.pid)) {
      record.snapshot.exitCode = record.child.exitCode ?? record.snapshot.exitCode;
      record.snapshot.signal = record.child.signalCode ?? record.snapshot.signal;
      record.snapshot.exitedAt ??= new Date().toISOString();
      record.snapshot.state = record.stopRequested
        ? "stopped"
        : record.snapshot.exitCode === 0
          ? "exited"
          : "failed";
      if (record.snapshot.cleanup.status === "pending" && !record.stopRequested) {
        record.snapshot.cleanup = {
          status: "not_needed",
          at: record.snapshot.exitedAt,
          reason: "process exited"
        };
      }
    }
  }

  private async waitForReadiness(
    record: ManagedProcessRecord,
    probe: ManagedProcessReadinessProbe,
    signal?: AbortSignal
  ): Promise<ManagedProcessReadinessResult> {
    const started = Date.now();
    const timeoutMs = probe.timeoutMs ?? defaultReadinessTimeoutMs;
    const intervalMs = probe.intervalMs ?? defaultReadinessIntervalMs;
    const deadline = started + timeoutMs;
    let attempts = 0;
    let lastObservation: ProbeObservation = { ready: false, message: "Readiness probe has not run." };

    while (true) {
      signal?.throwIfAborted();
      this.refreshRecord(record);
      attempts += 1;
      if (isRunningState(record.snapshot.state) && !record.stopRequested) {
        lastObservation = await runReadinessProbe(record.snapshot.logPath, probe, Math.max(1, deadline - Date.now()), signal);
        // A probe can finish after exit, stop, or cancellation. Revalidate its owner
        // before accepting either readiness or timeout from that observation.
        signal?.throwIfAborted();
        this.refreshRecord(record);
      }
      if (!isRunningState(record.snapshot.state) || record.stopRequested) {
        return {
          type: probe.type,
          status: "failed",
          passed: false,
          attempts,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          message: record.stopRequested
            ? "Process stop requested before readiness."
            : `Process exited before readiness (${record.snapshot.state}).`
        };
      }

      if (lastObservation.ready) {
        return {
          type: probe.type,
          status: "ready",
          passed: true,
          attempts,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          message: lastObservation.message,
          httpStatus: lastObservation.httpStatus
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          type: probe.type,
          status: "timed_out",
          passed: false,
          attempts,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          message: lastObservation.message ?? `Readiness timed out after ${String(timeoutMs)}ms.`,
          httpStatus: lastObservation.httpStatus
        };
      }
      await abortableDelay(Math.min(intervalMs, remaining), signal);
    }
  }

  private async recordLifecycle(event: string, snapshot: ManagedProcessSnapshot, message?: string): Promise<void> {
    await this.initialize();
    const entry = JSON.stringify({
      at: new Date().toISOString(),
      event,
      processId: snapshot.processId,
      pid: snapshot.pid,
      state: snapshot.state,
      readiness: snapshot.readiness,
      cleanup: snapshot.cleanup,
      message
    });
    await appendFile(this.lifecycleLogPath, `${entry}\n`, "utf8").catch(() => undefined);
  }
}

async function resolveManagedCwd(workspaceRoot: string, requested: string | undefined): Promise<string> {
  const resolved = requested !== undefined && path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(workspaceRoot, requested ?? ".");
  if (requested === undefined || !path.isAbsolute(requested)) {
    const relative = path.relative(workspaceRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Managed process cwd must stay inside the workspace.");
    }
  }
  const [canonicalWorkspace, canonicalCwd] = await Promise.all([
    realpath(workspaceRoot),
    realpath(resolved)
  ]);
  const canonicalRelative = path.relative(canonicalWorkspace, canonicalCwd);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error("Managed process cwd must not escape the workspace through a symbolic link.");
  }
  if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("Managed process cwd must be a directory.");
  return canonicalCwd;
}

function validateReadinessProbe(probe: ManagedProcessReadinessProbe | undefined): void {
  if (!probe) return;
  const timeoutMs = probe.timeoutMs ?? defaultReadinessTimeoutMs;
  const intervalMs = probe.intervalMs ?? defaultReadinessIntervalMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError("Readiness timeoutMs must be positive.");
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError("Readiness intervalMs must be positive.");
  if (probe.type === "http") {
    const url = new URL(probe.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("HTTP readiness requires an http:// or https:// URL.");
    const expectedStatus = probe.expectedStatus ?? 200;
    if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
      throw new RangeError("HTTP readiness expectedStatus must be between 100 and 599.");
    }
  } else if (probe.type === "tcp") {
    if (!probe.host.trim()) throw new Error("TCP readiness host must not be empty.");
    if (!Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65_535) {
      throw new RangeError("TCP readiness port must be between 1 and 65535.");
    }
  } else {
    if (!probe.pattern) throw new Error("Log readiness pattern must not be empty.");
    if (probe.regex) new RegExp(probe.pattern, "u");
  }
}

async function runReadinessProbe(
  logPath: string,
  probe: ManagedProcessReadinessProbe,
  remainingMs: number,
  signal?: AbortSignal
): Promise<ProbeObservation> {
  const probeTimeoutMs = Math.max(1, Math.min(defaultProbeTimeoutMs, remainingMs));
  if (probe.type === "http") return await probeHttp(probe, probeTimeoutMs, signal);
  if (probe.type === "tcp") return await probeTcp(probe, probeTimeoutMs, signal);
  return await probeLog(logPath, probe);
}

async function probeHttp(probe: HttpReadinessProbe, timeoutMs: number, signal?: AbortSignal): Promise<ProbeObservation> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await fetch(probe.url, { method: "GET", redirect: "follow", signal: combinedSignal });
    const expectedStatus = probe.expectedStatus ?? 200;
    await response.body?.cancel().catch(() => undefined);
    return {
      ready: response.status === expectedStatus,
      httpStatus: response.status,
      message: response.status === expectedStatus
        ? `HTTP readiness returned ${String(response.status)}.`
        : `HTTP readiness returned ${String(response.status)}; expected ${String(expectedStatus)}.`
    };
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    return { ready: false, message: `HTTP readiness failed: ${errorMessage(error)}` };
  }
}

async function probeTcp(probe: TcpReadinessProbe, timeoutMs: number, signal?: AbortSignal): Promise<ProbeObservation> {
  return await new Promise<ProbeObservation>((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host: probe.host, port: probe.port });
    const settle = (observation?: ProbeObservation, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(observation ?? { ready: false });
    };
    const onAbort = () => settle(undefined, abortReason(signal));
    const timer = setTimeout(() => settle({ ready: false, message: `TCP readiness timed out after ${String(timeoutMs)}ms.` }), timeoutMs);
    socket.once("connect", () => settle({ ready: true, message: `TCP readiness connected to ${probe.host}:${String(probe.port)}.` }));
    socket.once("error", (error) => settle({ ready: false, message: `TCP readiness failed: ${error.message}` }));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function probeLog(logPath: string, probe: LogReadinessProbe): Promise<ProbeObservation> {
  let contents: string;
  try {
    const metadata = await stat(logPath);
    const file = await open(logPath, "r");
    try {
      const start = Math.max(0, metadata.size - maxReadinessLogBytes);
      const buffer = Buffer.alloc(Math.min(maxReadinessLogBytes, metadata.size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      contents = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    return { ready: false, message: `Log readiness failed: ${errorMessage(error)}` };
  }
  const matched = probe.regex ? new RegExp(probe.pattern, "u").test(contents) : contents.includes(probe.pattern);
  return {
    ready: matched,
    message: matched ? `Log readiness matched ${JSON.stringify(probe.pattern)}.` : `Log readiness is waiting for ${JSON.stringify(probe.pattern)}.`
  };
}

function waitForSpawn(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onSpawn = () => settle();
    const onError = (error: Error) => settle(error);
    const onAbort = () => settle(abortReason(signal));
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function cloneSnapshot(snapshot: ManagedProcessSnapshot): ManagedProcessSnapshot {
  return {
    ...snapshot,
    readiness: snapshot.readiness ? { ...snapshot.readiness } : undefined,
    cleanup: { ...snapshot.cleanup }
  };
}

function isRunningState(state: ManagedProcessState): boolean {
  return state === "starting" || state === "running";
}

function managedProcessExists(pid: number): boolean {
  return process.platform === "win32" ? pidExists(pid) : processGroupExists(pid) || pidExists(pid);
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") return pidExists(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // macOS 对 detached 进程组可能返回 EPERM；逐 PID 信号和后续 SIGKILL
    // 仍会继续执行，不能因为组信号这条 best-effort 路径失败而提前放弃收口。
    if (!isNoSuchProcessError(error) && !isPermissionError(error)) throw error;
  }
}

function signalTrackedProcesses(pids: ReadonlySet<number>, signal: NodeJS.Signals): void {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!isNoSuchProcessError(error)) {
        // The process group signal and bounded settle still provide cleanup.
      }
    }
  }
}

async function waitUntilStopped(groupPid: number, trackedPids: ReadonlySet<number>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processGroupExists(groupPid) && ![...trackedPids].some(pidExists)) return true;
    await abortableDelay(Math.min(25, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return !processGroupExists(groupPid) && ![...trackedPids].some(pidExists);
}

async function killWindowsProcessTree(pid: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      killer.kill();
      resolve();
    }, timeoutMs);
    killer.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function descendantProcessIds(rootPids: readonly number[]): Promise<number[]> {
  if (process.platform === "win32" || rootPids.length === 0) return [];
  let output: string;
  try {
    output = await new Promise<string>((resolve, reject) => {
      const processList = spawn("ps", ["-axo", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] });
      let result = "";
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        processList.kill("SIGKILL");
        settle(new Error("Timed out while inspecting the process tree."));
      }, 250);
      processList.stdout?.on("data", (chunk: Buffer) => {
        if (result.length < 4 * 1024 * 1024) result += chunk.toString("utf8");
      });
      processList.once("error", (error) => settle(error));
      processList.once("close", (code) => code === 0 ? settle() : settle(new Error(`ps exited with ${String(code)}`)));
    });
  } catch {
    return [];
  }

  const children = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) continue;
    const childPids = children.get(parentPid) ?? [];
    childPids.push(pid);
    children.set(parentPid, childPids);
  }
  const roots = new Set(rootPids);
  const descendants = new Set<number>();
  const pending = [...roots];
  while (pending.length) {
    const parent = pending.pop();
    if (parent === undefined) continue;
    for (const child of children.get(parent) ?? []) {
      if (roots.has(child) || descendants.has(child)) continue;
      descendants.add(child);
      pending.push(child);
    }
  }
  return [...descendants];
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
