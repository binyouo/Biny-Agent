// 自研 macOS 原生 driver：spawn native/computer-use daemon 并通过 unix socket 通信。
// 协议：换行分隔 JSON，{"id","cmd","args"} → {"id","ok","data"|"error"}。
// daemon 是独立的 Swift 可执行文件（native/computer-use），不依赖任何第三方 SDK。
import { toNativeActionArgs, toNativeObservationArgs } from "./nativeArgs.js";
import { applicationPlaybook } from "./playbooks.js";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import type { ComputerDriver, DriverReply } from "./controller.js";
import type { ComputerMirrorRequest, ComputerAction, WindowObserve } from "./protocol.js";
import { ToolOutcomeUnknownError } from "../tools/types.js";

const maxIpcBytes = 2 * 1024 * 1024;
const maxPending = 32;
// 截图本来就慢，其余请求不该陪着它等。参照实现同样是 20s 默认 / 30s 截图。
/**
 * socket 名按**二进制**隔离，不按工作目录。
 *
 * 按 cwd 的话同一个人换个目录跑就会起第二个 daemon —— 两份 ref 表、两套空闲计时。
 * 按内容哈希还多一层好处：重新构建后名字就变了，不会有上一次构建的旧 daemon
 * 应答新请求。macOS 每次新构建都会重置 TCC 授权，这两件事本来就该一起变。
 */
function socketKeyFor(binaryPath: string): string {
  try {
    return crypto.createHash("sha1").update(readFileSync(binaryPath)).digest("hex").slice(0, 8);
  } catch {
    // 还没构建好就退回按路径 —— 至少同一个源码树里的实例共用。
    return crypto.createHash("sha1").update(binaryPath).digest("hex").slice(0, 8);
  }
}

const adoptTimeoutMs = 400;
const requestTimeoutMs = 20_000;
const screenshotTimeoutMs = 30_000;
const screenshotCommands = new Set(["capture_screen", "get_app_state", "shot_display"]);
const shutdownTimeoutMs = 2_000;
const idleTimeoutMs = 900_000;
// 与 protocol.ts 的 maxComputerImageBytes 保持一致。
const maxImageBytes = 1_048_576;

class NativeCommandError extends Error {
  constructor(message: string, readonly inputNotDispatched?: boolean) { super(message); }
}

interface PendingJob {
  captureId?: string;
  resolve: (value: DriverReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

interface Host {
  /** 采用一个已经在听的 daemon 时没有子进程 —— 那个 daemon 是别人起的。 */
  child?: ChildProcess;
  socket: net.Socket;
  socketPath: string;
  buffer: Buffer;
  bufferStart: number;
  bufferEnd: number;
  bufferScan: number;
  bufferOverflowed: boolean;
  closed: boolean;
  connected: boolean;
  stdout: string;
  decoder: StringDecoder;
  lastActivityAt: number;
  idleExitPending?: boolean;
}

export interface NativeDriverOptions {
  binaryPath?: string;
  socketDir?: string;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/**
 * 把 daemon 的 elements 数组映射成 captureSchema 需要的形状。
 *
 * ⚠️ 这里会**重建一个对象**，所以必须先把 daemon 其余的字段铺进来 ——
 * 只搬运"认识的"字段会让新加的一律**静默消失**：`wakeupAttempts` 在带截图时就是这样没的
 * （同一功能不带截图时还在，于是表现为"同一个东西两次测出不同结果"）。
 * 只丢掉 daemon 自己的内部字段（截图路径、原始 elements、原始宽高）。
 */
function toCapture(data: Record<string, unknown>, windowId: number, captureId?: string): Record<string, unknown> {
  const elements = Array.isArray(data.elements) ? (data.elements as Record<string, unknown>[]) : [];
  const {
    screenshot: _screenshotPath, elements: _rawElements,
    screenshotWidth: _rawWidth, screenshotHeight: _rawHeight, ...rest
  } = data;
  return {
    ...rest,
    pid: data.pid,
    window_id: windowId,
    capture_id: captureId ?? data.capture_id,
    screenshot_width: data.screenshotWidth ?? 0,
    screenshot_height: data.screenshotHeight ?? 0,
    screenshot_frame_valid: true,
    elements: elements.map(element => ({
      element_token: typeof element.ref === "string" ? element.ref : undefined,
      role: element.role,
      title: element.title,
      description: element.description,
      role_description: element.role_description,
      subrole: element.subrole,
      value: element.value,
      frame: element.frame,
      focused: element.focused,
      enabled: element.enabled,
      selected: element.selected,
      actions: element.actions,
      children_count: element.children_count
    }))
  };
}

export class NativeProcessDriver implements ComputerDriver {
  private host?: Host;
  private readonly pending = new Map<string, PendingJob>();
  private starting?: { controller: AbortController; completion: Promise<void> };
  private stopping?: Promise<void>;
  private enabled = false;
  private disposed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  // 独立客户端保留最近观察目标，原生输入仍校验调用方、窗口及一次性凭据。
  private lastPid?: number;
  private lastCapture?: { id: string; pid: number; windowId: number };
  private readonly clientId = crypto.randomUUID();
  private readonly socketPath: string;
  private readonly binaryPath: string;
  private readonly idleTimeout: number;
  private readonly requestTimeout: number;

  constructor(private readonly onExit: () => void, options: NativeDriverOptions = {}) {
    this.binaryPath = options.binaryPath ?? NativeProcessDriver.resolveBinary();
    this.idleTimeout = options.idleTimeoutMs ?? idleTimeoutMs;
    this.requestTimeout = options.requestTimeoutMs ?? requestTimeoutMs;
    this.socketPath = path.join(
      options.socketDir ?? path.join(os.homedir(), "Library", "Application Support", "alma"),
      `biny-computer-use-${socketKeyFor(this.binaryPath)}.sock`
    );
  }

  static resolveBinary(): string {
    // 开发期（源码树）与打包期（app.asar.unpacked）两条路径。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    // daemon 以 .app 形式发布：屏幕录制权限按 bundle 身份授予，裸二进制拿不到画面。
    // 开发期 out/native/computer-use 是指进 bundle 的软链，打包后要走 .app 内部路径。
    const inner = path.join("Contents", "MacOS", "computer-use");
    const candidates: string[] = [
      path.resolve(here, "../../out/native/computer-use"),
      path.resolve(here, "../../../out/native/computer-use"),
      path.resolve(here, "../../out/native/computer-use.app", inner),
      path.resolve(process.cwd(), "out/native/computer-use"),
      path.resolve(process.cwd(), "out/native/computer-use.app", inner),
      ...(resourcesPath ? [
        path.join(resourcesPath, "native", "computer-use"),
        path.join(resourcesPath, "native", "computer-use.app", inner)
      ] : [])
    ];
    return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
  }

  workerPath(): string { return this.binaryPath; }

  private assertLive(): void {
    if (this.disposed) throw new Error("driver_disposed");
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const host = this.host;
    if (!host || host.closed || this.disposed || this.stopping) return;
    this.idleTimer = setTimeout(() => {
      if (this.host !== host || host.closed || this.disposed || this.stopping) return;
      this.idleTimer = undefined;
      // A reply's timer may expire after another request has been admitted.
      // Pending work is never idle; recent failed/cancelled requests also get
      // an idle window without relying on every settlement path to rearm it.
      if (this.pending.size > 0 || performance.now() - host.lastActivityAt < this.idleTimeout) {
        this.armIdle();
        return;
      }
      void this.stopHost(host).catch(() => {
        if (this.host === host && this.enabled) { this.enabled = false; this.onExit(); }
      });
    }, this.idleTimeout);
  }

  private spawnHost(): Host {
    // 与 ActivityNativeClient 共用同一个 daemon 约定：`daemon --socket <path>`，就绪时 stdout 打 "ready"。
    const child = spawn(this.binaryPath, ["daemon", "--socket", this.socketPath, "--idle-seconds", "900"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr?.resume();
    const socket = new net.Socket();
    const host: Host = { child, socket, socketPath: this.socketPath, buffer: Buffer.alloc(0), bufferStart: 0, bufferEnd: 0, bufferScan: 0, bufferOverflowed: false, closed: false, connected: false, stdout: "", decoder: new StringDecoder("utf8"), lastActivityAt: performance.now() };
    // 立刻开始收集 stdout：daemon 可能在监听器挂上之前就打出 "ready"。
    child.stdout?.on("data", (chunk: Buffer) => { host.stdout += chunk.toString(); });
    socket.on("data", chunk => this.onData(host, chunk));
    // 连接建立前的 error/close 属于正常启动时序，只有「连上之后又断」才算断连。
    socket.on("error", error => { if (host.connected) this.failAndRetire(host, `driver_socket_error: ${error.message}`); });
    socket.on("close", () => { if (host.connected && !host.closed) this.failAndRetire(host, "driver_process_disconnected; outcome may be unknown"); });
    child.on("error", error => this.failAndRetire(host, `driver_sdk_missing_or_crashed: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (host.idleExitPending) {
        host.idleExitPending = false;
        const active = this.host === host;
        if (active) this.host = undefined;
        if ((code !== 0 || signal) && this.enabled && active) { this.enabled = false; this.onExit(); }
        return;
      }
      if (host.closed) return;
      const active = this.host === host;
      const idle = this.isExpectedIdle(host);
      this.failHost(host, `driver_process_exited: ${String(code ?? signal)}; outcome may be unknown`);
      if (active) { this.host = undefined; if (this.enabled && !idle) { this.enabled = false; this.onExit(); } }
    });
    return host;
  }

  /**
   * 先看有没有已经在听的 daemon，有就直接用它。
   *
   * socket 名按**二进制内容**隔离，用意就是「同一个 daemon 被所有调用方共用」。
   * 无条件 spawn 会让每个新进程都把前一个 daemon 的 socket 顶掉 —— 于是命令行里
   * `cu snap` 拿到的 ref，在下一条命令里就不认了（ref 表存在 daemon 进程里）。
   * 带着 stale socket 文件的情况会连接失败（ECONNREFUSED），那时才 spawn。
   */
  private adoptExisting(): Promise<Host | undefined> {
    return new Promise(resolve => {
      const socket = new net.Socket();
      const host: Host = { socket, socketPath: this.socketPath, buffer: Buffer.alloc(0), bufferStart: 0, bufferEnd: 0, bufferScan: 0, bufferOverflowed: false, closed: false, connected: false, stdout: "", decoder: new StringDecoder("utf8"), lastActivityAt: performance.now() };
      // 放弃时才能清监听器。成功路径绝不能再调这个 —— 它会把下面刚装上的
      // data 监听一起摘掉，于是连接是通的、回包永远收不到，只剩请求超时。
      const giveUp = (): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(undefined);
      };
      const timer = setTimeout(giveUp, adoptTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        socket.on("data", chunk => this.onData(host, chunk));
        socket.on("error", error => { if (host.connected) this.failAndRetire(host, `driver_socket_error: ${error.message}`); });
        socket.on("close", () => { if (host.connected && !host.closed) this.failAndRetire(host, "driver_process_disconnected; outcome may be unknown"); });
        host.connected = true;
        resolve(host);
      });
      socket.once("error", () => { clearTimeout(timer); giveUp(); });
      socket.connect(this.socketPath);
    });
  }

  /** 等 daemon 打出 "ready" 后连上 socket；这是唯一的连接入口。 */
  private connectAfterReady(host: Host, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let connecting = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearInterval(poll);
        signal.removeEventListener("abort", aborted);
        host.child?.off("error", failed); host.child?.off("exit", exited);
        host.socket.off("error", failed); host.socket.off("connect", connected);
        if (error) reject(error); else resolve();
      };
      const failed = (error: Error): void => finish(error);
      const exited = (code: number | null): void => finish(new Error(`driver_sdk_missing_or_crashed: daemon exited ${String(code)}`));
      const aborted = (): void => finish(signal.reason);
      const connected = (): void => { host.connected = true; finish(); };
      const connectNow = (): void => {
        if (host.closed || connecting || settled) return;
        connecting = true;
        host.socket.once("connect", connected);
        host.socket.connect(this.socketPath);
      };
      const timer = setTimeout(() => finish(new Error("driver_sdk_missing_or_crashed: daemon did not become ready")), 8_000);
      const poll = setInterval(() => { if (host.stdout.includes("ready")) connectNow(); }, 20);
      host.child?.once("error", failed); host.child?.once("exit", exited);
      host.socket.once("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  private onData(host: Host, chunk: Buffer): void {
    const pendingBytes = host.bufferEnd - host.bufferStart;
    const requiredBytes = pendingBytes + chunk.length;
    // Preserve the aggregate chunk budget: do not dispatch even an early frame
    // when the pending suffix plus this entire chunk exceeds the limit.
    if (host.bufferOverflowed || requiredBytes > maxIpcBytes) {
      // The old oversized prefix rejected every later chunk on this connection.
      // Keep that sticky failure without retaining the rejected payload.
      host.bufferOverflowed = true;
      host.buffer = Buffer.alloc(0);
      host.bufferStart = host.bufferEnd = host.bufferScan = 0;
      this.failAndRetire(host, "driver_ipc_budget_exceeded");
      return;
    }
    if (host.bufferEnd + chunk.length > host.buffer.length) {
      if (requiredBytes > host.buffer.length) {
        const capacity = Math.min(maxIpcBytes, Math.max(requiredBytes, 1024, host.buffer.length * 2));
        const grown = Buffer.allocUnsafeSlow(capacity);
        host.buffer.copy(grown, 0, host.bufferStart, host.bufferEnd);
        host.buffer = grown;
      } else {
        host.buffer.copy(host.buffer, 0, host.bufferStart, host.bufferEnd);
      }
      host.bufferScan -= host.bufferStart;
      host.bufferStart = 0;
      host.bufferEnd = pendingBytes;
    }
    chunk.copy(host.buffer, host.bufferEnd);
    host.bufferEnd += chunk.length;
    // Scan only new bytes, but keep the unconsumed range if a reply callback
    // throws. Decode complete frames with the existing per-host decoder.
    let index = host.buffer.subarray(0, host.bufferEnd).indexOf(10, host.bufferScan);
    while (index >= 0) {
      const line = host.decoder.write(host.buffer.subarray(host.bufferStart, index));
      host.bufferStart = index + 1;
      host.bufferScan = host.bufferStart;
      if (line) this.onReply(line);
      index = host.buffer.subarray(0, host.bufferEnd).indexOf(10, host.bufferScan);
    }
    host.bufferScan = host.bufferEnd;
    if (host.bufferStart === host.bufferEnd) {
      // A drained connection should not retain its largest historical frame.
      host.buffer = Buffer.alloc(0);
      host.bufferStart = host.bufferEnd = host.bufferScan = 0;
    }
  }

  private readonly eventListeners = new Set<(event: string, data: unknown) => void>();
  onNativeEvent(listener: (event: string, data: unknown) => void): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  private onReply(line: string): void {
    let parsed: { id?: string | number; ok?: boolean; data?: unknown; error?: { code?: string; message?: string; inputNotDispatched?: unknown }; event?: string };
    try { parsed = JSON.parse(line); } catch { return; }
    if (typeof parsed.event === "string") { for (const listener of this.eventListeners) listener(parsed.event, parsed.data); return; }
    const id = parsed.id === undefined || parsed.id === null ? undefined : String(parsed.id);
    if (!id) return;
    const job = this.pending.get(id);
    if (!job) {
      const screenshot = (parsed.data as { screenshot?: unknown } | undefined)?.screenshot;
      if (typeof screenshot === "string") rmSync(screenshot, { force: true });
      return;
    }
    this.pending.delete(id);
    clearTimeout(job.timer);
    job.cleanup();
    if (parsed.ok === false) {
      const inputNotDispatched = parsed.error?.inputNotDispatched;
      job.reject(new NativeCommandError(parsed.error?.code ?? parsed.error?.message ?? "native_action_failed", typeof inputNotDispatched === "boolean" ? inputNotDispatched : undefined));
      return;
    }
    job.resolve(this.shape(parsed.data, job.captureId));
    this.armIdle();
  }

  /** 把 daemon 的原始 data 折算成 controller 认识的样子。 */
  private shape(raw: unknown, captureId?: string): DriverReply {
    const data = (raw ?? {}) as Record<string, unknown>;
    if (Array.isArray(data.apps)) return { data, images: [] };
    if (data.screenshot && Array.isArray(data.elements)) {
      const windowId = typeof data.windowId === "number" ? data.windowId : Number(data.windowId ?? 0);
      // daemon 把截图落在磁盘上；读回来转成 ComputerImage，PiP 帧泵和模型帧都靠它。
      let imageError: string | undefined;
      const image = this.readImage(data.screenshot, reason => { imageError = reason; });
      const capture = toCapture(data, windowId, captureId);
      if (!image) { capture.screenshot_frame_valid = false; capture.screenshot_error = imageError ?? "screenshot_read_failed"; }
      return { data: capture, images: image ? [image] : [] };
    }
    return { data, images: [] };
  }

  /** 把 daemon 写出的 jpeg 读成 ComputerImage；调用方可区分读取失败和图片超限。 */
  private readImage(path: unknown, onFailure?: (reason: string) => void): { mimeType: "image/jpeg"; dataBase64: string } | undefined {
    if (typeof path !== "string" || !path) { onFailure?.("screenshot_read_failed"); return undefined; }
    try {
      const bytes = readFileSync(path);
      // 与 maxComputerImageBytes 对齐：超预算的帧直接丢弃，避免撑爆模型请求。
      if (bytes.byteLength > maxImageBytes) { onFailure?.("screenshot_too_large"); return undefined; }
      const base64 = bytes.toString("base64");
      if (base64.length > Math.ceil(maxImageBytes / 3) * 4) { onFailure?.("screenshot_too_large"); return undefined; }
      return { mimeType: "image/jpeg", dataBase64: base64 };
    } catch {
      onFailure?.("screenshot_read_failed");
      return undefined;
    } finally { rmSync(path, { force: true }); }
  }

  private failHost(host: Host, reason: string): void {
    for (const [, job] of this.pending) { clearTimeout(job.timer); job.cleanup(); job.reject(new Error(reason)); }
    this.pending.clear();
    host.closed = true;
  }

  private isExpectedIdle(host: Host): boolean {
    return this.pending.size === 0 && !host.child?.signalCode && (host.child?.exitCode == null || host.child.exitCode === 0) && performance.now() - host.lastActivityAt >= this.idleTimeout;
  }

  private failAndRetire(host: Host, reason: string): void {
    if (host.closed) return;
    const active = this.host === host;
    const idle = this.isExpectedIdle(host);
    if (active && idle && this.enabled && host.child && host.child.exitCode === null && host.child.signalCode === null) {
      this.failHost(host, reason); host.idleExitPending = true; return;
    }
    this.failHost(host, reason);
    if (active) this.host = undefined;
    try { host.child?.kill("SIGTERM"); } catch { /* already gone */ }
    if (active && this.enabled && !idle) { this.enabled = false; this.onExit(); }
  }

  private async call(cmd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverReply> {
    let dispatched = false;
    try {
      this.assertLive();
      await this.ensureHost();
      const host = this.host;
      if (!host) throw new Error("driver_sdk_missing_or_crashed: no host");
      if (this.pending.size >= maxPending) throw new Error("driver_busy: IPC request budget reached");
      const id = crypto.randomUUID();
      const captureId = cmd === "get_app_state" ? crypto.randomUUID() : undefined;
      if (captureId) args = { ...args, capture_id: captureId };
      signal?.throwIfAborted();
      const frame = `${JSON.stringify({ id, cmd, args })}\n`;
      return await new Promise<DriverReply>((resolve, reject) => {
        const cancelNative = (): void => {
          if (!dispatched || host.closed || !host.socket.writable) return;
          try { host.socket.write(`${JSON.stringify({ cmd: "cancel", args: { request_id: id } })}\n`); }
          catch { host.socket.destroy(); }
        };
        const timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          cancelNative();
          reject(new Error("driver_request_timeout; outcome may be unknown"));
        }, screenshotCommands.has(cmd) ? screenshotTimeoutMs : this.requestTimeout);
        const onAbort = () => { this.pending.delete(id); clearTimeout(timer); cleanup(); cancelNative(); reject(new Error("driver_request_aborted")); };
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.pending.set(id, { resolve, reject, timer, cleanup, captureId });
        host.lastActivityAt = performance.now();
        dispatched = true;
        host.socket.write(frame);
      });
    } catch (error) {
      if (!dispatched && !(error instanceof NativeCommandError)) throw new NativeCommandError(error instanceof Error ? error.message : String(error), true);
      throw error;
    }
  }

  private async ensureHost(): Promise<void> {
    if (this.stopping) await this.stopping;
    this.assertLive();
    if (this.host && !this.host.closed) return;
    if (!this.starting) {
      const controller = new AbortController();
      const completion = Promise.resolve().then(async () => {
        let candidate: Host | undefined;
        try {
          controller.signal.throwIfAborted();
          if (this.host?.closed) await this.stopHost();
          candidate = await this.adoptExisting();
          controller.signal.throwIfAborted();
          if (!candidate) {
            candidate = this.spawnHost();
            await this.connectAfterReady(candidate, controller.signal);
          }
          controller.signal.throwIfAborted();
          this.assertLive();
          this.host = candidate;
          this.armIdle();
        } catch (error) {
          if (candidate) {
            if (controller.signal.reason?.message === "driver_detached") this.detachHost(candidate);
            else await this.stopHost(candidate);
          }
          throw error;
        }
      });
      const attempt = { controller, completion };
      this.starting = attempt;
      void completion.finally(() => { if (this.starting === attempt) this.starting = undefined; }).catch(() => undefined);
    }
    await this.starting.completion;
  }

  async start(): Promise<void> {
    this.assertLive();
    this.enabled = true;
    await this.ensureHost();
  }

  /**
   * 放手：断开连接，但**不**结束守护进程。
   *
   * 每次命令行调用都是一个新进程，而 ref 表、坐标映射都存在守护进程里。
   * 走完一条命令就把它杀掉，等于 ref 永远活不过一次调用 —— `cu snap` 得到的 ref
   * 在下一条命令里必然失效。守护进程自己会在空闲 900s 后退出，那个计时器就是
   * 为这件事存在的。
   */
  detach(): void {
    this.disposed = true;
    this.starting?.controller.abort(new Error("driver_detached"));
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    const host = this.host;
    this.host = undefined;
    if (host) this.detachHost(host);
  }

  private detachHost(host: Host): void {
    this.failHost(host, "driver_detached");
    host.child?.unref();
    host.child?.stdout?.destroy();
    host.child?.stderr?.destroy();
    host.socket.destroy();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.enabled = false;
    const starting = this.starting;
    starting?.controller.abort(new Error("driver_stopped"));
    const stopping = Promise.resolve().then(async () => {
      await starting?.completion.catch(() => undefined);
      await this.stopHost();
    }).finally(() => { if (this.stopping === stopping) this.stopping = undefined; });
    this.stopping = stopping;
    return stopping;
  }

  private async stopHost(host = this.host): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    if (!host) return;
    if (this.host === host) this.host = undefined;
    host.socket.destroy();
    if (!host.closed) this.failHost(host, "driver_stopped");
    const child = host.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(force); clearTimeout(deadline);
          child.off("exit", exited);
          if (error) reject(error); else resolve();
        };
        const exited = (): void => finish();
        const kill = (signal: NodeJS.Signals): void => {
          try { child.kill(signal); }
          catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        };
        const force = setTimeout(() => kill("SIGKILL"), shutdownTimeoutMs);
        const deadline = setTimeout(() => finish(new Error("driver_shutdown_timeout: daemon did not exit")), shutdownTimeoutMs * 2);
        child.once("exit", exited);
        kill("SIGTERM");
      });
    } catch (error) {
      // 清理失败仍保留归属，后续停止可重试；不能把仍存活的进程当作已释放。
      if (!this.host) this.host = host;
      throw error;
    }
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }

  /** 动作回图不重新观察，保留调用方正在使用的 AX 引用与坐标映射。 */
  async captureWindow(pid?: number): Promise<DriverReply> {
    const target = pid ?? this.lastPid;
    if (target === undefined) return { data: {}, images: [] };
    return await this.capturePreview({ pid: target });
  }

  /** 纯像素帧源；没有目标时截屏，有目标时不能扩大捕获范围。 */
  async capturePreview(target?: { pid: number; windowId?: string }, signal?: AbortSignal): Promise<DriverReply> {
    signal?.throwIfAborted();
    const out = path.join(os.tmpdir(), `biny-cu-preview-${crypto.randomUUID()}.jpg`);
    try {
      // 系统捕获不能取消，等待回执后再释放帧泵槽位并删除文件；取消只阻止发布。
      const reply = await this.call("shot_display", {
        out, pid: target?.pid, window_id: target?.windowId === undefined ? undefined : Number(target.windowId)
      });
      signal?.throwIfAborted();
      const image = this.readImage(out);
      const { path: _path, ...data } = reply.data;
      return { data, images: image ? [image] : [] };
    } finally { rmSync(out, { force: true }); }
  }

  /**
   * 让守护进程自己发起辅助功能授权弹窗。
   * 系统弹窗授的是「调用进程」——从宿主发起会把权限授给宿主，
   * 而需要它的是这个独立签名的 helper。
   */
  grantAccessibility(): Promise<DriverReply> { return this.call("grant", {}); }

  /** 后台拉起（不抢焦点）；已运行则原样返回 pid。供 MCP 出口使用。 */
  launchApp(bundle: string, signal?: AbortSignal): Promise<DriverReply> { return this.call("launch_app", { bundle }, signal); }

  /**
   * 按原始 daemon 参数观察，不做 WindowTarget 折算。供 MCP 出口使用。
   * 直接返回 call 的结果：shape() 已经把落盘的截图读成 image 了，
   * 这里再按 data.screenshot 重读会踩到 shape 之后的形状（已被 toCapture 换过）而丢图。
   */
  async observeRaw(args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverReply> {
    this.lastCapture = undefined;
    if (typeof args.pid === "number") this.lastPid = args.pid;
    const reply = await this.call("get_app_state", { ...args, client_id: this.clientId }, signal);
    if (reply.images.length === 1 && typeof reply.data.capture_id === "string") this.lastCapture = { id: reply.data.capture_id, pid: Number(reply.data.pid), windowId: Number(reply.data.window_id) };
    // 调用方可能给的是 bundle 而不是 pid；守护进程一定会在回复里带上真实 pid，
    // 从那里取 —— 动作和动作后的回执截图都靠它定位目标。
    const observed = (reply.data as { pid?: unknown }).pid;
    if (typeof observed === "number" && observed > 0) this.lastPid = observed;
    return { ...reply, data: { ...reply.data, playbook: applicationPlaybook(reply.data.bundleId ?? reply.data.bundle) || undefined } };
  }

  /**
   * 直接派发一个 daemon 动作，参数原样透传。供 MCP 出口使用。
   * 未给进程或窗口时使用最近观察目标；每次输入消费凭据，下一次须重新观察。
   */
  actRaw(action: string, params: Record<string, unknown>, pid?: number, signal?: AbortSignal): Promise<DriverReply> {
    const target = pid ?? this.lastPid;
    return this.input(action, { ...params, pid: target, client_id: this.clientId, capture_id: this.lastCapture?.id, window_id: params.window_id ?? this.lastCapture?.windowId }, signal);
  }

  /**
   * 整屏截图，用作观察失败时的回落（优先抓窗口，失败回落整屏）。
   * 走 daemon 的 capture_screen：只截图、不读 AX，因此不会被卡住的无障碍调用牵连，
   * 也不依赖目标 app 是否可被单独捕获。
   */
  async captureScreen(): Promise<DriverReply> {
    const out = path.join(os.tmpdir(), `biny-cu-screen-${Date.now()}.jpg`);
    const reply = await this.call("capture_screen", { out });
    const image = this.readImage(out);
    return { data: reply.data, images: image ? [image] : [] };
  }

  diagnostics(): Promise<DriverReply> { return this.call("doctor", {}); }
  /** 用户显式调用的命令行和系统诊断入口，不替代模型工具的控制器审批。 */
  daemonCommand(cmd: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<DriverReply> {
    return this.call(cmd, args, signal);
  }

  mirror(operation: ComputerMirrorRequest["operation"], args: Record<string, unknown>): Promise<DriverReply> {
    return this.call(`pip_${operation}`, args);
  }

  list(_session: string, pid: number | undefined, signal?: AbortSignal, days?: number): Promise<DriverReply> {
    return this.call("list_apps", { pid, recent_days: days }, signal);
  }

  async observe(_session: string, target: WindowObserve, signal?: AbortSignal): Promise<DriverReply> {
    this.lastPid = target.pid;
    const args = toNativeObservationArgs(target);
    const reply = await this.call("get_app_state", { ...args, client_id: this.clientId }, signal);
    return { ...reply, data: { ...reply.data, playbook: applicationPlaybook(reply.data.bundleId ?? reply.data.bundle) || undefined } };
  }

  private async input(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverReply> {
    try {
      const reply = await this.call(command, args, signal);
      const data = reply.data;
      // AX 属性写入只有原生回读证据才能确认；接口接受或命令名称不足以证明值已改变。
      const attributeWrite = ["type", "type_text", "set_value", "select_text"].includes(command);
      const accepted = !attributeWrite && (data.route === "ax" || data.route === "ax-page");
      return { ...reply, data: { ...data, effect: data.effect ?? (accepted && !data.warning && !data.verification_note ? "confirmed" : "unverifiable") } };
    } catch (error) {
      // 同一错误可发生在多字符或多事件输入中途，只信任本次原生请求的派发证据。
      if (error instanceof NativeCommandError && error.inputNotDispatched === true) {
        return { data: { effect: "refused", code: error.message }, images: [], errorCode: error.message };
      }
      throw new ToolOutcomeUnknownError(error instanceof NativeCommandError ? "interrupted" : "transport_error", error instanceof Error ? error.message : String(error));
    }
  }

  async act(_session: string, action: ComputerAction, signal?: AbortSignal): Promise<DriverReply> {
    return await this.input(action.action, {
      ...toNativeActionArgs(action), client_id: this.clientId, capture_id: action.captureId
    }, signal);
  }
}
