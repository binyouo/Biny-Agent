/** 用真实 loopback WebSocket 验证鉴权、主动推送、失败恢复和关闭，不接触用户目录。 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { MemoryEmbeddingRuntimeStatus } from "../src/agent/context/MemoryEmbeddingService.js";

let revision = 0;
let fail = false;
let operation: MemoryEmbeddingRuntimeStatus["operation"];
const client: Parameters<typeof startMemoryHttpServer>[0] = {
  memory: async <T>(action: string) => {
    if (fail) throw new Error("host temporarily unavailable");
    return (action === "overview" ? { storeRevision: revision, entryCount: revision } : { state: "idle" }) as T;
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
