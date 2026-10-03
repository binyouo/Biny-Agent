/** 本地 HTTP 与真实 Desktop/Runtime 装配验证回合配置隔离；不调用外部模型。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { resolveToolModelAlias } from "../src/llm/toolModel.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function send(response: ServerResponse, delta: Record<string, unknown>, finishReason: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-turn-model-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "note.txt"), "local-model-selection-fixture");
  const firstRequest = deferred<void>();
  const releaseFirst = deferred<void>();
  const mainModels: string[] = [];
  const auxiliaryModels: string[] = [];
  const counts = new Map<string, number>();
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; tools?: unknown[] };
    if (body.model.startsWith("aux-") || !Array.isArray(body.tools)) {
      auxiliaryModels.push(body.model);
      send(response, { content: JSON.stringify({ tools: ["Read"] }) }, "stop");
      return;
    }
    mainModels.push(body.model);
    const count = (counts.get(body.model) ?? 0) + 1;
    counts.set(body.model, count);
    if (mainModels.length === 1) {
      firstRequest.resolve();
      await releaseFirst.promise;
    }
    if (count === 1 || (body.model === "chat-old" && count === 2) || (body.model === "chat-new" && count === 3)) {
      const name = body.model === "chat-old" && count === 1 ? "Read" : "ToolSearch";
      const args = name === "Read" ? { path: "note.txt" } : { query: "read the local note" };
      send(response, { tool_calls: [{ index: 0, id: `${body.model}-${count}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    } else {
      send(response, { content: `Completed with ${body.model}` }, "stop");
    }
  })().catch((error: unknown) => { response.writeHead(500); response.end(String(error)); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const configRoot = path.join(root, "config");
  const store = () => createFileConfigStore(workspace, { globalDir: configRoot, credentialStore: {
    persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {}
  } });
  const configStore = store();
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save(configSchema.parse({
    ...defaultConfig,
    defaultModel: "old", toolModel: "oldAux",
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: Object.fromEntries([["old", "chat-old"], ["new", "chat-new"], ["oldAux", "aux-old"], ["newAux", "aux-new"]].map(([alias, model]) => [alias, {
      provider: "local", model, contextWindow: 128_000, capabilities: { tools: true, reasoning: false, streaming: true }
    }])),
    thinking: { ...defaultConfig.thinking, enabled: false },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
    extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
    checkpoints: { enabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    activity: { ...defaultConfig.activity, enabled: false },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  }));
  return { root, workspace, configStore, store, firstRequest, releaseFirst, mainModels, auxiliaryModels, async close() {
    releaseFirst.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  } };
}

test("运行中可保存聊天与工具模型，当前回合保持旧配置，下一回合使用新配置", { timeout: 25_000 }, async () => {
  const f = await fixture();
  let agents: DesktopAgentManager | undefined;
  const completed = new Map<string, string>();
  let notifyCompleted = deferred<void>();
  const timer = setTimeout(() => f.releaseFirst.resolve(), 20_000);
  try {
    const storage = new DesktopUserDataStore(path.join(f.root, "desktop"));
    await storage.initialize();
    const state = new DesktopStateStore(path.join(f.root, "state.json"));
    await state.load();
    const projects = new DesktopProjectService(state, storage, f.configStore);
    const project = await projects.createProject(f.workspace);
    agents = new DesktopAgentManager(state, projects, f.configStore, (_projectId, update) => {
      if (update.event && ["run.completed", "run.failed", "run.blocked"].includes(update.event.type) && "runId" in update.event) {
        completed.set(update.event.runId, update.event.type);
        notifyCompleted.resolve();
      }
    });
    const selection = { tools: ["Read", "ToolSearch"], skills: "none" as const };
    const first = await agents.sendPrompt(project.id, undefined, "Read and discover the note", [], undefined, undefined, undefined, undefined, selection);
    await f.firstRequest.promise;
    assert.equal(agents.hasRunningTasks(), true);
    const switched = await agents.switchModel(project.id, "new", "off");
    assert.equal(switched.modelAlias, "new");
    await assert.rejects(agents.switchModel(project.id, "missing", "off"));
    assert.equal((await f.configStore.load()).defaultModel, "new", "无效选择不能覆盖有效配置");
    const settings = new DesktopSettingsTransaction(state, agents);
    const snapshot = await settings.snapshot(project.id);
    const saved = await settings.save(project.id, {
      expectedConfigRevision: snapshot.configRevision, expectedPreferenceRevision: snapshot.preferenceRevision,
      models: { upserts: [], removeAliases: [], toolModel: { alias: "newAux" } }
    });
    assert.equal(saved.status, "committed", JSON.stringify(saved));
    const view = await agents.workspaceSnapshot(project.id, false);
    const currentRuntime = view.sessionRuntimes?.[first.sessionId] ?? view.runtime;
    assert.equal(currentRuntime?.info.modelAlias, "old", "执行状态继续反映当前回合的实际模型");
    assert.equal(view.selectedModel?.modelAlias, "new", "选择器使用已保存配置");
    assert.equal(agents.hasRunningTasks(), true, "保存模型不得取消或重启运行");
    f.releaseFirst.resolve();
    if (!completed.has(first.runId)) await notifyCompleted.promise;
    assert.equal(completed.get(first.runId), "run.completed");
    assert.deepEqual(f.mainModels, ["chat-old", "chat-old", "chat-old"]);
    assert.ok(f.auxiliaryModels.length > 0);
    assert.ok(f.auxiliaryModels.every((model) => model === "aux-old"), "运行中变更不影响当前回合内后续工具筛选");
    notifyCompleted = deferred<void>();
    const next = await agents.sendPrompt(project.id, first.sessionId, "Discover again", [], undefined, undefined, undefined, undefined, selection);
    if (!completed.has(next.runId)) await notifyCompleted.promise;
    assert.equal(completed.get(next.runId), "run.completed");
    assert.deepEqual(f.mainModels, ["chat-old", "chat-old", "chat-old", "chat-new", "chat-new"]);
    assert.ok(f.auxiliaryModels.includes("aux-new"));
    assert.ok(currentRuntime?.info.sessionFile);
    const events = await readSessionEvents(currentRuntime.info.sessionFile);
    assert.equal(events.filter((event) => event.type === "turn_status" && event.status === "completed").length, 2);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.tool === "ToolSearch").length, 2);
    assert.deepEqual(events.filter((event) => event.type === "tool_result" && event.tool === "ToolSearch")
      .map((event) => event.type === "tool_result" ? (event.result as { model: { modelId: string } }).model.modelId : undefined), ["aux-old", "aux-new"]);
  } finally {
    clearTimeout(timer);
    f.releaseFirst.resolve();
    await agents?.closeAll();
    await f.close();
  }
});

test("独立配置客户端修改模型后，驻留 Runtime 下一回合从磁盘读取新选择", { timeout: 20_000 }, async () => {
  const f = await fixture();
  let runtime: CommandRuntime | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => { f.releaseFirst.resolve(); controller.abort(); }, 15_000);
  try {
    runtime = await createCommandRuntime(f.workspace, { configStore: f.store() });
    const run = runtime.agent.runTask("Read the note", { abortSignal: controller.signal, emotionAnalysis: false, capabilitySelection: { tools: ["Read", "ToolSearch"], skills: "none" } });
    await f.firstRequest.promise;
    await updateConfig(f.configStore, f.workspace, (config) => ({ ...config, defaultModel: "new", toolModel: "newAux" }));
    f.releaseFirst.resolve();
    assert.equal((await run).status, "completed");
    assert.deepEqual(f.mainModels, ["chat-old", "chat-old", "chat-old"]);
    assert.equal((await runtime.agent.runTask("Discover again", { abortSignal: controller.signal, emotionAnalysis: false, capabilitySelection: { tools: ["Read", "ToolSearch"], skills: "none" } })).status, "completed");
    assert.equal(f.mainModels.at(-1), "chat-new");
    assert.deepEqual(f.auxiliaryModels, ["aux-old", "aux-new"]);
    await updateConfig(f.configStore, f.workspace, (config) => ({ ...config, toolModel: undefined }));
    const automatic = await f.configStore.load();
    const automaticAlias = resolveToolModelAlias(automatic);
    assert.ok(automaticAlias);
    assert.equal((await runtime.agent.runTask("Discover in automatic mode", { abortSignal: controller.signal, emotionAnalysis: false, capabilitySelection: { tools: ["Read", "ToolSearch"], skills: "none" } })).status, "completed");
    assert.equal(f.auxiliaryModels.at(-1), automatic.models[automaticAlias]?.model, "自动选择不能沿用上一回合的显式工具模型");
  } finally {
    clearTimeout(timer);
    controller.abort();
    f.releaseFirst.resolve();
    await runtime?.close();
    await f.close();
  }
});
