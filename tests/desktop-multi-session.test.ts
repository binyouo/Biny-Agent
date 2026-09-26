/** Desktop 的真实配置、Host/socket、Agent 和 JSONL 链路；模型响应由本地服务设置屏障。 */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopAgentEventEnvelope } from "../src/desktop/protocol.js";
import { HeartbeatScheduler } from "../src/agent/context/heartbeat.js";
import { pendingPermission } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { readSessionCatalogRecord } from "../src/session/catalog.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-desktop-parallel-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const responses = new Map<string, ServerResponse>();
const updates: DesktopAgentEventEnvelope[] = [];
const originalHeartbeatStart = HeartbeatScheduler.prototype.start;
let heartbeatStarts = 0;
HeartbeatScheduler.prototype.start = function () { heartbeatStarts += 1; originalHeartbeatStart.call(this); };
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }).messages;
  const marker = JSON.stringify(messages.filter((message) => message.role === "user").at(-1)?.content).match(/parallel-probe-[A-Z]/gu)?.at(-1);
  if (!marker) { response.writeHead(400); response.end("missing probe"); return; }
  if (responses.has(marker)) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[]" }, finish_reason: "stop" }] }));
    return;
  }
  responses.set(marker, response);
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
let manager: DesktopAgentManager | undefined;
try {
  const configStore = new DesktopConfigStore(path.join(root, "config"), {
    persistent: true,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  });
  await configStore.save(configSchema.parse({
    ...defaultConfig,
    defaultModel: "local-test",
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "local-test": { provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
    thinking: { ...defaultConfig.thinking, enabled: false },
    chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "all" },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    permission: { ...defaultConfig.permission, mode: "ask" }
  }));
  const storage = new DesktopUserDataStore(path.join(root, "desktop"));
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createProject(root);
  manager = new DesktopAgentManager(state, projects, configStore, (projectId, update, meta) => updates.push({ ...update, projectId, ...meta }));
  const internals = manager as unknown as {
    ensureRuntime(projectId: string): Promise<{ runtime: RuntimeHostClient }>;
    rebuildIdleManagedRuntimes(): Promise<void>;
  };
  const { runtime: client } = await internals.ensureRuntime(project.id);
  assert.ok(client instanceof RuntimeHostClient, "safeStorage 配置必须使用 Host 客户端");
  let factoryCalled = false;
  await assert.rejects(startRuntimeHost(root, async () => {
    factoryCalled = true;
    throw new Error("must not initialize");
  }), /already running/u);
  assert.equal(factoryCalled, false, "竞争 owner 失败不能先创建 Runtime");

  const [a, b] = await Promise.all([
    manager.sendPrompt(project.id, undefined, "parallel-probe-A", [], undefined, undefined, "pending-message-a", undefined, undefined, undefined, true),
    manager.sendPrompt(project.id, undefined, "parallel-probe-B", [], undefined, undefined, "pending-message-b")
  ]);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal((await readSessionCatalogRecord(await projects.dataRoot(project), a.sessionId))?.isIncognito, true);
  assert.equal((await readSessionCatalogRecord(await projects.dataRoot(project), b.sessionId))?.isIncognito ?? false, false);
  assert.equal(a.messageId, "pending-message-a");
  assert.equal(b.messageId, "pending-message-b");
  assert.deepEqual(await manager.sendPrompt(project.id, undefined, "parallel-probe-A", [], undefined, undefined, "pending-message-a"), a);
  await waitFor(() => responses.has("parallel-probe-A") && responses.has("parallel-probe-B"), () => ({ received: [...responses.keys()], states: [a, b].map((session) => ({ sessionId: session.sessionId, state: client.getSnapshot(session.sessionId).state })) }));
  assert.equal(client.getSnapshot(a.sessionId).state.kind, "runs");
  assert.equal(client.getSnapshot(b.sessionId).state.kind, "runs");
  assert.equal(client.getSnapshot(a.sessionId).info.workspaceRoot, client.getSnapshot(b.sessionId).info.workspaceRoot);
  assert.equal(heartbeatStarts, 1, "多个 Session 只启用一份心跳");
  const aResponse = responses.get("parallel-probe-A")!;
  aResponse.writeHead(200, { "content-type": "text/event-stream" });
  aResponse.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "parallel-write", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "a.txt", content: "A" }) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""));
  await waitFor(() => pendingPermission(client.getSnapshot(a.sessionId)) !== undefined);
  assert.equal(pendingPermission(client.getSnapshot(b.sessionId)), undefined, "A 的权限请求不能进入 B");
  await manager.openSession(project.id, a.sessionId);
  await manager.openSession(project.id, b.sessionId);
  assert.equal(client.getSnapshot(a.sessionId).state.kind, "runs", "导航不能中止 A");
  finish("parallel-probe-B");
  await waitFor(() => client.getSnapshot(b.sessionId).state.kind === "idle");
  assert.equal(client.getSnapshot(a.sessionId).state.kind, "runs", "完成 B 不能结束 A");
  await manager.cancelRun(project.id, a.runId);
  await waitFor(() => client.getSnapshot(a.sessionId).state.kind === "idle");
  const aEvents = await readSessionEvents(sessionFilePath(root, a.sessionId));
  const bEvents = await readSessionEvents(sessionFilePath(root, b.sessionId));
  for (const [receipt, events] of [[a, aEvents], [b, bEvents]] as const) {
    assert.equal(events.filter((event) => event.type === "user_message" && event.messageId === receipt.messageId).length, 1);
    assert.ok(updates.some((update) => update.event?.type === "message.user" && update.event.messageId === receipt.messageId));
  }
  assert.ok(aEvents.some((event) => event.type === "user_message" && event.content.includes("parallel-probe-A")));
  assert.ok(bEvents.some((event) => event.type === "assistant_message" && event.content.includes("parallel-probe-B")));
  assert.ok(!JSON.stringify(aEvents).includes("parallel-probe-B"));
  assert.ok(!JSON.stringify(bEvents).includes("parallel-probe-A"));
  assert.ok(updates.some((update) => update.event?.type === "run.completed" && update.event.sessionId === b.sessionId));
  assert.ok(updates.some((update) => update.event?.type === "run.cancelled" && update.event.sessionId === a.sessionId));

  // 刷新必须覆盖所有驻留 Session，而不只是 primary。
  const config = await configStore.load(root);
  await configStore.save({ ...config, permission: { ...config.permission, mode: "full-access" } }, root);
  await internals.rebuildIdleManagedRuntimes();
  assert.ok(client.runtimeSnapshots().every((entry) => entry.snapshot.permissionMode === "full-access"));

  // 十个独立 Session 同时发送都应成功，跨过旧的 4 并发 / 8 常驻门槛。
  const markers = ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
  const sessions = await Promise.all(markers.map(async () => await client.ensureSession({ writeIntent: true, focus: false })));
  const admissions = await Promise.all(sessions.map(async (session, index) => await client.submitRunForSession(session.sessionId, `parallel-probe-${markers[index]}`)));
  assert.equal(admissions.filter((result) => result.accepted).length, markers.length);
  assert.equal(admissions.filter((result) => !result.accepted).length, 0);
  const accepted = sessions.filter((_session, index) => admissions[index]?.accepted);
  await waitFor(() => responses.size === markers.length + 2, () => ({ received: [...responses.keys()], states: accepted.map((session) => ({ sessionId: session.sessionId, state: client.getSnapshot(session.sessionId).state })) }));
  assert.equal(client.runtimeSnapshots().filter((entry) => entry.snapshot.state.kind === "runs").length, markers.length);
  const duplicate = await client.submitRunForSession(accepted[0]!.sessionId, "same-session-cannot-overlap");
  assert.equal(duplicate.accepted, false, "同一 Session 不得并行两个 run");
  // 一个 Provider 失败只结束对应会话，不能影响其余九个运行中的会话。
  const failedResponse = responses.get("parallel-probe-C")!;
  failedResponse.writeHead(400, { "content-type": "application/json" });
  failedResponse.end(JSON.stringify({ error: { message: "controlled provider failure", type: "invalid_request_error" } }));
  await waitFor(() => client.getSnapshot(accepted[0]!.sessionId).state.kind === "idle");
  assert.equal(client.runtimeSnapshots().filter((entry) => entry.snapshot.state.kind === "runs").length, markers.length - 1);
  await manager.closeAll();
  for (const [index, session] of accepted.entries()) {
    const events = await readSessionEvents(sessionFilePath(root, session.sessionId));
    assert.equal(events.filter((event) => event.type === "user_message" && event.content.includes(`parallel-probe-${markers[index]}`)).length, 1);
    assert.ok(events.some((event) => event.type === "turn_status" && event.status === (index === 0 ? "failed" : "cancelled")), "失败与退出必须按会话持久化对应终态");
  }
  console.log("desktop multi-session integration tests passed (overlap, routing, cancellation, refresh, unbounded sessions, shutdown)");
} catch (error) {
  console.error("runtime terminal events", updates.flatMap((update) => update.event?.type === "run.failed" ? [update.event] : []));
  console.error(error);
  throw error;
} finally {
  await manager?.closeAll().catch((error) => console.error("cleanup", error));
  HeartbeatScheduler.prototype.start = originalHeartbeatStart;
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

function finish(marker: string): void {
  const response = responses.get(marker);
  assert.ok(response);
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: marker }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""));
}

async function waitFor(predicate: () => boolean, diagnostics?: () => unknown): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`等待真实运行链路超时${diagnostics ? `：${JSON.stringify(diagnostics())}` : ""}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
