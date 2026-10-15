import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { runtimeHostPaths } from "../src/runtime/RuntimeHost.js";
import { SessionRecorder } from "../src/session/recorder.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-prewarm-"));
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
  const recorder = new SessionRecorder(dataRoot, "prewarm-history");
  recorder.record({ type: "user_message", content: "历史问题" });
  recorder.record({ type: "assistant_message", content: "历史回答" });
  await recorder.close();
  context.after(async () => {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, state, projects, project, dataRoot, manager, configStore, sessionId: recorder.sessionId };
}

type LoadFn = ReturnType<typeof createFileConfigStore>["load"];

/** 只卡住 Host 初始化读配置的那次调用（来自 CommandRuntime 装配），界面自己的读取不受阻。 */
function gateRuntimeInitialization(configStore: ReturnType<typeof createFileConfigStore>, failure?: Error) {
  const load = configStore.load.bind(configStore) as LoadFn;
  let release!: () => void;
  let entered!: () => void;
  let calls = 0;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  configStore.load = (async (...args: Parameters<LoadFn>) => {
    const fromRuntimeAssembly = new Error().stack?.includes("createCommandRuntime") === true;
    if (fromRuntimeAssembly) {
      calls += 1;
      entered();
      await gate;
      if (failure) throw failure;
    }
    return await load(...args);
  }) as LoadFn;
  return { enteredPromise, release, get calls() { return calls; }, restore: () => { configStore.load = load; } };
}

async function settled<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return await Promise.race([promise.then(() => true, () => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), ms))]);
}

test("准备工作区不等待 Host 冷启动；消费操作复用同一次进行中的初始化", { timeout: 30_000 }, async (context) => {
  context.after(() => { gated.release(); gated.restore(); });
  const { project, manager, configStore } = await fixture(context);
  const gated = gateRuntimeInitialization(configStore);
  const preparedPromise = manager.prepareWorkspace(project.id);
  await gated.enteredPromise;
  // Host 初始化还卡在配置加载上，工作区快照必须先返回，不能把首屏和输入框冻结在冷启动上。
  const prepared = await Promise.race([
    preparedPromise.then(() => "resolved" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000))
  ]);
  assert.equal(prepared, "resolved", "prepareWorkspace 不得在 Host 初始化未完成时阻塞");
  // 真实消费入口（此处用不触发模型调用的权限操作代替发送）等待的是同一次预热，而非再次冷启动。
  const consumed = manager.setPermissionMode(project.id, "ask");
  assert.equal(await settled(consumed, 500), false, "消费入口应等待进行中的预热，而不是另起初始化或立即失败");
  gated.release();
  const snapshot = await consumed;
  assert.equal(snapshot.runtimeError, undefined);
  assert.equal((await preparedPromise).runtimeError, undefined);
});

test("打开历史会话触发项目 Host 预热；同项目重复打开复用同一初始化", { timeout: 30_000 }, async (context) => {
  context.after(() => { gated.release(); gated.restore(); });
  const { project, manager, configStore, sessionId } = await fixture(context);
  const gated = gateRuntimeInitialization(configStore);
  // 打开会话是准备继续的信号：冷态下后台预热该项目的 Host。
  const document = await manager.openSession(project.id, sessionId);
  assert.equal(document.runtimeError, undefined);
  assert.ok(document.events.length > 0, "预热在后台进行，不阻塞历史正文");
  // 仅打开会话、尚未触碰任何消费入口，就应已有进行中的 Host 初始化（预热）。
  await Promise.race([
    gated.enteredPromise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)).then((value) => {
      assert.equal(value, "entered" as never, "打开历史会话应在无消费操作时即触发项目 Host 预热");
    })
  ]);
  await manager.openSession(project.id, sessionId);
  assert.equal(gated.calls, 1, "初始化中重复打开历史会话不得另起 Host 装配");
  gated.release();
  // Host 按工作区复用：等待预热完成后再次打开会话，复用同一驻留 runtime，不重复初始化。
  await manager.retryRuntime(project.id);
  const calls = gated.calls;
  await manager.openSession(project.id, sessionId);
  assert.equal(gated.calls, calls, "同项目已有驻留 runtime 时打开会话不得重复初始化");
});

test("预热失败不阻塞快照；错误经 runtimeError 透出，正文仍可读", { timeout: 30_000 }, async (context) => {
  const { project, manager, configStore, sessionId } = await fixture(context);
  const load = configStore.load.bind(configStore);
  configStore.load = async () => { throw new Error("credential backend unavailable"); };
  // 预热失败必须异步处理：prepareWorkspace 正常返回快照（不 reject），历史与模型设置可读。
  const prepared = await manager.prepareWorkspace(project.id);
  assert.ok(prepared.sessions.some(session => session.id === sessionId), "预热失败仍返回持久化历史列表");
  // 失败经 runtimeError 透出（可能在快照返回时已记录，或随后的只读快照可见）。
  let after = await manager.workspaceSnapshot(project.id, false);
  const deadline = performance.now() + 1_000;
  while (after.runtimeError === undefined && performance.now() < deadline) {
    await new Promise<void>(resolve => setImmediate(resolve));
    after = await manager.workspaceSnapshot(project.id, false);
  }
  assert.equal(after.runtimeError?.message, "credential backend unavailable");
  configStore.load = load;
});


test("预热就绪后的保活请求失败仍返回历史，并通过 runtimeError 报告", { timeout: 30_000 }, async (context) => {
  const setKeepAlive = RuntimeHostClient.prototype.setKeepAlive;
  context.after(() => { RuntimeHostClient.prototype.setKeepAlive = setKeepAlive; });
  const { project, manager, sessionId } = await fixture(context);
  let requested!: () => void;
  const keepAliveRequested = new Promise<void>((resolve) => { requested = resolve; });
  RuntimeHostClient.prototype.setKeepAlive = async () => {
    requested();
    throw new Error("keep-alive connection unavailable");
  };
  const document = await manager.openSession(project.id, sessionId);
  assert.ok(document.events.some(event => event.type === "user_message" && event.content === "历史问题"));
  await keepAliveRequested;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const snapshot = await manager.workspaceSnapshot(project.id, false);
  assert.equal(snapshot.runtimeError?.message, "keep-alive connection unavailable");
});


test("切换项目的准备不等待旧项目释放保活", { timeout: 10_000 }, async (context) => {
  const { root, projects, project, manager } = await fixture(context);
  await manager.prepareWorkspace(project.id);
  await manager.retryRuntime(project.id);
  const other = await projects.createEmptyProject(path.join(root, "other"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = RuntimeHostClient.prototype.setKeepAlive;
  context.mock.method(RuntimeHostClient.prototype, "setKeepAlive", async function (this: RuntimeHostClient, keepAlive: boolean) {
    if (!keepAlive) await gate;
    await original.call(this, keepAlive);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const pending = manager.prepareWorkspace(other.id);
  try {
    const result = await Promise.race([pending, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("new workspace waited for old keep-alive RPC")), 1_000);
    })]);
    assert.equal(result.project.id, other.id);
  } finally {
    clearTimeout(timeout); release(); await pending;
  }
});

test("removing the last project owns its pending Host initialization", { timeout: 30_000 }, async (context) => {
  const { project, state, manager, configStore, dataRoot } = await fixture(context);
  const gated = gateRuntimeInitialization(configStore);
  let initialization: Promise<unknown> | undefined;
  let removal: Promise<void> | undefined;
  try {
    const prepared = manager.prepareWorkspace(project.id);
    await gated.enteredPromise;
    await prepared;
    initialization = manager["runtimeInitializations"].get(project.id);
    assert.ok(initialization, "the real Host assembly must still be pending");
    const settledInitialization = Promise.allSettled([initialization]);
    assert.equal(manager.isProjectRunning(project.id), false);
    // Match removeProject IPC ordering. Let a nonblocking disposal settle while
    // startup is held, but also permit a correct disposal to join that startup.
    removal = manager.disposeProject(project.id).then(() => state.removeProject(project.id));
    await nextTurn();
    gated.release();
    await Promise.all([settledInitialization, removal]);
    assert.equal(state.project(project.id), undefined);
    assert.equal(state.activeProjectId(), undefined);
    // Check the real owned fallback Host, not just a display/cache entry.
    await assert.rejects(access(runtimeHostPaths(dataRoot).registrationPath), { code: "ENOENT" },
      "removing a project must close the Host owned by its late initializer");
    assert.equal(manager["runtimes"].has(project.id), false,
      "a removed project must not acquire a resident Desktop client after disposal");
  } finally {
    gated.release();
    gated.restore();
    await Promise.allSettled([initialization, removal]);
  }
});

test("a removed project's late startup failure cannot restore its error cache", { timeout: 30_000 }, async (context) => {
  const { project, state, manager, configStore } = await fixture(context);
  const gated = gateRuntimeInitialization(configStore, new Error("removed project startup failure"));
  let initialization: Promise<unknown> | undefined;
  let removal: Promise<void> | undefined;
  try {
    const prepared = manager.prepareWorkspace(project.id);
    await gated.enteredPromise;
    await prepared;
    initialization = manager["runtimeInitializations"].get(project.id);
    assert.ok(initialization, "the failing real Host assembly must still be pending");
    // Observe rejection before releasing the gate, including on assertion failure.
    const settledInitialization = Promise.allSettled([initialization]);
    removal = manager.disposeProject(project.id).then(() => state.removeProject(project.id));
    await nextTurn();
    gated.release();
    await Promise.all([settledInitialization, removal]);
    // prewarmRuntime has its own rejection continuation in addition to getRuntime.
    await nextTurn();
    assert.equal(state.project(project.id), undefined);
    assert.equal(manager["runtimeErrors"].has(project.id), false,
      "late prewarm failure must not repopulate a disposed project's error cache");
    assert.equal(manager["runtimes"].has(project.id), false);
  } finally {
    gated.release();
    gated.restore();
    await Promise.allSettled([initialization, removal]);
  }
});

test("disposing a pending project leaves another project's real Host usable", { timeout: 30_000 }, async (context) => {
  const { root, project, state, projects, manager, configStore } = await fixture(context);
  const gated = gateRuntimeInitialization(configStore);
  let initialization: Promise<unknown> | undefined;
  let removal: Promise<void> | undefined;
  try {
    const prepared = manager.prepareWorkspace(project.id);
    await gated.enteredPromise;
    await prepared;
    initialization = manager["runtimeInitializations"].get(project.id);
    assert.ok(initialization);
    const settledInitialization = Promise.allSettled([initialization]);
    // Only the first assembly remains held; a separate project uses real startup.
    gated.restore();
    const other = await projects.createEmptyProject(path.join(root, "unrelated"));
    await manager.prepareWorkspace(other.id);
    await manager.retryRuntime(other.id);
    const healthy = manager["runtimes"].get(other.id);
    assert.ok(healthy);
    assert.ok(healthy.runtime instanceof RuntimeHostClient);
    const originalSessions = (await healthy.runtime.listRuntimeSessions()).map(({ sessionId }) => sessionId);
    assert.ok(originalSessions.length > 0);
    removal = manager.disposeProject(project.id).then(() => state.removeProject(project.id));
    await nextTurn();
    gated.release();
    await Promise.all([settledInitialization, removal]);
    assert.equal(manager["runtimes"].get(other.id), healthy,
      "project disposal must preserve the other project's client identity");
    assert.deepEqual((await healthy.runtime.listRuntimeSessions()).map(({ sessionId }) => sessionId), originalSessions,
      "the other project's real Host connection must remain usable");
    assert.equal(state.project(other.id)?.id, other.id);
  } finally {
    gated.release();
    gated.restore();
    await Promise.allSettled([initialization, removal]);
  }
});

test("same-ID replacement cannot inherit disposed initialization or its old waiters", { timeout: 30_000 }, async (context) => {
  const { project, state, manager, configStore, dataRoot } = await fixture(context);
  const gated = gateRuntimeInitialization(configStore);
  let initialization: Promise<unknown> | undefined;
  let waiter: ReturnType<typeof manager["getRuntime"]> | undefined;
  let blockedAdmission: ReturnType<typeof manager["getRuntime"]> | undefined;
  let disposal: Promise<void> | undefined;
  try {
    const prepared = manager.prepareWorkspace(project.id);
    await gated.enteredPromise;
    await prepared;
    initialization = manager["runtimeInitializations"].get(project.id);
    assert.ok(initialization);
    const settledInitialization = Promise.allSettled([initialization]);
    waiter = manager["getRuntime"](project.id, true);
    const settledWaiter = Promise.allSettled([waiter]);
    disposal = manager.disposeProject(project.id);
    // Deliberately restore the exact persisted fields while old startup is held.
    // Membership or addedAt alone cannot distinguish this replacement lifetime.
    await state.removeProject(project.id);
    await state.upsertProject({ ...project });
    let admissionSettled = false;
    blockedAdmission = manager["getRuntime"](project.id, true);
    void blockedAdmission.then(() => { admissionSettled = true; }, () => { admissionSettled = true; });
    await nextTurn();
    assert.equal(admissionSettled, true, "fresh admission must not wait on or escape an in-progress disposal");
    assert.equal(await blockedAdmission, undefined);
    assert.equal(gated.calls, 1);
    gated.release();
    await Promise.all([settledInitialization, settledWaiter, disposal]);
    assert.equal(await waiter, undefined, "an old waiter must not recursively start the replacement");
    await nextTurn();
    assert.equal(manager["runtimes"].has(project.id), false);
    assert.equal(manager["runtimeErrors"].has(project.id), false);
    await assert.rejects(access(runtimeHostPaths(dataRoot).registrationPath), { code: "ENOENT" },
      "the retired initializer must close its own Host even when the ID exists again");
    await manager.prepareWorkspace(project.id);
    await manager.retryRuntime(project.id);
    const replacement = manager["runtimes"].get(project.id);
    assert.ok(replacement);
    assert.ok(replacement.runtime instanceof RuntimeHostClient);
    assert.equal(gated.calls, 2, "a later explicit prepare must start one fresh lifetime");
    assert.ok((await replacement.runtime.listRuntimeSessions()).length > 0);
  } finally {
    gated.release();
    gated.restore();
    await Promise.allSettled([initialization, waiter, blockedAdmission, disposal]);
  }
});

test("disposing a pending attachment preserves an existing Host and its retaining client", { timeout: 30_000 }, async (context) => {
  const { root, project, manager, configStore, dataRoot } = await fixture(context);
  const { createInteractiveAgentHost } = await import("../src/runtime/InteractiveAgentRuntime.js");
  const { connectRuntimeHost, startRuntimeHost } = await import("../src/runtime/RuntimeHost.js");
  const configDir = path.join(root, "config");
  const host = await startRuntimeHost(dataRoot, async () => await createInteractiveAgentHost(project.path, {
    configStore, persistenceRoot: dataRoot
  }), { configDir });
  let retaining: RuntimeHostClient | undefined;
  const acquired: { client?: RuntimeHostClient } = {};
  let initialization: Promise<unknown> | undefined;
  let disposal: Promise<void> | undefined;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const setBrowserAutomation = RuntimeHostClient.prototype.setBrowserAutomation;
  const close = RuntimeHostClient.prototype.close;
  const closed: RuntimeHostClient[] = [];
  try {
    retaining = await connectRuntimeHost(dataRoot, { configDir, clientId: "retaining-control", surface: "tui", keepAlive: true });
    assert.ok(retaining);
    const sessions = (await retaining.listRuntimeSessions()).map(({ sessionId }) => sessionId);
    assert.ok(sessions.length > 0);
    context.mock.method(RuntimeHostClient.prototype, "setBrowserAutomation", async function (
      this: RuntimeHostClient, ...args: Parameters<typeof setBrowserAutomation>
    ) {
      acquired.client = this;
      entered();
      await gate;
      return await setBrowserAutomation.apply(this, args);
    });
    context.mock.method(RuntimeHostClient.prototype, "close", async function (this: RuntimeHostClient) {
      closed.push(this);
      await close.call(this);
    });
    const prepared = manager.prepareWorkspace(project.id);
    await enteredPromise;
    await prepared;
    initialization = manager["runtimeInitializations"].get(project.id);
    assert.ok(initialization);
    assert.ok(acquired.client);
    assert.notEqual(acquired.client, retaining);
    const settledInitialization = Promise.allSettled([initialization]);
    disposal = manager.disposeProject(project.id);
    release();
    await Promise.all([settledInitialization, disposal]);
    await nextTurn();
    assert.equal(manager["runtimes"].has(project.id), false);
    assert.equal(manager["runtimeErrors"].has(project.id), false);
    assert.ok(closed.includes(acquired.client), "disposal must close the late acquired Desktop client");
    assert.equal(closed.includes(retaining), false, "the other surface's client is not Desktop-owned");
    await access(runtimeHostPaths(dataRoot).registrationPath);
    assert.deepEqual((await retaining.listRuntimeSessions()).map(({ sessionId }) => sessionId), sessions);
    assert.equal(await host.retireIfIdle(0), false, "the second retaining client must still retain its Host");
  } finally {
    release();
    await Promise.allSettled([initialization, disposal]);
    await manager.closeAll();
    await retaining?.close();
    await host.close();
  }
});
