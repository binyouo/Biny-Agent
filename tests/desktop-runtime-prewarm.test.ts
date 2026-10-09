import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  return { project, dataRoot, manager, configStore, sessionId: recorder.sessionId };
}

type LoadFn = ReturnType<typeof createFileConfigStore>["load"];

/** 只卡住 Host 初始化读配置的那次调用（来自 CommandRuntime 装配），界面自己的读取不受阻。 */
function gateRuntimeInitialization(configStore: ReturnType<typeof createFileConfigStore>) {
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
  const after = await manager.workspaceSnapshot(project.id, false);
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
