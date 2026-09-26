/** 本地记忆 REST 入口：只转发到宿主，不持有第二份领域状态或绕过运行时写入边界。 */
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { RuntimeHostClient } from "./client.js";
import { readMemoryEntryInput, readMemoryEntryPatch } from "./validation.js";
import { SessionSearchIndex } from "../../session/searchIndex.js";
import { archiveConversationMarkdown } from "../../session/markdownArchive.js";
import { attachMemoryWebSocket } from "./memory-websocket.js";
import type { MemoryArchiveEntriesResult, MemoryArchiveResult, MemoryClearResult, MemoryDeleteResult, MemoryEntriesResult, MemoryEntry, MemorySearchResult, MemorySleepRun, MemoryWriteResult } from "../../agent/context/memoryTypes.js";

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
        const limit = integerQuery(url, "limit");
        const offset = integerQuery(url, "offset");
        const paginated = limit !== undefined || offset !== undefined;
        const pageLimit = paginated ? limit || 20 : Number.MAX_SAFE_INTEGER;
        const pageOffset = offset ?? 0;
        const listed = await client.memory<MemoryEntriesResult>("list", {
          limit: pageLimit, offset: pageOffset, threadId: stringQuery(url, "threadId")
        });
        const items = listed.entries.map(toHttpMemoryEntry);
        send(200, paginated
          ? { items, total: listed.total, limit: pageLimit, offset: pageOffset }
          : items);
        return;
      } else if (route === "/api/memories" && method === "POST") {
        const written = await client.memory<MemoryWriteResult>("write", { entry: validate(() => readMemoryEntryInput(withMemoryMetadata(body))) });
        if (!written.written || !written.entry) throw new Error("Memory write did not create an entry");
        send(201, toHttpMemoryEntry(written.entry));
        return;
      } else if (route === "/api/memories" && method === "DELETE") {
        const threadId = stringQuery(url, "threadId");
        const cleared = await client.memory<MemoryClearResult>("clear", { threadId });
        send(200, threadId === undefined ? { message: "All memories cleared" } : { deleted: cleared.deletedEntries });
        return;
      } else if (route === "/api/memories/stats" && method === "GET") {
        result = await client.memory("stats");
      } else if (route === "/api/memories/status" && method === "GET") {
        result = await client.memory("service-status");
      } else if (route === "/api/memories/embedding-model" && method === "GET") {
        result = await client.memory("stored-embedding-model");
      } else if (route === "/api/tool-model/memory" && method === "GET") {
        result = await client.memory("tool-model");
      } else if (route === "/api/memories/search" && method === "POST") {
        if (typeof body.query !== "string" || !body.query.trim()) throw new InputError("query is required");
        if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) throw new InputError("tags must be a string array");
        if (body.threshold !== undefined &&
          (typeof body.threshold !== "number" || !Number.isFinite(body.threshold) || body.threshold < 0 || body.threshold > 1)) {
          throw new InputError("threshold must be a finite number between 0 and 1");
        }
        if (body.rewriteQuery !== undefined && typeof body.rewriteQuery !== "boolean") {
          throw new InputError("rewriteQuery must be a boolean");
        }
        const searched = await client.memory<MemorySearchResult>("search", {
          query: body.query,
          tags: body.tags,
          userId: body.userId,
          userIds: body.userIds,
          threadId: body.threadId,
          limit: body.limit,
          threshold: body.threshold,
          rewriteQuery: body.rewriteQuery
        });
        result = {
          results: searched.matches.map(({ entry, score }) => ({ ...toHttpMemoryEntry(entry), score })),
          originalQuery: searched.originalQuery ?? body.query.trim(),
          rewrittenQuery: searched.rewrittenQuery
        };
      } else if (route === "/api/memories/archive" && method === "GET") {
        const limit = Math.min(integerQuery(url, "limit") || 50, 200);
        const archived = await client.memory<MemoryArchiveEntriesResult>("archive-list", {
          limit, offset: integerQuery(url, "offset") ?? 0,
          runId: stringQuery(url, "runId"), userId: stringQuery(url, "userId")
        });
        send(200, { items: archived.entries.map(toHttpMemoryEntry), total: archived.total });
        return;
      } else if (/^\/api\/memories\/archive\/[^/]+\/restore$/u.test(route) && method === "POST") {
        const id = decodeURIComponent(route.split("/")[4]!);
        const archivedEntry = await client.memory<MemoryEntry | null>("get", { id });
        if (!archivedEntry?.archivedAt) result = null;
        else {
          // 恢复会消耗归档行；先读取合并指向，避免事实已恢复但响应读取失败。
          const target = archivedEntry.archivedReason === "llm_merge" && archivedEntry.mergedInto
            ? await client.memory<MemoryEntry | null>("get", { id: archivedEntry.mergedInto })
            : null;
          const restored = await client.memory<MemoryArchiveResult>("archive", { id, archived: false });
          if (!restored.entry) result = null;
          else {
            result = { success: true, memory: toHttpMemoryEntry(restored.entry), mergedTarget: target && !target.archivedAt
              ? { id: target.id, content: target.content } : null };
          }
        }
      } else if (route === "/api/memories/sleep/cancel" && method === "POST") {
        await client.cancelMemorySleep();
        result = { success: true };
      } else if (/^\/api\/memories\/sleep\/(status|runs|run|preview)$/u.test(route)) {
        const action = route.split("/").at(-1)!;
        if (method !== (action === "status" || action === "runs" ? "GET" : "POST")) { send(405, { error: "Method not allowed" }); return; }
        if (action === "runs") {
          const limit = Math.min(integerQuery(url, "limit") || 20, 100);
          const runs = await client.memory<MemorySleepRun[]>("sleep-runs");
          result = { runs: [...runs].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)).slice(0, limit) };
        } else if (action === "run") {
          const execution = await client.memory<{ maintenance: { lastRun?: MemorySleepRun } }>("sleep-run-now");
          if (!execution.maintenance.lastRun) throw new Error("Sleep run completed without an audit record");
          result = { success: true, run: execution.maintenance.lastRun };
        } else if (action === "preview") {
          result = { success: true, report: await client.memory("sleep-preview") };
        } else result = await client.memory("sleep-http-status");
      } else if (route === "/api/memories/rebuild-progress" && method === "GET") {
        const status = await client.memoryEmbeddingStatus();
        const operation = status.operation;
        result = operation?.kind === "rebuild" && operation.state === "running"
          ? { status: "rebuilding", total: operation.totalEntries, current: operation.processedEntries }
          : { status: "idle", total: 0, current: 0 };
      } else if ((route === "/api/local-embeddings/models" || route === "/api/local-embeddings/progress") && method === "GET") {
        result = await client.memoryEmbeddingStatus();
      } else if (route === "/api/memories/rebuild" && method === "POST") {
        const status = await client.memoryEmbeddingStatus();
        if (!status.activeModel) { send(400, { error: "No embedding model available" }); return; }
        try {
          await client.rebuildMemoryEmbeddingIndex();
        } catch (error) {
          send(500, { success: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        result = { success: true, message: "Embedding rebuild completed" };
      } else if (route === "/api/memories/cancel-rebuild" && method === "POST") {
        await client.cancelMemoryEmbeddingRebuild();
        result = { success: true, message: "Rebuild cancelled" };
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
        if (method === "GET") {
          const entry = await client.memory<MemoryEntry | null>("get", { id, activeOnly: true });
          result = entry ? toHttpMemoryEntry(entry) : null;
        }
        else if (method === "PUT") {
          const updated = await client.memory<MemoryWriteResult | null>("update", { id, patch: validate(() => readMemoryEntryPatch(withMemoryMetadata(body))), activeOnly: true });
          result = updated?.entry ? toHttpMemoryEntry(updated.entry) : null;
        } else if (method === "DELETE") {
          const deleted = await client.memory<MemoryDeleteResult | null>("delete", { id, activeOnly: true });
          if (!deleted) { send(404, { error: "Memory not found" }); return; }
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
          return;
        } else { send(405, { error: "Method not allowed" }); return; }
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

// REST 使用嵌套 metadata；Host/SQLite 的事实结构保持独立。
function withMemoryMetadata(body: Record<string, unknown>): Record<string, unknown> {
  if (body.metadata === undefined) return body;
  if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
    throw new InputError("metadata must be an object");
  }
  const metadata = body.metadata as Record<string, unknown>;
  for (const key of ["source", "rationale", "expiresAt"] as const) {
    if (metadata[key] !== undefined && typeof metadata[key] !== "string") {
      throw new InputError(`metadata.${key} must be a string`);
    }
  }
  const reserved = new Set(["source", "tags", "importance", "rationale", "durability", "expiresAt",
    "accessCount", "lastAccessedAt", "activitySource", "activitySessionId", "originAnchors"]);
  return {
    ...body,
    metadataExtra: Object.fromEntries(Object.entries(metadata).filter(([key]) => !reserved.has(key))),
    source: metadata.source,
    tags: metadata.tags,
    importance: metadata.importance,
    rationale: metadata.rationale,
    durability: metadata.durability,
    expiresAt: metadata.expiresAt
  };
}

function toHttpMemoryEntry(entry: MemoryEntry): Record<string, unknown> {
  const metadata = {
    ...entry.metadataExtra,
    source: entry.source,
    tags: entry.tags,
    importance: entry.importance,
    accessCount: entry.accessCount,
    durability: entry.durability,
    rationale: entry.rationale,
    expiresAt: entry.expiresAt,
    lastAccessedAt: entry.lastAccessedAt,
    activitySource: entry.activitySource,
    activitySessionId: entry.activitySessionId,
    originAnchors: entry.originAnchors
  };
  const common = {
    id: entry.id,
    content: entry.content,
    threadId: entry.threadId ?? null,
    messageId: entry.messageId ?? null,
    userId: entry.userId ?? null,
    metadata
  };
  return entry.archivedAt ? {
    ...common,
    originalId: entry.originalId,
    originalCreatedAt: entry.createdAt,
    originalUpdatedAt: entry.updatedAt,
    archivedAt: entry.archivedAt,
    archivedReason: entry.archivedReason,
    archivedBy: entry.archivedBy,
    mergedInto: entry.mergedInto ?? null
  } : { ...common, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
}

function stringQuery(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1 || (values.length === 1 && !values[0]?.trim())) {
    throw new InputError(`${key} must be one non-empty value`);
  }
  return values[0];
}

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
