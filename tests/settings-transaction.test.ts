import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigRevisionConflictError, configDocumentRevision } from "../src/config/versioned.js";
import { defaultConfig } from "../src/config/schema.js";
import { SessionCatalogConflictError, type SessionCatalogRecord } from "../src/session/catalog.js";
import { defaultChatPersonalizationOverride } from "../src/personalization/index.js";
import type {
  DesktopSettingsChatSnapshot,
  DesktopSettingsSaveInput
} from "../src/desktop/protocol.js";
import type {
  DesktopSettingsConfigSnapshot,
  PreparedDesktopSettingsChat,
  PreparedDesktopSettingsConfig
} from "../src/desktop/electron/main/DesktopAgentManager.js";
import {
  DesktopSettingsTransaction,
  type DesktopSettingsJournal,
  type DesktopSettingsTransactionAgents
} from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { runtimeMutationStartsWork } from "../src/desktop/electron/main/settingsRuntimeGate.js";

type FailurePoint =
  | "prepare_config"
  | "prepare_chat"
  | "config_before_write"
  | "config_after_write"
  | "config_cas"
  | "chat_before_write"
  | "chat_after_write"
  | "chat_cas"
  | "config_readback";

class FakeSettingsAgents implements DesktopSettingsTransactionAgents {
  config = structuredClone(defaultConfig);
  configRevision = "config:0";
  chatRecord: SessionCatalogRecord | undefined;
  chatRevision = "missing";
  failure?: FailurePoint;
  rollbackConfigFails = false;
  rollbackChatFails = false;
  rollbackConfigCalls = 0;
  rollbackChatCalls = 0;
  consumedCredentialHandles: string[] = [];
  settingsCommitNotifications = 0;
  settingsCommitHookThrows = false;
  blockChatCommit = false;
  private readonly blockedChatStarted = Promise.withResolvers<void>();
  readonly deferredConfigTransactions = new Map<string, {
    status: "before" | "target";
    prepared: PreparedDesktopSettingsConfig;
  }>();
  finalizedConfigTransactions: string[] = [];
  private configSequence = 0;
  private chatSequence = 0;
  private badConfigReadbacks = 0;

  hasRunningTasks(): boolean {
    return false;
  }

  async settingsConfigSnapshot(_projectId: string): Promise<DesktopSettingsConfigSnapshot> {
    const revision = this.badConfigReadbacks > 0 ? "config:stale-readback" : this.configRevision;
    if (this.badConfigReadbacks > 0) this.badConfigReadbacks -= 1;
    return {
      revision,
      activity: structuredClone(this.config.activity),
      memory: structuredClone(this.config.context.memory),
      compaction: structuredClone(this.config.context.compaction),
      chatParams: structuredClone(this.config.chat),
      permission: structuredClone(this.config.permission),
      webSearch: structuredClone(this.config.web.search),
      models: {
        configured: [],
        connections: [],
        embeddingModels: [],
        defaultModel: this.config.defaultModel,
        thinking: this.config.thinking.enabled ? this.config.thinking.effort : "off",
        modelProfiles: Object.fromEntries(Object.entries(this.config.providers).map(([providerAlias, provider]) => [
          providerAlias,
          structuredClone(provider.modelProfiles ?? {})
        ]))
      }
    };
  }

  async settingsChatSnapshot(_projectId: string, sessionId: string): Promise<DesktopSettingsChatSnapshot> {
    return {
      sessionId,
      metadataRevision: this.chatRevision,
      personalization: this.chatRecord?.personalization ?? defaultChatPersonalizationOverride
    };
  }

  async prepareSettingsConfig(
    projectId: string,
    input: DesktopSettingsSaveInput
  ): Promise<PreparedDesktopSettingsConfig> {
    if (this.failure === "prepare_config") throw new Error("injected config prepare failure");
    const before = structuredClone(this.config);
    const after = structuredClone(this.config);
    if (input.activity !== undefined) after.activity = { ...after.activity, ...structuredClone(input.activity) };
    if (input.memory !== undefined) after.context.memory = structuredClone(input.memory);
    if (input.compaction !== undefined) after.context.compaction = structuredClone(input.compaction);
    if (input.chatParams !== undefined) after.chat = structuredClone(input.chatParams);
    if (input.permission !== undefined) after.permission = structuredClone(input.permission);
    if (input.webSearch !== undefined) after.web.search = structuredClone(input.webSearch);
    for (const model of input.models?.upserts ?? []) {
      after.providers.deepseek!.apiKey = model.apiKey ?? after.providers.deepseek!.apiKey;
    }
    if (input.skills !== undefined) {
      after.extensions.skillDefaults = structuredClone(input.skills.globalDefaults);
      after.extensions.skillProjectOverrides = {
        ...after.extensions.skillProjectOverrides,
        "fake-project": structuredClone(input.skills.projectOverrides)
      };
    }
    if (input.models?.modelProfiles !== undefined) {
      for (const [providerAlias, profiles] of Object.entries(input.models.modelProfiles)) {
        const provider = after.providers[providerAlias];
        if (!provider) throw new Error(`unknown provider: ${providerAlias}`);
        provider.modelProfiles = structuredClone(profiles);
      }
    }
    const included = input.activity !== undefined
      || input.memory !== undefined
      || input.compaction !== undefined
      || input.chatParams !== undefined
      || input.permission !== undefined
      || input.webSearch !== undefined
      || input.skills !== undefined
      || input.models !== undefined;
    const credentialHandles = [
      ...(input.models?.upserts.map((model) => model.apiKeyHandle) ?? []),
      ...(input.models?.oauthCredentialHandles ?? [])
    ].filter((handle): handle is string => handle !== undefined);
    return {
      projectId,
      workspaceRoot: "/fake-workspace",
      before,
      after,
      beforeRevision: this.configRevision,
      targetRevision: included
        ? configDocumentRevision(before) === configDocumentRevision(after)
          ? this.configRevision
          : `config:${String(++this.configSequence)}`
        : this.configRevision,
      credentialHandles
    };
  }

  async prepareSettingsChat(
    projectId: string,
    input: NonNullable<DesktopSettingsSaveInput["chat"]>
  ): Promise<PreparedDesktopSettingsChat> {
    if (this.failure === "prepare_chat") throw new Error("injected chat prepare failure");
    const before = this.chatRecord === undefined ? undefined : structuredClone(this.chatRecord);
    const now = new Date().toISOString();
    const after: SessionCatalogRecord = {
      ...(before ?? {
        version: 1,
        sessionId: input.sessionId,
        rootSessionId: input.sessionId,
        createdAt: now,
        updatedAt: now
      }),
      personalization: structuredClone(input.personalization),
      updatedAt: now
    };
    return {
      projectId,
      persistenceRoot: "/fake-persistence",
      sessionId: input.sessionId,
      before,
      after,
      beforeRevision: this.chatRevision,
      targetRevision: `chat:${String(++this.chatSequence)}`
    };
  }

  async commitSettingsConfig(prepared: PreparedDesktopSettingsConfig, transactionId: string): Promise<void> {
    if (this.failure === "config_cas") {
      this.configRevision = "config:external";
      throw new ConfigRevisionConflictError(prepared.beforeRevision, this.configRevision);
    }
    if (this.failure === "config_before_write") throw new Error("injected config write failure");
    this.config = structuredClone(prepared.after);
    this.configRevision = prepared.targetRevision;
    this.deferredConfigTransactions.set(transactionId, { status: "target", prepared });
    if (this.failure === "config_readback") this.badConfigReadbacks = 1;
    if (this.failure === "config_after_write") throw new Error("injected config post-write failure");
  }

  async settingsConfigTransactionStatus(
    _projectId: string,
    transactionId: string
  ): Promise<"missing" | "before" | "target"> {
    return this.deferredConfigTransactions.get(transactionId)?.status ?? "missing";
  }

  async finalizeSettingsConfig(_projectId: string, transactionId: string): Promise<void> {
    this.deferredConfigTransactions.delete(transactionId);
    this.finalizedConfigTransactions.push(transactionId);
  }

  async commitSettingsChat(prepared: PreparedDesktopSettingsChat): Promise<void> {
    if (this.failure === "chat_cas") {
      this.chatRevision = "chat:external";
      throw new SessionCatalogConflictError(prepared.sessionId, prepared.beforeRevision, this.chatRevision);
    }
    if (this.failure === "chat_before_write") throw new Error("injected chat write failure");
    if (this.blockChatCommit) {
      this.blockedChatStarted.resolve();
      await new Promise<void>(() => undefined);
    }
    this.chatRecord = structuredClone(prepared.after);
    this.chatRevision = prepared.targetRevision;
    if (this.failure === "chat_after_write") throw new Error("injected chat post-write failure");
  }

  async rollbackSettingsConfig(
    prepared: PreparedDesktopSettingsConfig,
    transactionId: string
  ): Promise<"not_needed" | "completed" | "failed"> {
    this.rollbackConfigCalls += 1;
    if (this.rollbackConfigFails) return "failed";
    if (this.configRevision === prepared.beforeRevision && prepared.targetRevision !== prepared.beforeRevision) {
      this.deferredConfigTransactions.delete(transactionId);
      return "not_needed";
    }
    if (this.configRevision !== prepared.targetRevision) return "failed";
    this.config = structuredClone(prepared.before);
    this.configRevision = prepared.beforeRevision;
    this.deferredConfigTransactions.delete(transactionId);
    return "completed";
  }

  async rollbackPendingSettingsConfig(
    _projectId: string,
    transactionId: string
  ): Promise<"not_needed" | "completed" | "failed"> {
    const deferred = this.deferredConfigTransactions.get(transactionId);
    if (!deferred) return "not_needed";
    this.config = structuredClone(deferred.prepared.before);
    this.configRevision = deferred.prepared.beforeRevision;
    this.deferredConfigTransactions.delete(transactionId);
    return deferred.status === "target" ? "completed" : "not_needed";
  }

  async rollbackSettingsChat(
    prepared: PreparedDesktopSettingsChat
  ): Promise<"not_needed" | "completed" | "failed"> {
    this.rollbackChatCalls += 1;
    if (this.rollbackChatFails) return "failed";
    if (this.chatRevision === prepared.beforeRevision) return "not_needed";
    if (this.chatRevision !== prepared.targetRevision) return "failed";
    this.chatRecord = prepared.before === undefined ? undefined : structuredClone(prepared.before);
    this.chatRevision = prepared.beforeRevision;
    return "completed";
  }

  consumeSettingsCredentials(handles: string[]): void {
    this.consumedCredentialHandles.push(...handles);
  }

  settingsCommitted(_prepared: PreparedDesktopSettingsConfig): void {
    this.settingsCommitNotifications += 1;
    if (this.settingsCommitHookThrows) throw new Error("injected post-commit rebuild failure");
  }

  async waitForBlockedChatCommit(): Promise<void> {
    await this.blockedChatStarted.promise;
  }
}

class FailInitialJournalTransaction extends DesktopSettingsTransaction {
  private firstWrite = true;

  protected override async writeJournal(journal: DesktopSettingsJournal): Promise<void> {
    if (this.firstWrite) {
      this.firstWrite = false;
      throw new Error("injected initial journal failure");
    }
    await super.writeJournal(journal);
  }
}

class FailJournalDeleteTransaction extends DesktopSettingsTransaction {
  private remainingFailures: number;

  constructor(state: DesktopStateStore, agents: DesktopSettingsTransactionAgents, failures: number) {
    super(state, agents);
    this.remainingFailures = failures;
  }

  protected override async deleteJournal(): Promise<void> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("injected journal cleanup failure");
    }
    await super.deleteJournal();
  }
}

class KeepJournalTransaction extends DesktopSettingsTransaction {
  protected override async deleteJournal(): Promise<void> {
    // 测试需要检查提交中的 journal；模拟进程在清理前退出。
  }
}

class FailPreferenceRollbackEvidenceTransaction extends DesktopSettingsTransaction {
  private injected = false;

  protected override async writeJournal(journal: DesktopSettingsJournal): Promise<void> {
    if (!this.injected && journal.segments.preferences.state === "rolled_back") {
      this.injected = true;
      throw new Error("injected crash after preference rollback write");
    }
    await super.writeJournal(journal);
  }
}

await testCommitAndJournalRedaction();
await testActivitySettingsUseConfigCas();
await testChatParamsOnlySaveCommits();
await testPermissionOnlySaveCommits();
await testSkillSettingsOnlySaveCommits();
await testModelProfilesCommitAndRollback();
await testPostCommitHookCannotRollbackSettings();
await testPreflightConflictsAreZeroWrite();
await testSegmentFailureCompensation();
await testCredentialOnlyChatFailureRestoresKeychainState();
await testCommitPointCasDoesNotOverwriteExternalState();
await testReadbackFailureRollsBack();
await testInitialJournalFailureNeedsNoRecovery();
await testRecoveryRequiredAndRestartRecovery();
await testCrashAfterConfigBeforeChatIsCompensatedOnRestart();
await testCredentialOnlyCrashUsesInnerTargetMarker();
await testCredentialOnlyPendingJournalIsAmbiguous();
await testStartupRecoveryRunsBeforeTaskAdmission();
testSettingsSaveInputAcceptsCompactionAndChatParams();
testRuntimeMutationRecoveryClassification();
console.log("settings transaction tests passed");

async function testActivitySettingsUseConfigCas(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const activity = initial.activity;
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      activity: { ...activity, heartbeatMs: 90_000 }
    });
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.deepEqual(result.appliedFields, ["activity"]);
    assert.equal(agents.config.activity.heartbeatMs, 90_000);
    assert.equal("externalPolicy" in agents.config.activity, false);
  });
}

async function testChatParamsOnlySaveCommits(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    // 只改聊天采样参数时也必须真正提交：appliedFields 漏掉 chatParams 会让保存
    // 以「无字段变更」提前返回，配置永远落不了盘。
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      chatParams: { temperature: 0.4, maxOutputTokens: 8_192, hashlineEdit: true, response: { markdown: false, streaming: false } }
    });
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.deepEqual(result.appliedFields, ["chatParams"]);
    assert.deepEqual(agents.config.chat, { temperature: 0.4, maxOutputTokens: 8_192, hashlineEdit: true, response: { markdown: false, streaming: false } });
    assert.equal(result.snapshot.chatParams.temperature, 0.4);
    assert.equal(result.snapshot.chatParams.hashlineEdit, true);
    assert.deepEqual((await transaction.snapshot("project")).chatParams.response, { markdown: false, streaming: false });
  });
}

async function testPermissionOnlySaveCommits(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      permission: { ...initial.permission, mode: "read-only", criticalAlwaysAsk: false }
    });
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.deepEqual(result.appliedFields, ["permission"]);
    assert.equal(agents.config.permission.mode, "read-only");
    assert.equal(agents.config.permission.criticalAlwaysAsk, false);
  });
}

async function testSkillSettingsOnlySaveCommits(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      skills: {
        globalDefaults: { "demo-skill": false },
        projectOverrides: { "demo-skill": true }
      }
    });
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.deepEqual(result.appliedFields, ["skills"]);
    assert.deepEqual(agents.config.extensions.skillDefaults, { "demo-skill": false });
    assert.deepEqual(agents.config.extensions.skillProjectOverrides["fake-project"], { "demo-skill": true });
  });
}

async function testModelProfilesCommitAndRollback(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const profile = {
      contextWindow: 1_000_000,
      maxInputTokens: 950_000,
      maxOutputTokens: 128_000,
      thinkingLevelMap: { off: "none", high: "high", max: "max" }
    };
    const committed = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      models: { upserts: [], removeAliases: [], modelProfiles: { deepseek: { "deepseek-v4-flash": profile } } }
    });
    assert.equal(committed.status, "committed", JSON.stringify(committed));
    assert.deepEqual(agents.config.providers.deepseek?.modelProfiles, { "deepseek-v4-flash": profile });
    assert.deepEqual(committed.snapshot.models.modelProfiles.deepseek, { "deepseek-v4-flash": profile });

    const after = await transaction.snapshot("project");
    const prepared = await agents.prepareSettingsConfig("project", {
      expectedPreferenceRevision: after.preferenceRevision,
      expectedConfigRevision: after.configRevision,
      models: { upserts: [], removeAliases: [], modelProfiles: { deepseek: {} } }
    });
    assert.deepEqual(prepared.after.providers.deepseek?.modelProfiles, {});
    await agents.commitSettingsConfig(prepared, "profile-rollback");
    assert.equal(await agents.rollbackSettingsConfig(prepared, "profile-rollback"), "completed");
    assert.deepEqual(agents.config.providers.deepseek?.modelProfiles, { "deepseek-v4-flash": profile });

    const invalidProfile = {
      contextWindow: 1_000_000,
      unknownField: true
    };
    assert.throws(() => settingsSaveInputSchema.parse({
      expectedPreferenceRevision: 0,
      expectedConfigRevision: "config:0",
      models: { upserts: [], removeAliases: [], modelProfiles: { deepseek: { model: invalidProfile } } }
    }));
  });
}

function testSettingsSaveInputAcceptsCompactionAndChatParams(): void {
  // 渲染层 saveInput 每次都会带上 compaction/chatParams 键（未修改时值为 undefined 但键名
  // 保留）；strict schema 缺这两个字段时会把所有设置保存拒之门外。
  const base = {
    expectedPreferenceRevision: 0,
    expectedConfigRevision: "config:0",
    themePreference: undefined,
    fontPreference: undefined,
    activity: undefined,
    memory: undefined,
    compaction: undefined,
    chatParams: undefined,
    permission: undefined,
    webSearch: undefined,
    skills: undefined,
    models: undefined,
    chat: undefined
  };
  assert.doesNotThrow(() => settingsSaveInputSchema.parse(base));
  const parsed = settingsSaveInputSchema.parse({
    ...base,
    compaction: { enabled: false },
    chatParams: { temperature: 0.4, maxOutputTokens: 8_192 }
  });
  assert.equal(parsed.compaction?.enabled, false);
  assert.equal(parsed.chatParams?.temperature, 0.4);
  assert.equal(parsed.chatParams?.maxOutputTokens, 8_192);
  // strict 语义不变：未知键仍然拒绝。
  assert.throws(() => settingsSaveInputSchema.parse({ ...base, unknownField: 1 }));
}

async function testCommitAndJournalRedaction(): Promise<void> {
  await withFixture(async ({ root, state, agents }) => {
    const transaction = new KeepJournalTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    assert.equal(initial.hasRunningTasks, false);
    const secret = "never-write-this-secret";
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark",
      models: { upserts: [{ alias: "deepseek-v4-flash", displayName: "DeepSeek", providerType: "deepseek", model: "deepseek-v4-flash", apiKey: secret, apiKeyHandle: "credential-handle" }], deletes: [] },
      chat: chatInput("missing")
    });
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.equal(state.themePreference(), "dark");
    assert.deepEqual(agents.consumedCredentialHandles, ["credential-handle"]);
    assert.equal(agents.settingsCommitNotifications, 1);
    const journal = await fs.readFile(state.settingsTransactionJournalPath(), "utf8");
    assert.equal(journal.includes(secret), false, "journal must never contain plaintext credentials");
    assert.equal(journal.includes("credential-handle"), true, "journal retains only the opaque handle lineage");
    await fs.rm(path.join(root, "desktop-state.json.settings-journal.json"), { force: true });
  });
}

async function testPostCommitHookCannotRollbackSettings(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    agents.settingsCommitHookThrows = true;
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      memory: {
        ...initial.memory,
        useMemories: !initial.memory.useMemories
      }
    });
    assert.equal(result.status, "committed", "post-commit hook failure must not roll back verified settings");
    assert.equal(agents.settingsCommitNotifications, 1);
    assert.equal(agents.config.context.memory.useMemories, !initial.memory.useMemories);
  });
}

async function testPreflightConflictsAreZeroWrite(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const transaction = new DesktopSettingsTransaction(state, agents);
    const result = await transaction.save("project", {
      expectedPreferenceRevision: 99,
      expectedConfigRevision: "config:stale",
      themePreference: "dark",
      chat: chatInput("chat:stale")
    });
    assert.equal(result.status, "rolled_back");
    if (result.status !== "rolled_back") throw new Error("expected rolled_back");
    assert.deepEqual(result.conflicts?.map((conflict) => conflict.segment), [
      "preferences",
      "config",
      "chat_metadata"
    ]);
    assert.equal(state.themePreference(), "system");
    assert.equal(agents.configRevision, "config:0");
    assert.equal(agents.chatRevision, "missing");
  });
}

async function testSegmentFailureCompensation(): Promise<void> {
  for (const failure of [
    "config_before_write",
    "config_after_write",
    "chat_before_write",
    "chat_after_write"
  ] satisfies FailurePoint[]) {
    await withFixture(async ({ state, agents }) => {
      agents.failure = failure;
      const transaction = new DesktopSettingsTransaction(state, agents);
      const initial = await transaction.snapshot("project");
      const result = await transaction.save("project", {
        expectedPreferenceRevision: initial.preferenceRevision,
        expectedConfigRevision: initial.configRevision,
        themePreference: "dark",
        memory: {
          ...initial.memory,
          useMemories: !initial.memory.useMemories
        },
        chat: chatInput("missing")
      });
      assert.equal(result.status, "rolled_back", failure);
      assert.equal(state.themePreference(), "system", failure);
      assert.equal(agents.configRevision, "config:0", failure);
      assert.equal(agents.chatRevision, "missing", failure);
      await assert.rejects(fs.access(state.settingsTransactionJournalPath()), { code: "ENOENT" });
    });
  }
}

async function testCredentialOnlyChatFailureRestoresKeychainState(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    agents.failure = "chat_before_write";
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      models: { upserts: [{ alias: "deepseek-v4-flash", displayName: "DeepSeek", providerType: "deepseek", model: "deepseek-v4-flash", apiKey: "credential-only-target", apiKeyHandle: "credential-only-handle" }], deletes: [] },
      chat: chatInput("missing")
    });
    assert.equal(result.status, "rolled_back");
    assert.equal(agents.configRevision, initial.configRevision, "credential-only save keeps the public revision");
    assert.equal(agents.config.providers.deepseek!.apiKey, undefined, "later chat failure restores the prior credential");
    assert.equal(agents.deferredConfigTransactions.size, 0, "rollback cleans the retained Keychain lineage");
  });
}

async function testCommitPointCasDoesNotOverwriteExternalState(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    agents.failure = "config_cas";
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark",
      memory: {
        ...initial.memory,
        useMemories: !initial.memory.useMemories
      },
    });
    assert.equal(result.status, "rolled_back");
    if (result.status !== "rolled_back") throw new Error("expected rolled_back");
    assert.equal(result.conflicts?.[0]?.segment, "config");
    assert.equal(agents.configRevision, "config:external");
    assert.equal(agents.rollbackConfigCalls, 0, "CAS failure must not compensate an external config");
    assert.equal(state.themePreference(), "system");
  });

  await withFixture(async ({ state, agents }) => {
    agents.failure = "chat_cas";
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark",
      memory: {
        ...initial.memory,
        useMemories: !initial.memory.useMemories
      },
      chat: chatInput("missing")
    });
    assert.equal(result.status, "rolled_back");
    if (result.status !== "rolled_back") throw new Error("expected rolled_back");
    assert.equal(result.conflicts?.[0]?.segment, "chat_metadata");
    assert.equal(agents.chatRevision, "chat:external");
    assert.equal(agents.rollbackChatCalls, 0, "CAS failure must not compensate external chat metadata");
    assert.equal(agents.configRevision, "config:0", "earlier config segment must still be compensated");
    assert.equal(state.themePreference(), "system");
  });
}

async function testReadbackFailureRollsBack(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    agents.failure = "config_readback";
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark",
      memory: {
        ...initial.memory,
        useMemories: !initial.memory.useMemories
      },
    });
    assert.equal(result.status, "rolled_back");
    assert.equal(agents.configRevision, "config:0");
    assert.equal(state.themePreference(), "system");
  });
}

async function testInitialJournalFailureNeedsNoRecovery(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const transaction = new FailInitialJournalTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const result = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark"
    });
    assert.equal(result.status, "rolled_back");
    assert.equal(state.themePreference(), "system");
    assert.equal((await transaction.snapshot("project")).pendingRecovery, undefined);
  });
}

async function testRecoveryRequiredAndRestartRecovery(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    agents.failure = "config_after_write";
    agents.rollbackConfigFails = true;
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project");
    const failed = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark",
      memory: {
        ...initial.memory,
        useMemories: !initial.memory.useMemories
      },
    });
    assert.equal(failed.status, "recovery_required");
    assert.equal((await transaction.snapshot("project")).pendingRecovery?.journalId, failed.journalId);

    // 模拟重启前底层补偿终于完成；pending+before 与已记录的偏好补偿证据足以安全收尾。
    agents.config = structuredClone(defaultConfig);
    agents.configRevision = "config:0";
    agents.rollbackConfigFails = false;
    agents.failure = undefined;
    const restarted = new DesktopSettingsTransaction(state, agents);
    const recovered = await restarted.snapshot("project");
    assert.equal(recovered.pendingRecovery, undefined);
    await assert.rejects(fs.access(state.settingsTransactionJournalPath()), { code: "ENOENT" });
  });

  await withFixture(async ({ state, agents }) => {
    const transaction = new FailJournalDeleteTransaction(state, agents, 2);
    const initial = await transaction.snapshot("project");
    const failed = await transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark",
    });
    assert.equal(failed.status, "recovery_required");
    assert.equal(state.themePreference(), "dark", "verified commit must not be rolled back only because cleanup failed");
    const restarted = new DesktopSettingsTransaction(state, agents);
    assert.equal((await restarted.snapshot("project")).pendingRecovery, undefined);
  });
}

async function testCrashAfterConfigBeforeChatIsCompensatedOnRestart(): Promise<void> {
  await withFixture(async ({ root, state, agents }) => {
    const transaction = new DesktopSettingsTransaction(state, agents);
    const initial = await transaction.snapshot("project", "session");
    agents.blockChatCommit = true;
    const credentialSecret = "must-not-enter-settings-recovery-payload";
    void transaction.save("project", {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark",
      models: { upserts: [{ alias: "deepseek-v4-flash", displayName: "DeepSeek", providerType: "deepseek", model: "deepseek-v4-flash", apiKey: credentialSecret, apiKeyHandle: "opaque-crash-handle" }], deletes: [] },
      chat: chatInput("missing")
    });
    await agents.waitForBlockedChatCommit();

    const journal = JSON.parse(
      await fs.readFile(state.settingsTransactionJournalPath(), "utf8")
    ) as DesktopSettingsJournal;
    assert.equal(journal.segments.config.state, "committed");
    assert.equal(journal.segments.chatMetadata.state, "pending");
    assert.ok(journal.recoveryPayload, "cross-segment transactions retain a recovery payload");
    const payloadPath = path.join(root, journal.recoveryPayload.fileName);
    const payload = await fs.readFile(payloadPath, "utf8");
    assert.equal(payload.includes(credentialSecret), false, "recovery payload must redact credential plaintext");
    assert.equal((await fs.stat(payloadPath)).mode & 0o777, 0o600);

    const hardlink = `${payloadPath}.hardlink`;
    await fs.link(payloadPath, hardlink);
    const unsafeRecovery = await new DesktopSettingsTransaction(state, agents).snapshot("project", "session");
    assert.match(unsafeRecovery.pendingRecovery?.message ?? "", /临时版本无法验证/u);
    assert.equal(agents.configRevision, journal.segments.config.targetRevision, "unsafe payload binding must be fail-closed");
    await fs.unlink(hardlink);

    // 不释放旧 commitSettingsChat 的屏障，等价于进程在 config journal 落盘后被终止。
    const interruptedRecovery = new FailPreferenceRollbackEvidenceTransaction(state, agents);
    const interrupted = await interruptedRecovery.snapshot("project", "session");
    assert.equal(interrupted.pendingRecovery?.journalId, journal.id);
    assert.equal(state.themePreference(), "system", "preference rollback reached disk before the second crash");
    const interruptedJournal = JSON.parse(
      await fs.readFile(state.settingsTransactionJournalPath(), "utf8")
    ) as DesktopSettingsJournal;
    assert.equal(interruptedJournal.segments.preferences.state, "rolling_back");

    const restarted = new DesktopSettingsTransaction(state, agents);
    const recovered = await restarted.snapshot("project", "session");
    assert.equal(recovered.pendingRecovery, undefined);
    assert.equal(state.themePreference(), "system");
    assert.equal(agents.configRevision, initial.configRevision);
    assert.equal(agents.config.providers.deepseek!.apiKey, undefined);
    assert.equal(agents.chatRevision, "missing");
    assert.equal(agents.deferredConfigTransactions.size, 0);
    await assert.rejects(fs.access(state.settingsTransactionJournalPath()), { code: "ENOENT" });
    await assert.rejects(fs.access(payloadPath), { code: "ENOENT" });
  });
}

async function testCredentialOnlyCrashUsesInnerTargetMarker(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const preferences = state.settingsPreferences();
    const transactionId = "credential-only-inner-target";
    const before = structuredClone(agents.config);
    const after = structuredClone(before);
    after.providers.deepseek!.apiKey = "inner-keychain-only-secret";
    const prepared: PreparedDesktopSettingsConfig = {
      projectId: "project",
      workspaceRoot: "/fake-workspace",
      before,
      after,
      beforeRevision: agents.configRevision,
      targetRevision: agents.configRevision,
      credentialHandles: ["opaque-inner-handle"]
    };
    agents.config = structuredClone(after);
    agents.deferredConfigTransactions.set(transactionId, { status: "target", prepared });
    const journal: DesktopSettingsJournal = {
      version: 1,
      id: transactionId,
      projectId: "project",
      createdAt: new Date().toISOString(),
      segments: {
        preferences: {
          included: false,
          state: "pending",
          before: preferences,
          after: preferences,
          rollback: undefined
        },
        config: {
          included: true,
          state: "pending",
          beforeRevision: agents.configRevision,
          targetRevision: agents.configRevision,
          rollbackRevision: undefined,
          credentialHandles: ["opaque-inner-handle"]
        },
        chatMetadata: {
          included: false,
          state: "pending",
          sessionId: undefined,
          beforeRevision: undefined,
          targetRevision: undefined,
          rollbackRevision: undefined
        }
      }
    };
    await fs.writeFile(state.settingsTransactionJournalPath(), `${JSON.stringify(journal)}\n`, "utf8");

    const restarted = new DesktopSettingsTransaction(state, agents);
    const snapshot = await restarted.snapshot("project");
    assert.equal(snapshot.pendingRecovery, undefined);
    assert.deepEqual(agents.finalizedConfigTransactions, [transactionId]);
    assert.deepEqual(agents.consumedCredentialHandles, ["opaque-inner-handle"]);
    assert.equal(agents.config.providers.deepseek!.apiKey, "inner-keychain-only-secret");
    await assert.rejects(fs.access(state.settingsTransactionJournalPath()), { code: "ENOENT" });
  });
}

async function testCredentialOnlyPendingJournalIsAmbiguous(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const preferences = state.settingsPreferences();
    const journal: DesktopSettingsJournal = {
      version: 1,
      id: "credential-only-crash",
      projectId: "project",
      createdAt: new Date().toISOString(),
      segments: {
        preferences: {
          included: false,
          state: "pending",
          before: preferences,
          after: preferences,
          rollback: undefined
        },
        config: {
          included: true,
          state: "pending",
          beforeRevision: agents.configRevision,
          targetRevision: agents.configRevision,
          rollbackRevision: undefined,
          credentialHandles: ["opaque-key-handle"]
        },
        chatMetadata: {
          included: false,
          state: "pending",
          sessionId: undefined,
          beforeRevision: undefined,
          targetRevision: undefined,
          rollbackRevision: undefined
        }
      }
    };
    await fs.writeFile(state.settingsTransactionJournalPath(), `${JSON.stringify(journal)}\n`, "utf8");
    const transaction = new DesktopSettingsTransaction(state, agents);
    const snapshot = await transaction.snapshot("project");
    assert.equal(snapshot.pendingRecovery?.journalId, journal.id);
    await assert.rejects(
      transaction.assertRuntimeReady(),
      /设置事务尚未恢复，暂时不能启动新任务/u
    );
  });
}

async function testStartupRecoveryRunsBeforeTaskAdmission(): Promise<void> {
  await withFixture(async ({ state, agents }) => {
    const preferences = state.settingsPreferences();
    const after = await state.applySettingsPreferences({ themePreference: "dark" }, preferences.revision);
    const journal: DesktopSettingsJournal = {
      version: 1,
      id: "startup-recovery-before-ipc",
      projectId: "project",
      createdAt: new Date().toISOString(),
      segments: {
        preferences: {
          included: true,
          state: "committed",
          before: preferences,
          after,
          rollback: undefined
        },
        config: {
          included: false,
          state: "pending",
          beforeRevision: agents.configRevision,
          targetRevision: agents.configRevision,
          rollbackRevision: undefined,
          credentialHandles: []
        },
        chatMetadata: {
          included: false,
          state: "pending",
          sessionId: undefined,
          beforeRevision: undefined,
          targetRevision: undefined,
          rollbackRevision: undefined
        }
      }
    };
    await fs.writeFile(state.settingsTransactionJournalPath(), `${JSON.stringify(journal)}\n`, "utf8");

    const transaction = new DesktopSettingsTransaction(state, agents);
    assert.equal(await transaction.recoverAtStartup(), undefined);
    assert.equal(state.themePreference(), "dark");
    await assert.doesNotReject(transaction.assertRuntimeReady());
    await assert.rejects(fs.access(state.settingsTransactionJournalPath()), { code: "ENOENT" });
  });

  await withFixture(async ({ state, agents }) => {
    const preferences = state.settingsPreferences();
    const journal: DesktopSettingsJournal = {
      version: 1,
      id: "startup-recovery-ambiguous",
      projectId: "project",
      createdAt: new Date().toISOString(),
      segments: {
        preferences: {
          included: false,
          state: "pending",
          before: preferences,
          after: preferences,
          rollback: undefined
        },
        config: {
          included: true,
          state: "pending",
          beforeRevision: agents.configRevision,
          targetRevision: agents.configRevision,
          rollbackRevision: undefined,
          credentialHandles: ["opaque-startup-handle"]
        },
        chatMetadata: {
          included: false,
          state: "pending",
          sessionId: undefined,
          beforeRevision: undefined,
          targetRevision: undefined,
          rollbackRevision: undefined
        }
      }
    };
    await fs.writeFile(state.settingsTransactionJournalPath(), `${JSON.stringify(journal)}\n`, "utf8");

    const transaction = new DesktopSettingsTransaction(state, agents);
    const pending = await transaction.recoverAtStartup();
    assert.equal(pending?.journalId, journal.id);
    await assert.rejects(transaction.assertRuntimeReady(), /设置事务尚未恢复，暂时不能启动新任务/u);
  });
}

function testRuntimeMutationRecoveryClassification(): void {
  for (const operation of [
    "task.create",
    "task.start",
    "task.approve",
    "task.resume",
    "task.retry",
    "automation.create",
    "automation.resume",
    "automation.run",
    "goal.create",
    "goal.resume",
    "graph.create",
    "graph.start",
    "graph.resume",
    "capability.invoke",
    "capability.accept",
    "capability.start",
    "capability.result",
    "capability.chunk"
  ] as const) {
    assert.equal(runtimeMutationStartsWork(operation), true, `${operation} must be recovery-gated`);
  }
  for (const operation of [
    "task.cancel",
    "automation.pause",
    "automation.delete",
    "goal.pause",
    "goal.cancel",
    "graph.pause",
    "graph.cancel",
    "capability.reject",
    "capability.release",
    "capability.fail",
    "capability.cancel"
  ] as const) {
    assert.equal(runtimeMutationStartsWork(operation), false, `${operation} must remain available for cleanup`);
  }
}

function chatInput(expectedMetadataRevision: string): NonNullable<DesktopSettingsSaveInput["chat"]> {
  return {
    sessionId: "session",
    expectedMetadataRevision,
    personalization: {
      useMemories: "inherit",
      contributeMemories: "inherit"
    }
  };
}

async function withFixture(
  run: (fixture: { root: string; state: DesktopStateStore; agents: FakeSettingsAgents }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-settings-transaction-"));
  try {
    const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
    await state.load();
    await run({ root, state, agents: new FakeSettingsAgents() });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
