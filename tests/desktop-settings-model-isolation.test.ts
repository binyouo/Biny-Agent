import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { InMemoryModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";

async function createFixture(fetcher?: typeof fetch) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-settings-model-isolation-"));
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
  return { root, manager, store, state, project, catalogs, async close() {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  } };
}

test("saving a vision selection reads only its Provider catalog", async context => {
  const h = await createFixture();
  try {
    const reads: string[][] = [];
    const readMany = h.catalogs.readMany.bind(h.catalogs);
    context.mock.method(h.catalogs, "readMany", async (keys: readonly string[]) => {
      reads.push([...keys]);
      return await readMany(keys);
    });
    const prepared = await h.manager.prepareSettingsConfig(h.project.id, {
      expectedPreferenceRevision: h.state.settingsPreferences().revision,
      expectedConfigRevision: await h.manager.settingsConfigRevision(h.project.id),
      models: { upserts: [], removeAliases: [], visionModel: { alias: "vision" } }
    });
    assert.equal(prepared.after.visionModel, "vision");
    assert.equal(prepared.after.toolModel, undefined);
    assert.equal(prepared.after.defaultModel, "chat");
    assert.equal(reads.length, 1);
    assert.ok(reads.flat().every(key => key === "vision-provider" || key.startsWith("vision-provider::")),
      "vision validation must not load chat or tool Provider catalogs");
  } finally { await h.close(); }
});

test("model choices leave resident runtimes intact while shared execution settings still refresh them", async context => {
  const h = await createFixture();
  try {
    await h.manager.setPermissionMode(h.project.id, "read-only");
    const internals = h.manager as unknown as {
      runtimes: Map<string, { runtime: { restartRuntime(sessionId?: string): Promise<unknown> } }>;
      idleRuntimeRebuildTail: Promise<void>;
    };
    const resident = internals.runtimes.get(h.project.id);
    assert.ok(resident);
    const restarts = context.mock.method(resident.runtime, "restartRuntime", resident.runtime.restartRuntime.bind(resident.runtime));
    const prepare = async (toolModel?: string, rtkEnabled?: boolean) => await h.manager.prepareSettingsConfig(h.project.id, {
      expectedPreferenceRevision: h.state.settingsPreferences().revision,
      expectedConfigRevision: await h.manager.settingsConfigRevision(h.project.id),
      models: toolModel === undefined ? undefined : { upserts: [], removeAliases: [], toolModel: { alias: toolModel } },
      rtkEnabled
    });
    const selection = await prepare("tool");
    await h.manager.commitSettingsConfig(selection, "model-only");
    await h.manager.finalizeSettingsConfig(h.project.id, "model-only");
    h.manager.settingsCommitted(selection);
    await internals.idleRuntimeRebuildTail;
    assert.equal(restarts.mock.callCount(), 0, "tool selection is read by the next turn and must not rebuild resident projects");
    assert.equal((await h.store.load()).toolModel, "tool");

    const shared = await prepare(undefined, !selection.after.agent.rtkEnabled);
    await h.manager.commitSettingsConfig(shared, "shared-setting");
    await h.manager.finalizeSettingsConfig(h.project.id, "shared-setting");
    h.manager.settingsCommitted(shared);
    await internals.idleRuntimeRebuildTail;
    assert.equal(restarts.mock.callCount(), 1, "shared execution settings retain their real Runtime refresh");
  } finally { await h.close(); }
});

test("tool and vision saves return confirmed selections without loading unrelated settings", async context => {
  const h = await createFixture();
  try {
    const transaction = new DesktopSettingsTransaction(h.state, h.manager);
    const base = await transaction.snapshot(h.project.id);
    const readMany = context.mock.method(h.catalogs, "readMany", h.catalogs.readMany.bind(h.catalogs));
    const snapshotRead = context.mock.method(h.manager, "settingsConfigSnapshot", h.manager.settingsConfigSnapshot.bind(h.manager));
    const input = {
      expectedPreferenceRevision: base.preferenceRevision,
      expectedConfigRevision: base.configRevision,
      models: { upserts: [], removeAliases: [], toolModel: { alias: "tool" } }
    };
    const result = await transaction.save(h.project.id, input);
    assert.equal(result.status, "committed");
    assert.equal(result.snapshot, undefined, "a local model choice does not need a complete settings snapshot");
    assert.ok(result.status === "committed" && result.modelSelection);
    assert.equal(result.modelSelection.configRevision, await h.manager.settingsConfigRevision(h.project.id));
    assert.deepEqual(result.modelSelection.models, { toolModel: "tool", visionModel: undefined, visionModelEnabled: false, resolvedToolModel: "tool" });
    assert.equal(snapshotRead.mock.callCount(), 0);
    assert.equal(readMany.mock.callCount(), 0);

    const vision = await transaction.save(h.project.id, { ...input,
      expectedConfigRevision: result.modelSelection.configRevision,
      models: { upserts: [], removeAliases: [], visionModel: { alias: "vision" } }
    });
    assert.ok(vision.status === "committed" && vision.modelSelection);
    assert.deepEqual(vision.modelSelection.models, { toolModel: "tool", visionModel: "vision", visionModelEnabled: true, resolvedToolModel: "tool" });
    assert.equal(snapshotRead.mock.callCount(), 0);
    assert.equal(readMany.mock.callCount(), 1, "only the target vision Provider requires catalog validation");

    const conflict = await transaction.save(h.project.id, input);
    assert.equal(conflict.status, "rolled_back");
    assert.equal(conflict.snapshot?.models.visionModel, "vision", "conflict recovery still returns full current settings");
    assert.equal((await h.store.load()).visionModel, "vision");

    const disabled = await transaction.save(h.project.id, { ...input,
      expectedConfigRevision: conflict.snapshot!.configRevision,
      models: { upserts: [], removeAliases: [], visionModel: { alias: undefined } }
    });
    assert.ok(disabled.status === "committed" && disabled.modelSelection);
    assert.equal(disabled.modelSelection.models.visionModel, undefined);
    const persisted = await h.store.load();
    assert.equal(persisted.visionModel, undefined, "显式清空选择仍可移除已保存的视觉模型");
    assert.equal(persisted.toolModel, "tool");
    assert.equal(persisted.defaultModel, "chat");
  } finally { await h.close(); }
});

test("vision toggle persists independently of its model without catalog reads or runtime restarts", async context => {
  const h = await createFixture();
  try {
    await h.manager.setPermissionMode(h.project.id, "read-only");
    const internals = h.manager as unknown as {
      runtimes: Map<string, { runtime: { restartRuntime(sessionId?: string): Promise<unknown> } }>;
      idleRuntimeRebuildTail: Promise<void>;
    };
    const resident = internals.runtimes.get(h.project.id)!;
    const restarts = context.mock.method(resident.runtime, "restartRuntime", resident.runtime.restartRuntime.bind(resident.runtime));
    const transaction = new DesktopSettingsTransaction(h.state, h.manager);
    const base = await transaction.snapshot(h.project.id);
    const selected = await transaction.save(h.project.id, { expectedPreferenceRevision: base.preferenceRevision,
      expectedConfigRevision: base.configRevision, models: { upserts: [], removeAliases: [], visionModel: { alias: "vision" } } });
    assert.ok(selected.status === "committed" && selected.modelSelection);
    let revision = selected.modelSelection.configRevision;
    const reads = context.mock.method(h.catalogs, "readMany", h.catalogs.readMany.bind(h.catalogs));
    const snapshots = context.mock.method(h.manager, "settingsConfigSnapshot", h.manager.settingsConfigSnapshot.bind(h.manager));
    for (const enabled of [false, true, false]) {
      const result = await transaction.save(h.project.id, { expectedPreferenceRevision: base.preferenceRevision,
        expectedConfigRevision: revision, models: { upserts: [], removeAliases: [], visionModelEnabled: enabled } });
      assert.ok(result.status === "committed" && result.modelSelection);
      revision = result.modelSelection.configRevision;
      assert.equal(result.modelSelection.models.visionModelEnabled, enabled);
      assert.equal(result.modelSelection.models.visionModel, "vision");
      const persisted = await h.store.load();
      assert.equal(persisted.visionModelEnabled, enabled);
      assert.equal(persisted.visionModel, "vision");
      assert.equal(persisted.defaultModel, "chat");
    }
    await internals.idleRuntimeRebuildTail;
    assert.equal(restarts.mock.callCount(), 0);
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(snapshots.mock.callCount(), 0);
    assert.equal((await transaction.snapshot(h.project.id)).models.visionModelEnabled, false);
  } finally { await h.close(); }
});

test("refreshing one Provider does not restore the other Provider catalogs", async context => {
  const requested: string[] = [];
  const h = await createFixture(async input => {
    requested.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: "new-tool" }] }), { headers: { "content-type": "application/json" } });
  });
  try {
    const readMany = context.mock.method(h.catalogs, "readMany", h.catalogs.readMany.bind(h.catalogs));
    const result = await h.manager.fetchModelCatalog(h.project.id, "tool-provider", true);
    assert.equal(result.source, "fetched");
    assert.ok(result.models.some(model => model.id === "new-tool"));
    assert.equal(requested.length, 1);
    assert.ok(requested[0]!.startsWith("https://tool-provider.invalid/"));
    assert.ok(readMany.mock.calls.flatMap(call => call.arguments[0]).every(key => key === "tool-provider" || key.startsWith("tool-provider::")),
      "refreshing a single Provider cannot read unrelated Provider catalogs");
  } finally { await h.close(); }
});

test("a failed model selection readback rolls back and retains the full recovery snapshot", async context => {
  const h = await createFixture();
  try {
    const transaction = new DesktopSettingsTransaction(h.state, h.manager);
    const base = await transaction.snapshot(h.project.id);
    const revision = h.manager.settingsConfigRevision.bind(h.manager);
    let reads = 0;
    context.mock.method(h.manager, "settingsConfigRevision", async (projectId: string) => {
      reads += 1;
      return reads === 2 ? "sha256:unconfirmed" : await revision(projectId);
    });
    const result = await transaction.save(h.project.id, {
      expectedPreferenceRevision: base.preferenceRevision,
      expectedConfigRevision: base.configRevision,
      models: { upserts: [], removeAliases: [], toolModel: { alias: "tool" } }
    });
    assert.equal(result.status, "rolled_back");
    assert.ok(result.status === "rolled_back");
    assert.match(result.message ?? "", /复读校验失败/u);
    assert.equal(result.snapshot.models.toolModel, undefined);
    assert.equal(result.snapshot.models.defaultModel, "chat");
    assert.equal((await h.store.load()).toolModel, undefined);
    assert.equal(await transaction.recoverAtStartup(), undefined, "a verified rollback removes the pending journal");
  } finally { await h.close(); }
});
