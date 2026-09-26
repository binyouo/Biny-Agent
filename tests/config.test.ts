import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadConfigFile, saveConfig, saveConfigFile } from "../src/config/loader.js";
import { migrateLegacyGlobalState } from "../src/config/globalStateMigration.js";
import { BINY_AGENT_DIR_ENV, globalAgentDir, globalConfigDir, globalConfigPath, globalModelsStorePath, globalPluginRoot, projectSessionsDir } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import {
  BINY_KEYCHAIN_SERVICE,
  deferredCredentialTransactionStatus,
  finalizeDeferredCredentialTransaction,
  loadStoredCredentials,
  MacKeychainCredentialStore,
  rollbackDeferredCredentialTransaction,
  providerCredentialAccount,
  saveConfigAndStoredCredentials
} from "../src/config/credentials.js";
import { resolveRunBudget } from "../src/agent/runBudget.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { loadProjectSettings, updateProjectSettings } from "../src/config/projectSettings.js";
import { ConfigRevisionConflictError, configDocumentRevision } from "../src/config/versioned.js";
import { migrateGlobalConfigDocument } from "../src/config/migrations.js";
import type { CredentialStore } from "../src/config/credentials.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";

await testGlobalPathResolution();
await testLegacyGlobalStateMigration();
testRunBudget();
testMemoryEmbeddingDefaultsToE5();
testEmotionStrippedAndHeartbeatDefaultsToDisabled();
testRemovedToolNamesAreNotMigrated();
testLegacySubagentDefaultMigration();
testRemovedModelFormatsRequireManualUpdate();
await testProjectOverridesAndGlobalPersistence();
await testConcurrentProjectSettingUpdates();
await testRemovedProjectBudgetFieldsAreRejected();
await testProjectCredentialFieldsAreRejected();
await testProjectModelAliasMustBeGlobal();
await testLegacyProjectConfigIsIgnored();
await testVersionedActivityEmbeddingFieldsMigrateToMemory();
await testRemovedMemoryPolicyFieldsAreIgnored();
await testVersionedGlobalConfigRejectsStaleWriters();
await testInlineCredentialsRequirePersistentStorage();
await testMcpCredentialReferencesStayOutOfConfig();
await testVersionedCredentialUpdatesRejectStaleWriters();
testConfigRevisionMatchesJsonRoundTrip();
await testConfigUpdatesRequireVersionedStore();
await testConfigUpdatesBindClassStoreMethods();
await testCredentialTransactionCompensatesPartialWrites();
await testDeferredCredentialTransactionKeepsRollbackLineage();
await testFileConfigStoreDeferredCredentialContract();
await testMacKeychainCredentialStore();
await testMacKeychainCredentialStoreCachesReads();

async function testGlobalPathResolution(): Promise<void> {
  const configured = path.join(os.tmpdir(), `biny-agent-${String(process.pid)}`);
  assert.equal(globalAgentDir({ env: { [BINY_AGENT_DIR_ENV]: configured }, homeDir: "/unused" }), configured);
  assert.equal(globalConfigPath({ env: { [BINY_AGENT_DIR_ENV]: configured }, homeDir: "/unused" }), path.join(configured, "config.json"));
  assert.equal(globalAgentDir({ env: {}, homeDir: "/tmp/biny-home" }), "/tmp/biny-home/.biny/agent");
  assert.equal(globalConfigDir({ env: {}, homeDir: "/tmp/biny-home" }), "/tmp/biny-home/.config/biny");
  assert.equal(globalConfigPath({ env: {}, homeDir: "/tmp/biny-home" }), "/tmp/biny-home/.config/biny/config.json");
  assert.equal(globalModelsStorePath({ env: {}, homeDir: "/tmp/biny-home" }), "/tmp/biny-home/.config/biny/models-store.json");
  assert.equal(globalPluginRoot({ env: {}, homeDir: "/tmp/biny-home" }), "/tmp/biny-home/.config/biny/plugins");
  assert.equal(globalConfigDir({ env: { [BINY_AGENT_DIR_ENV]: configured }, homeDir: "/unused" }), configured);
  const projectA = projectSessionsDir("/tmp/project-a", { env: { [BINY_AGENT_DIR_ENV]: configured } });
  const projectB = projectSessionsDir("/tmp/project-b", { env: { [BINY_AGENT_DIR_ENV]: configured } });
  assert.equal(path.dirname(projectA), path.join(configured, "sessions"));
  assert.notEqual(projectA, projectB);
  assert.equal(projectSessionsDir("/tmp/project-a", { env: { [BINY_AGENT_DIR_ENV]: configured } }), projectA);
}

function testRunBudget(): void {
  assert.deepEqual(resolveRunBudget(defaultConfig.agent), {
    softStepLimit: 32,
    hardStepLimit: 96,
    maxToolCalls: 512,
    maxRepeatedActions: 3
  });

  const configured = configSchema.parse({
    ...defaultConfig,
    agent: {
      ...defaultConfig.agent,
      softStepLimit: 12,
      hardStepLimit: 48,
      maxToolCalls: 200,
      maxRepeatedActions: 5
    }
  });
  assert.deepEqual(resolveRunBudget(configured.agent), {
    softStepLimit: 12,
    hardStepLimit: 48,
    maxToolCalls: 200,
    maxRepeatedActions: 5
  });
  assert.throws(() => configSchema.parse({
    ...defaultConfig,
    agent: { ...defaultConfig.agent, maxProviderRetries: 2 }
  }), /Unrecognized key/u);
}

function testEmotionStrippedAndHeartbeatDefaultsToDisabled(): void {
  const document = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  const context = document.context as Record<string, unknown>;
  context.emotion = { enabled: false, allowModelUpdate: false, autoAnalyze: false };
  // 遗留 heartbeat 对象（含未知键）落入新结构：未知键剥离，缺省键补默认值。
  document.heartbeat = { enabled: true, intervalMinutes: 45, legacyPrompt: "outdated" };
  const migrated = migrateGlobalConfigDocument(document).document;
  const parsed = configSchema.parse(migrated);
  assert.equal("emotion" in parsed.context, false);
  assert.deepEqual(parsed.heartbeat, { enabled: true, intervalMinutes: 45, activeHoursStart: 8, activeHoursEnd: 23 });

  const withoutHeartbeat = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  delete withoutHeartbeat.heartbeat;
  assert.deepEqual(configSchema.parse(withoutHeartbeat).heartbeat, {
    enabled: false,
    intervalMinutes: 30,
    activeHoursStart: 8,
    activeHoursEnd: 23
  });
}

function testRemovedToolNamesAreNotMigrated(): void {
  const document = structuredClone(defaultConfig) as unknown as Record<string, any>;
  document.permission.allowTools = ["read_file", "write_file", "multi_edit", "apply_patch", "Read"];
  document.extensions.subagent.allowedTools = ["read_file", "multi_edit", "apply_patch", "write_file"];

  const migrated = migrateGlobalConfigDocument(document).document;
  assert.deepEqual((migrated as Record<string, any>).permission.allowTools, document.permission.allowTools);
  assert.deepEqual((migrated as Record<string, any>).extensions.subagent.allowedTools, document.extensions.subagent.allowedTools);
  assert.throws(() => configSchema.parse(migrated), /Invalid enum value/u);
}

function testLegacySubagentDefaultMigration(): void {
  const versioned = structuredClone(defaultConfig) as unknown as Record<string, any>;
  delete versioned.extensions.subagent.enabled;
  const migratedVersioned = migrateGlobalConfigDocument(versioned).document as Record<string, any>;
  assert.equal(migratedVersioned.extensions.subagent.enabled, true);

  const explicitlyDisabled = structuredClone(defaultConfig) as unknown as Record<string, any>;
  const migratedDisabled = migrateGlobalConfigDocument(explicitlyDisabled).document as Record<string, any>;
  assert.equal(migratedDisabled.extensions.subagent.enabled, false);

  const unversioned = structuredClone(defaultConfig) as unknown as Record<string, any>;
  delete unversioned.format;
  delete unversioned.configVersion;
  delete unversioned.extensions.subagent.enabled;
  const migratedUnversioned = migrateGlobalConfigDocument(unversioned).document as Record<string, any>;
  assert.equal(migratedUnversioned.extensions.subagent.enabled, true);
}

async function testLegacyGlobalStateMigration(): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-migration-"));
  try {
    const legacyRoot = path.join(home, ".biny");
    const legacyAgentRoot = path.join(legacyRoot, "agent");
    const legacyIdentityRoot = path.join(legacyAgentRoot, "identity");
    await fs.mkdir(legacyIdentityRoot, { recursive: true });
    await fs.mkdir(path.join(legacyAgentRoot, "memory"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "config.json"), JSON.stringify(defaultConfig), "utf8");
    await fs.writeFile(path.join(legacyAgentRoot, "models-store.json"), JSON.stringify({ version: 2, providers: {} }), "utf8");
    await fs.writeFile(path.join(legacyAgentRoot, "SOUL.md"), "旧 Soul\n", "utf8");
    await fs.writeFile(path.join(legacyRoot, "SOUL.md"), "实验版旧 Soul\n", "utf8");
    await fs.writeFile(path.join(legacyIdentityRoot, "USER.md"), "旧用户资料\n", "utf8");
    await fs.writeFile(path.join(legacyAgentRoot, "memory", "2026-09-08.md"), "旧日报\n", "utf8");
    await fs.writeFile(path.join(legacyAgentRoot, "memory", "memory.sqlite"), "runtime state", "utf8");

    const result = await migrateLegacyGlobalState({ env: {}, homeDir: home });
    const targetRoot = path.join(home, ".config", "biny");
    assert.ok(result.moved.length >= 5);
    assert.equal(await fs.readFile(path.join(targetRoot, "config.json"), "utf8"), JSON.stringify(defaultConfig));
    assert.equal(await fs.readFile(path.join(targetRoot, "models-store.json"), "utf8"), JSON.stringify({ version: 2, providers: {} }));
    assert.equal(await fs.readFile(path.join(targetRoot, "SOUL.md"), "utf8"), "旧 Soul\n");
    assert.equal(await fs.readFile(path.join(legacyRoot, "SOUL.md"), "utf8"), "实验版旧 Soul\n");
    assert.equal(result.conflicts.filter((entry) => entry.endsWith(`${path.sep}SOUL.md`)).length, 1);
    assert.equal(await fs.readFile(path.join(targetRoot, "USER.md"), "utf8"), "旧用户资料\n");
    assert.equal(await fs.readFile(path.join(targetRoot, "memory", "2026-09-08.md"), "utf8"), "旧日报\n");
    assert.equal(await fs.readFile(path.join(legacyAgentRoot, "memory", "memory.sqlite"), "utf8"), "runtime state");
    await assert.rejects(fs.stat(path.join(legacyRoot, "config.json")), { code: "ENOENT" });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

function testMemoryEmbeddingDefaultsToE5(): void {
  const parsed = configSchema.parse({
    ...defaultConfig,
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, embeddingModel: undefined }
    }
  });
  assert.deepEqual(parsed.context.memory.embeddingModel, { kind: "auto" });
}

function testRemovedModelFormatsRequireManualUpdate(): void {
  assert.throws(
    () => configSchema.parse({ ...defaultConfig, model: { provider: "deepseek", model: "deepseek-chat" } }),
    (error: unknown) => error instanceof Error
      && /Unsupported model configuration/u.test(error.message)
      && /no longer auto-migrates/u.test(error.message)
      && /defaultModel/u.test(error.message)
      && /biny doctor/u.test(error.message)
  );
  assert.throws(
    () => configSchema.parse({
      ...defaultConfig,
      defaultModel: "legacy",
      models: { ...defaultConfig.models, legacy: { provider: "deepseek", model: "deepseek-reasoner" } }
    }),
    /model ID `deepseek-reasoner` was removed/u
  );
  assert.throws(
    () => configSchema.parse({
      ...defaultConfig,
      defaultModel: "legacy",
      models: { ...defaultConfig.models, legacy: { provider: "deepseek", model: "deepseek-v4-flash", thinking: { efforts: ["high"] } } }
    }),
    /model-level `thinking` field was removed; use `reasoning`/u
  );
}

async function testProjectOverridesAndGlobalPersistence(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-test-"));
  const globalRoot = path.join(root, "global");
  const workspace = path.join(root, "project");
  await fs.mkdir(workspace);
  try {
    await saveConfig(workspace, { ...defaultConfig, defaultModel: "deepseek-v4-pro" }, { globalDir: globalRoot });
    await fs.mkdir(path.join(workspace, ".biny"));
    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({
      format: "biny-project-settings",
      configVersion: 1,
      defaultModel: "deepseek-v4-flash",
      thinking: { enabled: false },
      agent: { softStepLimit: 2 },
      permission: { mode: "read-only" },
      context: {
        compaction: { reserveTokens: 2_048, keepRecentTokens: 8_192, maxSummaryTokens: 1_024 },
        memory: { maxRecalled: 1 }
      },
      sandbox: { mode: "workspace-write" }
    }));

    const effective = await loadConfig(workspace, { globalDir: globalRoot });
    assert.equal(effective.defaultModel, "deepseek-v4-flash");
    assert.equal(effective.thinking.enabled, false);
    assert.equal(effective.agent.softStepLimit, 2);
    assert.equal(effective.permission.mode, "full-access");
    assert.equal(effective.context.compaction.reserveTokens, 2_048);
    assert.equal(effective.context.compaction.keepRecentTokens, 8_192);
    assert.equal(effective.context.compaction.maxSummaryTokens, 1_024);
    assert.deepEqual(effective.context.identity, defaultConfig.context.identity);
    // 个性化和记忆策略只有 global + chat 两层；旧 project memory override 迁移后被移除。
    assert.equal(effective.context.memory.maxRecalled, defaultConfig.context.memory.maxRecalled);
    assert.equal(effective.sandbox.mode, "workspace-write");

    const changed = structuredClone(effective);
    changed.defaultModel = "deepseek-v4-pro";
    changed.permission.mode = "full-access";
    await saveConfig(workspace, changed, { globalDir: globalRoot });
    const global = await loadConfigFile(globalRoot);
    assert.equal(global.defaultModel, "deepseek-v4-pro");
    assert.equal(global.permission.mode, "full-access");
    assert.equal((await loadConfig(workspace, { globalDir: globalRoot })).defaultModel, "deepseek-v4-flash");
    assert.equal((await loadConfig(workspace, { globalDir: globalRoot })).permission.mode, "full-access");
    const projectDocument = JSON.parse(await fs.readFile(path.join(workspace, ".biny", "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(projectDocument.configVersion, 1, "read-only config loading must not rewrite project settings");
    assert.deepEqual(projectDocument.permission, { mode: "read-only" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testRemovedProjectBudgetFieldsAreRejected(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-project-budget-"));
  const globalRoot = path.join(root, "global");
  const workspace = path.join(root, "project");
  await fs.mkdir(path.join(workspace, ".biny"), { recursive: true });
  try {
    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({
      agent: {
        maxSteps: 2,
        maxTaskSteps: 10,
        maxAttempts: 7,
        maxCompletionContinuations: 3
      }
    }));
    await assert.rejects(
      loadConfig(workspace, { globalDir: globalRoot }),
      /Invalid project [\s\S]*Unrecognized key\(s\)/u
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testConcurrentProjectSettingUpdates(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-project-settings-lock-"));
  try {
    await Promise.all([
      updateProjectSettings(root, (current) => ({ ...current, defaultModel: "deepseek-v4-pro" })),
      updateProjectSettings(root, (current) => ({ ...current, agent: { ...current.agent, softStepLimit: 9 } }))
    ]);
    const current = await loadProjectSettings(root);
    assert.equal(current.defaultModel, "deepseek-v4-pro");
    assert.equal(current.agent?.softStepLimit, 9);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testProjectCredentialFieldsAreRejected(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-project-settings-"));
  const workspace = path.join(root, "project");
  await fs.mkdir(path.join(workspace, ".biny"), { recursive: true });
  try {
    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({
      providers: { leaked: { type: "openai", apiKey: "not-a-real-key" } }
    }));
    await assert.rejects(loadConfig(workspace, { globalDir: path.join(root, "global") }), /Unrecognized key|Invalid project/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testProjectModelAliasMustBeGlobal(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-project-model-"));
  const workspace = path.join(root, "project");
  const globalRoot = path.join(root, "global");
  await fs.mkdir(path.join(workspace, ".biny"), { recursive: true });
  try {
    await saveConfig(workspace, defaultConfig, { globalDir: globalRoot });
    await fs.writeFile(path.join(workspace, ".biny", "settings.json"), JSON.stringify({ defaultModel: "project-only" }));
    await assert.rejects(loadConfig(workspace, { globalDir: globalRoot }), /Project defaultModel.*not configured in global/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testLegacyProjectConfigIsIgnored(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-legacy-config-"));
  const workspace = path.join(root, "project");
  const globalRoot = path.join(root, "global");
  await fs.mkdir(workspace);
  try {
    await saveConfigFile(globalRoot, defaultConfig);
    await saveConfigFile(workspace, { ...defaultConfig, defaultModel: "deepseek-v4-pro" });
    assert.equal((await loadConfig(workspace, { globalDir: globalRoot })).defaultModel, defaultConfig.defaultModel);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVersionedGlobalConfigRejectsStaleWriters(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-cas-"));
  const workspace = path.join(root, "project");
  const globalRoot = path.join(root, "global");
  await fs.mkdir(workspace);
  const credentialStore: CredentialStore = {
    persistent: false,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  };
  try {
    const firstStore = createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore });
    const secondStore = createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore });
    const firstLoad = firstStore.loadVersioned;
    const firstSave = firstStore.saveVersioned;
    const secondLoad = secondStore.loadVersioned;
    const secondSave = secondStore.saveVersioned;
    if (!firstLoad || !firstSave || !secondLoad || !secondSave) throw new Error("Versioned config store API is unavailable.");
    const first = await firstLoad();
    const second = await secondLoad();

    await firstSave(structuredClone(first.config), first.revision);

    const stale = structuredClone(second.config);
    stale.providers.deepseek!.apiKey = "stale-secret";
    await assert.rejects(
      secondSave(stale, second.revision),
      (error: unknown) => error instanceof ConfigRevisionConflictError
    );
    assert.ok((await firstLoad()).config.context.memory, "memory config section should exist");
    await assert.rejects(fs.access(path.join(globalRoot, ".config.write.lock")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVersionedCredentialUpdatesRejectStaleWriters(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-credential-cas-"));
  const workspace = path.join(root, "project");
  const globalRoot = path.join(root, "global");
  const values = new Map<string, string>();
  const credentialStore: CredentialStore = {
    persistent: true,
    get: async (account) => values.get(account),
    set: async (account, value) => { values.set(account, value); },
    delete: async (account) => { values.delete(account); }
  };
  try {
    await fs.mkdir(workspace);
    const firstStore = createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore });
    const secondStore = createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore });
    const first = await firstStore.loadVersioned!();
    const stale = await secondStore.loadVersioned!();
    const target = structuredClone(first.config);
    target.providers.deepseek!.apiKey = "first-secret";
    await firstStore.saveVersioned!(target, first.revision);
    assert.equal(values.get(providerCredentialAccount("deepseek", "apiKey")), "first-secret");

    const staleTarget = structuredClone(stale.config);
    staleTarget.providers.deepseek!.apiKey = "stale-secret";
    await assert.rejects(
      secondStore.saveVersioned!(staleTarget, stale.revision),
      (error: unknown) => error instanceof ConfigRevisionConflictError
    );
    assert.equal((await firstStore.loadVersioned!()).config.providers.deepseek?.apiKey, "first-secret");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testInlineCredentialsRequirePersistentStorage(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-inline-credential-"));
  const workspace = path.join(root, "project");
  const globalRoot = path.join(root, "global");
  const credentialStore: CredentialStore = {
    persistent: false,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  };
  try {
    await fs.mkdir(workspace);
    await fs.mkdir(globalRoot);
    const document = structuredClone(defaultConfig);
    document.providers.deepseek!.apiKey = "inline-test-secret";
    await fs.writeFile(path.join(globalRoot, "config.json"), `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await assert.rejects(
      createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore }).load(),
      /apiKeyEnv/u
    );
    assert.equal((await fs.readFile(path.join(globalRoot, "config.json"), "utf8")).includes("inline-test-secret"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testMcpCredentialReferencesStayOutOfConfig(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-mcp-credentials-"));
  const journalPath = path.join(root, ".credentials.transaction.json");
  const values = new Map<string, string>();
  const store: CredentialStore = {
    persistent: true,
    get: async (account) => values.get(account),
    set: async (account, value) => { values.set(account, value); },
    delete: async (account) => { values.delete(account); }
  };
  const previous = structuredClone(defaultConfig);
  const target = structuredClone(defaultConfig);
  target.extensions.mcp = {
    "demo-server": {
      id: "11111111-1111-4111-8111-111111111111",
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { DEMO_TOKEN: "mcp-inline-secret" },
      credentialRefs: { env: { DEMO_TOKEN: "mcp:demo-server:env:DEMO_TOKEN" } },
      enabled: true,
      stderr: "ignore"
    }
  };
  let persisted = structuredClone(previous);
  try {
    await saveConfigAndStoredCredentials(
      target,
      previous,
      store,
      journalPath,
      async () => {
        await saveConfigFile(root, target);
        persisted = await loadConfigFile(root);
      },
      async () => persisted
    );
    assert.equal(values.get("mcp:demo-server:env:DEMO_TOKEN"), "mcp-inline-secret");
    const document = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(JSON.stringify(document).includes("mcp-inline-secret"), false);
    assert.equal(configDocumentRevision(target), configDocumentRevision(persisted));
    const restored = await loadStoredCredentials(persisted, store);
    assert.equal(restored.extensions.mcp["demo-server"]?.env?.DEMO_TOKEN, "mcp-inline-secret");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function testConfigRevisionMatchesJsonRoundTrip(): void {
  const explicitUndefined = structuredClone(defaultConfig);
  explicitUndefined.providers.deepseek = {
    ...explicitUndefined.providers.deepseek!,
    headers: undefined,
    embeddingModels: undefined
  };
  const persistedShape = JSON.parse(JSON.stringify(explicitUndefined)) as typeof explicitUndefined;
  assert.equal(configDocumentRevision(explicitUndefined), configDocumentRevision(persistedShape));

  const searchCredential = structuredClone(defaultConfig);
  searchCredential.providers.deepseek!.apiKey = "test-only-search-key";
  const searchDocument = structuredClone(searchCredential);
  delete searchDocument.providers.deepseek!.apiKey;
  assert.equal(configDocumentRevision(searchCredential), configDocumentRevision(searchDocument));
}

async function testConfigUpdatesRequireVersionedStore(): Promise<void> {
  await assert.rejects(
    updateConfig({
      load: async () => structuredClone(defaultConfig),
      save: async () => undefined
    }, undefined, (current) => current),
    /require a versioned config store/u
  );
}

async function testConfigUpdatesBindClassStoreMethods(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-class-store-"));
  const credentials: CredentialStore = {
    persistent: false,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  };
  try {
    const store = new DesktopConfigStore(root, credentials);
    await store.save(structuredClone(defaultConfig), root);
    const updated = await updateConfig(store, root, (current) => ({
      ...current,
      permission: { ...current.permission, mode: "full-access" }
    }));
    assert.equal(updated.permission.mode, "full-access");
    assert.equal((await store.load(root)).permission.mode, "full-access");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCredentialTransactionCompensatesPartialWrites(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-credential-transaction-"));
  const journalPath = path.join(root, ".credentials.transaction.json");
  const providerAccount = providerCredentialAccount("deepseek", "apiKey");
  const values = new Map<string, string>([
    ["web-search:apiKey", "old-web-secret"],
    [providerAccount, "old-provider-secret"]
  ]);
  let failProviderWrite = true;
  const store: CredentialStore = {
    persistent: true,
    get: async (account) => values.get(account),
    set: async (account, value) => {
      if (account === providerAccount && value === "new-provider-secret" && failProviderWrite) {
        failProviderWrite = false;
        throw new Error("injected Keychain failure");
      }
      values.set(account, value);
    },
    delete: async (account) => {
      values.delete(account);
    }
  };
  const previous = structuredClone(defaultConfig);
  previous.providers.deepseek!.apiKey = "old-provider-secret";
  const next = structuredClone(previous);
  next.providers.deepseek!.apiKey = "new-provider-secret";

  try {
    await assert.rejects(
      saveConfigAndStoredCredentials(
        next,
        previous,
        store,
        journalPath,
        async () => assert.fail("config must not be persisted after a partial Keychain write"),
        async () => previous
      ),
      /injected Keychain failure/u
    );
    assert.equal(values.get("web-search:apiKey"), "old-web-secret");
    assert.equal(values.get(providerAccount), "old-provider-secret");
    assert.equal([...values.keys()].some((account) => account.startsWith("settings-tx:")), false);
    await assert.rejects(fs.access(journalPath), /ENOENT/u);

    await assert.rejects(
      saveConfigAndStoredCredentials(
        next,
        previous,
        store,
        journalPath,
        async () => {
          const journal = await fs.readFile(journalPath, "utf8");
          assert.equal(journal.includes("old-provider-secret"), false);
          assert.equal(journal.includes("new-provider-secret"), false);
          throw new Error("injected config failure");
        },
        async () => previous
      ),
      /injected config failure/u
    );
    assert.equal(values.get("web-search:apiKey"), "old-web-secret");
    assert.equal(values.get(providerAccount), "old-provider-secret");
    assert.equal([...values.keys()].some((account) => account.startsWith("settings-tx:")), false);
    await assert.rejects(fs.access(journalPath), /ENOENT/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testDeferredCredentialTransactionKeepsRollbackLineage(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-deferred-credential-transaction-"));
  const journalPath = path.join(root, ".credentials.transaction.json");
  const account = providerCredentialAccount("deepseek", "apiKey");
  const values = new Map<string, string>([[account, "before-secret"]]);
  const store: CredentialStore = {
    persistent: true,
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    }
  };
  const before = structuredClone(defaultConfig);
  before.providers.deepseek!.apiKey = "before-secret";
  const target = structuredClone(before);
  target.providers.deepseek!.apiKey = "target-secret";
  let document = structuredClone(before);

  try {
    await saveConfigAndStoredCredentials(
      target,
      before,
      store,
      journalPath,
      async () => {
        document = structuredClone(target);
      },
      async () => document,
      { deferredFor: "outer-rollback" }
    );
    assert.equal(values.get(account), "target-secret");
    assert.equal(
      await deferredCredentialTransactionStatus(store, journalPath, async () => document, "outer-rollback"),
      "target",
      "inner marker proves the credential-only commit although beforeRevision equals targetRevision"
    );
    const pendingJournal = await fs.readFile(journalPath, "utf8");
    assert.equal(pendingJournal.includes("before-secret"), false);
    assert.equal(pendingJournal.includes("target-secret"), false);
    assert.equal([...values.keys()].some((key) => key.startsWith("settings-tx:")), true);

    await rollbackDeferredCredentialTransaction(
      store,
      journalPath,
      async () => document,
      "outer-rollback",
      async () => {
        document = structuredClone(before);
      }
    );
    assert.equal(values.get(account), "before-secret");
    assert.equal([...values.keys()].some((key) => key.startsWith("settings-tx:")), false);
    await assert.rejects(fs.access(journalPath), /ENOENT/u);

    await saveConfigAndStoredCredentials(
      target,
      before,
      store,
      journalPath,
      async () => {
        document = structuredClone(target);
      },
      async () => document,
      { deferredFor: "outer-finalize" }
    );
    await finalizeDeferredCredentialTransaction(store, journalPath, async () => document, "outer-finalize");
    assert.equal(values.get(account), "target-secret");
    assert.equal([...values.keys()].some((key) => key.startsWith("settings-tx:")), false);
    await assert.rejects(fs.access(journalPath), /ENOENT/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testFileConfigStoreDeferredCredentialContract(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-deferred-config-store-"));
  const workspace = path.join(root, "workspace");
  const globalRoot = path.join(root, "global");
  const account = providerCredentialAccount("deepseek", "apiKey");
  const values = new Map<string, string>();
  const credentialStore: CredentialStore = {
    persistent: true,
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    }
  };
  try {
    await fs.mkdir(workspace);
    const store = createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore });
    const loadVersioned = store.loadVersioned;
    const saveDeferred = store.saveVersionedDeferred;
    const status = store.deferredCredentialStatus;
    const finalize = store.finalizeDeferredCredentials;
    const rollback = store.rollbackVersionedDeferred;
    if (!loadVersioned || !saveDeferred || !status || !finalize || !rollback) {
      throw new Error("Deferred credential transaction API is unavailable.");
    }
    const before = await loadVersioned();
    const target = structuredClone(before.config);
    target.providers.deepseek!.apiKey = "deferred-store-target";
    const saved = await saveDeferred(target, before.revision, "store-rollback");
    assert.notEqual(saved.revision, before.revision, "credential updates advance the opaque credential revision");
    assert.equal(await status("store-rollback"), "target");
    assert.equal(values.get(account), "deferred-store-target");
    assert.equal(await rollback(before.config, saved.revision, "store-rollback"), "completed");
    assert.equal(values.get(account), undefined);

    await saveDeferred(target, before.revision, "store-finalize");
    assert.equal(await status("store-finalize"), "target");
    await finalize("store-finalize");
    assert.equal(values.get(account), "deferred-store-target");
    await assert.rejects(fs.access(path.join(globalRoot, ".credentials.transaction.json")), /ENOENT/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testMacKeychainCredentialStore(): Promise<void> {
  const values = new Map<string, string>();
  const calls: Array<{ command: string; args: string[] }> = [];
  const store = new MacKeychainCredentialStore(async (command, args, input) => {
    calls.push({ command, args });
    const account = args[args.indexOf("-a") + 1]!;
    if (command === "security" && args[0] === "find-generic-password") {
      const value = values.get(account);
      if (!value) throw Object.assign(new Error("missing"), { code: 44 });
      return { stdout: `${value}\n` };
    }
    if (args[0] === "add-generic-password") values.set(account, input?.trim() ?? "");
    if (args[0] === "delete-generic-password") values.delete(account);
    return { stdout: "" };
  });

  await store.set("provider:openai:apiKey", "test-secret");
  assert.equal(await store.get("provider:openai:apiKey"), "test-secret");
  await store.delete("provider:openai:apiKey");
  assert.equal(await store.get("provider:openai:apiKey"), undefined);
  assert.ok(calls.every((call) => call.args.includes("-s") && call.args[call.args.indexOf("-s") + 1] === BINY_KEYCHAIN_SERVICE));
  const addCall = calls.find((call) => call.args[0] === "add-generic-password");
  assert.equal(addCall?.args.at(-1), "-w");
  assert.equal(addCall?.args.includes("test-secret"), false);
}

async function testMacKeychainCredentialStoreCachesReads(): Promise<void> {
  const values = new Map<string, string>([["provider:cached:apiKey", "cached-secret"]]);
  let findCalls = 0;
  const store = new MacKeychainCredentialStore(async (_command, args, input) => {
    const account = args[args.indexOf("-a") + 1]!;
    if (args[0] === "find-generic-password") {
      findCalls += 1;
      const value = values.get(account);
      if (!value) throw Object.assign(new Error("missing"), { code: 44 });
      return { stdout: `${value}\n` };
    }
    if (args[0] === "add-generic-password") values.set(account, input?.trim() ?? "");
    if (args[0] === "delete-generic-password") values.delete(account);
    return { stdout: "" };
  });

  // 第一次读会 fork security；之后命中进程内缓存，不再产生子进程——这是设置保存提速的关键。
  assert.equal(await store.get("provider:cached:apiKey"), "cached-secret");
  assert.equal(await store.get("provider:cached:apiKey"), "cached-secret");
  assert.equal(await store.get("provider:cached:apiKey"), "cached-secret");
  assert.equal(findCalls, 1, "重复读取同一 account 必须命中缓存，不应重复 fork security");

  // set/delete 之后缓存同步，下一读反映最新值。
  await store.set("provider:cached:apiKey", "rotated-secret");
  assert.equal(await store.get("provider:cached:apiKey"), "rotated-secret");
  assert.equal(findCalls, 1, "set 之后应直接命中更新后的缓存");
  await store.delete("provider:cached:apiKey");
  assert.equal(await store.get("provider:cached:apiKey"), undefined);
}

async function testVersionedActivityEmbeddingFieldsMigrateToMemory(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-activity-embedding-"));
  try {
    // 复刻历史文件形态：配置已版本化，但嵌入字段还留在 activity.*（版本门内迁移够不到）。
    const document = JSON.parse(JSON.stringify(defaultConfig)) as Record<string, any>;
    document.format = "biny-config";
    document.configVersion = 1;
    delete document.context.memory.embeddingModel;
    delete document.context.memory.cloudEmbeddingConsents;
    const consents = { "alias@endpoint-hash": { endpointHash: "0123456789abcdef", confirmedAt: "2026-08-27T09:00:00.000Z" } };
    document.activity.embeddingModel = { kind: "local", model: "paraphrase-multilingual-MiniLM-L12-v2" };
    document.activity.embeddingConsents = consents;
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(document, null, 2) + "\n", "utf8");

    const loaded = await loadConfigFile(root);
    assert.equal("embeddingConsents" in (loaded.activity as Record<string, unknown>), false, "activity 段的嵌入字段必须被清除");
    assert.equal("cloudEmbeddingConsents" in loaded.context.memory, false);
    assert.deepEqual(loaded.context.memory.embeddingModel, { kind: "auto" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testRemovedMemoryPolicyFieldsAreIgnored(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-removed-memory-fields-"));
  try {
    const document = JSON.parse(JSON.stringify(defaultConfig)) as Record<string, any>;
    document.format = "biny-config";
    document.configVersion = 1;
    document.context.memory.telos = {
      enabled: true,
      autoObserve: false,
      driftDetection: true,
      proactivePrompts: false
    };
    // 旧版记忆策略的向量生命周期字段（806cb2d 前的 schema）仍可能留在存量配置里。
    document.context.memory.similarityThresholds = { memory: 0.2, activity: 0.3 };
    document.context.memory.dedupAcrossUserIds = false;
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(document, null, 2) + "\n", "utf8");

    const loaded = await loadConfigFile(root);
    const memory = loaded.context.memory as Record<string, unknown>;
    assert.equal("telos" in memory, false);
    assert.equal("similarityThresholds" in memory, false);
    assert.equal("dedupAcrossUserIds" in memory, false);
    assert.equal(loaded.context.memory.enabled, defaultConfig.context.memory.enabled);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
