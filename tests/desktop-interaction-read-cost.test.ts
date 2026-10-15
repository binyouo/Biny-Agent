import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { FileModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";

async function fixture(run: (f: { root: string; projectId: string; state: DesktopStateStore; agents: DesktopAgentManager; models: FileModelsStore; catalogKey: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-interaction-read-cost-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  let agents: DesktopAgentManager | undefined;
  try {
    const userData = new DesktopUserDataStore(root); await userData.initialize();
    const state = new DesktopStateStore(path.join(root, "desktop.json")); await state.load();
    const configStore = createFileConfigStore(root, { globalDir: root, credentialStore: {
      persistent: true, get: async () => undefined, set: async () => {}, delete: async () => {}
    } });
    const config = structuredClone(defaultConfig);
    config.providers = { isolated: { type: "openai", apiKeyEnv: "BINY_READ_COST_UNUSED_KEY" } };
    config.models = { isolated: { provider: "isolated", model: "isolated" } };
    config.defaultModel = "isolated";
    await configStore.save(config);
    const projects = new DesktopProjectService(state, userData, configStore);
    const project = await projects.createProject(root);
    const models = new FileModelsStore(path.join(root, "models-store.json"));
    const catalogKey = modelCatalogCacheKey("isolated", (await configStore.load()).providers.isolated!);
    await models.write(catalogKey, {
      models: [{ id: "catalog-one", displayName: "Catalog One", provider: "openai", capabilities: {}, reasoningEfforts: [] }]
    });
    agents = new DesktopAgentManager(state, projects, configStore, () => {}, undefined, models);
    await run({ root, projectId: project.id, state, agents, models, catalogKey });
  } finally {
    await agents?.closeAll();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("单字段设置保存只为返回快照读取一次模型目录，仍复核版本并返回新目录", async () => {
  await fixture(async ({ projectId, state, agents, models, catalogKey }) => {
    const settings = new DesktopSettingsTransaction(state, agents);
    const initial = await settings.snapshot(projectId);
    let catalogReads = 0;
    const readMany = models.readMany.bind(models);
    models.readMany = async ids => { catalogReads += 1; return await readMany(ids); };
    const input = { expectedPreferenceRevision: initial.preferenceRevision, expectedConfigRevision: initial.configRevision, themePreference: "light" as const };
    const result = await settings.save(projectId, input);
    assert.equal(result.status, "committed");
    assert.equal(result.snapshot?.themePreference, "light");
    assert.equal(catalogReads, 1, "CAS 预检不能恢复全部模型目录");
    const current = await models.read(catalogKey);
    assert.ok(current);
    await models.write(catalogKey, {
      models: [{ id: "catalog-two", displayName: "Catalog Two", provider: "openai", capabilities: {}, reasoningEfforts: [] }]
    });
    catalogReads = 0;
    const conflict = await settings.save(projectId, input);
    assert.equal(conflict.status, "rolled_back");
    assert.equal(conflict.conflicts?.[0]?.segment, "preferences");
    assert.deepEqual(conflict.snapshot?.models.catalogs?.isolated?.map(model => model.id), ["catalog-two"], "不复用过期目录");
    assert.equal(catalogReads, 1);
  });
});

test("记忆统计仅查询活动事实元数据，不取出正文，归档与后续写入准确计数", async () => {
  await fixture(async ({ root, projectId, agents }) => {
    const storage = new MemoryStorage(root);
    try {
      await storage.writeEntry({ content: "Manual fact " + "x".repeat(8000), source: "manual" });
      await storage.writeEntry({ content: "Automatic fact", source: "conversation", threadId: "thread-one" });
      const archived = await storage.writeEntry({ content: "Archived fact", source: "manual" });
      await storage.archiveEntries([archived.entry!.id], "manual");
      const queries: string[] = [];
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql: string) { queries.push(sql); return prepare.call(this, sql); };
      try {
        const stats = await agents.memoryStats(projectId);
        assert.deepEqual(stats.memoryStats, { total: 2, manualAdded: 1, autoGenerated: 1 });
        assert.equal(stats.totalEntries, 2);
        assert.equal(stats.revision, (await storage.getOverview()).storeRevision);
        assert.ok(!queries.some(sql => /SELECT\s+(?:\*|[^;]*\bcontent\b)[\s\S]*\bFROM\s+memories\b/iu.test(sql)), "统计不能读取所有记忆正文");
      } finally { DatabaseSync.prototype.prepare = prepare; }
      await storage.writeEntry({ content: "Another manual fact", source: "manual" });
      assert.deepEqual((await agents.memoryStats(projectId)).memoryStats, { total: 3, manualAdded: 2, autoGenerated: 1 });
    } finally { storage.close(); }
  });
});


test("记忆统计保留缺省来源，空库返回当前版本，非法来源不伪装为成功", async () => {
  await fixture(async ({ root, projectId, agents }) => {
    const storage = new MemoryStorage(root);
    let database: DatabaseSync | undefined;
    try {
      assert.deepEqual(await storage.getStats(), { storeRevision: 0, total: 0, manualAdded: 0, autoGenerated: 0 });
      const written = await storage.writeEntry({ content: "A fact", source: "manual" });
      database = new DatabaseSync(path.join(root, "agent.sqlite"));
      database.prepare("UPDATE memories SET metadata = json_remove(metadata, '$.source') WHERE id = ?").run(written.entry!.id);
      assert.deepEqual((await agents.memoryStats(projectId)).memoryStats, { total: 1, manualAdded: 1, autoGenerated: 0 });
      database.prepare("UPDATE memories SET metadata = json_set(metadata, '$.source', 17) WHERE id = ?").run(written.entry!.id);
      await assert.rejects(agents.memoryStats(projectId), /Invalid memory source metadata/u);
      database.prepare("UPDATE memories SET metadata = ? WHERE id = ?").run("{broken", written.entry!.id);
      await assert.rejects(agents.memoryStats(projectId), /malformed JSON/u);
      database.prepare("UPDATE memories SET metadata = ? WHERE id = ?").run(JSON.stringify({ source: "manual", importance: 3, durability: "permanent" }), written.entry!.id);
      await storage.clearAll();
      const empty = await storage.getStats();
      assert.deepEqual(empty, { storeRevision: (await storage.getOverview()).storeRevision, total: 0, manualAdded: 0, autoGenerated: 0 });
      assert.ok(empty.storeRevision > 0, "清空后版本不能回到初始值");
    } finally { database?.close(); storage.close(); }
  });
});
