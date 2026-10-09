/** 真实 Host、socket 和持久化目录上的生命周期契约；时间等待只用于验证空闲宽限窗口。 */
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { createFileConfigStore } from "../src/config/store.js";
import { saveConfig } from "../src/config/loader.js";
import { startRuntimeHost, connectRuntimeHost, runtimeHostPaths } from "../src/runtime/RuntimeHost.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-idle-"));
const configDir = path.join(root, "config");
await saveConfig(root, {
  ...structuredClone(defaultConfig),
  defaultModel: "local-test",
  providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
  models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }
}, { globalDir: configDir });
const local = await createInteractiveAgentHost(root, { configStore: createFileConfigStore(root, { globalDir: configDir }) });
const server = await startRuntimeHost(root, async () => local, { configDir });
const clientOptions = { spawnOptions: { workspaceRoot: root, configDir } };
let first = await connectRuntimeHost(root, { ...clientOptions, clientId: "first" });
let second = await connectRuntimeHost(root, { ...clientOptions, clientId: "second" });
const observer = await connectRuntimeHost(root, { ...clientOptions, clientId: "desktop-observer", surface: "desktop", keepAlive: false });
try {
  assert.ok(first && second && observer);
  await first.close();
  first = undefined;
  assert.equal(await server.retireIfIdle(0), false, "one client leaving must not stop the other client");
  await second.close();
  second = undefined;
  await observer.setKeepAlive(true);
  assert.equal(await server.retireIfIdle(0), false, "active workspace retains its MCP Host even without a message");
  await observer.setKeepAlive(false);
  const automation = local.commands.automationStore.create({ name: "future work", triggerType: "interval", schedule: { intervalMs: 86_400_000 }, executionTemplate: { prompt: "Never invoke a model in this test" } });
  assert.equal(await server.retireIfIdle(0), false, "future scheduled work is residency, not idle");
  local.commands.automationStore.pause(automation.automationId);
  // 进程查询期间到达的新请求必须打断本次回收，即使连接本身不保活。
  const listProcesses = local.commands.managedProcesses.list.bind(local.commands.managedProcesses);
  let releaseProbe!: () => void;
  let enteredProbe!: () => void;
  const probing = new Promise<void>((resolve) => { enteredProbe = resolve; });
  const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  local.commands.managedProcesses.list = async (options) => {
    enteredProbe();
    await probeGate;
    return await listProcesses(options);
  };
  const retirement = server.retireIfIdle(0);
  await probing;
  try {
    assert.ok((await observer.listRuntimeSessions()).length > 0);
  } finally {
    local.commands.managedProcesses.list = listProcesses;
    releaseProbe();
  }
  assert.equal(await retirement, false, "异步空闲检查不能跨过新请求关闭 owner");
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const operation = local.runtime.runExclusiveOperation("memory", async () => { started(); await held; });
  await began;
  try { assert.equal(await server.retireIfIdle(0), false, "active work must survive disconnect"); }
  finally { release(); await operation; }
  const background = await local.commands.managedProcesses.start({ command: "tail -f /dev/null", cwd: root });
  assert.equal(await server.retireIfIdle(0), false, "background processes keep the Host resident");
  await local.commands.managedProcesses.stop(background.processId);
  const finishedAutomation = local.commands.automationStore.create({
    name: "completed work", triggerType: "interval", schedule: { intervalMs: 86_400_000 },
    executionTemplate: { prompt: "Never invoke a model in this test" }, maxFires: 1
  });
  const finishedFire = local.commands.automationStore.forceFire(finishedAutomation.automationId);
  local.commands.automationStore.claimFire(finishedFire.fireId);
  local.commands.automationStore.completeFire(finishedFire.fireId, "completed-run");
  assert.equal(local.commands.automationStore.get(finishedAutomation.automationId)?.status, "completed");
  // 宽限计时基于真实进程断连；最多轮询 5 秒，不以睡够某段时间作为成功条件。
  const deadline = Date.now() + 5_000;
  let retired = false;
  while (!retired && Date.now() < deadline) {
    retired = await server.retireIfIdle(30);
    if (!retired) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(retired, true, "已完成的调度历史不得永久阻止 Host 回收");
  const disconnectDeadline = Date.now() + 1_000;
  while (!observer.isRetired && Date.now() < disconnectDeadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(observer.isRetired, true, "观察连接收到正常回收通知后不得自动重新启动 Host");
  await assert.rejects(access(runtimeHostPaths(root).registrationPath), { code: "ENOENT" });
  await assert.rejects(access(runtimeHostPaths(root).lockPath), { code: "ENOENT" });
} finally {
  await first?.close();
  await second?.close();
  await observer?.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
console.log("runtime host idle lifecycle tests passed");
