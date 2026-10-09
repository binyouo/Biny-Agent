import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/index.js";
import { readSessionCatalogRecord, sessionCatalogRecordRevision } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { ensureAgentDirs } from "../src/session/store.js";

test("cold chat memory toggle persists without model credentials or Runtime; status-only reads did not cover writes", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cold-chat-memory-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  let agents: DesktopAgentManager | undefined;
  let conversation: AgentSession | undefined;
  try {
    const userData = new DesktopUserDataStore(root); await userData.initialize();
    const state = new DesktopStateStore(path.join(root, "desktop.json")); await state.load();
    const configStore = createFileConfigStore(root, { globalDir: root });
    configStore.supportsDetachedRuntimeHost = false;
    const config = structuredClone(defaultConfig);
    config.providers = { isolated: { type: "openai", apiKeyEnv: "BINY_MEMORY_TOGGLE_UNCONFIGURED_KEY" } };
    config.models = { isolated: { provider: "isolated", model: "isolated" } };
    config.defaultModel = "isolated";
    config.permission.mode = "full-access";
    await configStore.save(config);
    const initialConfig = await configStore.load();
    const projects = new DesktopProjectService(state, userData, configStore);
    const project = await projects.createProject(root);
    const dataRoot = await projects.dataRoot(project);
    const recorder = new SessionRecorder(dataRoot, "cold-chat-memory");
    recorder.record({ type: "user_message", content: "Keep this conversation intact" });
    await recorder.close();
    const transcript = await readFile(recorder.filePath, "utf8");
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const document = await agents.openSession(project.id, recorder.sessionId);
    const requests: string[] = [];
    const model: AgentModel = {
      provider: "test", modelId: "test",
      async stream(context) {
        requests.push(context.systemPrompt ?? "");
        return (async function* () {
          yield { type: "text-delta" as const, text: "Done" };
          yield { type: "finish" as const, reason: "stop" as const };
        })();
      }
    };
    conversation = new AgentSession({
      workspaceRoot: project.path, persistenceRoot: dataRoot, config: initialConfig, configStore, model,
      recorder: new SessionRecorder(dataRoot, recorder.sessionId), toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager(initialConfig.permission)
    });
    await conversation.initialize();
    assert.equal((await conversation.getPersonalizationState()).resolved.useMemories, true);
    const disabled = { useMemories: false, contributeMemories: false };
    const saved = await agents.saveChatPersonalization(project.id, recorder.sessionId, disabled, document.session.metadataRevision);
    const record = await readSessionCatalogRecord(dataRoot, recorder.sessionId);
    assert.ok(record);
    assert.deepEqual(record.personalization, disabled);
    assert.deepEqual(saved.sessions.find(session => session.id === recorder.sessionId)?.personalization, disabled);
    assert.equal(saved.runtime, undefined);
    assert.equal(saved.permissionMode, "full-access");
    assert.equal(await readFile(recorder.filePath, "utf8"), transcript);
    assert.deepEqual(await configStore.load(), initialConfig);
    await projects.updateSessionMetadata(project, recorder.sessionId, { title: "Changed elsewhere" });
    await assert.rejects(agents.saveChatPersonalization(project.id, recorder.sessionId,
      { useMemories: true, contributeMemories: true }, sessionCatalogRecordRevision(record)), /Session catalog revision conflict/u);
    const afterConflict = await readSessionCatalogRecord(dataRoot, recorder.sessionId);
    assert.equal(afterConflict?.title, "Changed elsewhere");
    assert.deepEqual(afterConflict?.personalization, disabled);
    const stages: string[] = [];
    for await (const event of conversation.prompt("Reply without retrieving or contributing memories")) {
      if (event.type === "preparation.updated") stages.push(event.stage);
    }
    assert.equal((await conversation.contextStatus()).memoryEnabled, false);
    assert.ok(!stages.includes("memory"));
    assert.equal((await conversation.getPersonalizationState()).resolved.contributeMemories, false);
    await conversation.close();
    conversation = undefined;
    assert.equal(requests.length, 1, "a disabled conversation must not make extraction or query-rewrite model requests, including queued work");
  } finally {
    await conversation?.close();
    await agents?.closeAll();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("re-enabling memory contributes only opted-in turns; a disabled-only turn did not cover later history backfill", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-opt-in-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  let conversation: AgentSession | undefined;
  const storage = new CrystalStorage({ agentDir: root });
  try {
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    const extracted: string[] = [];
    const model: AgentModel = {
      provider: "test", modelId: "test",
      async stream(context) {
        const extracting = context.systemPrompt?.startsWith("你是一个称呼抽取器") === true;
        const content = context.messages.at(-1)?.content;
        const input = typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
        if (extracting) extracted.push(input);
        return (async function* () {
          yield { type: "text-delta" as const, text: extracting ? JSON.stringify([input]) : "Done" };
          yield { type: "finish" as const, reason: "stop" as const };
        })();
      }
    };
    conversation = new AgentSession({
      workspaceRoot: root, config, model, recorder: new SessionRecorder(root, "memory-opt-in"),
      toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission)
    });
    await conversation.initialize();
    await conversation.updateChatPersonalization({ useMemories: false, contributeMemories: false },
      (await conversation.getPersonalizationState()).catalogRevision);
    assert.equal((await conversation.runTask("PrivateTopic")).status, "completed");
    await conversation.updateChatPersonalization({ contributeMemories: true },
      (await conversation.getPersonalizationState()).catalogRevision);
    assert.equal((await conversation.runTask("PublicTopicOne")).status, "completed");
    assert.equal((await conversation.runTask("PublicTopicTwo")).status, "completed");
    await conversation.close();
    conversation = undefined;
    assert.deepEqual(extracted.sort(), ["PublicTopicOne", "PublicTopicTwo"]);
    await storage.initialize();
    assert.deepEqual(storage.listTerms().map(term => term.term).sort(), ["publictopicone", "publictopictwo"]);
  } finally {
    await conversation?.close();
    storage.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

for (const query of ["index", "sleep"] as const) test(`cold memory ${query} reads persisted state without launching a runtime`, { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cold-memory-"));
  const previous = process.env.BINY_AGENT_DIR;
  const previousEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  process.env.BINY_AGENT_DIR = root;
  process.env.BINY_RUNTIME_HOST_ENTRY = path.join(root, "missing-host.js");
  let agents: DesktopAgentManager | undefined;
  let storage: MemoryStorage | undefined;
  try {
    const userData = new DesktopUserDataStore(root); await userData.initialize();
    const state = new DesktopStateStore(path.join(root, "desktop.json")); await state.load();
    const configStore = createFileConfigStore(root, { globalDir: root, credentialStore: {
      persistent: true, get: async () => undefined, set: async () => undefined, delete: async () => undefined
    } });
    const config = structuredClone(defaultConfig);
    config.providers = { isolated: { type: "openai", apiKeyEnv: "BINY_COLD_TEST_UNUSED_KEY" } };
    config.models = { isolated: { provider: "isolated", model: "isolated" } };
    config.defaultModel = "isolated";
    config.context.memory.embeddingModel = { kind: "local", model: "multilingual-e5-small" };
    await configStore.save(config);
    const projects = new DesktopProjectService(state, userData, configStore);
    const project = await projects.createProject(root);
    storage = new MemoryStorage(root);
    await storage.writeEntry({ content: "A durable local fact", source: "manual", importance: 3 });
    const entries = await storage.listEntries();
    const localManager = new LocalEmbeddingManager(path.join(root, "models", "embeddings"));
    const descriptor = (await localManager.list())[0]!.descriptor;
    const index = new MemoryVectorIndex(root);
    try {
      index.replaceAll(descriptor.fingerprint, 3, entries.entries.map(entry => ({ entryId: entry.id, revision: entry.revision, embedding: [1, 0, 0] })));
    } finally { index.close(); }
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    if (query === "index") {
      const status = await agents.memoryEmbeddingStatus(project.id);
      assert.equal(status.totalEntries, 1);
      assert.equal(status.indexedEntries, 1, "existing vectors must not be reported as pending in a cold project");
      assert.equal(status.pendingEntries, 0);
      await storage.writeEntry({ content: "Another fact without a vector", source: "manual", importance: 3 });
      assert.equal((await agents.memoryEmbeddingStatus(project.id)).pendingEntries, 1);
    } else {
      assert.deepEqual(await agents.memorySleepStatus(project.id), await storage.readMaintenanceStatus());
      assert.deepEqual(await agents.memorySleepRuns(project.id), []);
    }
  } finally {
    await agents?.closeAll();
    storage?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    if (previousEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY; else process.env.BINY_RUNTIME_HOST_ENTRY = previousEntry;
    await rm(root, { recursive: true, force: true });
  }
});

for (const storeState of ["populated", "empty"] as const) test(`cold memory settings requests read ${storeState === "populated" ? "a populated" : "an empty"} store without initializing a runtime`, { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cold-memory-settings-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  let agents: DesktopAgentManager | undefined;
  let storage: MemoryStorage | undefined;
  try {
    const userData = new DesktopUserDataStore(root); await userData.initialize();
    const state = new DesktopStateStore(path.join(root, "desktop.json")); await state.load();
    const configStore = createFileConfigStore(root, { globalDir: root, credentialStore: {
      persistent: true, get: async () => undefined, set: async () => undefined, delete: async () => undefined
    } });
    const config = structuredClone(defaultConfig);
    config.providers = { isolated: { type: "openai", apiKeyEnv: "BINY_COLD_TEST_UNUSED_KEY" } };
    config.models = { isolated: { provider: "isolated", model: "isolated" } };
    config.defaultModel = "isolated";
    config.context.memory.embeddingModel = { kind: "local", model: "multilingual-e5-small" };
    await configStore.save(config);
    const projects = new DesktopProjectService(state, userData, configStore);
    const project = await projects.createProject(root);
    storage = new MemoryStorage(root);
    let finalId: string | undefined;
    let sourceArchiveId: string | undefined;
    let manualArchiveId: string | undefined;
    if (storeState === "populated") {
      const final = await storage.writeEntry({ content: "Current durable fact", source: "manual" });
      const intermediate = await storage.writeEntry({ content: "Earlier durable fact", source: "manual" });
      const source = await storage.writeEntry({ content: "Oldest durable fact", source: "manual" });
      const manual = await storage.writeEntry({ content: "Manually archived fact", source: "manual" });
      assert.ok(final.entry && intermediate.entry && source.entry && manual.entry);
      finalId = final.entry.id;
      await storage.archiveEntries([intermediate.entry.id], "llm_merge", {
        mergedInto: finalId, now: new Date("2030-01-01T00:00:00.000Z")
      });
      const manualArchive = await storage.archiveEntries([manual.entry.id], "manual", {
        now: new Date("2030-01-01T00:00:01.000Z")
      });
      const sourceArchive = await storage.archiveEntries([source.entry.id], "llm_merge", {
        mergedInto: intermediate.entry.id, now: new Date("2030-01-01T00:00:02.000Z")
      });
      assert.ok(sourceArchive.entries[0] && manualArchive.entries[0]);
      sourceArchiveId = sourceArchive.entries[0].id;
      manualArchiveId = manualArchive.entries[0].id;
    }
    // 配置快照仍能只读；只有 Runtime 初始化使用的公开 load 边界被拒绝。
    configStore.load = async () => { throw new Error("Cold settings reads must not initialize a Runtime Host."); };
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const [stats, entries, sleep, runs, archive, embedding] = await Promise.all([
      agents.memoryStats(project.id),
      agents.memoryEntries(project.id, 0, 20),
      agents.memorySleepStatus(project.id),
      agents.memorySleepRuns(project.id),
      agents.archivedMemoryEntries(project.id, 0, 25, true),
      agents.memoryEmbeddingStatus(project.id)
    ]);
    const activeTotal = storeState === "populated" ? 1 : 0;
    const archiveTotal = storeState === "populated" ? 3 : 0;
    assert.equal(stats.totalEntries, activeTotal);
    assert.equal(stats.memoryStats.manualAdded, activeTotal);
    assert.equal(entries.total, activeTotal);
    assert.equal(entries.entries.length, activeTotal);
    assert.deepEqual(sleep, await storage.readMaintenanceStatus());
    assert.deepEqual(runs, []);
    assert.equal(embedding.totalEntries, activeTotal);
    assert.equal(archive.total, archiveTotal);
    assert.equal(archive.entries.length, archiveTotal);
    assert.equal(archive.offset, 0);
    assert.equal(archive.limit, 25);
    if (sourceArchiveId) {
      assert.equal(archive.entries[0]?.id, sourceArchiveId);
      assert.deepEqual(archive.chains?.[sourceArchiveId], { finalId, depth: 1 });
    } else assert.equal(archive.chains, undefined);
    const secondPage = await agents.archivedMemoryEntries(project.id, 1, 1);
    assert.equal(secondPage.total, archiveTotal);
    assert.deepEqual(secondPage.entries.map(entry => entry.id), manualArchiveId ? [manualArchiveId] : []);
    assert.equal(secondPage.chains, undefined);
    assert.equal((await agents.archivedMemoryEntries(project.id, 0, 1_000)).chains, undefined);
    await assert.rejects(agents.archivedMemoryEntries(project.id, 0, 26, true), /每页至多 25 条/);
  } finally {
    await agents?.closeAll();
    storage?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
