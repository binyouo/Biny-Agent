/** 本地记忆 REST 入口：只转发到宿主，不持有第二份领域状态或绕过运行时写入边界。 */
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { RuntimeHostClient } from "./client.js";
import { readMemoryEntryInput, readMemoryEntryPatch } from "./validation.js";
import { SessionSearchIndex } from "../../session/searchIndex.js";
import { archiveConversationMarkdown } from "../../session/markdownArchive.js";
import { attachMemoryWebSocket } from "./memory-websocket.js";

type MemoryHttpClient = Pick<RuntimeHostClient,
  "memory" | "cancelMemorySleep" | "memoryEmbeddingStatus" | "rebuildMemoryEmbeddingIndex" |
  "cancelMemoryEmbeddingRebuild" | "downloadMemoryEmbeddingModel" | "deleteMemoryEmbeddingModel"
>;

export async function startMemoryHttpServer(client: MemoryHttpClient, options: { token: string; port?: number }) {
  if (!options.token.trim()) throw new Error("BINY_MEMORY_API_TOKEN must be set before starting the memory API.");
  const expected = Buffer.from(`Bearer ${options.token}`);
  const authorize = (request: IncomingMessage): number | undefined => {
    if (request.headers.origin || !/^(127\.0\.0\.1|localhost):\d+$/u.test(request.headers.host ?? "")) return 403;
    const supplied = Buffer.from(request.headers.authorization ?? "");
    return supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ? 401 : undefined;
  };
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    // 本接口面向本机程序，不允许网页跨域或 DNS rebinding 访问用户记忆。
    const rejected = authorize(request);
    if (rejected !== undefined) {
      send(rejected, { error: rejected === 403 ? "Local program access only." : "Bearer token required." });
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method;
      const route = url.pathname.replace(/\/$/u, "");
      const body = await readBody(request);
      let result: unknown;
      if (route === "/api/memories" && method === "GET") {
        result = await client.memory("list", {
          limit: integerQuery(url, "limit"), offset: integerQuery(url, "offset")
        });
      } else if (route === "/api/memories" && method === "POST") {
        result = await client.memory("write", { entry: validate(() => readMemoryEntryInput(body)) });
      } else if (route === "/api/memories" && method === "DELETE") {
        result = await client.memory("clear");
      } else if (route === "/api/memories/stats" && method === "GET") {
        result = await client.memory("overview");
      } else if (route === "/api/memories/search" && method === "POST") {
        if (typeof body.query !== "string" || !body.query.trim()) throw new InputError("query is required");
        if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) throw new InputError("tags must be a string array");
        result = await client.memory("search", { query: body.query, tags: body.tags, limit: body.limit });
      } else if (route === "/api/memories/archive" && method === "GET") {
        result = await client.memory("archive-list");
      } else if (/^\/api\/memories\/archive\/[^/]+\/restore$/u.test(route) && method === "POST") {
        result = await client.memory("archive", { id: decodeURIComponent(route.split("/")[4]!), archived: false });
      } else if (route === "/api/memories/sleep/cancel" && method === "POST") {
        result = { cancelled: await client.cancelMemorySleep() };
      } else if (/^\/api\/memories\/sleep\/(status|runs|run|preview)$/u.test(route)) {
        const action = route.split("/").at(-1)!;
        if (method !== (action === "status" || action === "runs" ? "GET" : "POST")) { send(405, { error: "Method not allowed" }); return; }
        result = await client.memory(action === "run" ? "sleep-run-now" : `sleep-${action}`);
      } else if ((route === "/api/memories/rebuild-progress" || route === "/api/local-embeddings/models" || route === "/api/local-embeddings/progress") && method === "GET") {
        result = await client.memoryEmbeddingStatus();
      } else if (route === "/api/memories/rebuild" && method === "POST") {
        result = await client.rebuildMemoryEmbeddingIndex();
      } else if (route === "/api/memories/cancel-rebuild" && method === "POST") {
        result = await client.cancelMemoryEmbeddingRebuild();
      } else if (route === "/api/local-embeddings/download" && method === "POST") {
        if (body.model !== "multilingual-e5-small") throw new InputError("Unsupported embedding model");
        result = await client.downloadMemoryEmbeddingModel(body.model);
      } else if (route === "/api/local-embeddings/models/multilingual-e5-small" && method === "DELETE") {
        result = await client.deleteMemoryEmbeddingModel("multilingual-e5-small");
      } else if (route === "/api/threads/archive" && method === "POST") {
        result = await archiveConversationMarkdown();
      } else if (route === "/api/history/search" && method === "POST") {
        if (typeof body.query !== "string" || !body.query.trim()) throw new InputError("query is required");
        const index = new SessionSearchIndex();
        try {
          await index.refreshAll();
          result = { hits: body.literal === true ? index.grep(body.query) : index.search(body.query) };
        } finally { index.close(); }
      } else if (/^\/api\/memories\/[^/]+$/u.test(route)) {
        const id = decodeURIComponent(route.split("/")[3]!);
        if (method === "GET") result = await client.memory("get", { id });
        else if (method === "PUT") result = await client.memory("update", { id, patch: validate(() => readMemoryEntryPatch(body)) });
        else if (method === "DELETE") result = await client.memory("delete", { id });
        else { send(405, { error: "Method not allowed" }); return; }
      } else { send(404, { error: "Not found" }); return; }
      if (result === null) send(404, { error: "Memory not found" });
      else if (typeof result === "object" && result !== null && "accepted" in result && result.accepted === false) send(409, result);
      else send(200, result);
    } catch (error) {
      send(error instanceof InputError ? 400 : 502, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const closeWebSocket = await attachMemoryWebSocket(server, client, authorize);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { await closeWebSocket(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Memory API address unavailable");
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close: (): Promise<void> => {
      closing ??= (async () => {
        await closeWebSocket();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      })();
      return closing;
    }
  };
}

class InputError extends Error {}

function validate<T>(operation: () => T): T {
  try { return operation(); } catch (error) { throw new InputError(String(error)); }
}

function integerQuery(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new InputError(`${key} must be a nonnegative integer`);
  return number;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.method !== "POST" && request.method !== "PUT") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1024) throw new InputError("Request body exceeds 64 KiB");
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return {};
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new InputError("Expected application/json");
  const parsed: unknown = validate(() => JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("Expected a JSON object");
  return parsed as Record<string, unknown>;
}
