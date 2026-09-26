/**
 * Activity 的本地 REST 投影。
 *
 * Desktop 主流程继续使用 Electron IPC；本机集成使用loopback API。
 * 服务只绑定 127.0.0.1，所有文本仍从 ActivityStore 的脱敏查询层读取。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
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
  /** 服务持有显式分析后的投影及 ActivityStore 清理，关闭时收齐。 */
  scheduleProjection?: (task: Promise<void>) => void;
  crystal?: CrystalHttpDependencies;
  getRuntimeSnapshot?(): ActivityRuntimeSnapshot | Promise<ActivityRuntimeSnapshot>;
  /** REST 专属前台状态；IPC 快照继续使用自身的展示模型。 */
  getFrontmost?(): { bundleId: string | null; appName: string | null };
  isCaptureRunning?(): boolean;
  getPermissions?(): ActivityPermissionStatus | Promise<ActivityPermissionStatus>;
  /** 使用采集宿主现有的一代任务信号，stop/clear/配置变更时共同失效。 */
  getOperationSignal?(): AbortSignal;
  start?(): Promise<unknown>;
  stop?(): Promise<unknown>;
  clear?(): Promise<unknown>;
  openPermissions?(pane: "screen-recording" | "accessibility"): Promise<void>;
}

export interface ActivityPermissionStatus {
  platform: string;
  screenRecording: string;
  accessibility: boolean;
  openSettingsCapable: boolean;
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
  token: string;
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
            "sessions/:id/analyze", "report/:date", "summary/daily/:date", "summary/weekly/:weekKey (GET)", "summary/weekly/:endDateKey (POST)", "suggestions", "snapshot-file"
          ]
        }
      };
    }
  if (pathname === "/api/activity-recorder/config" && method === "GET") {
      return { status: 200, body: toActivityRestConfig(await deps.loadSettings()) };
    }
    if (pathname === "/api/activity-recorder/config" && method === "PUT") {
      const parsed = activitySettingsPatchSchema.safeParse(fromActivityRestPatch(request.body));
      if (!parsed.success) return badRequest("Activity 配置无效。");
      if (!deps.setConfig) return { status: 501, body: { error: "当前 Activity 宿主不提供配置修改。" } };
      return { status: 200, body: toActivityRestConfig(await deps.setConfig(parsed.data)) };
    }
    if (pathname === "/api/activity-recorder/status" && method === "GET") {
      return { status: 200, body: await activityStatus(deps) };
    }
    if (pathname === "/api/activity-recorder/permissions" && method === "GET") {
      if (!deps.getPermissions) return { status: 501, body: { error: "当前 Activity 宿主不提供权限状态。" } };
      return { status: 200, body: await deps.getPermissions() };
    }
    if (pathname === "/api/activity-recorder/permissions/open" && method === "POST") {
      const which = searchParams.get("which");
      const pane = which === "screen" ? "screen-recording" : which;
      if (pane !== "screen-recording" && pane !== "accessibility") return badRequest("权限设置页无效。");
      if (!deps.openPermissions) {
        const permissions = await deps.getPermissions?.();
        if (permissions && permissions.platform !== "darwin") {
          return { status: 200, body: { ok: false, reason: "not darwin" } };
        }
        return { status: 501, body: { error: "当前 Activity 宿主不能打开系统设置。" } };
      }
      await deps.openPermissions(pane);
      return { status: 200, body: { ok: true } };
    }
    if (pathname === "/api/activity-recorder/start" && method === "POST") {
      if (!deps.start) return { status: 501, body: { error: "start 不在当前 Activity 宿主中可用。" } };
      await deps.start();
      return { status: 200, body: await activityStatus(deps) };
    }
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
    let backgroundProjection: Promise<void> | undefined;
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
        const since = epochMilliseconds(searchParams.get("since"));
        const until = epochMilliseconds(searchParams.get("until"));
        const analysisStatus = searchParams.get("analysisStatus") ?? undefined;
        if (since === null || until === null) return badRequest("session 时间无效。");
        if (analysisStatus !== undefined && !["pending", "analyzed", "skipped", "failed", "not_worth"].includes(analysisStatus)) {
          return badRequest("analysisStatus 无效。");
        }
        return { status: 200, body: {sessions:store.listHttpSessions({
          since, until, analysisStatus,
          limit: boundedLimit(searchParams.get("limit"), 100, 1_000),
          offset: boundedOffset(searchParams.get("offset"))
        })} };
      }
      if (pathname.startsWith("/api/activity-recorder/sessions/") && pathname.endsWith("/analyze") && method === "POST") {
        hostSignal?.throwIfAborted();
        const sessionId = decodePathPart(pathname.slice("/api/activity-recorder/sessions/".length, -"/analyze".length));
        const resolvedSessionId = store.getHttpSessionDetail(sessionId)?.session.id;
        if (!resolvedSessionId) return notFound("没有找到 Activity session。");
        await analyzeActivitySession({
            store,
            model: await deps.getModel?.(),
            ...operation,
            writeMemories: deps.writeMemories,
            onAnalyzed: deps.onAnalyzed,
            deferProjection: deps.scheduleProjection === undefined ? undefined : (task) => {
              backgroundProjection = task.then(undefined, () => {
                if (!signal.aborted) console.error("[ActivityAnalyzer] projection failed");
              });
            }
          }, resolvedSessionId, true);
        // REST 返回保存后的 session 元数据，分析结果由状态字段表达。
        return { status: 200, body: store.getHttpSessionDetail(resolvedSessionId)?.session };
      }
      if (pathname.startsWith("/api/activity-recorder/sessions/") && method === "GET") {
        const sessionId = decodePathPart(pathname.slice("/api/activity-recorder/sessions/".length));
        if (!sessionId) return badRequest("session id 不能为空。");
        const detail = store.getHttpSessionDetail(sessionId);
        if (!detail) return notFound("没有找到 Activity session。");
        return { status: 200, body: detail };
      }
      if (pathname.startsWith("/api/activity-recorder/sessions/") && method === "DELETE") {
        const sessionId = decodePathPart(pathname.slice("/api/activity-recorder/sessions/".length));
        if (!sessionId) return badRequest("session id 不能为空。");
        const result = await store.deleteSession(sessionId);
        if (result === "not_found") return notFound("没有找到 Activity session。");
        if (result === "active") return { status: 409, body: { error: "进行中的 Activity session 不能删除。" } };
        return { status: 200, body: { ok: true } };
      }
      if (pathname === "/api/activity-recorder/digest" && method === "GET") {
        const lookbackMin = Math.max(5, boundedLimit(searchParams.get("lookbackMin"), 120, 1_440));
        const maxAnalyzed = boundedLimit(searchParams.get("maxAnalyzed"), 8, 50);
        const result = await buildActivityDigest({ store, maxAnalyzed }, lookbackMin);
        return { status: 200, body: result.markdown, contentType: "text/markdown; charset=utf-8" };
      }
      if (pathname.startsWith("/api/activity-recorder/report/") && method === "GET") {
        hostSignal?.throwIfAborted();
        const date = decodePathPart(pathname.slice("/api/activity-recorder/report/".length));
        const range = resolveActivityReportRange(date, new Date());
        const skeletonOnly = isTrueQueryValue(searchParams.get("skeletonOnly"));

        const skeleton = await buildActivityReport({
          store,
          ...operation
        }, range.label, { force: isTrueQueryValue(searchParams.get("force")), skeletonOnly });
        const model = skeleton.cached || skeletonOnly ? undefined : await deps.getModel?.();
        const report = await narrateActivityReport(skeleton, { store, model, skeleton: skeletonOnly, ...operation });
        if (searchParams.get("format") !== "json") {
          return { status: 200, body: report.markdown, contentType: "text/markdown; charset=utf-8" };
        }
        const reportGeneratedAt = store.getSummary("daily", report.date)?.stats.reportGeneratedAt;
        if (typeof reportGeneratedAt !== "number") throw new Error("Activity report 缺少持久化生成时间。");
        const jsonReport = {
          dateKey: report.date,
          markdown: report.markdown,
          isPartial: report.date >= resolveActivityReportRange("today", new Date()).label,
          model: report.cached ? null : report.narrativeModel ?? null,
          generatedAt: reportGeneratedAt,
          stats: report.stats
        };
        return { status: 200, body: jsonReport };
      }
      const summaryRoute = /^\/api\/activity-recorder\/summary\/(daily|weekly)\/(.+)$/u.exec(pathname);
      if (summaryRoute && (method === "GET" || method === "POST")) {
        const kind = summaryRoute[1] as "daily" | "weekly";
        const dateKey = decodePathPart(summaryRoute[2] ?? "");
        if (kind === "weekly" && method === "GET") {
          if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/u.test(dateKey)) return badRequest("weekly summary weekKey 必须是 YYYY-Www。");
          return { status: 200, body: store.getHttpSummary("weekly", dateKey) ?? null };
        }
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) return badRequest("summary date 必须是 YYYY-MM-DD。");
        if (method === "GET") return { status: 200, body: store.getHttpSummary(kind, dateKey) ?? null };
        hostSignal?.throwIfAborted();
        const model = await deps.getModel?.();

        const refreshed = await refreshActivitySummaryWithNarrative(store, kind, dateKey, {
            model,
            ...operation,
            withNarrative: searchParams.get("narrative") === "true"
          });
        return { status: 200, body: store.getHttpSummary(kind, refreshed.dateKey) };
      }
      if (pathname === "/api/activity-recorder/suggestions" && method === "GET") {
        hostSignal?.throwIfAborted();
        const model = await deps.getModel?.();
        const result = await generateActivitySuggestions({
          store,
          model,
          ...operation,
          force: isTrueQueryValue(searchParams.get("force"))
        });
        return { status: 200, body: { suggestions: result.suggestions } };
      }
      if (method === "GET" && pathname === "/api/activity-recorder/snapshot-file") {
        const requested = searchParams.get("path");
        if (!requested) return badRequest("path required");
        const root = await realpath(resolveActivityDirectory(settings.outputDirectory));
        let file: string;
        try {
          file = await realpath(path.resolve(requested));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return notFound("not found");
          throw error;
        }
        const relative = path.relative(root, file);
        if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          return { status: 403, body: { error: "forbidden path" } };
        }
        try {
          return { status: 200, body: await readFile(file), contentType: "image/jpeg" };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return notFound("not found");
          throw error;
        }
      }
      return notFound();
    } finally {
      if (backgroundProjection && deps.scheduleProjection) {
        deps.scheduleProjection(backgroundProjection.finally(async () => await store.close()));
      } else {
        await store.close();
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { status: 409, body: { error: "Activity 请求已取消。" } };
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function startActivityHttpServer(
  deps: ActivityHttpApiDependencies,
  options: { port?: number; token?: string } = {}
): Promise<ActivityHttpServer> {
  const host = "127.0.0.1";
  const token = options.token ?? randomBytes(32).toString("base64url");
  let port = options.port ?? 0;
  const shutdown = new AbortController();
  const responses = new Set<Promise<void>>();
  const projections = new Set<Promise<void>>();
  const scheduleProjection = (task: Promise<void>): void => {
    const managed = task.catch(() => {
      console.error("[ActivityHttp] projection cleanup failed");
    }).finally(() => { projections.delete(managed); });
    projections.add(managed);
  };
  const server = createServer((request, response) => {
    const managed = respond(request, response, { ...deps, scheduleProjection }, shutdown.signal, token, port)
      .catch(() => {
        if (!response.destroyed) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "Activity 请求失败。" }));
        }
      }).finally(() => { responses.delete(managed); });
    responses.add(managed);
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
  port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;
  return {
    server,
    host,
    port,
    token,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        shutdown.abort();
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      while (responses.size) await Promise.all(responses);
      while (projections.size) await Promise.all(projections);
    }
  };
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ActivityHttpApiDependencies,
  shutdownSignal: AbortSignal,
  token: string,
  port: number
): Promise<void> {
  const disconnected = new AbortController();
  const onClose = (): void => { if (!response.writableFinished) disconnected.abort(); };
  response.once("close", onClose);
  try {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "forbidden origin" }));
      return;
    }
    if (origin !== undefined) response.setHeader("Access-Control-Allow-Origin", origin);
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ") ? Buffer.from(authorization.slice(7)) : Buffer.alloc(0);
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.statusCode = 401;
      response.setHeader("WWW-Authenticate", "Bearer");
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
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
    response.end(Buffer.isBuffer(result.body) || (typeof result.body === "string" && result.contentType?.startsWith("text/"))
      ? result.body : JSON.stringify(result.body));
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
  if (!runtime) return { running: false, config: null };
  const settings = await deps.loadSettings();
  return {
    running: deps.isCaptureRunning?.() ?? runtime.state === "running",
    currentSessionId: runtime.currentSessionId ?? null,
    screenLocked: runtime.screenLocked,
    frontmost: deps.getFrontmost?.() ?? { bundleId: null, appName: null },
    config: toActivityRestConfig(settings),
    outputDir: settings.outputDirectory,
    totalBytes: runtime.storageBytes,
    sessionCount: runtime.sessions
  };
}

/** REST 只暴露本地采集器能兑现的配置；未实现的设置不伪装成可配置能力。 */
function toActivityRestConfig(settings: ActivitySettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    outputDir: settings.outputDirectory,
    snapshotDebounceMs: settings.captureDebounceMs,
    heartbeatIntervalMs: settings.heartbeatMs,
    idleThresholdMs: settings.idleTimeoutMs,
    typingPauseMs: settings.inputPauseMs,
    visualCheckIntervalMs: settings.visualPollMs,
    histogramChangeThreshold: settings.histogramChangeThreshold,
    pixelDiffThreshold: settings.pixelDiffThreshold,
    pixelTolerance: settings.pixelTolerance,
    enableOcr: settings.ocrEnabled,
    ocrLanguages: settings.ocrLanguages,
    ocrEveryN: settings.ocrEveryNFrames,
    enableInputMonitor: settings.inputMonitoringEnabled,
    sensitiveApps: settings.sensitiveApplications,
    maxStorageBytes: settings.maxStorageMb * 1024 * 1024,
    captureFormat: "jpg",
    jpegQuality: settings.jpegQuality,
    browserPollIntervalMs: settings.browserPollIntervalMs
  };
}

function fromActivityRestPatch(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const names: Record<string, keyof ActivitySettings> = {
    outputDir: "outputDirectory", snapshotDebounceMs: "captureDebounceMs", heartbeatIntervalMs: "heartbeatMs",
    idleThresholdMs: "idleTimeoutMs", typingPauseMs: "inputPauseMs", visualCheckIntervalMs: "visualPollMs",
    enableOcr: "ocrEnabled", ocrEveryN: "ocrEveryNFrames", enableInputMonitor: "inputMonitoringEnabled",
    sensitiveApps: "sensitiveApplications"
  };
  const patch: Record<string, unknown> = {};
  const internalNames = new Set([...Object.values(names), "maxStorageMb"]);
  for (const [key, field] of Object.entries(value)) {
    if (internalNames.has(key)) {
      patch[`unsupported:${key}`] = field;
      continue;
    }
    if (key === "maxStorageBytes") {
      patch.maxStorageMb = typeof field === "number" && Number.isInteger(field) && field % (1024 * 1024) === 0
        ? field / (1024 * 1024) : field;
      continue;
    }
    if (key === "captureFormat") {
      if (field !== "jpg") patch.captureFormat = field;
      continue;
    }
    patch[names[key] ?? key] = field;
  }
  return patch;
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

function isTrueQueryValue(value: string | null): boolean {
  return value === "1" || value === "true";
}

function epochMilliseconds(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function boundedOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function badRequest(message: string): ActivityHttpResponse {
  return { status: 400, body: { error: message } };
}

function notFound(message = "Activity endpoint 不存在。"): ActivityHttpResponse {
  return { status: 404, body: { error: message } };
}
