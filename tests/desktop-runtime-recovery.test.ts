import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { SessionLeaseStore } from "../src/runtime/SessionLease.js";
import { connectRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { RuntimeHostStartupError } from "../src/runtime/host/errors.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths, writeRegistration } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import { runtimeHostSpawnCircuitFor } from "../src/runtime/host/reconnect.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { sessionFilePath } from "../src/session/store.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-recovery-"));
  const configDir = path.join(root, "config");
  const configStore = createFileConfigStore(root, { globalDir: configDir });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save({ ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const dataRoot = await projects.dataRoot(project);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  const recorder = new SessionRecorder(dataRoot, "recovery-history");
  recorder.record({ type: "user_message", content: "保留原始问题" });
  recorder.record({ type: "assistant_message", content: "仍然可以读取历史" });
  await recorder.close();
  context.after(async () => {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { project, dataRoot, manager, configStore, configDir, sessionId: recorder.sessionId };
}

test("写入冲突保留历史；重读不解除冲突，重试检查写入权且不重发消息", { timeout: 30_000 }, async (context) => {
  const { project, dataRoot, manager, sessionId } = await fixture(context);
  const before = await readSessionEvents(sessionFilePath(dataRoot, sessionId));
  const owner = await SessionLeaseStore.open(dataRoot);
  context.after(() => owner.close());
  owner.acquire(sessionId);
  await assert.rejects(manager.sendPrompt(project.id, sessionId, "不得自动重发", []), /writer|owned|lease/iu);
  const blocked = await manager.openSession(project.id, sessionId);
  assert.equal(blocked.writerConflict?.sessionId, sessionId);
  assert.equal(blocked.runtimeError, undefined, "session writer 争用不是项目启动故障");
  assert.deepEqual(blocked.events, before);
  const stillBlocked = await manager.retryRuntime(project.id, sessionId);
  assert.equal(stillBlocked.document?.writerConflict?.sessionId, sessionId);
  owner.close();
  const ready = await manager.retryRuntime(project.id, sessionId);
  assert.equal(ready.document?.writerConflict, undefined);
  assert.equal(ready.workspace.runtimeError, undefined);
  assert.ok(ready.document?.runtimeSnapshot);
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
});

test("真实配置故障与会话占用分开；显式重试只重新装配，不运行模型", { timeout: 30_000 }, async (context) => {
  const { project, dataRoot, manager, configStore, sessionId } = await fixture(context);
  const load = configStore.load.bind(configStore);
  configStore.load = async () => { throw new Error("local configuration unavailable"); };
  await assert.rejects(manager.sendPrompt(project.id, sessionId, "未接收输入", []), /local configuration unavailable/u);
  const failed = await manager.workspaceSnapshot(project.id, false);
  assert.equal(failed.runtimeError?.kind, "startup_failed");
  assert.equal(failed.runtimeError?.message, "local configuration unavailable");
  assert.equal((await manager.openSession(project.id, sessionId)).runtimeError?.kind, "startup_failed");
  const before = await readSessionEvents(sessionFilePath(dataRoot, sessionId));
  configStore.load = load;
  const ready = await manager.retryRuntime(project.id, sessionId);
  assert.equal(ready.workspace.runtimeError, undefined);
  assert.equal(ready.document?.writerConflict, undefined);
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
});

test("被占用的会话仍可创建历史分支，原会话及其 writer 不变", { timeout: 30_000 }, async (context) => {
  const { project, dataRoot, manager, sessionId } = await fixture(context);
  const before = await readSessionEvents(sessionFilePath(dataRoot, sessionId));
  const owner = await SessionLeaseStore.open(dataRoot);
  context.after(() => owner.close());
  owner.acquire(sessionId);
  await assert.rejects(manager.sendPrompt(project.id, sessionId, "冲突输入", []));
  const branch = await manager.duplicateSession(project.id, sessionId);
  assert.ok(branch.selectedSessionId);
  assert.notEqual(branch.selectedSessionId, sessionId);
  const document = await manager.openSession(project.id, branch.selectedSessionId!);
  assert.equal(document.writerConflict, undefined);
  assert.equal(document.events.some((event) => event.type === "assistant_message" && event.content === "仍然可以读取历史"), true);
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
  await assert.rejects(manager.sendPrompt(project.id, sessionId, "仍不允许写入", []));
});

test("启动超时保留结构化原因，空白草稿重试不创建会话或回放历史", { timeout: 30_000 }, async (context) => {
  const { project, dataRoot, manager, configStore, sessionId } = await fixture(context);
  const before = await readSessionEvents(sessionFilePath(dataRoot, sessionId));
  const load = configStore.load.bind(configStore);
  configStore.load = async () => { throw new RuntimeHostStartupError("timeout", 8_000); };
  const failed = await manager.retryRuntime(project.id);
  assert.equal(failed.document, undefined);
  assert.equal(failed.workspace.runtimeError?.kind, "startup_timeout");
  assert.equal(failed.workspace.runtimeError?.retryable, true);
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
  configStore.load = load;
  const ready = await manager.retryRuntime(project.id);
  assert.equal(ready.workspace.runtimeError, undefined);
  assert.equal(ready.document, undefined);
  assert.deepEqual(ready.workspace.sessions.map((session) => session.id), failed.workspace.sessions.map((session) => session.id));
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
});

test("并发重试复用运行时初始化；等待中仍可只读历史且不会提交新回合", { timeout: 30_000 }, async (context) => {
  const { project, dataRoot, manager, configStore, sessionId } = await fixture(context);
  const before = await readSessionEvents(sessionFilePath(dataRoot, sessionId));
  const load = configStore.load.bind(configStore);
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  configStore.load = async (...args) => { enter(); await gate; return await load(...args); };
  const first = manager.retryRuntime(project.id, sessionId);
  const second = manager.retryRuntime(project.id, sessionId);
  try {
    await entered;
    assert.deepEqual((await manager.openSession(project.id, sessionId)).events, before);
  } finally {
    release();
  }
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.document?.runtimeSnapshot?.info.sessionId === sessionId && result.workspace.runtimeError === undefined));
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
});

test("恢复目标会话后释放先前空闲会话的写入权，不把别的会话长期占住", { timeout: 30_000 }, async (context) => {
  const { project, dataRoot, manager, configDir, sessionId } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "other-history");
  recorder.record({ type: "user_message", content: "另一个会话" });
  await recorder.close();
  await manager.retryRuntime(project.id, sessionId);
  await manager.openSession(project.id, recorder.sessionId);
  const recovered = await manager.retryRuntime(project.id, recorder.sessionId);
  assert.equal(recovered.document?.runtimeSnapshot?.info.sessionId, recorder.sessionId);
  const client = await connectRuntimeHost(dataRoot, { configDir, clientId: "other-writer", surface: "tui", keepAlive: false });
  assert.ok(client);
  try {
    await client.claimSession(sessionId);
    await client.claimSession(recorder.sessionId);
  } finally {
    await client.close();
  }
});

test("旧协议 owner 存活时保留它；owner 退出后在原窗口重试恢复且不提交消息", { timeout: 30_000 }, async (context) => {
  const { project, dataRoot, manager, configDir, sessionId } = await fixture(context);
  const before = await readSessionEvents(sessionFilePath(dataRoot, sessionId));
  const paths = runtimeHostPaths(dataRoot);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  await writeRegistration({ ...paths, ...currentRuntimeHostIdentity({ configDir }),
    protocolVersion: runtimeHostProtocolVersion - 1, persistenceRoot: dataRoot,
    hostEpoch: "old-owner", token: "test-access-secret", pid: process.pid, createdAt: new Date().toISOString()
  });
  context.after(() => rm(paths.registrationPath, { force: true }));
  const blocked = await manager.prepareWorkspace(project.id);
  assert.equal(blocked.runtimeError?.kind, "protocol_mismatch");
  assert.equal(blocked.runtimeError?.retryable, true);
  const stillBlocked = await manager.retryRuntime(project.id, sessionId);
  assert.equal(stillBlocked.workspace.runtimeError?.kind, "protocol_mismatch");
  assert.equal(JSON.parse(await readFile(paths.registrationPath, "utf8")).hostEpoch, "old-owner");
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
  // 模拟原 owner 正常退出并撤下 registration；客户端不能擅自终止旧进程。
  await rm(paths.registrationPath);
  const ready = await manager.retryRuntime(project.id, sessionId);
  assert.equal(ready.workspace.runtimeError, undefined);
  assert.equal(ready.document?.runtimeSnapshot?.info.sessionId, sessionId);
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
});

test("浏览不解除启动熔断；显式重试只复位当前项目并恢复历史而不运行模型", { timeout: 30_000 }, async (context) => {
  const { project, dataRoot, manager, configStore, sessionId } = await fixture(context);
  const before = await readSessionEvents(sessionFilePath(dataRoot, sessionId));
  const circuit = runtimeHostSpawnCircuitFor(runtimeHostPaths(dataRoot).endpoint);
  const otherCircuit = runtimeHostSpawnCircuitFor(runtimeHostPaths(path.join(dataRoot, "other")).endpoint);
  for (let i = 0; i < 3; i++) { circuit.recordFailure(new Error("fixture startup failed")); otherCircuit.recordFailure(); }
  const load = configStore.load.bind(configStore);
  configStore.load = async (...args) => {
    const failure = circuit.failureError();
    if (failure) throw failure;
    return await load(...args);
  };
  await assert.rejects(manager.sendPrompt(project.id, sessionId, "未接收输入", []), /3 times in a row/u);
  const blocked = await manager.workspaceSnapshot(project.id, false);
  assert.equal(blocked.runtimeError?.retryable, true);
  assert.equal((await manager.openSession(project.id, sessionId)).runtimeError?.kind, "startup_failed");
  assert.equal(circuit.consecutiveFailures, 3);
  const ready = await manager.retryRuntime(project.id, sessionId);
  assert.equal(ready.workspace.runtimeError, undefined);
  assert.equal(ready.document?.runtimeSnapshot?.info.sessionId, sessionId);
  assert.equal(circuit.consecutiveFailures, 0);
  assert.equal(otherCircuit.consecutiveFailures, 3);
  assert.deepEqual(await readSessionEvents(sessionFilePath(dataRoot, sessionId)), before);
});
