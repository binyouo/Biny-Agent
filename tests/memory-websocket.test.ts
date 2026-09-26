/** 用真实 loopback WebSocket 验证鉴权、主动推送、失败恢复和关闭，不接触用户目录。 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { MemoryEmbeddingRuntimeStatus } from "../src/agent/context/MemoryEmbeddingService.js";

let revision = 0;
let fail = false;
let operation: MemoryEmbeddingRuntimeStatus["operation"];
let sleepStatus: unknown = { state: "idle" };
const client: Parameters<typeof startMemoryHttpServer>[0] = {
  memory: async <T>(action: string) => {
    if (fail) throw new Error("host temporarily unavailable");
    return (action === "overview" ? { storeRevision: revision, entryCount: revision } : sleepStatus) as T;
  },
  memoryEmbeddingStatus: async () => ({ models: [], localModels: [], index: {}, totalEntries: revision, indexedEntries: 0, pendingEntries: revision, needsRebuild: false, operation }),
  cancelMemorySleep: async () => false,
  rebuildMemoryEmbeddingIndex: async () => client.memoryEmbeddingStatus(),
  cancelMemoryEmbeddingRebuild: async () => ({ cancelled: false, status: await client.memoryEmbeddingStatus() }),
  downloadMemoryEmbeddingModel: async () => client.memoryEmbeddingStatus(),
  deleteMemoryEmbeddingModel: async () => ({ filesDeleted: 0, bytesFreed: 0, status: await client.memoryEmbeddingStatus() })
};
const api = await startMemoryHttpServer(client, { token: "test-only-token" });
const url = `ws://127.0.0.1:${api.port}/ws/memory`;
const headers = { Authorization: "Bearer test-only-token" };
const sockets: WebSocket[] = [];
const frames: Array<{ type: string; data: unknown; timestamp: string }> = [];
async function waitFor(predicate: () => boolean): Promise<void> {
  // 网络和服务端定时采样是本测试的契约；以条件为准，硬超时 5 秒。
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "WebSocket condition timed out");
}
async function rejected(requestHeaders: Record<string, string>, status: number, suffix = ""): Promise<void> {
  const ws = new WebSocket(url + suffix, { headers: requestHeaders, handshakeTimeout: 2_000 });
  sockets.push(ws);
  ws.on("error", () => undefined);
  const response = await new Promise<number | undefined>((resolve, reject) => {
    ws.once("unexpected-response", (_request, incoming) => { incoming.resume(); ws.terminate(); resolve(incoming.statusCode); });
    ws.once("open", () => reject(new Error("Unexpected authorized connection")));
    ws.once("error", reject);
  });
  assert.equal(response, status);
}
try {
  await rejected({}, 401);
  await rejected({ ...headers, Origin: "https://example.test" }, 403);
  await rejected({ ...headers, Host: "example.test:1234" }, 403);
  await rejected({}, 401, "?token=test-only-token");
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await once(ws, "open");
  await waitFor(() => frames.some((frame) => frame.type === "memory-changed"));
  assert.ok(frames.every((frame) => !Number.isNaN(Date.parse(frame.timestamp))));
  const stages = ["exact", "expired", "similarity", "purge"] as const;
  const progressEvents = stages.map((stage, index) => ({ stage, examined: index >= 2 ? 2 : 0,
    archivedExact: 1, archivedExpired: index >= 1 ? 1 : 0, archivedSimilarity: 0, archivedLlm: 0, purged: 0 }));
  sleepStatus = { state: "running", progressStage: "similarity", lastRun: {
    id: "test-sleep-run", status: "running", trigger: "manual", archivedExact: 1, archivedExpired: 1,
    progressEvents: progressEvents.slice(0, 2)
  } };
  await waitFor(() => frames.some((frame) => frame.type === "memory-sleep-progress" && (frame.data as { stage?: string }).stage === "expired"));
  assert.ok(frames.some((frame) => frame.type === "memory-sleep-started" && (frame.data as { runId?: string }).runId === "test-sleep-run"));
  assert.ok(frames.some((frame) => frame.type === "memory-sleep-progress" && (frame.data as { stage?: string }).stage === "exact"));
  const midRunFrames: Array<{ type: string; data: unknown }> = [];
  const midRunSocket = new WebSocket(url, { headers });
  sockets.push(midRunSocket);
  midRunSocket.on("message", (data) => midRunFrames.push(JSON.parse(data.toString())));
  await once(midRunSocket, "open");
  await waitFor(() => midRunFrames.some((frame) => frame.type === "memory-sleep-progress" && (frame.data as { stage?: string }).stage === "expired"));
  assert.ok(midRunFrames.some((frame) => frame.type === "memory-sleep-started"));
  sleepStatus = { state: "idle", lastRun: { id: "test-sleep-run", status: "completed", trigger: "manual",
    archivedExact: 1, archivedExpired: 1, examined: 2, progressEvents } };
  await waitFor(() => frames.some((frame) => frame.type === "memory-sleep-completed" && (frame.data as { runId?: string }).runId === "test-sleep-run"));
  assert.deepEqual(frames.filter((frame) => frame.type === "memory-sleep-progress").map((frame) => (frame.data as { stage?: string }).stage), stages);
  sleepStatus = { state: "idle", lastRun: { id: "quick-sleep-run", status: "completed", trigger: "manual",
    archivedExact: 1, archivedExpired: 1, examined: 2, progressEvents } };
  await waitFor(() => frames.some((frame) => frame.type === "memory-sleep-completed" && (frame.data as { runId?: string }).runId === "quick-sleep-run"));
  assert.deepEqual(frames.filter((frame) => frame.type === "memory-sleep-progress" && (frame.data as { runId?: string }).runId === "quick-sleep-run")
    .map((frame) => (frame.data as { stage?: string }).stage), stages, "一次采样之后仍能补齐快速运行的四阶段");
  const namespaceProgress = [
    { ...progressEvents[0], sequence: 1 },
    { ...progressEvents[1], sequence: 2 },
    { ...progressEvents[2], sequence: 3, examined: 2, namespaceUserId: "user-a" },
    { ...progressEvents[2], sequence: 4, examined: 4, namespaceUserId: "user-b" },
    { ...progressEvents[3], sequence: 5, examined: 4 }
  ];
  sleepStatus = { state: "idle", lastRun: { id: "namespace-sleep-run", status: "completed", trigger: "manual",
    archivedExact: 1, archivedExpired: 1, examined: 4, progressEvents: namespaceProgress } };
  await waitFor(() => frames.some((frame) => frame.type === "memory-sleep-completed" && (frame.data as { runId?: string }).runId === "namespace-sleep-run"));
  assert.deepEqual(frames.filter((frame) => frame.type === "memory-sleep-progress" && (frame.data as { runId?: string }).runId === "namespace-sleep-run")
    .map((frame) => (frame.data as { stage?: string; namespaceUserId?: string }).namespaceUserId)
    .filter((userId) => userId !== undefined), ["user-a", "user-b"], "相同阶段的多个命名空间累计事件都送达");
  const initial = frames.length;
  revision = 1;
  operation = { kind: "rebuild", state: "running", startedAt: "now", updatedAt: "now", processedEntries: 0, totalEntries: 1 };
  await waitFor(() => frames.slice(initial).some((frame) => frame.type === "memory-rebuild-progress"));
  assert.ok(frames.some((frame) => frame.type === "memory-changed" && JSON.stringify(frame.data).includes('"storeRevision":1')));
  fail = true;
  await waitFor(() => frames.some((frame) => frame.type === "memory-stream-error"));
  fail = false;
  revision = 2;
  await waitFor(() => frames.some((frame) => frame.type === "memory-changed" && JSON.stringify(frame.data).includes('"storeRevision":2')));
  const reconnected: unknown[] = [];
  const ws2 = new WebSocket(url, { headers });
  sockets.push(ws2);
  ws2.on("message", (data) => reconnected.push(JSON.parse(data.toString())));
  await waitFor(() => reconnected.length >= 3);
  assert.ok(JSON.stringify(reconnected).includes('"storeRevision":2'), "重连补最新状态");
  assert.equal(reconnected.some((frame) => ["memory-sleep-started", "memory-sleep-progress", "memory-sleep-completed"]
    .includes((frame as { type?: string }).type ?? "")), false, "结束后的新订阅只收到状态快照，不重放历史生命周期");
  assert.ok(reconnected.some((frame) => (frame as { type?: string; data?: { lastRun?: { id?: string } } }).type === "memory-sleep-status"
    && (frame as { data?: { lastRun?: { id?: string } } }).data?.lastRun?.id === "namespace-sleep-run"));
  operation = { kind: "download", state: "completed", model: "multilingual-e5-small", startedAt: "now", updatedAt: "later", progress: { model: "multilingual-e5-small", status: "ready", progress: 1 } };
  await waitFor(() => frames.some((frame) => frame.type === "local-embedding-progress"));
  const readOnlyClosed = once(ws2, "close");
  ws2.send(JSON.stringify({ command: "delete" }));
  assert.equal((await readOnlyClosed)[0], 1008, "订阅不接受写命令");
  const oversized = new WebSocket(url, { headers });
  sockets.push(oversized);
  await once(oversized, "open");
  const oversizedClosed = once(oversized, "close");
  oversized.send("x".repeat(2048));
  assert.ok([1006, 1009].includes((await oversizedClosed)[0] as number), "超限客户端消息必须断开");
  const closed = once(ws, "close");
  await api.close();
  await closed;
  await api.close();
  console.log("memory websocket tests passed");
} finally {
  for (const ws of sockets) ws.terminate();
  await api.close();
}
