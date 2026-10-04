// 自研 macOS 原生 driver：spawn native/computer-use daemon 并通过 unix socket 通信。
// 协议：换行分隔 JSON，{"id","cmd","args"} → {"id","ok","data"|"error"}。
// daemon 是独立的 Swift 可执行文件（native/computer-use），不依赖任何第三方 SDK。
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import type { ComputerDriver, DriverReply } from "./controller.js";
import type { ComputerAction, WindowTarget } from "./protocol.js";

const maxIpcBytes = 2 * 1024 * 1024;
const maxPending = 32;
const requestTimeoutMs = 30_000;
const shutdownTimeoutMs = 2_000;
const idleTimeoutMs = 900_000;

interface PendingJob {
  resolve: (value: DriverReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

interface Host {
  child: ChildProcess;
  socket: net.Socket;
  socketPath: string;
  buffer: string;
  closed: boolean;
  connected: boolean;
  stdout: string;
}

export interface NativeDriverOptions {
  binaryPath?: string;
  socketDir?: string;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/** 把 daemon 的 elements 数组映射成 captureSchema 需要的形状。 */
function toCapture(data: Record<string, unknown>, windowId: number): Record<string, unknown> {
  const elements = Array.isArray(data.elements) ? (data.elements as Record<string, unknown>[]) : [];
  return {
    pid: data.pid,
    window_id: windowId,
    capture_id: crypto.randomUUID(),
    screenshot_width: data.screenshotWidth ?? 0,
    screenshot_height: data.screenshotHeight ?? 0,
    screenshot_frame_valid: true,
    elements: elements.map(element => ({
      element_token: typeof element.ref === "string" ? element.ref : undefined,
      role: element.role,
      title: element.title,
      value: element.value,
      frame: element.frame,
      enabled: element.enabled
    }))
  };
}

export class NativeProcessDriver implements ComputerDriver {
  private host?: Host;
  private readonly pending = new Map<string, PendingJob>();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private enabled = false;
  private disposed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly socketPath: string;
  private readonly binaryPath: string;

  constructor(private readonly onExit: () => void, options: NativeDriverOptions = {}) {
    this.binaryPath = options.binaryPath ?? NativeProcessDriver.resolveBinary();
    this.socketPath = path.join(
      options.socketDir ?? path.join(os.homedir(), "Library", "Application Support", "alma"),
      `biny-computer-use-${crypto.createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8)}.sock`
    );
  }

  static resolveBinary(): string {
    // 开发期（源码树）与打包期（app.asar.unpacked）两条路径。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates: string[] = [
      path.resolve(here, "../../out/native/computer-use"),
      path.resolve(here, "../../../out/native/computer-use"),
      // 打包后 import.meta.url 指向 out/main/index.js；用工作目录兜底。
      path.resolve(process.cwd(), "out/native/computer-use"),
      ...(resourcesPath ? [path.join(resourcesPath, "native", "computer-use")] : [])
    ];
    return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
  }

  workerPath(): string { return this.binaryPath; }

  private assertLive(): void {
    if (this.disposed) throw new Error("driver_disposed");
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop(); }, idleTimeoutMs);
  }

  private spawnHost(): Host {
    // 与 ActivityNativeClient 共用同一个 daemon 约定：`daemon --socket <path>`，就绪时 stdout 打 "ready"。
    const child = spawn(this.binaryPath, ["daemon", "--socket", this.socketPath, "--idle-seconds", "900"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr?.resume();
    const socket = new net.Socket();
    const host: Host = { child, socket, socketPath: this.socketPath, buffer: "", closed: false, connected: false, stdout: "" };
    // 立刻开始收集 stdout：daemon 可能在监听器挂上之前就打出 "ready"。
    child.stdout?.on("data", (chunk: Buffer) => { host.stdout += chunk.toString(); });
    socket.on("data", chunk => this.onData(host, chunk.toString("utf8")));
    // 连接建立前的 error/close 属于正常启动时序，只有「连上之后又断」才算断连。
    socket.on("error", error => { if (host.connected) this.failAndRetire(host, `driver_socket_error: ${error.message}`); });
    socket.on("close", () => { if (host.connected && !host.closed) this.failAndRetire(host, "driver_process_disconnected; outcome may be unknown"); });
    child.on("error", error => this.failAndRetire(host, `driver_sdk_missing_or_crashed: ${error.message}`));
    child.once("exit", (code, signal) => {
      host.closed = true;
      this.failHost(host, `driver_process_exited: ${String(code ?? signal)}; outcome may be unknown`);
      if (this.host === host) this.host = undefined;
    });
    return host;
  }

  /** 等 daemon 打出 "ready" 后连上 socket；这是唯一的连接入口。 */
  private connectAfterReady(host: Host): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error("driver_sdk_missing_or_crashed: daemon did not become ready")); }, 8_000);
      let connected = false;
      const connectNow = (): void => {
        if (host.closed || connected) return;
        connected = true;
        host.socket.once("connect", () => { host.connected = true; clearTimeout(timer); clearInterval(poll); resolve(); });
        host.socket.connect(this.socketPath);
      };
      const poll = setInterval(() => { if (host.stdout.includes("ready")) connectNow(); }, 20);
      host.child.once("error", error => { clearInterval(poll); clearTimeout(timer); reject(error); });
      host.child.once("exit", code => { clearInterval(poll); clearTimeout(timer); reject(new Error(`driver_sdk_missing_or_crashed: daemon exited ${String(code)}`)); });
    });
  }

  private onData(host: Host, chunk: string): void {
    host.buffer += chunk;
    if (host.buffer.length > maxIpcBytes) { this.failAndRetire(host, "driver_ipc_budget_exceeded"); return; }
    let index = host.buffer.indexOf("\n");
    while (index >= 0) {
      const line = host.buffer.slice(0, index);
      host.buffer = host.buffer.slice(index + 1);
      this.onReply(line);
      index = host.buffer.indexOf("\n");
    }
  }

  private onReply(line: string): void {
    let parsed: { id?: string | number; ok?: boolean; data?: unknown; error?: { code?: string; message?: string } };
    try { parsed = JSON.parse(line); } catch { return; }
    const id = parsed.id === undefined || parsed.id === null ? undefined : String(parsed.id);
    if (!id) return;
    const job = this.pending.get(id);
    if (!job) return;
    this.pending.delete(id);
    clearTimeout(job.timer);
    job.cleanup();
    if (parsed.ok === false) {
      job.reject(new Error(parsed.error?.code ?? parsed.error?.message ?? "native_action_failed"));
      return;
    }
    job.resolve(this.shape(parsed.data));
    this.armIdle();
  }

  /** 把 daemon 的原始 data 折算成 controller 认识的样子。 */
  private shape(raw: unknown): DriverReply {
    const data = (raw ?? {}) as Record<string, unknown>;
    if (Array.isArray(data.apps)) return { data, images: [] };
    if (data.screenshot && Array.isArray(data.elements)) {
      const windowId = typeof data.windowId === "number" ? data.windowId : Number(data.windowId ?? 0);
      return { data: toCapture(data, windowId), images: [] };
    }
    return { data, images: [] };
  }

  private failHost(host: Host, reason: string): void {
    for (const [, job] of this.pending) { clearTimeout(job.timer); job.cleanup(); job.reject(new Error(reason)); }
    this.pending.clear();
    host.closed = true;
  }

  private failAndRetire(host: Host, reason: string): void {
    this.failHost(host, reason);
    if (this.host === host) this.host = undefined;
    try { host.child.kill("SIGTERM"); } catch { /* already gone */ }
  }

  private async call(cmd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverReply> {
    this.assertLive();
    await this.ensureHost();
    const host = this.host;
    if (!host) throw new Error("driver_sdk_missing_or_crashed: no host");
    if (this.pending.size >= maxPending) throw new Error("driver_busy: IPC request budget reached");
    const id = crypto.randomUUID();
    return await new Promise<DriverReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error("driver_request_timeout; outcome may be unknown"));
      }, requestTimeoutMs);
      const onAbort = () => { this.pending.delete(id); clearTimeout(timer); cleanup(); reject(new Error("driver_request_aborted")); };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, cleanup });
      host.socket.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  private async ensureHost(): Promise<void> {
    if (this.host) return;
    if (!this.starting) {
      this.starting = (async () => {
        const host = this.spawnHost();
        await this.connectAfterReady(host);
        if (this.host !== undefined) throw new Error("driver_sdk_missing_or_crashed: host retired during startup");
        this.host = host;
        this.armIdle();
      })().finally(() => { this.starting = undefined; });
    }
    await this.starting;
  }

  async start(): Promise<void> {
    this.assertLive();
    this.enabled = true;
    await this.ensureHost();
  }

  async stop(): Promise<void> {
    this.enabled = false;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    const host = this.host;
    if (!host) return;
    this.host = undefined;
    this.failHost(host, "driver_stopped");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { try { host.child.kill("SIGKILL"); } catch { /* noop */ } resolve(); }, shutdownTimeoutMs);
      host.child.once("exit", () => { clearTimeout(timer); resolve(); });
      try { host.child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }

  diagnostics(): Promise<DriverReply> { return this.call("doctor", {}); }
  list(_session: string, pid: number | undefined, signal?: AbortSignal): Promise<DriverReply> {
    return this.call("list_apps", pid === undefined ? {} : { pid }, signal);
  }

  async observe(_session: string, target: WindowTarget, signal?: AbortSignal): Promise<DriverReply> {
    const args: Record<string, unknown> = {};
    if (typeof target.pid === "number") args.pid = target.pid;
    if (typeof (target as { bundleId?: string }).bundleId === "string") args.bundle = (target as { bundleId?: string }).bundleId;
    return await this.call("get_app_state", args, signal);
  }

  async act(_session: string, action: ComputerAction, signal?: AbortSignal): Promise<DriverReply> {
    switch (action.action) {
      case "click":
        return await this.call("click", action.elementToken ? { ref: action.elementToken } : { x: action.x, y: action.y }, signal);
      case "type_text":
        return await this.call("type_text", { text: action.text }, signal);
      case "press_key":
        return await this.call("press_key", { key: action.key }, signal);
      case "scroll":
        return await this.call("scroll", { direction: action.direction, amount: action.amount }, signal);
      default:
        throw new Error(`action_unsupported: ${String((action as { action: string }).action)}`);
    }
  }
}
