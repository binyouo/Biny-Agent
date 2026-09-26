/** 本机扩展连接权威：令牌认证、多配置连接、限量请求与中断后不重放。 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { BrowserRelayError, isRelayMutation, relayPageSchema, relayBinarySchema, relaySchemas, relayTabSchema, type RelayMethod, type RelayStatus } from "./relayProtocol.js";
import { relayCredentialsSchema } from "./relayClient.js";

interface Connection { socket: WebSocket; id: string; name: string; alive: boolean; pending?: Pending }
interface Pending { id: string; connection: Connection; reject(error: Error): void; resolve(value: unknown): void }

export class BrowserRelay {
  private token = randomBytes(32).toString("hex");
  private port = 0;
  private readonly connections = new Map<string, Connection>();
  private readonly server = createServer((request, response) => { void this.handleHttp(request, response); });
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 13 * 1024 * 1024 });
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private readonly file: string, private readonly timeoutMs = 15000) {
    this.server.on("upgrade", (request, socket, head) => {
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
      catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      const origin = request.headers.origin ?? "";
      if (url.pathname !== "/relay" || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || !this.authenticated(url.searchParams.get("token") ?? "")) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      if (this.connections.size >= 8) { socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); return; }
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.attach(ws));
    });
  }

  async start(): Promise<void> {
    if (this.server.listening) return;
    let preferredPort = 0;
    try {
      const saved = relayCredentialsSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      this.token = saved.token; preferredPort = saved.port;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("浏览器连接配置损坏，请检查私有连接文件。"); }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(preferredPort, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("浏览器连接地址不可用。");
    this.port = address.port;
    try { await this.save(); }
    catch (error) { await this.close(); throw error; }
    // ws ping/pong 仅检查连接存活，不重发任何浏览器动作。
    this.heartbeat = setInterval(() => {
      for (const connection of this.connections.values()) {
      if (!connection.alive) { connection.socket.terminate(); continue; }
      connection.alive = false; connection.socket.ping();
      // 数据消息唤醒 MV3 worker；协议 ping 本身不触发 worker 的 message 事件。
      if (connection.name) connection.socket.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 20000);
    this.heartbeat.unref();
  }

  status(): RelayStatus {
    const browsers = [...this.connections.values()].filter((item) => item.name && item.socket.readyState === WebSocket.OPEN).map((item) => ({ browserId: item.id, browserName: item.name }));
    return { running: this.server.listening, connected: browsers.length > 0, browsers };
  }

  /** 仅显式配对操作使用；禁止写入日志、工具输出或普通状态。 */
  pairingUrl(): string { return `ws://127.0.0.1:${this.port}/relay?token=${this.token}`; }

  async disconnect(): Promise<void> {
    this.token = randomBytes(32).toString("hex");
    for (const connection of this.connections.values()) {
      connection.pending?.reject(new BrowserRelayError("unknown", "浏览器连接已撤销，已派发操作的结果未确认；不会自动重试。"));
      connection.socket.terminate();
    }
    this.connections.clear();
    await this.save();
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    for (const connection of this.connections.values()) connection.pending?.reject(new BrowserRelayError("unknown", "浏览器服务已关闭，已派发操作结果未确认。"));
    for (const socket of this.sockets.clients) socket.terminate();
    this.connections.clear();
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
  }

  async request(method: RelayMethod, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = relaySchemas[method].parse(input);
    signal?.throwIfAborted();
    if (method === "status") return this.status();
    if (method === "tabs" && !("browserId" in args && args.browserId)) {
      const browsers = this.status().browsers;
      if (!browsers.length) throw new BrowserRelayError("unavailable", "浏览器扩展未连接，请在设置 → 浏览器配对。");
      return { browsers: await Promise.all(browsers.map((item) => this.request("tabs", { browserId: item.browserId }, signal))) };
    }
    const connection = "browserId" in args && typeof args.browserId === "string" ? this.connections.get(args.browserId) : undefined;
    if (!connection?.name || connection.socket.readyState !== WebSocket.OPEN) throw new BrowserRelayError("invalid", "浏览器连接已变化，请重新列出标签后再操作。");
    if ("browserId" in args && args.browserId !== connection.id) throw new BrowserRelayError("invalid", "浏览器连接已变化，请重新列出标签后再操作。");
    if (connection.pending) throw new BrowserRelayError("busy", "真实浏览器正在执行另一项操作，请等待完成。");
    const result = await new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const failure = (): BrowserRelayError => new BrowserRelayError(isRelayMutation(method) ? "unknown" : "unavailable", isRelayMutation(method)
        ? "浏览器操作超时或中断，结果未确认；请检查页面，不会自动重试。" : "浏览器读取超时或连接中断，请重新连接并列出标签。");
      const finish = (error?: Error, value?: unknown): void => {
        if (connection.pending?.id !== id) return;
        connection.pending = undefined; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = (): void => { finish(failure()); connection.socket.terminate(); };
      const timer = setTimeout(abort, this.timeoutMs);
      connection.pending = { id, connection, resolve: (value) => finish(undefined, value), reject: (error) => finish(error instanceof BrowserRelayError && error.code === "unknown" && !isRelayMutation(method) ? new BrowserRelayError("unavailable", error.message) : error) };
      signal?.addEventListener("abort", abort, { once: true });
      connection.socket.send(JSON.stringify({ id, method, args }), (error) => { if (error) abort(); });
    });
    if (method === "tabs") return { browserId: connection.id, browserName: connection.name, tabs: z.array(relayTabSchema).max(1000).parse(result) };
    if (method === "screenshot" || method === "download") return relayBinarySchema.parse(result);
    if (method === "read") return { browserId: connection.id, browserName: connection.name, tabId: (args as { tabId: number }).tabId, ...relayPageSchema.parse(result) };
    const actionResult = z.object({ success: z.literal(true), url: relayTabSchema.shape.url }).safeParse(result);
    if (!actionResult.success) throw new BrowserRelayError("unknown", "浏览器动作已派发，但返回结果无效；请检查页面，不会自动重试。");
    return actionResult.data;
  }

  private attach(socket: WebSocket): void {
    const connection: Connection = { socket, id: randomUUID(), name: "", alive: true };
    this.connections.set(connection.id, connection);
    const handshake = setTimeout(() => { if (!connection.name) socket.terminate(); }, 5000);
    socket.on("pong", () => { connection.alive = true; });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(handshake);
      this.connections.delete(connection.id);
      if (connection.pending?.connection === connection) connection.pending.reject(new BrowserRelayError("unknown", "浏览器扩展已断开，已派发操作的结果未确认；不会自动重试。"));
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!connection.name) {
          const hello = z.object({ type: z.literal("hello"), browserName: z.string().trim().min(1).max(80), version: z.literal(2) }).strict().parse(message);
          connection.name = hello.browserName; clearTimeout(handshake); socket.send(JSON.stringify({ type: "ready" })); return;
        }
        const reply = z.object({ id: z.string().uuid(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(1000).optional(), unknown: z.boolean().optional() }).strict().parse(message);
        const pending = connection.pending;
        if (pending?.connection !== connection || pending.id !== reply.id) return;
        if (reply.ok) pending.resolve(reply.result);
        else pending.reject(new BrowserRelayError(reply.unknown ? "unknown" : "invalid", reply.error ?? "浏览器操作失败。"));
      } catch { socket.terminate(); }
    });
  }

  private authenticated(value: string): boolean {
    const candidate = Buffer.from(value); const expected = Buffer.from(this.token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify({ port: this.port, token: this.token }), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/command" || request.headers.origin || !this.authenticated((request.headers.authorization ?? "").replace(/^Bearer /, ""))) {
      response.writeHead(403).end(); return;
    }
    const controller = new AbortController();
    const abort = (): void => { if (!response.writableEnded) controller.abort(); };
    response.once("close", abort);
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 13 * 1024 * 1024) throw new Error("请求过大。"); chunks.push(chunk); }
      const command = z.object({ method: z.enum(Object.keys(relaySchemas) as [RelayMethod, ...RelayMethod[]]), args: z.unknown() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = await this.request(command.method, command.args, controller.signal);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      if (!response.destroyed) response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ok: false, code: error instanceof BrowserRelayError ? error.code : "invalid", error: error instanceof BrowserRelayError ? error.message : "浏览器请求或响应格式无效。" }));
    } finally { response.off("close", abort); }
  }
}
