// 自研 macOS 原生 driver：spawn native/computer-use daemon 并通过 unix socket 通信。
// 协议：换行分隔 JSON，{"id","cmd","args"} → {"id","ok","data"|"error"}。
// daemon 是独立的 Swift 可执行文件（native/computer-use），不依赖任何第三方 SDK。
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import type { ComputerDriver, DriverReply } from "./controller.js";
import type { ComputerAction, WindowTarget } from "./protocol.js";

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

interface PendingJob {
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
  closed: boolean;
  connected: boolean;
  stdout: string;
  decoder: StringDecoder;
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
  // daemon 的 ref 表和坐标映射都是按 pid 存的，动作必须带上目标 pid。
  // 观察时记下来，动作时默认用它。
  private lastPid?: number;
  private readonly socketPath: string;
  private readonly binaryPath: string;

  constructor(private readonly onExit: () => void, options: NativeDriverOptions = {}) {
    this.binaryPath = options.binaryPath ?? NativeProcessDriver.resolveBinary();
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
    this.idleTimer = setTimeout(() => { void this.stop(); }, idleTimeoutMs);
  }

  private spawnHost(): Host {
    // 与 ActivityNativeClient 共用同一个 daemon 约定：`daemon --socket <path>`，就绪时 stdout 打 "ready"。
    const child = spawn(this.binaryPath, ["daemon", "--socket", this.socketPath, "--idle-seconds", "900"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr?.resume();
    const socket = new net.Socket();
    const host: Host = { child, socket, socketPath: this.socketPath, buffer: Buffer.alloc(0), closed: false, connected: false, stdout: "", decoder: new StringDecoder("utf8") };
    // 立刻开始收集 stdout：daemon 可能在监听器挂上之前就打出 "ready"。
    child.stdout?.on("data", (chunk: Buffer) => { host.stdout += chunk.toString(); });
    socket.on("data", chunk => this.onData(host, chunk));
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
      const host: Host = { socket, socketPath: this.socketPath, buffer: Buffer.alloc(0), closed: false, connected: false, stdout: "", decoder: new StringDecoder("utf8") };
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
      host.child?.once("error", error => { clearInterval(poll); clearTimeout(timer); reject(error); });
      host.child?.once("exit", code => { clearInterval(poll); clearTimeout(timer); reject(new Error(`driver_sdk_missing_or_crashed: daemon exited ${String(code)}`)); });
    });
  }

  private onData(host: Host, chunk: Buffer): void {
    // 必须按字节累积：一次 recv 可能切在多字节 UTF-8 字符中间，
    // 直接 toString 会插入 U+FFFD 并破坏 JSON（响应里都是中文标签）。
    host.buffer = Buffer.concat([host.buffer, chunk]);
    if (host.buffer.length > maxIpcBytes) { this.failAndRetire(host, "driver_ipc_budget_exceeded"); return; }
    let index = host.buffer.indexOf(10);
    while (index >= 0) {
      const line = host.decoder.write(host.buffer.subarray(0, index));
      host.buffer = host.buffer.subarray(index + 1);
      if (line) this.onReply(line);
      index = host.buffer.indexOf(10);
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
      // daemon 把截图落在磁盘上；读回来转成 ComputerImage，PiP 帧泵和模型帧都靠它。
      const image = this.readImage(data.screenshot);
      return { data: toCapture(data, windowId), images: image ? [image] : [] };
    }
    return { data, images: [] };
  }

  /** 把 daemon 写出的 jpeg 读成 ComputerImage；读不到就当没有，不阻断动作。 */
  private readImage(path: unknown): { mimeType: "image/jpeg"; dataBase64: string } | undefined {
    if (typeof path !== "string" || !path) return undefined;
    try {
      const bytes = readFileSync(path);
      // 与 maxComputerImageBytes 对齐：超预算的帧直接丢弃，避免撑爆模型请求。
      if (bytes.byteLength > maxImageBytes) return undefined;
      const base64 = bytes.toString("base64");
      if (base64.length > Math.ceil(maxImageBytes / 3) * 4) return undefined;
      return { mimeType: "image/jpeg", dataBase64: base64 };
    } catch {
      return undefined;
    }
  }

  private failHost(host: Host, reason: string): void {
    for (const [, job] of this.pending) { clearTimeout(job.timer); job.cleanup(); job.reject(new Error(reason)); }
    this.pending.clear();
    host.closed = true;
  }

  private failAndRetire(host: Host, reason: string): void {
    this.failHost(host, reason);
    if (this.host === host) this.host = undefined;
    try { host.child?.kill("SIGTERM"); } catch { /* already gone */ }
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
      }, screenshotCommands.has(cmd) ? screenshotTimeoutMs : requestTimeoutMs);
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
        // 已有一个 daemon 在听就采用它：ref 表、坐标映射、空闲计时都在那个进程里，
        // 每个调用方各起一个会把它们全部切碎。
        const adopted = await this.adoptExisting();
        if (adopted) { this.host = adopted; this.armIdle(); return; }
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
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    const host = this.host;
    this.host = undefined;
    if (!host) return;
    this.failHost(host, "driver_detached");
    host.child?.unref();
    host.child?.stdout?.destroy();
    host.child?.stderr?.destroy();
    host.socket.destroy();
  }

  async stop(): Promise<void> {
    this.enabled = false;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    const host = this.host;
    if (!host) return;
    this.host = undefined;
    this.failHost(host, "driver_stopped");
    await new Promise<void>(resolve => {
      // 采用来的 daemon 不是我们的子进程：断开连接就够了，它自己会在空闲后退出，
      // 而且别的调用方可能正用着它，杀了就是替别人做主。
      if (!host.child) { resolve(); return; }
      const timer = setTimeout(() => { try { host.child?.kill("SIGKILL"); } catch { /* noop */ } resolve(); }, shutdownTimeoutMs);
      host.child.once("exit", () => { clearTimeout(timer); resolve(); });
      try { host.child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }

  /**
   * 只截目标窗口、不读无障碍树。动作后回图用 —— 调用方执行完一个动词
   * 就能立刻看到结果，不必再 observe 一次（Alma 的每个动作工具都带回执截图）。
   */
  async captureWindow(pid?: number): Promise<DriverReply> {
    const target = pid ?? this.lastPid;
    if (target === undefined) return { data: {}, images: [] };
    // max_elements=0：跳过遍历，只留窗口节点和截图。
    return await this.observeRaw({ pid: target, max_elements: 0 });
  }

  /**
   * 让守护进程自己发起辅助功能授权弹窗。
   * 系统弹窗授的是「调用进程」——从宿主发起会把权限授给宿主，
   * 而需要它的是这个独立签名的 helper。
   */
  grantAccessibility(): Promise<DriverReply> { return this.call("grant", {}); }

  /** 后台拉起（不抢焦点）；已运行则原样返回 pid。供 MCP 出口使用。 */
  launchApp(bundle: string): Promise<DriverReply> { return this.call("launch_app", { bundle }); }

  /**
   * 按原始 daemon 参数观察，不做 WindowTarget 折算。供 MCP 出口使用。
   * 直接返回 call 的结果：shape() 已经把落盘的截图读成 image 了，
   * 这里再按 data.screenshot 重读会踩到 shape 之后的形状（已被 toCapture 换过）而丢图。
   */
  async observeRaw(args: Record<string, unknown>): Promise<DriverReply> {
    if (typeof args.pid === "number") this.lastPid = args.pid;
    const reply = await this.call("get_app_state", args);
    // 调用方可能给的是 bundle 而不是 pid；守护进程一定会在回复里带上真实 pid，
    // 从那里取 —— 动作和动作后的回执截图都靠它定位目标。
    const observed = (reply.data as { pid?: unknown }).pid;
    if (typeof observed === "number" && observed > 0) this.lastPid = observed;
    return reply;
  }

  /**
   * 直接派发一个 daemon 动作，参数原样透传。供 MCP 出口使用。
   * pid 缺省时回落到最近一次观察的目标——daemon 的 ref 表和坐标映射都按 pid 存，
   * 让调用方「观察一次、连续动作」时不必每一步都重复 pid。
   */
  actRaw(action: string, params: Record<string, unknown>, pid?: number): Promise<DriverReply> {
    const target = pid ?? this.lastPid;
    return this.call(action, target === undefined ? params : { ...params, pid: target });
  }

  /**
   * 整屏截图，用作观察失败时的回落（Alma 的帧泵同样是「优先抓窗口，失败回落整屏」）。
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
  /**
   * 通用命令口：命令行（`biny cu`）和测试用它直接对话守护进程。
   *
   * 模型侧的三个工具走的是 controller（有审批、审计、capture 校验），
   * 而人和脚本要的是「我说什么它做什么」——所以这条口子绕开那些策略层，
   * 只保留守护进程本身的能力。这也是 Alma 把 cu 放在命令行层的原因。
   */
  daemonCommand(cmd: string, args: Record<string, unknown> = {}): Promise<DriverReply> {
    return this.call(cmd, args);
  }

  list(_session: string, pid: number | undefined, signal?: AbortSignal): Promise<DriverReply> {
    return this.call("list_apps", pid === undefined ? {} : { pid }, signal);
  }

  async observe(_session: string, target: WindowTarget, signal?: AbortSignal): Promise<DriverReply> {
    const args: Record<string, unknown> = {};
    if (typeof target.pid === "number") { args.pid = target.pid; this.lastPid = target.pid; }
    if (typeof (target as { bundleId?: string }).bundleId === "string") args.bundle = (target as { bundleId?: string }).bundleId;
    // windowId 以前被丢在这里，从没到过守护进程 —— 而 ComputerObserve 把它列为必填。
    // 结果是模型必须编一个字符串，守护进程则拍它自己挑的窗口。现在它真的用于定位。
    const windowId = Number(target.windowId);
    if (Number.isSafeInteger(windowId) && windowId > 0) args.window_id = windowId;
    return await this.call("get_app_state", args, signal);
  }

  async act(_session: string, action: ComputerAction, signal?: AbortSignal): Promise<DriverReply> {
    // daemon 按 pid 找 ref 表和坐标映射；动作不自己带 pid，用最近一次观察的目标。
    const pid = this.lastPid;
    const withPid = (params: Record<string, unknown>): Record<string, unknown> =>
      pid === undefined ? params : { ...params, pid };
    switch (action.action) {
      case "click":
        return await this.call("click", withPid(action.elementToken ? { ref: action.elementToken } : { x: action.x, y: action.y }), signal);
      case "type_text":
        return await this.call("type_text", withPid({ text: action.text }), signal);
      case "press_key":
        return await this.call("press_key", withPid({ key: action.key }), signal);
      case "scroll":
        return await this.call("scroll", withPid({ direction: action.direction, amount: action.amount }), signal);
      case "drag":
        return await this.call("drag", withPid({ x1: action.x1, y1: action.y1, x2: action.x2, y2: action.y2 }), signal);
      case "perform_secondary_action":
        return await this.call("perform_secondary_action", withPid(action.elementToken ? { ref: action.elementToken } : { x: action.x, y: action.y }), signal);
      case "set_value":
        return await this.call("set_value", withPid({ ref: action.elementToken, value: action.value }), signal);
      case "select_text":
        return await this.call("select_text", withPid(
          action.text !== undefined
            ? { ref: action.elementToken, text: action.text }
            : { ref: action.elementToken, location: action.location, length: action.length ?? 0 }
        ), signal);
      default:
        throw new Error(`action_unsupported: ${String((action as { action: string }).action)}`);
    }
  }
}
