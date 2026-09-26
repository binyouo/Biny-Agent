/** 记忆只读推送：文件事件触发刷新，Sleep 阶段从有界持久日志补发，所有数据仍从宿主读取。 */
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { AGENT_DATABASE_FILE, globalAgentDir } from "../../config/paths.js";
import type { MemoryMaintenanceStatus } from "../../agent/context/memoryTypes.js";
import type { RuntimeHostClient } from "./client.js";

type MemoryStatusClient = Pick<RuntimeHostClient, "memory" | "memoryEmbeddingStatus">;
const maxBufferedBytes = 1024 * 1024;

export async function attachMemoryWebSocket(
  server: Server,
  client: MemoryStatusClient,
  authorize: (request: IncomingMessage) => number | undefined
): Promise<() => Promise<void>> {
  const directory = globalAgentDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Memory directory must be a real directory.");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const states = new Map<WebSocket, {
    last: Map<string, string>;
    alive: boolean;
    sleepInitialized: boolean;
    lastSleepRunId?: string;
    sleepReplayEligible: boolean;
  }>();
  let closed = false;
  let pending = false;
  let dirty = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const publish = (type: string, data: unknown, key = type, recipients?: ReadonlySet<WebSocket>): void => {
    if (closed) return;
    const value = JSON.stringify(data);
    const frame = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const [ws, state] of states) {
      if (recipients && !recipients.has(ws)) continue;
      if (ws.readyState !== WebSocket.OPEN || state.last.get(key) === value) continue;
      // 慢消费者应重连补快照，不能让其无界累积宿主状态。
      if (ws.bufferedAmount + Buffer.byteLength(frame) > maxBufferedBytes) { ws.terminate(); continue; }
      state.last.set(key, value);
      ws.send(frame, (error) => { if (error) ws.terminate(); });
    }
  };
  const refresh = async (): Promise<void> => {
    if (closed || !states.size) return;
    if (pending) { dirty = true; return; }
    pending = true;
    try {
      const sources = ["memory", "sleep", "embedding"];
      const results = await Promise.allSettled([
        client.memory<{ overview?: unknown }>("overview"),
        client.memory<MemoryMaintenanceStatus>("sleep-status"),
        client.memoryEmbeddingStatus()
      ]);
      if (closed) return;
      for (const [index, result] of results.entries()) {
        const source = sources[index]!;
        const errorKey = `error:${source}`;
        if (result.status === "rejected") {
          publish("memory-stream-error", { source, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }, errorKey);
          for (const state of states.values()) state.last.delete(`ready:${source}`);
          continue;
        }
        let recovered = false;
        for (const state of states.values()) if (state.last.delete(errorKey)) recovered = true;
        // 明确告知恢复，即便恢复后的业务值与断线前相同。
        if (recovered) publish("memory-stream-ready", { source }, `ready:${source}`);
      }
      const [memory, sleep, embedding] = results;
      if (memory.status === "fulfilled") publish("memory-changed", memory.value.overview ?? memory.value);
      if (sleep.status === "fulfilled") {
        const status = sleep.value;
        publish("memory-sleep-status", status);
        const run = status.lastRun;
        const recipients = new Set<WebSocket>();
        for (const [ws, state] of states) {
          if (!state.sleepInitialized) {
            state.sleepInitialized = true;
            state.lastSleepRunId = run?.id;
            state.sleepReplayEligible = run?.status === "running";
          } else if (run && state.lastSleepRunId !== run.id) {
            for (const key of state.last.keys()) if (key.startsWith("sleep:")) state.last.delete(key);
            state.lastSleepRunId = run.id;
            state.sleepReplayEligible = true;
          }
          if (run && state.sleepReplayEligible) recipients.add(ws);
        }
        // 采样可能跨过多个快速阶段；按已提交的有界阶段日志逐一补发。
        if (run && recipients.size && (status.state === "running" || run.progressEvents !== undefined)) {
          const currentProgressKeys = new Set((run.progressEvents ?? []).map((progress, index) =>
            `sleep:${run.id}:progress:${progress.sequence ?? index + 1}`));
          for (const ws of recipients) {
            const last = states.get(ws)?.last;
            if (!last) continue;
            for (const key of last.keys()) if (key.startsWith(`sleep:${run.id}:progress:`) && !currentProgressKeys.has(key)) last.delete(key);
          }
          publish("memory-sleep-started", { runId: run.id, trigger: run.trigger }, `sleep:${run.id}:started`, recipients);
          for (const [index, progress] of (run.progressEvents ?? []).entries()) {
            publish("memory-sleep-progress", { runId: run.id, ...progress }, `sleep:${run.id}:progress:${progress.sequence ?? index + 1}`, recipients);
          }
          if (run.status !== "running") {
            publish("memory-sleep-completed", {
              runId: run.id, status: run.status, examined: run.examined,
              archivedExact: run.archivedExact, archivedExpired: run.archivedExpired,
              archivedSimilarity: run.archivedSimilarity, archivedLlm: run.archivedLlm,
              error: run.error
            }, `sleep:${run.id}:completed`, recipients);
          }
        }
      }
      if (embedding.status === "fulfilled") {
        publish("memory-embedding-status", embedding.value);
        const operation = embedding.value.operation;
        if (operation?.kind === "rebuild") publish("memory-rebuild-progress", operation);
        if (operation?.kind === "download") publish("local-embedding-progress", operation);
      }
    } finally {
      pending = false;
      if (dirty) { dirty = false; scheduleRefresh(); }
    }
  };
  const scheduleRefresh = (): void => {
    if (closed || !states.size || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh().catch((error: unknown) => publish("memory-stream-error", { source: "stream", error: String(error) }));
    }, 50);
    refreshTimer.unref();
  };
  // 文件监听补获其它进程/工作区的 SQLite 提交；定时采样同时兜底丢失的文件事件。
  try {
    watcher = watch(directory, (_event, name) => {
      if (!name || String(name).startsWith(AGENT_DATABASE_FILE)) scheduleRefresh();
    });
    watcher.on("error", () => { watcher?.close(); watcher = undefined; });
    watcher.unref();
  } catch { /* 文件监听不可用时仍由采样读取同一权威状态。 */ }
  const sampler = setInterval(scheduleRefresh, 1_000);
  sampler.unref();
  const heartbeat = setInterval(() => {
    for (const [ws, state] of states) {
      if (!state.alive) { ws.terminate(); continue; }
      state.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => socket.destroy());
    // 与 REST 使用同一套鉴权；不接收 query token，防止凭证进入 URL/访问日志。
    const status = authorize(request) ?? (request.url !== "/ws/memory" ? 404 : states.size >= 32 || closed ? 503 : undefined);
    if (status !== undefined) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const state = { last: new Map<string, string>(), alive: true, sleepInitialized: false, sleepReplayEligible: false };
      states.set(ws, state);
      ws.on("error", () => ws.terminate());
      ws.on("close", () => states.delete(ws));
      ws.on("pong", () => { state.alive = true; });
      ws.on("message", () => ws.close(1008, "Read-only subscription"));
      scheduleRefresh();
    });
  };
  server.on("upgrade", upgrade);
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    closed = true;
    clearInterval(sampler);
    clearInterval(heartbeat);
    clearTimeout(refreshTimer);
    watcher?.close();
    server.off("upgrade", upgrade);
    for (const ws of states.keys()) ws.terminate();
    states.clear();
    closing = new Promise<void>((resolve) => wss.close(() => resolve()));
    return closing;
  };
}
