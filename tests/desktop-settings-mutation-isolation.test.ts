import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopSettingsTransaction, type DesktopSettingsJournal } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";
import { writeSessionCatalogRecord } from "../src/session/catalog.js";
import { InMemoryModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";

async function createFixture(fetcher?: typeof fetch) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-settings-mutation-isolation-"));
  const previousGlobalDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const workspace = path.join(root, "project");
  await mkdir(workspace);
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const storage = new DesktopUserDataStore(path.join(root, "desktop"));
  await storage.initialize();
  const store = createFileConfigStore(workspace, { globalDir: path.join(root, "config"), credentialStore: {
    persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {}
  } });
  store.supportsDetachedRuntimeHost = false;
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "chat",
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    providers: Object.fromEntries(["chat-provider", "tool-provider", "vision-provider"].map(id => [id, {
      type: "openai-compatible", baseUrl: `https://${id}.invalid/v1`, requiresApiKey: false
    }])),
    models: { chat: { provider: "chat-provider", model: "chat" }, tool: { provider: "tool-provider", model: "tool" },
      vision: { provider: "vision-provider", model: "vision" } }
  });
  await store.save(config);
  const projects = new DesktopProjectService(state, storage, store);
  const project = await projects.createProject(workspace);
  const catalogs = new InMemoryModelsStore();
  await catalogs.write(modelCatalogCacheKey("vision-provider", config.providers["vision-provider"]!), { models: [{
    id: "vision", provider: "vision-provider", displayName: "Vision", contextWindow: 128_000,
    maxOutputTokens: 8192, capabilities: { vision: true }, reasoningEfforts: []
  }] });
  const manager = new DesktopAgentManager(state, projects, store, () => {}, undefined, catalogs, fetcher ?? (async () => {
    throw new Error("Saving a model choice must not fetch remote catalogs");
  }));
  return { root, manager, store, state, project, projects, catalogs, async close() {
    await manager.closeAll();
    await removeTestRoot(root, { recursive: true, force: true });
    if (previousGlobalDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousGlobalDir;
  } };
}

test("verified model rollback does not restart other projects or leave the global recovery gate closed", async context => {
  const h = await createFixture();
  try {
    const secondPath = path.join(h.root, "second-project");
    await mkdir(secondPath);
    const second = await h.projects.createProject(secondPath);
    await h.manager.setPermissionMode(h.project.id, "read-only");
    await h.manager.setPermissionMode(second.id, "read-only");
    const internals = h.manager as unknown as {
      runtimes: Map<string, { runtime: { restartRuntime(sessionId?: string): Promise<unknown> } }>;
    };
    const firstRuntime = internals.runtimes.get(h.project.id)!.runtime;
    const firstRestart = context.mock.method(firstRuntime, "restartRuntime", firstRuntime.restartRuntime.bind(firstRuntime));
    const unrelatedRestart = context.mock.method(internals.runtimes.get(second.id)!.runtime, "restartRuntime", async () => {
      throw new Error("unrelated Runtime unavailable");
    });
    const transaction = new DesktopSettingsTransaction(h.state, h.manager);
    const base = await transaction.snapshot(h.project.id);
    const revision = h.manager.settingsConfigRevision.bind(h.manager);
    let revisionReads = 0;
    context.mock.method(h.manager, "settingsConfigRevision", async (projectId: string) => {
      return ++revisionReads === 2 ? "sha256:readback-mismatch" : await revision(projectId);
    });
    const result = await transaction.save(h.project.id, {
      expectedPreferenceRevision: base.preferenceRevision,
      expectedConfigRevision: base.configRevision,
      models: { upserts: [], removeAliases: [], toolModel: { alias: "tool" } }
    });
    assert.equal(result.status, "rolled_back", "derived Runtime availability must not override confirmed config compensation");
    assert.equal((await h.store.load()).toolModel, undefined);
    assert.equal(firstRestart.mock.callCount(), 0);
    assert.equal(unrelatedRestart.mock.callCount(), 0);
    assert.equal(await transaction.recoverAtStartup(), undefined);
    await transaction.assertRuntimeReady();
  } finally { await h.close(); }
});

test("metadata and permission mutations return only confirmed changed fields", async context => {
  const h = await createFixture();
  try {
    const sessionId = "local-metadata";
    await writeSessionCatalogRecord(await h.projects.dataRoot(h.project), {
      version: 1, sessionId, rootSessionId: sessionId,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const snapshot = context.mock.method(h.manager, "workspaceSnapshot", h.manager.workspaceSnapshot.bind(h.manager));
    const catalogs = context.mock.method(h.catalogs, "readMany", h.catalogs.readMany.bind(h.catalogs));
    const renamedProject = await h.manager.renameProject(h.project.id, "Renamed");
    assert.equal(renamedProject.name, "Renamed");
    assert.equal((await h.manager.setProjectPinned(h.project.id, true)).pinned, true);
    const renamed = await h.manager.renameSession(h.project.id, sessionId, "Renamed session");
    assert.equal(renamed.metadata.title, "Renamed session");
    const pinned = await h.manager.pinSession(h.project.id, sessionId, true, renamed.metadata.metadataRevision);
    assert.equal(pinned.metadata.pinned, true);
    assert.equal(Object.hasOwn(pinned.metadata, "title"), false, "unrelated metadata is not replaced");
    await assert.rejects(h.manager.archiveSession(h.project.id, sessionId, true, renamed.metadata.metadataRevision), /revision|版本/u);
    const archived = await h.manager.archiveSession(h.project.id, sessionId, true, pinned.metadata.metadataRevision);
    assert.equal(archived.metadata.archived, true);
    const fast = await h.manager.setSessionFastMode(h.project.id, sessionId, true, archived.metadata.metadataRevision);
    assert.equal(fast.metadata.fastMode, true);
    const read = await h.manager.markSessionRead(h.project.id, sessionId, fast.metadata.metadataRevision);
    assert.equal(read.metadata.unread, false);
    const permission = await h.manager.setPermissionMode(h.project.id, "read-only");
    assert.deepEqual(permission, { projectId: h.project.id, permissionMode: "read-only" });
    assert.equal(snapshot.mock.callCount(), 0, "local writes must not reload the workspace");
    assert.equal(catalogs.mock.callCount(), 0, "metadata does not depend on model catalogs");
  } finally { await h.close(); }
});

test("preferences save and stale preference conflicts remain independent of unrelated config", async context => {
  const h = await createFixture();
  try {
    const transaction = new DesktopSettingsTransaction(h.state, h.manager);
    const before = h.state.settingsPreferences();
    const configPath = path.join(h.root, "config", "config.json");
    const document = await readFile(configPath, "utf8");
    const snapshot = context.mock.method(h.manager, "settingsConfigSnapshot", h.manager.settingsConfigSnapshot.bind(h.manager));
    const revisions = context.mock.method(h.manager, "settingsConfigRevision", h.manager.settingsConfigRevision.bind(h.manager));
    await writeFile(configPath, "{unrelated-invalid-config");
    try {
      const result = await transaction.save(h.project.id, {
        expectedPreferenceRevision: before.revision, expectedConfigRevision: "unused-stale-config", themePreference: "dark"
      });
      assert.equal(result.status, "committed");
      assert.equal(result.snapshot, undefined);
      assert.equal(result.preferences?.themePreference, "dark");
      assert.equal(result.preferences?.preferenceRevision, before.revision + 1);
      const conflict = await transaction.save(h.project.id, {
        expectedPreferenceRevision: before.revision, expectedConfigRevision: "unused-stale-config", themePreference: "light"
      });
      assert.equal(conflict.status, "rolled_back");
      assert.ok(conflict.status === "rolled_back");
      assert.equal(conflict.conflicts?.[0]?.segment, "preferences");
      assert.equal(conflict.preferences?.themePreference, "dark");
      assert.equal(await transaction.recoverAtStartup(), undefined);
      assert.equal(snapshot.mock.callCount(), 0);
      assert.equal(revisions.mock.callCount(), 0);
    } finally { await writeFile(configPath, document); }
  } finally { await h.close(); }
});

for (const point of ["journal-write", "journal-cleanup"] as const) {
  test(`preferences ${point} failure preserves compensation and startup recovery without config`, async context => {
    const h = await createFixture();
    try {
      class FailingPreferenceTransaction extends DesktopSettingsTransaction {
        failed = false;
        protected override async writeJournal(journal: DesktopSettingsJournal): Promise<void> {
          if (point === "journal-write" && !this.failed && journal.segments.preferences.state === "committed") {
            this.failed = true;
            throw new Error("injected preference journal write failure");
          }
          await super.writeJournal(journal);
        }
        protected override async deleteJournal(): Promise<void> {
          if (point === "journal-cleanup" && !this.failed) {
            this.failed = true;
            throw new Error("injected preference journal cleanup failure");
          }
          await super.deleteJournal();
        }
      }
      const transaction = new FailingPreferenceTransaction(h.state, h.manager);
      const before = h.state.settingsPreferences();
      const snapshot = context.mock.method(h.manager, "settingsConfigSnapshot", h.manager.settingsConfigSnapshot.bind(h.manager));
      const configPath = path.join(h.root, "config", "config.json");
      const document = await readFile(configPath, "utf8");
      await writeFile(configPath, "{unrelated-invalid-config");
      try {
        const result = await transaction.save(h.project.id, {
          expectedPreferenceRevision: before.revision, expectedConfigRevision: "not-consumed", themePreference: "dark"
        });
        assert.equal(result.status, point === "journal-write" ? "rolled_back" : "recovery_required");
        assert.equal(result.snapshot, undefined);
        assert.equal(result.preferences?.themePreference, point === "journal-write" ? before.themePreference : "dark");
        assert.equal(result.preferences?.preferenceRevision, before.revision + (point === "journal-write" ? 2 : 1));
        const restarted = new DesktopSettingsTransaction(h.state, h.manager);
        assert.equal(await restarted.recoverAtStartup(), undefined);
        await restarted.assertRuntimeReady();
        assert.equal(snapshot.mock.callCount(), 0);
      } finally { await writeFile(configPath, document); }
    } finally { await h.close(); }
  });
}

test("non-model settings receipts preserve transaction authority without reading model catalogs", async context => {
  const h = await createFixture();
  try {
    const transaction = new DesktopSettingsTransaction(h.state, h.manager);
    const base = await transaction.snapshot(h.project.id);
    const catalogs = context.mock.method(h.catalogs, "readMany", h.catalogs.readMany.bind(h.catalogs));
    const input = { expectedPreferenceRevision: base.preferenceRevision, expectedConfigRevision: base.configRevision,
      chatParams: { ...base.chatParams, temperature: 0.4 } };
    const committed = await transaction.save(h.project.id, input);
    assert.equal(committed.status, "committed");
    assert.equal(catalogs.mock.callCount(), 0, "chat parameters do not consume Provider catalogs");
    assert.ok(committed.settings);
    assert.equal(committed.snapshot, undefined);
    assert.equal(Object.hasOwn(committed.settings, "models"), false);
    assert.equal(committed.settings.chatParams.temperature, 0.4);
    assert.equal(committed.settings.configRevision, await h.manager.settingsConfigRevision(h.project.id));

    const conflict = await transaction.save(h.project.id, input);
    assert.equal(conflict.status, "rolled_back");
    assert.ok(conflict.settings);
    assert.equal(conflict.settings.configRevision, committed.settings.configRevision);
    assert.equal(catalogs.mock.callCount(), 0, "conflict projection does not consume Provider catalogs");

    const commit = h.manager.commitSettingsConfig.bind(h.manager);
    context.mock.method(h.manager, "commitSettingsConfig", async (prepared, transactionId) => {
      await commit(prepared, transactionId);
      throw new Error("synthetic post-write failure");
    });
    const rolledBack = await transaction.save(h.project.id, { ...input,
      expectedConfigRevision: committed.settings.configRevision, chatParams: { ...input.chatParams, temperature: 0.7 } });
    assert.equal(rolledBack.status, "rolled_back");
    assert.ok(rolledBack.settings);
    assert.equal(rolledBack.settings.chatParams.temperature, 0.4);
    assert.equal(rolledBack.settings.configRevision, await h.manager.settingsConfigRevision(h.project.id));
    assert.equal(catalogs.mock.callCount(), 0, "rollback verification and receipt do not consume Provider catalogs");
    await transaction.assertRuntimeReady();
  } finally { await h.close(); }
});

test("project Skill overrides refresh only the target workspace", async context => {
  const h = await createFixture();
  try {
    const secondPath = path.join(h.root, "unrelated-project");
    await mkdir(secondPath);
    const second = await h.projects.createProject(secondPath);
    await h.manager.setPermissionMode(h.project.id, "read-only");
    await h.manager.setPermissionMode(second.id, "read-only");
    const internals = h.manager as unknown as {
      runtimes: Map<string, { runtime: { restartRuntime(sessionId?: string): Promise<unknown> } }>;
      idleRuntimeRebuildTail: Promise<void>;
    };
    const first = internals.runtimes.get(h.project.id)!.runtime;
    const unrelated = internals.runtimes.get(second.id)!.runtime;
    const firstRestart = context.mock.method(first, "restartRuntime", first.restartRuntime.bind(first));
    const otherRestart = context.mock.method(unrelated, "restartRuntime", unrelated.restartRuntime.bind(unrelated));
    const transaction = new DesktopSettingsTransaction(h.state, h.manager);
    const before = await transaction.snapshot(h.project.id);
    const result = await transaction.save(h.project.id, {
      expectedPreferenceRevision: before.preferenceRevision, expectedConfigRevision: before.configRevision,
      skills: { globalDefaults: before.skills.globalDefaults, projectOverrides: { "builtin:travel": false } }
    });
    assert.equal(result.status, "committed");
    await internals.idleRuntimeRebuildTail;
    assert.equal(firstRestart.mock.callCount(), 1, "target resident runtime receives the new Skill policy");
    assert.equal(otherRestart.mock.callCount(), 0, "unrelated project keeps its resident runtime");
  } finally { await h.close(); }
});

test("another project's Skill override preserves shared resources for the current workspace", async () => {
  const { RuntimeHostResourceRegistry } = await import("../src/runtime/host/resources.js");
  const { createProjectSkillKey } = await import("../src/extensions/skillRef.js");
  const registry = new RuntimeHostResourceRegistry();
  const before = structuredClone(defaultConfig);
  const after = structuredClone(before);
  after.extensions.skillProjectOverrides[createProjectSkillKey("/project-a")] = { "builtin:travel": false };
  const first = registry.acquire("/project-b", before);
  const second = registry.acquire("/project-b", after);
  try { assert.equal(second, first, "unrelated override does not replace MCP and Skill resources"); }
  finally { await registry.release(first); await registry.release(second); await registry.close(); }
});

test("MCP saves refresh only changed connections and report committed refresh failures", async context => {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { DesktopMcpService } = await import("../src/desktop/electron/main/DesktopMcpService.js");
  const starts: string[] = [];
  const closes: string[] = [];
  const endpoint = (transport: unknown) => (transport as { _url: URL })._url.pathname;
  context.mock.method(StreamableHTTPClientTransport.prototype, "start", async function () { starts.push(endpoint(this)); });
  context.mock.method(StreamableHTTPClientTransport.prototype, "close", async function () { closes.push(endpoint(this)); this.onclose?.(); });
  context.mock.method(StreamableHTTPClientTransport.prototype, "send", async function (message) {
    if (!("method" in message) || !("id" in message)) return;
    const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
      : message.method === "tools/call" ? { content: [{ type: "text", text: endpoint(this) }] } : undefined;
    assert.ok(result, `unexpected MCP request ${message.method}`);
    this.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
  });
  const h = await createFixture();
  const mcp = new DesktopMcpService(h.store, h.projects, h.manager);
  try {
    const config = await h.store.load();
    config.computer.enabled = false;
    config.extensions.mcp = {
      disabled: { enabled: false, command: "never-executed", args: [], description: "before" },
      target: { enabled: true, type: "http", url: "https://mcp.invalid/target-v1", args: [], transportProtocol: "streamable-http" },
      other: { enabled: true, type: "http", url: "https://mcp.invalid/other", args: [], transportProtocol: "streamable-http" }
    };
    await h.store.save(config);
    const secondPath = path.join(h.root, "mcp-second"); await mkdir(secondPath);
    const second = await h.projects.createProject(secondPath);
    await h.manager.setPermissionMode(h.project.id, "read-only");
    await h.manager.setPermissionMode(second.id, "read-only");
    const internals = h.manager as unknown as { runtimes: Map<string, { runtime: {
      restartRuntime(sessionId?: string): Promise<unknown>;
      mcpConfigure(servers: string[], force?: boolean): Promise<void>;
      mcpStatus(): Promise<Array<{ name: string; connected: boolean; command: string }>>;
    } }> };
    const first = internals.runtimes.get(h.project.id)!.runtime;
    const unrelated = internals.runtimes.get(second.id)!.runtime;
    const restart = context.mock.method(first, "restartRuntime", first.restartRuntime.bind(first));
    const secondRestart = context.mock.method(unrelated, "restartRuntime", unrelated.restartRuntime.bind(unrelated));
    const base = await mcp.snapshot(h.project.id);
    const noOp = await mcp.setEnabled(h.project.id, "disabled", false, base.configRevision);
    assert.equal(restart.mock.callCount() + secondRestart.mock.callCount(), 0, "no-op MCP save must preserve every runtime");
    assert.equal(noOp.saved?.runtimeRefresh, "not_needed");
    const description = await mcp.upsertServer(h.project.id, "disabled", { name: "disabled", transport: "stdio",
      command: "never-executed", args: [], env: [], headers: [], description: "after" }, noOp.configRevision);
    assert.equal(description.saved?.runtimeRefresh, "not_needed");
    assert.equal(restart.mock.callCount() + secondRestart.mock.callCount(), 0);
    const draft = { name: "target", transport: "remote" as const, url: "https://mcp.invalid/target-v2", args: [], env: [], headers: [] };
    const changed = await mcp.upsertServer(h.project.id, "target", draft, description.configRevision);
    assert.equal(changed.saved?.runtimeRefresh, "completed");
    assert.equal(restart.mock.callCount() + secondRestart.mock.callCount(), 0, "MCP reconfiguration preserves session runtimes");
    assert.equal(starts.filter(value => value === "/other").length, 2, "one unchanged connection per workspace survives");
    assert.equal(closes.filter(value => value === "/other").length, 0);
    assert.equal(starts.filter(value => value === "/target-v2").length, 2);
    for (const runtime of [first, unrelated]) {
      const target = (await runtime.mcpStatus()).find(server => server.name === "target");
      assert.equal(target?.command, draft.url);
      assert.equal(target?.connected, true);
    }
    const failedRefresh = context.mock.method(unrelated, "mcpConfigure", async () => { throw new Error("synthetic connection refresh failure fixture-private-value https://mcp.invalid/target-v3?token=fixture-private-value"); });
    const degraded = await mcp.upsertServer(h.project.id, "target", { ...draft, url: "https://mcp.invalid/target-v3?token=fixture-private-value" }, changed.configRevision);
    assert.equal(degraded.saved?.runtimeRefresh, "failed");
    assert.match(degraded.saved?.message ?? "", /已保存/u);
    assert.equal(degraded.saved?.message?.includes("fixture-private-value"), false);
    assert.equal((await h.store.load()).extensions.mcp.target?.url, "https://mcp.invalid/target-v3?token=fixture-private-value");
    failedRefresh.mock.restore();
    const retried = await h.manager.mcpReconnect(second.id, "target");
    assert.equal(retried.connected, true);
    assert.equal(retried.command, "https://mcp.invalid/target-v3?token=fixture-private-value");
    assert.equal(closes.filter(value => value === "/other").length, 0);
  } finally { await mcp.dispose(); await h.close(); }
});

test("Desktop reconnect preserves in-process MCP ownership", async () => {
  const h = await createFixture();
  try {
    const config = await h.store.load(); config.computer.enabled = false; await h.store.save(config);
    await h.manager.setPermissionMode(h.project.id, "read-only");
    const internals = h.manager as unknown as { runtimes: Map<string, { host: { commands: { mcp: import("../src/extensions/mcp.js").McpToolHost } } }> };
    const host = internals.runtimes.get(h.project.id)!.host.commands.mcp;
    let starts = 0;
    let current: import("@modelcontextprotocol/sdk/shared/transport.js").Transport | undefined;
    await host.attachLocalServer("computer-use", "test-local", [], async () => {
      const transport: import("@modelcontextprotocol/sdk/shared/transport.js").Transport = {
        async start() { starts += 1; },
        async close() { transport.onclose?.(); },
        async send(message) {
          if (!("method" in message) || !("id" in message)) return;
          const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} }, serverInfo: { name: "local", version: "1" } } : { tools: [] };
          transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
        }
      };
      current = transport;
      return { transport, close: async () => {} };
    });
    current?.onclose?.();
    assert.equal(host.listServers()[0]?.connected, false);
    const status = await h.manager.mcpReconnect(h.project.id, "computer-use");
    assert.equal(status.connected, true);
    assert.equal(status.transport, "in-process");
    assert.equal(starts, 2);
  } finally { await h.close(); }
});

test("project Skill overrides can save beside another busy workspace while shared changes remain gated", { timeout: 15_000 }, async () => {
  const h = await createFixture();
  const release = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const secondPath = path.join(h.root, "busy-project"); await mkdir(secondPath);
    const second = await h.projects.createProject(secondPath);
    await h.manager.setPermissionMode(h.project.id, "read-only");
    await h.manager.setPermissionMode(second.id, "read-only");
    const transaction = new DesktopSettingsTransaction(h.state, h.manager);
    const before = await transaction.snapshot(h.project.id);
    const internals = h.manager as unknown as { runtimes: Map<string, {
      host: { runtime: { runExclusiveOperation<T>(label: string, action: () => Promise<T>): Promise<T> } };
      runtime: { subscribe(listener: () => void): () => void };
    }> };
    const secondRuntime = internals.runtimes.get(second.id)!;
    const busy = Promise.withResolvers<void>();
    timer = setTimeout(() => busy.reject(new Error("busy state did not publish")), 5_000);
    unsubscribe = secondRuntime.runtime.subscribe(() => { if (h.manager.isProjectRunning(second.id)) busy.resolve(); });
    pending = secondRuntime.host.runtime.runExclusiveOperation("scope-test", async () => await release.promise);
    await busy.promise; clearTimeout(timer);
    const result = await transaction.save(h.project.id, { expectedPreferenceRevision: before.preferenceRevision,
      expectedConfigRevision: before.configRevision, skills: { globalDefaults: before.skills.globalDefaults, projectOverrides: { "builtin:travel": false } } });
    assert.equal(result.status, "committed", "another workspace's activity does not own this project's Skill overrides");
    assert.ok(result.settings);
    const blocked = await transaction.save(second.id, { expectedPreferenceRevision: result.settings.preferenceRevision,
      expectedConfigRevision: result.settings.configRevision, skills: { globalDefaults: before.skills.globalDefaults, projectOverrides: { "builtin:travel": false } } });
    assert.equal(blocked.status, "rolled_back", "the active target remains protected");
    const shared = await transaction.save(h.project.id, { expectedPreferenceRevision: result.settings.preferenceRevision,
      expectedConfigRevision: result.settings.configRevision, skills: { globalDefaults: { "builtin:travel": false }, projectOverrides: { "builtin:travel": false } } });
    assert.equal(shared.status, "rolled_back", "global defaults remain shared across active workspaces");
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.(); release.resolve(); await pending; await h.close();
  }
});
