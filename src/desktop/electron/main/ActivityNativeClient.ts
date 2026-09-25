/** 主进程复用 Computer Use daemon 的持久 JSONL socket；OCR 是独立的短进程。 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
const executeFile = promisify(execFile);

export class ActivityNativeClient {
  private child?: ChildProcess;
  private socket?: Socket;
  private starting?: Promise<void>;
  private readonly socketPath: string;
  private readonly pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly directory: string, private readonly tempDirectory: string) {
    this.socketPath = path.join(os.tmpdir(), `biny-cu-${process.pid}-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}.sock`);
  }
  async capture(maxWidth: number, quality: number): Promise<Buffer> {
    await mkdir(this.tempDirectory, { recursive: true });
    const output = path.join(this.tempDirectory, `${randomUUID()}.jpg`);
    try {
      await this.request("shot_display", { out: output, max_width: maxWidth, quality: quality / 100 });
      return await readFile(output);
    } finally { await unlink(output).catch(() => undefined); }
  }
  async recognize(file: string, languages: string[], signal?: AbortSignal): Promise<string> {
    const { stdout } = await executeFile(path.join(this.directory, "activity-ocr"), [file, ...languages], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal });
    return stdout.trim();
  }
  async stop(): Promise<void> {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("截图服务已停止")); }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
    this.starting = undefined;
    if (child) await unlink(this.socketPath).catch(() => undefined);
  }
  private async ensureStarted(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.starting) return await this.starting;
    this.starting = (async () => {
      try { await this.connectSocket(); return; } catch { /* 尚无共享 daemon，启动本进程持有的实例。 */ }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(path.join(this.directory, "computer-use"), ["daemon", "--socket", this.socketPath, "--idle-seconds", "900"], { stdio: ["ignore", "pipe", "ignore"] });
        this.child = child;
        const timer = setTimeout(() => { child.kill(); reject(new Error("截图 daemon 启动超时")); }, 10000);
        child.once("error", error => { clearTimeout(timer); if (this.child === child) this.child = undefined; reject(error); });
        child.once("exit", () => { clearTimeout(timer); if (this.child === child) this.child = undefined; reject(new Error("截图 daemon 已退出")); });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("ready\n")) { clearTimeout(timer); resolve(); } });
      });
      await this.connectSocket();
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private async connectSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.socketPath);
      let buffer = "";
      socket.once("error", reject);
      socket.once("connect", () => { this.socket = socket; resolve(); });
      socket.on("data", chunk => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line) as { id: string; ok: boolean; data?: unknown; error?: string | { message: string } };
            const pending = this.pending.get(response.id); if (!pending) continue;
            clearTimeout(pending.timer); this.pending.delete(response.id);
            if (!response.ok) pending.reject(new Error(typeof response.error === "string" ? response.error : response.error?.message ?? "截图失败")); else pending.resolve(response.data);
          } catch { socket.destroy(new Error("截图 daemon 返回无效 JSON")); }
        }
      });
      socket.once("close", () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("截图连接已关闭")); }
        this.pending.clear();
      });
    });
  }
  private async request(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    return await new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("截图请求超时")); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }
}
