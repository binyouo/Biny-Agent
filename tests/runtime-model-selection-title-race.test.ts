/** Real Desktop/Runtime model isolation with a controlled post-turn title race; only transport and provider I/O are in memory. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { readSessionEvents } from "../src/session/events.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function send(delta: Record<string, unknown>, finishReason: string): Response {
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const titleRelease = deferred<void>();
const titlePublished = deferred<void>();
const submissions: Array<Record<string, unknown>> = [];
class MemorySocket extends EventEmitter {
  destroyed = false; writableLength = 0; peer!: MemorySocket;
  setEncoding() { return this; }
  write(data: string) {
    for (const line of data.trim().split("\n")) {
      const frame = JSON.parse(line);
      if (frame.kind === "request" && frame.operation === "run.submit") submissions.push(frame.payload);
      if (frame.kind === "event" && frame.update.event?.type === "session.title") titlePublished.resolve();
      if (frame.kind === "request" && frame.operation === "run.submit" && frame.payload.input === "Discover again") {
        titleRelease.resolve();
        void titlePublished.promise.then(() => setImmediate(() => { if (!this.peer.destroyed) this.peer.emit("data", data); })); return true;
      }
    }
    setImmediate(() => { if (!this.peer.destroyed) this.peer.emit("data", data); }); return true;
  }
  end() { return this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); } return this; }
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; tools?: unknown[]; messages?: Array<{role:string,content:string}> };
    if (body.messages?.some(message => message.role === "system" && message.content.includes("为这段对话生成简短"))) {
      await titleRelease.promise;
    }
    if (body.model.startsWith("aux-") || !Array.isArray(body.tools)) {
      auxiliaryModels.push(body.model);
      return send( { content: JSON.stringify({ tools: ["Read"] }) }, "stop");
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
      return send( { tool_calls: [{ index: 0, id: `${body.model}-${count}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    } else {
      return send( { content: `Completed with ${body.model}` }, "stop");
    }
  };
  const configRoot = path.join(root, "config");
  const store = () => createFileConfigStore(workspace, { globalDir: configRoot, credentialStore: {
    persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {}
  } });
  const configStore = store();
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save(configSchema.parse({
    ...defaultConfig,
    defaultModel: "old", toolModel: "oldAux",
    providers: { local: { type: "openai-compatible", baseUrl: "http://fixture.local/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
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
    titleRelease.resolve();
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  } };
}

test("next model-selection turn survives a real background-title revision race", { timeout: 25_000 }, async (t) => {
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
    const persistenceRoot = await projects.dataRoot(project);
    const resourceRegistry = new RuntimeHostResourceRegistry();
    const factory = async (sessionId: string | undefined, options: any = {}) => {
      const local = await createInteractiveAgentHost(f.workspace, { configStore: f.configStore, persistenceRoot, attachmentRoot: projects.attachmentsRoot(project), sessionId: options.fresh ? sessionId : undefined, resourceRegistry: options.resourceRegistry, resourceBoot: options.resourceRegistry ? "background" : "blocking" });
      if (sessionId !== undefined && !options.fresh) await local.runtime.resumeSession(sessionId);
      return local;
    };
    const initial = await factory(undefined, { resourceRegistry });
    const registration = { protocolVersion: runtimeHostProtocolVersion, endpoint: "memory-only.sock", registrationPath: path.join(f.root,"unused.json"), lockPath: path.join(f.root,"unused.lock"), rootHash:"probe", configRoot: path.dirname(f.configStore.configPath!()), agentRoot:process.env.BINY_AGENT_DIR!, persistenceRoot, hostEpoch: "probe-epoch", token:"synthetic-probe-token", pid:process.pid, createdAt:new Date().toISOString() };
    const host = new RuntimeHostServer(initial.runtime, initial.commands, registration, { close: async () => undefined }, factory, { workspaceRoot:f.workspace, resourceRegistry });
    await host.initialize();
    t.mock.method(net, "createConnection", () => {
      const clientSocket = new MemorySocket(); const hostSocket = new MemorySocket(); clientSocket.peer = hostSocket; hostSocket.peer = clientSocket;
      (host as any).accept(hostSocket); queueMicrotask(() => clientSocket.emit("connect")); return clientSocket as unknown as net.Socket;
    });
    const client = await RuntimeHostClient.connect({ registration, clientId:"desktop-probe", surface:"desktop", configDir:path.dirname(f.configStore.configPath!()) });
    const managed = { runtime:client, host, unsubscribe:(agents as any).wireRuntimeEvents(project.id, client, true) };
    (agents as any).runtimes.set(project.id, managed);
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
    assert.equal(submissions.length, 3, "first turn is admitted once; second turn has one explicit rejection and one admission");
    assert.equal(submissions[1]!.expectedRevision, 21);
    assert.equal(submissions[2]!.expectedRevision, 22);
    assert.deepEqual({ ...submissions[2], expectedRevision: 21 }, submissions[1], "the retry retains all run/message/turn identities");
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
