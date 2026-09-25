/**
 * Activity 的本地 REST 投影。
 *
 * Desktop 主流程继续使用 Electron IPC；本机集成使用loopback API。
 * 服务只绑定 127.0.0.1，所有文本仍从 ActivityStore 的脱敏查询层读取。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import type { AgentModel } from "../agent/core/types.js";
import { activitySettingsPatchSchema, type ActivitySettings, type ActivitySettingsPatch } from "./settings.js";
import { ActivityStore, resolveActivityDirectory } from "./store.js";
import { createActivityOperation } from "./operation.js";
import { buildActivityDigest } from "./digest.js";
import { analyzeActivitySession, buildActivityReport, resolveActivityReportRange, type ActivityAnalyzerDeps } from "./analyzer.js";
import { narrateActivityReport } from "./reportNarrative.js";
import { refreshActivitySummaryWithNarrative } from "./summary.js";
import { generateActivitySuggestions } from "./suggestions.js";
import { searchActivitySemantic } from "./semanticSearch.js";
import type { ActivityRuntimeSnapshot } from "./types.js";
import { handleCrystalHttpRequest, type CrystalHttpDependencies } from "../agent/context/crystalHttp.js";
import { globalAgentDir } from "../config/paths.js";
import type { EmbeddingModelRuntime } from "../llm/embedding/types.js";

export interface ActivityHttpApiDependencies {
  /** 隔离运行时的 Agent 数据根；默认使用全局根。 */
  agentDir?: string;
  loadSettings(): Promise<ActivitySettings>;
  setConfig?(patch: ActivitySettingsPatch): Promise<ActivitySettings>;
  getModel?(): AgentModel | undefined | Promise<AgentModel | undefined>;
  getEmbeddingRuntime?(): Promise<EmbeddingModelRuntime | undefined>;
  writeMemories?: ActivityAnalyzerDeps["writeMemories"];
  onAnalyzed?: ActivityAnalyzerDeps["onAnalyzed"];
  crystal?: CrystalHttpDependencies;
  getRuntimeSnapshot?(): ActivityRuntimeSnapshot | Promise<ActivityRuntimeSnapshot>;
  /** 使用采集宿主现有的一代任务信号，stop/clear/配置变更时共同失效。 */
  getOperationSignal?(): AbortSignal;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  clear?(): Promise<unknown>;
  openPermissions?(pane: "screen-recording" | "accessibility"): Promise<void>;
}

export interface ActivityHttpRequest {
  method: string;
  pathname: string;
  searchParams?: URLSearchParams;
  body?: unknown;
  signal?: AbortSignal;
}

export interface ActivityHttpResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

export interface ActivityHttpServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

export async function handleActivityHttpRequest(
  request: ActivityHttpRequest,
  deps: ActivityHttpApiDependencies
): Promise<ActivityHttpResponse> {
  const method = request.method.toUpperCase();
  const pathname = normalizePath(request.pathname);
  const searchParams = request.searchParams ?? new URLSearchParams();
  if (deps.crystal) {
    const crystalResponse = await handleCrystalHttpRequest({
      method,
      pathname,
      searchParams,
      body: request.body
    }, deps.crystal);
    if (crystalResponse) return crystalResponse;
  }
  if (pathname !== "/api/activity-recorder" && !pathname.startsWith("/api/activity-recorder/")) {
    return notFound();
  }
  if (method === "OPTIONS") return { status: 204, body: undefined };

  try {
    if (pathname === "/api/activity-recorder" && method === "GET") {
      return {
        status: 200,
        body: {
          endpoints: [
            "config", "status", "permissions", "start", "stop", "clear", "search/keyword", "search/semantic", "sessions", "digest",
            "sessions/:id/analyze", "report/:date", "summary/daily/:date", "summary/weekly/:date", "suggestions", "snapshot-file"
          ]
        }
      };
    }
  if (pathname === "/api/activity-recorder/config" && method === "GET") {
      return { status: 200, body: await deps.loadSettings() };
    }
    if (pathname === "/api/activity-recorder/config" && method === "PUT") {
      const parsed = activitySettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) return badRequest("Activity 配置无效。");
      if (!deps.setConfig) return { status: 501, body: { error: "当前 Activity 宿主不提供配置修改。" } };
      return { status: 200, body: await deps.setConfig(parsed.data) };
    }
    if (pathname === "/api/activity-recorder/status" && method === "GET") {
      return { status: 200, body: await activityStatus(deps) };
    }
    if (pathname === "/api/activity-recorder/permissions" && method === "GET") {
      const snapshot = await deps.getRuntimeSnapshot?.();
      if (!snapshot) return { status: 501, body: { error: "当前 Activity 宿主不提供权限状态。" } };
      return { status: 200, body: {
        collectorAvailable: snapshot.collectorAvailable,
        screenRecordingGranted: snapshot.screenRecordingGranted,
        accessibilityGranted: snapshot.accessibilityGranted,
        fallbackAvailable: snapshot.fallbackAvailable
      } };
    }
    if (pathname === "/api/activity-recorder/permissions/open" && method === "POST") {
      const which = searchParams.get("which");
      const pane = which === "screen" ? "screen-recording" : which;
      if (pane !== "screen-recording" && pane !== "accessibility") return badRequest("权限设置页无效。");
      if (!deps.openPermissions) return { status: 501, body: { error: "当前 Activity 宿主不能打开系统设置。" } };
      await deps.openPermissions(pane);
      return { status: 200, body: { opened: true } };
    }
    if (pathname === "/api/activity-recorder/start" && method === "POST") return await control(deps.start, "start");
    if (pathname === "/api/activity-recorder/stop" && method === "POST") return await control(deps.stop, "stop");
    if (pathname === "/api/activity-recorder/clear" && method === "POST") return await control(deps.clear, "clear");

    const hostSignal = deps.getOperationSignal?.();
    // 停止时取消在途请求，但停止后新发起的本地历史查询仍可用；模型任务另行检查宿主状态。
    const signals = [request.signal, hostSignal?.aborted ? undefined : hostSignal].filter((value): value is AbortSignal => value !== undefined);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const settings = await deps.loadSettings();
    signal.throwIfAborted();
    const store = new ActivityStore();
    await store.open(settings.outputDirectory, deps.agentDir ?? globalAgentDir());
    try {
      const operation = createActivityOperation(store, settings, deps.loadSettings, signal);
      await operation.checkpoint();
      if ((pathname === "/api/activity-recorder/search" || pathname === "/api/activity-recorder/search/keyword") && method === "GET") {
        const query = searchParams.get("q")?.trim() ?? "";
        const results = query ? store.search(query, boundedLimit(searchParams.get("limit"), 50, 500)).map(row => ({id:row.id,sessionId:row.sessionId,snapshotId:row.snapshotId,text:row.ocrText,createdAt:row.createdAt})) : [];
        return {status:200,body:{results}};
      }
      if (pathname === "/api/activity-recorder/search/semantic" && method === "GET") {
        const query = searchParams.get("q")?.trim() ?? "";
        if (!query) return {status:200,body:{results:[]}};
        const result = await searchActivitySemantic({store,getEmbeddingRuntime:deps.getEmbeddingRuntime ?? (async()=>undefined),query,limit:boundedLimit(searchParams.get("limit"),20,100),...operation});
        if (!result.ok) return result.reason === "no_vectors" ? {status:200,body:{results:[]}} : {status:500,body:{error:result.message}};
        return {status:200,body:{results:result.hits.map(row=>({id:row.id,sessionId:row.sessionId,snapshotId:row.snapshotId,text:row.text,score:row.score,createdAt:row.createdAt}))}};
      }
      if (pathname === "/api/activity-recorder/sessions" && method === "GET") {
        const since = searchParams.get("since") ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
        const until = searchParams.get("until") ?? undefined;
        const analysisStatus = searchParams.get("analysisStatus") ?? undefined;
        if (!Number.isFinite(Date.parse(since)) || (until !== undefined && !Number.isFinite(Date.parse(until)))) {
          return badRequest("session 时间无效。");
        }
        if (analysisStatus !== undefined && !["pending", "analyzed", "skipped", "failed", "not_worth"].includes(analysisStatus)) {
          return badRequest("analysisStatus 无效。");
        }
        return { status: 200, body: store.listSessionsWithAnalysis({
          sinceIso: since, untilIso: until, analysisStatus,
          limit: boundedLimit(searchParams.get("limit"), 50, 200),
          offset: boundedOffset(searchParams.get("offset"))
        }) };
      }
      if (pathname.startsWith("/api/activity-recorder/sessions/") && pathname.endsWith("/analyze") && method === "POST") {
        hostSignal?.throwIfAborted();
        const sessionId = decodePathPart(pathname.slice("/api/activity-recorder/sessions/".length, -"/analyze".length));
        if (!store.getSessionDetail(sessionId)) return notFound("没有找到 Activity session。");
        return {
          status: 200,
          body: await analyzeActivitySession({
            store,
            model: await deps.getModel?.(),
            ...operation,
            writeMemories: deps.writeMemories,
            onAnalyzed: deps.onAnalyzed
          }, sessionId, true)
        };
      }
      if (pathname.startsWith("/api/activity-recorder/sessions/") && method === "GET") {
        const sessionId = decodePathPart(pathname.slice("/api/activity-recorder/sessions/".length));
        if (!sessionId) return badRequest("session id 不能为空。");
        const detail = store.getSessionDetail(sessionId);
        if (!detail) return notFound("没有找到 Activity session。");
        return {
          status: 200,
          body: {
            ...detail,
            events: detail.events.map(({ snapshotPath: _snapshotPath, ...event }) => event)
          }
        };
      }
      if (pathname.startsWith("/api/activity-recorder/sessions/") && method === "DELETE") {
        const sessionId = decodePathPart(pathname.slice("/api/activity-recorder/sessions/".length));
        if (!sessionId) return badRequest("session id 不能为空。");
        const result = await store.deleteSession(sessionId);
        if (result === "not_found") return notFound("没有找到 Activity session。");
        if (result === "active") return { status: 409, body: { error: "进行中的 Activity session 不能删除。" } };
        return { status: 200, body: { deleted: true } };
      }
      if (pathname === "/api/activity-recorder/digest" && method === "GET") {
        const lookbackMin = boundedLimit(searchParams.get("lookbackMin"), 120, 1_440);
        const result = await buildActivityDigest({ store, lookbackMin });
        return { status: 200, body: result };
      }
      if (pathname.startsWith("/api/activity-recorder/report/") && method === "GET") {
        hostSignal?.throwIfAborted();
        const date = decodePathPart(pathname.slice("/api/activity-recorder/report/".length));
        const range = resolveActivityReportRange(date, new Date());
        const model = await deps.getModel?.();

        const skeleton = await buildActivityReport({
          store,
          model,
          ...operation,
          writeMemories: deps.writeMemories,
          onAnalyzed: deps.onAnalyzed,
          analyzePending: searchParams.get("skeleton") !== "true"
        }, range.label, { force: searchParams.get("force") === "true" });
        return {
          status: 200,
          body: await narrateActivityReport(skeleton, { model, skeleton: searchParams.get("skeleton") === "true", ...operation })
        };
      }
      const summaryRoute = /^\/api\/activity-recorder\/summary\/(daily|weekly)\/(.+)$/u.exec(pathname);
      if (summaryRoute && (method === "GET" || method === "POST")) {
        const kind = summaryRoute[1] as "daily" | "weekly";
        const dateKey = decodePathPart(summaryRoute[2] ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) return badRequest("summary date 必须是 YYYY-MM-DD。");
        if (method === "GET") return { status: 200, body: store.getSummary(kind, dateKey) ?? null };
        hostSignal?.throwIfAborted();
        const model = await deps.getModel?.();

        return {
          status: 200,
          body: await refreshActivitySummaryWithNarrative(store, kind, dateKey, {
            model,
            ...operation,
            withNarrative: searchParams.get("narrative") === "true"
          })
        };
      }
      if (pathname === "/api/activity-recorder/suggestions" && method === "GET") {
        hostSignal?.throwIfAborted();
        const model = await deps.getModel?.();
        const result = await generateActivitySuggestions({
          store,
          model,
          ...operation,
          force: searchParams.get("force") === "true"
        });
        return { status: 200, body: result };
      }
      if (method === "GET" && pathname === "/api/activity-recorder/snapshot-file") {
        const requested = searchParams.get("path");
        if (!requested) return badRequest("path required");
        const file = path.resolve(requested);
        if (!file.startsWith(resolveActivityDirectory(settings.outputDirectory))) return { status: 403, body: { error: "forbidden path" } };
        try {
          return { status: 200, body: await readFile(file), contentType: "image/jpeg" };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return notFound("not found");
          throw error;
        }
      }
      return notFound();
    } finally {
      await store.close();
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { status: 409, body: { error: "Activity 请求已取消。" } };
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function startActivityHttpServer(
  deps: ActivityHttpApiDependencies,
  options: { port?: number } = {}
): Promise<ActivityHttpServer> {
  const host = "127.0.0.1";
  const shutdown = new AbortController();
  const server = createServer((request, response) => {
    void respond(request, response, deps, shutdown.signal);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, host);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;
  return {
    server,
    host,
    port,
    close: async () => await new Promise<void>((resolve, reject) => {
      shutdown.abort();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ActivityHttpApiDependencies,
  shutdownSignal: AbortSignal
): Promise<void> {
  const disconnected = new AbortController();
  const onClose = (): void => { if (!response.writableFinished) disconnected.abort(); };
  response.once("close", onClose);
  try {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body: unknown;
    if (["POST", "PUT", "PATCH"].includes((request.method ?? "GET").toUpperCase())) {
      const parsed = await readJsonBody(request);
      if (!parsed.ok) {
        response.statusCode = parsed.status;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      body = parsed.body;
    }
    const result = await handleActivityHttpRequest({
      method: request.method ?? "GET",
      pathname: url.pathname,
      searchParams: url.searchParams,
      body,
      signal: AbortSignal.any([disconnected.signal, shutdownSignal])
    }, deps);
    if (response.destroyed) return;
    response.statusCode = result.status;
    response.setHeader("Content-Type", result.contentType ?? "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (result.status === 204) {
      response.end();
      return;
    }
    response.end(Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body));
  } finally {
    response.off("close", onClose);
  }
}

async function readJsonBody(
  request: IncomingMessage
): Promise<{ ok: true; body?: unknown } | { ok: false; status: number; error: string }> {
  const maxBytes = 2 * 1024 * 1024;
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { ok: true; body?: unknown } | { ok: false; status: number; error: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        finish({ ok: false, status: 413, error: "request body too large" });
        request.resume();
        return;
      }
      chunks.push(buffer);
    });
    request.on("error", (error: Error) => finish({ ok: false, status: 400, error: error.message }));
    request.on("aborted", () => finish({ ok: false, status: 400, error: "request aborted" }));
    request.on("end", () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        finish({ ok: true, body: undefined });
        return;
      }
      try {
        finish({ ok: true, body: JSON.parse(text) as unknown });
      } catch {
        finish({ ok: false, status: 400, error: "request body must be valid JSON" });
      }
    });
  });
}

async function activityStatus(deps: ActivityHttpApiDependencies): Promise<unknown> {
  const runtime = await deps.getRuntimeSnapshot?.();
  if (runtime) return runtime;
  const settings = await deps.loadSettings();
  const store = new ActivityStore();
  await store.open(settings.outputDirectory, deps.agentDir ?? globalAgentDir());
  try {
    return {
      state: settings.enabled ? "unavailable" : "paused",
      collectorAvailable: false,
      ...store.snapshot()
    };
  } finally {
    await store.close();
  }
}

async function control(
  action: (() => Promise<unknown>) | undefined,
  name: string
): Promise<ActivityHttpResponse> {
  if (!action) return { status: 501, body: { error: `${name} 不在当前 Activity 宿主中可用。` } };
  return { status: 200, body: await action() };
}

function normalizePath(value: string): string {
  if (value.length > 1) return value.replace(/\/+$/u, "");
  return value;
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function boundedLimit(value: string | null, fallback: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

function boundedOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, 10_000) : 0;
}

function badRequest(message: string): ActivityHttpResponse {
  return { status: 400, body: { error: message } };
}

function notFound(message = "Activity endpoint 不存在。"): ActivityHttpResponse {
  return { status: 404, body: { error: message } };
}
