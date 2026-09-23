/** 真实 Host/socket/session 链路：慢维护和重建只影响目标会话，消息准入保留持久身份。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost, type RuntimeHostFactory, type RuntimeHostClient } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error("Unrelated session was blocked for 3 seconds");
  try {
    // 等待真实 socket/文件调度，3 秒仅为失败上限；成功由操作完成驱动。
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-admission-"));
const configDir = path.join(root, "config");
await saveConfig(root, {
  ...structuredClone(defaultConfig),
  defaultModel: "local-test",
  providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
  models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }
}, { globalDir: configDir });
const configStore = createFileConfigStore(root, { globalDir: configDir });
const slowStarted = deferred();
const slowRelease = deferred();
const restartStarted = deferred();
const restartRelease = deferred();
let rebuilding = false;
const initial = await createInteractiveAgentHost(root, { configStore, sessionId: "session-a" });
// MCP 是外部边界；受控未完成连接模拟远端不响应，Runtime 和持久化仍使用真实实现。
initial.commands.mcp.reconnectServer = async () => {
  slowStarted.resolve();
  await slowRelease.promise;
  return {
    name: "controlled-external-server", command: "test", transport: "stdio",
    enabled: true, connected: true, toolNames: [], promptNames: [], hasResources: false
  };
};
const createRuntime: RuntimeHostFactory = async (sessionId, options) => {
  if (rebuilding && sessionId === "session-a") {
    restartStarted.resolve();
    await restartRelease.promise;
  }
  const local = await createInteractiveAgentHost(root, {
    configStore, sessionId, resourceRegistry: options?.resourceRegistry
  });
  if (options?.fresh !== true && sessionId !== undefined) await local.runtime.resumeSession(sessionId);
  return local;
};
const host = await startRuntimeHost(root, async () => initial, { configDir, createRuntime });
let client: RuntimeHostClient | undefined;
let other: RuntimeHostClient | undefined;
let slow: Promise<unknown> | undefined;
let restart: Promise<unknown> | undefined;
try {
  client = await connectRuntimeHost(root, { configDir, clientId: "sender", surface: "desktop" });
  assert.ok(client);
  slow = client.mcpReconnect("controlled-external-server");
  await bounded(slowStarted.promise);
  // Given A 的维护尚未结束，When B 创建并发送，Then B 的用户消息可以持久化并返回。
  const target = await bounded(client.ensureSession({ sessionId: "session-b", writeIntent: true }));
  const received = deferred();
  const unsubscribe = client.subscribe((update) => {
    if (update.event?.type === "message.user" && update.event.messageId === "pending-message-id") received.resolve();
  });
  try {
    const submitted = await bounded(client.submitRunForSession(target.sessionId, "hello", [], { messageId: "pending-message-id" }));
    assert.equal(submitted.accepted, true);
    assert.ok(submitted.result);
    assert.equal(submitted.result.messageId, "pending-message-id");
    await bounded(received.promise);
    const events = await readSessionEvents(target.snapshot.info.sessionFile);
    assert.equal(events.filter((event) => event.type === "user_message" && event.messageId === "pending-message-id").length, 1);
    await client.cancelRunRequest(submitted.result.runId, "cancelled", target.sessionId);
    await bounded(client.waitForIdle(target.sessionId));
  } finally { unsubscribe(); }
  slowRelease.resolve();
  await slow;

  // 写入者冲突不能因常驻会话快速路径被绕过；只读连接仍可读取。
  await client.ensureSession({ sessionId: target.sessionId, writeIntent: true });
  other = await connectRuntimeHost(root, { configDir, clientId: "other-surface", surface: "tui" });
  assert.ok(other);
  await assert.rejects(other.ensureSession({ sessionId: target.sessionId, writeIntent: true }), /already open/u);
  assert.equal((await other.ensureSession({ sessionId: target.sessionId })).sessionId, target.sessionId);
  await assert.rejects(client.ensureSession({ sessionId: target.sessionId, isolation: "worktree" }), /already configured for shared/u);

  // A 重建时，B 的查询和已常驻准入不能等待 A；A 的后续请求必须等待替换完成。
  rebuilding = true;
  restart = client.restartRuntime("session-a");
  await bounded(restartStarted.promise);
  let sameSessionFinished = false;
  const sameSession = client.ensureSession({ sessionId: "session-a", focus: false }).then(() => { sameSessionFinished = true; });
  assert.equal((await bounded(client.focusSession(target.sessionId))).info.sessionId, target.sessionId);
  await bounded(client.ensureSession({ sessionId: target.sessionId, focus: false }));
  // 指定 B 的 run 身份验证使用 B 的 authority 连接，不能借读已关闭的 primary store。
  const control = await bounded(client.cancelRunRequest("missing-run", "cancelled", target.sessionId));
  assert.equal(control.accepted, false);
  assert.equal(sameSessionFinished, false);
  restartRelease.resolve();
  await Promise.all([restart, sameSession]);
  assert.equal(sameSessionFinished, true);
} finally {
  slowRelease.resolve();
  restartRelease.resolve();
  await Promise.allSettled([slow, restart]);
  await other?.close();
  await client?.close();
  await host.close();
  await rm(root, { recursive: true, force: true });
}
console.log("runtime host admission isolation tests passed");
