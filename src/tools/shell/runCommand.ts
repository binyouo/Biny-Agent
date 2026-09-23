/**
 * Shell 命令工具模块。
 *
 * `Bash` 在当前工作区执行本地 shell 命令，并把 stdout、stderr 和退出码统一返回。
 * 命令是否安全、是否需要确认由权限层处理，这里只负责受限超时和输出收集。
 */
import { homedir, tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { ToolAccesses } from "../access.js";
import { describeSandbox, sandboxCommand, type SandboxOptions } from "./sandbox.js";
import type { SandboxConfig } from "../../config/schema.js";
import type {
  ManagedProcessReadinessProbe,
  ManagedProcessService,
  ManagedProcessSnapshot
} from "../../runtime/ManagedProcessService.js";
import type { Tool, ToolContext, ToolUpdate } from "../types.js";
import { resolveWorkspaceDirectory } from "../../workspace/resolvePath.js";
import { managedProcessReadinessParameters, managedProcessReadinessSchema } from "../process/managedProcesses.js";

const maxOutputBytes = 1024 * 1024;
/** 普通调用仍只保留 1MiB；Bash 工具会在这个更大的边界内尽量保留全文，交给上层归档。 */
const maxCapturedOutputBytes = 8 * 1024 * 1024;
const defaultTimeoutMs = 120_000;
const defaultTerminationGraceMs = 1_000;
const defaultKillSettleMs = 1_000;

export interface RunCommandArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
  url?: string;
  readiness?: ManagedProcessReadinessProbe;
}

export type RunCommandToolResult =
  | (RunCommandResult & { background: false })
  | { background: true; sandbox: string; process: ManagedProcessSnapshot };

export interface RunCommandResult {
  status: "completed" | "failed" | "timed_out";
  /** 这次执行实际生效的沙箱边界；未生效时说明原因。 */
  sandbox?: string;
  stdout: string;
  stderr: string;
  /** stdout 的原始 UTF-8 字节数；stdout 可能只保留了末尾。 */
  stdoutBytes: number;
  stdoutRetainedBytes: number;
  stdoutTruncated: boolean;
  stdoutTruncationDirection?: "tail";
  /** stderr 的原始 UTF-8 字节数；stderr 可能只保留了末尾。 */
  stderrBytes: number;
  stderrRetainedBytes: number;
  stderrTruncated: boolean;
  stderrTruncationDirection?: "tail";
  exitCode: number;
  error?: string;
}

export interface RunShellCommandOptions {
  signal?: AbortSignal;
  /** 追加到子进程环境的变量；不提供时继承当前进程环境。 */
  env?: Record<string, string>;
  onUpdate?: (update: ToolUpdate) => void;
  timeoutMs?: number;
  terminationGraceMs?: number;
  killSettleMs?: number;
  /** 工具调用尽量保留较大的完整输出，避免在回合归档之前丢掉前半段。 */
  captureFullOutput?: boolean;
  /** 完整输出捕获的硬上限，超过后仍保留尾部并明确标记。 */
  maxCapturedOutputBytes?: number;
}

export interface RunCommandToolOptions {
  /** 内部调用方可收紧单次命令超时；普通模型工具继续使用 runShellCommand 的默认值。 */
  timeoutMs?: number;
}

export function createRunCommandTool(
  context: ToolContext,
  sandbox?: SandboxConfig,
  options: RunCommandToolOptions = {},
  managedProcesses?: ManagedProcessService
): Tool<RunCommandArgs, RunCommandToolResult> {
  const sandboxOptions: SandboxOptions = { mode: sandbox?.mode ?? "off", allowNetwork: sandbox?.allowNetwork ?? true };
  const schema = z.object({
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    background: z.boolean().optional(),
    url: z.string().url().optional(),
    readiness: managedProcessReadinessSchema.optional()
  }).superRefine((args, refinement) => {
    if (args.background === true) {
      if (args.timeoutMs !== undefined) refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeoutMs"],
        message: "timeoutMs is only available for foreground commands; use readiness.timeoutMs to bound startup checks."
      });
      return;
    }
    for (const key of ["url", "readiness"] as const) {
      if (args[key] !== undefined) refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} requires background: true.`
      });
    }
  }) satisfies z.ZodType<RunCommandArgs>;
  return {
    name: "Bash",
    description: "Run a shell command in the workspace. Foreground commands have a bounded timeout; set background for servers and other long-running commands, then use BashOutput or KillShell with the returned process ID.",
    promptSnippet: "Run a finite command or start a managed background process",
    promptGuidelines: ["Use background instead of &, nohup, or disown for long-running commands; pass a workspace-relative cwd for commands in a subdirectory"],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "Shell command to run in the workspace." },
        cwd: { type: "string", minLength: 1, description: "Optional workspace-relative working directory." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 600_000, description: "Foreground timeout in milliseconds; defaults to 120000." },
        background: { type: "boolean", description: "Start a runtime-managed background process instead of waiting for completion." },
        url: { type: "string", description: "Optional user-facing URL for a background service." },
        readiness: managedProcessReadinessParameters
      },
      required: ["command"],
      additionalProperties: false
    },
    schema,
    capability: "shell.execute",
    risk: "execute",
    resolveExecution(args) {
      if (args.background === true && !managedProcesses) throw new Error("Background Bash is unavailable in this runtime.");
      if (args.background === true && args.timeoutMs !== undefined) {
        throw new Error("Background Bash does not accept timeoutMs; use readiness.timeoutMs to bound startup checks.");
      }
      if (args.background !== true && (args.url !== undefined || args.readiness !== undefined)) {
        throw new Error("Bash url and readiness require background: true.");
      }
      const preview = args.command.length > 80 ? `${args.command.slice(0, 80)}...` : args.command;
      const inferredCwd = inferredCommandCwd(args.command);
      const commandCwd = resolveWorkspaceDirectory(context.workspaceRoot, args.cwd ?? inferredCwd ?? ".", context.ignore);
      return {
        accesses: ToolAccesses.readWriteTree(commandCwd),
        display: { kind: "command", command: args.command, cwd: commandCwd, language: "bash" },
        description: `${args.background === true ? "Start background" : "Run"} ${preview}`,
        approvalRule: `Bash(${args.command})`,
        async execute({ signal, onUpdate, deniedPaths }) {
          const currentCwd = resolveWorkspaceDirectory(context.workspaceRoot, args.cwd ?? inferredCwd ?? ".", context.ignore);
          if (currentCwd !== commandCwd) throw new Error("The command working directory changed after the tool call was prepared.");
          const cwd = args.cwd || !inferredCwd ? commandCwd : context.workspaceRoot;
          const executionSandbox = { ...sandboxOptions, denyPaths: deniedPaths };
          const sandboxed = sandboxCommand(args.command, context.workspaceRoot, executionSandbox, {
            platform: process.platform,
            home: homedir(),
            temporaryDirectory: tmpdir()
          });
          const sandboxDescription = sandboxed.applied
            ? describeSandbox(executionSandbox, process.platform)
            : `not applied (${sandboxed.reason ?? "unknown"})`;
          if (args.background === true) {
            const process = await managedProcesses!.start({
              command: sandboxed.command,
              displayCommand: args.command,
              cwd,
              url: args.url,
              readiness: args.readiness,
              signal
            });
            return { background: true, sandbox: sandboxDescription, process };
          }
          const result = await runShellCommand(cwd, sandboxed.command, {
            signal,
            onUpdate,
            timeoutMs: args.timeoutMs ?? options.timeoutMs,
            captureFullOutput: true
          });
          // 如实回报这次到底有没有边界，避免"沙箱模式"这个名字暗示一个不存在的保护。
          return { ...result, background: false, sandbox: sandboxDescription };
        }
      };
    }
  };
}

function inferredCommandCwd(command: string): string | undefined {
  const match = command.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&/u);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export async function runShellCommand(cwd: string, command: string, options: RunShellCommandOptions = {}): Promise<RunCommandResult> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const terminationGraceMs = options.terminationGraceMs ?? defaultTerminationGraceMs;
  const killSettleMs = options.killSettleMs ?? defaultKillSettleMs;
  const outputLimitBytes = options.captureFullOutput
    ? Math.min(options.maxCapturedOutputBytes ?? maxCapturedOutputBytes, maxCapturedOutputBytes)
    : maxOutputBytes;
  if (![timeoutMs, terminationGraceMs, killSettleMs].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new RangeError("Shell timeout and grace durations must be non-negative finite numbers.");
  }
  if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1) {
    throw new RangeError("Shell output capture limit must be a positive safe integer.");
  }

  return await new Promise<RunCommandResult>((resolve, reject) => {
    options.signal?.throwIfAborted();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let outputFinalized = false;
    let settled = false;
    let stopReason: "abort" | "timeout" | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let killSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let windowsTreeKill: ChildProcess | undefined;
    let windowsTreeKillPending = false;
    const trackedUnixPids = new Set<number>();
    let unixStopInitialized = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {})
    });

    const appendDiagnostic = (message: string) => {
      const text = `${stderr ? "\n" : ""}${message}`;
      stderrBytes += Buffer.byteLength(text, "utf8");
      stderr = appendCappedToLimit(stderr, text, outputLimitBytes);
      options.onUpdate?.({ kind: "stderr", text });
    };
    const onStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      const text = stdoutDecoder.write(chunk);
      stdout = appendCappedToLimit(stdout, text, outputLimitBytes);
      if (text) options.onUpdate?.({ kind: "stdout", text });
    };
    const onStderr = (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      const text = stderrDecoder.write(chunk);
      stderr = appendCappedToLimit(stderr, text, outputLimitBytes);
      if (text) options.onUpdate?.({ kind: "stderr", text });
    };
    const finalizeOutput = (): void => {
      if (outputFinalized) return;
      outputFinalized = true;
      const stdoutRemainder = stdoutDecoder.end();
      const stderrRemainder = stderrDecoder.end();
      stdout = appendCappedToLimit(stdout, stdoutRemainder, outputLimitBytes);
      stderr = appendCappedToLimit(stderr, stderrRemainder, outputLimitBytes);
      if (stdoutRemainder) options.onUpdate?.({ kind: "stdout", text: stdoutRemainder });
      if (stderrRemainder) options.onUpdate?.({ kind: "stderr", text: stderrRemainder });
    };
    const cleanup = () => {
      clearTimeout(commandTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (killSettleTimer) clearTimeout(killSettleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      windowsTreeKill?.removeAllListeners();
      windowsTreeKill?.unref();
    };
    const settleStopped = () => {
      if (stopReason === "abort") {
        settle(abortReason(options.signal));
        return;
      }
      settle(undefined, 124, "timed_out");
    };
    const settle = (error: unknown, exitCode?: number, stopStatus?: Extract<RunCommandResult["status"], "timed_out">) => {
      if (settled) return;
      settled = true;
      cleanup();
      finalizeOutput();
      if (error !== undefined) {
        reject(error);
        return;
      }
      const resolvedExitCode = exitCode ?? 1;
      const status = stopStatus ?? (resolvedExitCode === 0 ? "completed" : "failed");
      const failureMessage = status === "timed_out"
        ? `Command timed out after ${String(timeoutMs)}ms.`
        : status === "failed" ? `Command exited with code ${String(resolvedExitCode)}.` : undefined;
      options.onUpdate?.({
        kind: "status",
        text: status === "timed_out" ? `Timed out with exit code ${String(resolvedExitCode)}` : `Exited with ${String(resolvedExitCode)}`
      });
      const stdoutRetainedBytes = Buffer.byteLength(stdout, "utf8");
      const stderrRetainedBytes = Buffer.byteLength(stderr, "utf8");
      const stdoutTruncated = stdoutBytes > stdoutRetainedBytes;
      const stderrTruncated = stderrBytes > stderrRetainedBytes;
      resolve({
        status,
        stdout,
        stderr,
        stdoutBytes,
        stdoutRetainedBytes,
        stdoutTruncated,
        stdoutTruncationDirection: stdoutTruncated ? "tail" : undefined,
        stderrBytes,
        stderrRetainedBytes,
        stderrTruncated,
        stderrTruncationDirection: stderrTruncated ? "tail" : undefined,
        exitCode: resolvedExitCode,
        error: failureMessage
      });
    };
    const forceKill = async () => {
      if (settled) return;
      options.onUpdate?.({ kind: "status", text: "Command did not stop after SIGTERM; sending SIGKILL." });
      if (child.pid !== undefined) {
        for (const pid of await descendantProcessIds([child.pid, ...trackedUnixPids])) trackedUnixPids.add(pid);
      }
      if (settled) return;
      signalTrackedProcesses(trackedUnixPids, "SIGKILL");
      signalProcessGroup(child, "SIGKILL");
      killSettleTimer = setTimeout(() => {
        if (settled) return;
        // Never leave the agent waiting forever for a broken child-process close event.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settleStopped();
      }, killSettleMs);
    };
    const killWindowsProcessTree = () => {
      if (settled || child.pid === undefined) {
        settleStopped();
        return;
      }
      windowsTreeKillPending = true;
      windowsTreeKill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      windowsTreeKill.once("close", () => {
        windowsTreeKillPending = false;
        settleStopped();
      });
      windowsTreeKill.once("error", () => {
        // Fall back to the direct child. The hard-settle timer remains active;
        // Windows installations normally provide taskkill for process-tree cleanup.
        try {
          child.kill();
        } catch {
          // The hard-settle timer still guarantees a bounded caller wait.
        }
      });
      killSettleTimer = setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settleStopped();
      }, terminationGraceMs + killSettleMs);
    };
    const requestStop = (reason: "abort" | "timeout") => {
      if (settled) return;
      clearTimeout(commandTimer);
      if (!stopReason) {
        stopReason = reason;
        if (reason === "abort") appendDiagnostic("Command interrupted.");
        else appendDiagnostic(`Command timed out after ${String(timeoutMs)}ms.`);
        if (process.platform === "win32") {
          killWindowsProcessTree();
          return;
        }
        void (async () => {
          if (child.pid !== undefined) {
            trackedUnixPids.add(child.pid);
            for (const pid of await descendantProcessIds([child.pid])) trackedUnixPids.add(pid);
          }
          if (settled) return;
          unixStopInitialized = true;
          // Snapshot descendants before terminating the original process group;
          // otherwise a setsid/double-fork child can be re-parented and disappear
          // from the tree before we learn its pid.
          signalTrackedProcesses(trackedUnixPids, "SIGTERM");
          signalProcessGroup(child, "SIGTERM");
          if (!processGroupExists(child) && !trackedProcessesExist(trackedUnixPids)) {
            settleStopped();
            return;
          }
          terminationTimer = setTimeout(() => { void forceKill(); }, terminationGraceMs);
        })();
        return;
      }
      if (reason === "abort") stopReason = "abort";
    };
    function onAbort(): void {
      requestStop("abort");
    }
    function onError(error: Error): void {
      if (stopReason) {
        if (process.platform === "win32") {
          if (!windowsTreeKillPending) settleStopped();
        } else if (unixStopInitialized && !processGroupExists(child) && !trackedProcessesExist(trackedUnixPids)) {
          settleStopped();
        }
        return;
      }
      settle(error);
    }
    function onClose(code: number | null): void {
      if (stopReason) {
        if (process.platform === "win32") {
          if (!windowsTreeKillPending) settleStopped();
          return;
        }
        // The shell can exit before a background descendant. Keep the grace/KILL
        // timers alive until the whole process group is gone.
        if (unixStopInitialized && !processGroupExists(child) && !trackedProcessesExist(trackedUnixPids)) settleStopped();
        return;
      }
      settle(undefined, typeof code === "number" ? code : 1);
    }

    const commandTimer = setTimeout(() => requestStop("timeout"), timeoutMs);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    options.onUpdate?.({ kind: "status", text: `Started: ${command}` });

    // Abort cannot normally fire between the pre-spawn check and listener setup on
    // the same JS turn, but this closes the boundary for custom AbortSignal shims.
    if (options.signal?.aborted) requestStop("abort");
  });
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (isNoSuchProcessError(error)) return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The hard-settle timer still guarantees that the caller is released even
    // when the OS refuses or races a process signal.
  }
}

function processGroupExists(child: ChildProcess): boolean {
  if (child.pid === undefined || process.platform === "win32") return !child.killed;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

async function descendantProcessIds(rootPids: readonly number[]): Promise<number[]> {
  if (process.platform === "win32" || rootPids.length === 0) return [];
  let output = "";
  try {
    output = await new Promise<string>((resolve, reject) => {
      const processList = spawn("ps", ["-axo", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] });
      let result = "";
      let finished = false;
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          processList.kill("SIGKILL");
        } catch {
          // The rejection below still bounds cancellation if ps cannot be killed.
        }
        finish(new Error("Timed out while inspecting the process tree."));
      }, 250);
      processList.stdout?.on("data", (chunk: Buffer) => {
        if (result.length < 4 * 1024 * 1024) result += chunk.toString("utf8");
      });
      processList.once("error", (error) => finish(error));
      processList.once("close", (code) => {
        if (code === 0) finish();
        else finish(new Error(`ps exited with ${String(code)}`));
      });
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
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const roots = new Set(rootPids);
  const descendants = new Set<number>();
  const pending = [...roots];
  while (pending.length) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const pid of children.get(parentPid) ?? []) {
      if (roots.has(pid) || descendants.has(pid)) continue;
      descendants.add(pid);
      pending.push(pid);
    }
  }
  return [...descendants];
}

function signalTrackedProcesses(pids: ReadonlySet<number>, signal: NodeJS.Signals): void {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!isNoSuchProcessError(error)) {
        // The bounded settle path still releases the caller if signalling is denied.
      }
    }
  }
}

function trackedProcessesExist(pids: ReadonlySet<number>): boolean {
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (!isNoSuchProcessError(error)) return true;
    }
  }
  return false;
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

export function appendCapped(current: string, chunk: string): string {
  return appendCappedToLimit(current, chunk, maxOutputBytes);
}

function appendCappedToLimit(current: string, chunk: string, limitBytes: number): string {
  const next = `${current}${chunk}`;
  const byteLength = Buffer.byteLength(next, "utf8");
  if (byteLength <= limitBytes) return next;
  // 上限按字节计，截断也必须按字节来：起点落在多字节字符中间时前进到下一个字符边界，
  // 避免在输出开头留下半个 UTF-8 序列。
  const buffer = Buffer.from(next, "utf8");
  let start = byteLength - limitBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}
