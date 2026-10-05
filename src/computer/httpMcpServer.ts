import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createComputerUseMcpServer } from "./mcpServer.js";
import type { ComputerMcpPolicy } from "./mcpPolicy.js";
import { NativeProcessDriver } from "./nativeDriver.js";

interface Session {
  server: ReturnType<typeof createComputerUseMcpServer>;
  transport: StreamableHTTPServerTransport;
  driver: NativeProcessDriver;
  usedAt: number;
  active: number;
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > 1_048_576) throw new Error("mcp_request_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 外部客户端直接连本机能力；HTTP 会话不依赖 Desktop，共用全局应用策略。 */
export async function startComputerUseHttpServer(options: { port?: number; tokenPath?: string; createDriver?: () => NativeProcessDriver; createPolicy?: (driver: NativeProcessDriver) => ComputerMcpPolicy } = {}) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("mcp_invalid_port");
  const tokenPath = path.resolve(options.tokenPath ?? path.join(os.tmpdir(), `biny-computer-mcp-${randomUUID()}.token`));
  await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  const file = await open(tokenPath, "wx", 0o600);
  const bearer = randomBytes(32).toString("hex");
  try { await file.writeFile(bearer); } finally { await file.close(); }
  const tokenIdentity = await lstat(tokenPath);
  const sessions = new Map<string, Session>();
  const initializing = new Set<Session>();
  let closed = false;
  let activeRequests = 0;
  let boundPort = 0;
  async function closeSession(session: Session): Promise<void> {
    for (const [id, value] of sessions) if (value === session) sessions.delete(id);
    initializing.delete(session);
    try { await session.server.close(); } finally { session.driver.detach(); }
  }
  async function removeToken(): Promise<void> {
    const current = await lstat(tokenPath).catch(() => undefined);
    if (current?.ino === tokenIdentity.ino && current.dev === tokenIdentity.dev) await unlink(tokenPath);
  }
  const http = createServer((request, response) => {
    void (async () => {
      const reject = (status: number, message: string): void => {
        response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: message })); request.resume();
      };
      const authorization = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${bearer}`);
      if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { reject(401, "Unauthorized"); return; }
      if (![ `127.0.0.1:${boundPort}`, `localhost:${boundPort}` ].includes(request.headers.host ?? "") || request.headers.origin !== undefined) {
        reject(403, "Local MCP clients only"); return;
      }
      if (request.url !== "/mcp") { reject(404, "Not found"); return; }
      if (closed) { reject(503, "Server stopping"); return; }
      if (request.method !== "POST" && request.method !== "DELETE") { reject(405, "Use POST or DELETE"); return; }
      if (activeRequests >= 32) { reject(503, "MCP request budget reached"); return; }
      activeRequests++;
      let session: Session | undefined;
      try {
        const sessionID = request.headers["mcp-session-id"];
        if (typeof sessionID === "string") session = sessions.get(sessionID);
        if (sessionID !== undefined && !session) { reject(404, "Unknown MCP session"); return; }
        const body = request.method === "POST" ? await readBody(request) : undefined;
        if (!session) {
          if (!isInitializeRequest(body)) { reject(400, "Initialize an MCP session first"); return; }
          if (sessions.size + initializing.size >= 16) { reject(503, "MCP session budget reached"); return; }
          const driver = options.createDriver?.() ?? new NativeProcessDriver(() => undefined);
          const server = createComputerUseMcpServer(driver, options.createPolicy?.(driver));
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID, enableJsonResponse: true,
            onsessioninitialized: id => { if (session && !closed) { sessions.set(id, session); initializing.delete(session); } }
          });
          session = { server, transport, driver, usedAt: Date.now(), active: 0 };
          initializing.add(session);
          await server.connect(transport);
        }
        if (closed) { await closeSession(session); reject(503, "Server stopping"); return; }
        session.usedAt = Date.now(); session.active++;
        try { await session.transport.handleRequest(request, response, body); }
        finally { session.active--; session.usedAt = Date.now(); }
        if (request.method === "DELETE" || initializing.has(session)) await closeSession(session);
      } catch (error) {
        if (session && initializing.has(session)) await closeSession(session);
        if (!response.headersSent) reject(error instanceof SyntaxError ? 400 : error instanceof Error && error.message === "mcp_request_too_large" ? 413 : 500, "MCP request failed");
        else response.end();
      } finally { activeRequests--; }
    })().catch(() => { response.destroy(); });
  });
  http.requestTimeout = 35_000; http.headersTimeout = 10_000; http.maxConnections = 64;
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => { http.removeListener("error", reject); resolve(); });
    });
  } catch (error) { await removeToken(); throw error; }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("mcp_listen_failed");
  boundPort = address.port;
  const sweep = setInterval(() => {
    for (const session of sessions.values()) if (!session.active && Date.now() - session.usedAt >= 900_000) void closeSession(session).catch(() => undefined);
  }, 60_000);
  sweep.unref();
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`, tokenPath,
    close(): Promise<void> {
      closing ??= (async () => {
        closed = true; clearInterval(sweep);
        const listening = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        http.closeAllConnections();
        const results = await Promise.allSettled([listening, ...[...new Set([...sessions.values(), ...initializing])].map(closeSession)]);
        await removeToken();
        const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, "MCP cleanup failed");
      })();
      return closing;
    }
  };
}
