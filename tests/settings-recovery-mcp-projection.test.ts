import assert from "node:assert/strict";
import test, { after } from "node:test";
import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CredentialStore } from "../src/config/credentials.js";
import type { AgentConfig } from "../src/config/schema.js";
import type { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import type { DesktopSettingsTransactionAgents, DesktopSettingsJournal } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";

import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfigFile, loadConfigFile } from "../src/config/loader.js";
import { configDocumentRevision } from "../src/config/versioned.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { InMemoryModelsStore } from "../src/llm/ModelsStore.js";

// Real config/manager/transaction methods with temporary files and an in-memory
// credential store only. No Runtime, OS Keychain, or provider request is started.
let networkAttempts = 0;
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; assert.equal(networkAttempts, 0); });
globalThis.fetch = (async () => { networkAttempts++; throw new Error("SYNTHETIC_AUDIT_NETWORK_FORBIDDEN"); }) as typeof fetch;

const secrets = {
  env: "BINY_AUDIT_FAKE_MCP_ENV_SECRET_20261006_NEVER_VALID",
  header: "BINY_AUDIT_FAKE_MCP_HEADER_SECRET_20261006_NEVER_VALID",
  provider: "BINY_AUDIT_FAKE_PROVIDER_SECRET_20261006_NEVER_VALID"
};
const refs = { env: "biny-audit-fake:mcp:env", header: "biny-audit-fake:mcp:header" };

function stripReferencedValues(config: AgentConfig): AgentConfig {
  const clone = structuredClone(config);
  for (const server of Object.values(clone.extensions.mcp)) {
    for (const key of Object.keys(server.credentialRefs?.env ?? {})) delete server.env?.[key];
    for (const key of Object.keys(server.credentialRefs?.headers ?? {})) delete server.headers?.[key];
  }
  return clone;
}

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-settings-mcp-projection-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let f: Awaited<ReturnType<typeof setup>> | undefined;
  try { f = await setup(root); await run(f); }
  finally {
    try { await f?.manager.closeAll(); }
    finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

async function setup(root: string) {
  const workspace = path.join(root, "workspace");
  const configRoot = path.join(root, "config");
  const sessionsRoot = path.join(root, "sessions");
  await fs.mkdir(workspace);
  await fs.mkdir(sessionsRoot);
  const values = new Map([
    [refs.env, secrets.env], [refs.header, secrets.header], ["provider:local:apiKey", secrets.provider]
  ]);
  const credentials: CredentialStore = {
    persistent: true,
    get: async account => values.get(account),
    set: async (account, value) => { values.set(account, value); },
    delete: async account => { values.delete(account); }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "audit-model",
    providers: { local: { type: "openai-compatible", baseUrl: "https://biny-audit.invalid/v1", requiresApiKey: false } },
    models: { "audit-model": { provider: "local", model: "audit-model" } },
    chat: { ...defaultConfig.chat, temperature: 0.1 },
    extensions: { ...defaultConfig.extensions, mcp: {
      fake: {
        id: "00000000-0000-4000-8000-000000000006", type: "http", url: "https://biny-audit.invalid/mcp",
        enabled: false, description: "SYNTHETIC public description", timeoutMs: 12000,
        env: { PUBLIC_MODE: "synthetic-nonsecret", ENV_REFERENCE: "${BINY_AUDIT_FAKE_ENV_REFERENCE}" },
        headers: { "X-Public-Mode": "synthetic-nonsecret" },
        credentialRefs: { env: { PRIVATE_ENV: refs.env }, headers: { "X-Audit-Secret": refs.header } }
      }
    } }
  });
  await saveConfigFile(configRoot, config);
  const store = new DesktopConfigStore(configRoot, credentials);
  const loaded = await store.loadVersioned(workspace);
  assert.equal(loaded.config.extensions.mcp.fake?.env?.PRIVATE_ENV, secrets.env);
  assert.equal(loaded.config.extensions.mcp.fake?.headers?.["X-Audit-Secret"], secrets.header);
  assert.equal(loaded.config.providers.local?.apiKey, secrets.provider);
  const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
  await state.load();
  const project = { id: "biny-audit-project", name: "Synthetic audit project", path: workspace };
  const projects = {
    requireProject: (id: string) => { assert.equal(id, project.id); return project; },
    dataRoot: async () => sessionsRoot
  } as unknown as DesktopProjectService;
  const manager = new DesktopAgentManager(state, projects, store, () => {},
    async () => { throw new Error("SYNTHETIC_AUDIT_EXTERNAL_OPEN_FORBIDDEN"); },
    new InMemoryModelsStore(), globalThis.fetch);
  const bridge: DesktopSettingsTransactionAgents = {
    hasRunningTasks: manager.hasRunningTasks.bind(manager),
    settingsConfigSnapshot: manager.settingsConfigSnapshot.bind(manager),
    settingsChatSnapshot: manager.settingsChatSnapshot.bind(manager),
    prepareSettingsConfig: manager.prepareSettingsConfig.bind(manager),
    prepareSettingsChat: manager.prepareSettingsChat.bind(manager),
    commitSettingsConfig: manager.commitSettingsConfig.bind(manager),
    commitSettingsChat: manager.commitSettingsChat.bind(manager),
    settingsConfigTransactionStatus: manager.settingsConfigTransactionStatus.bind(manager),
    finalizeSettingsConfig: manager.finalizeSettingsConfig.bind(manager),
    rollbackSettingsConfig: manager.rollbackSettingsConfig.bind(manager),
    rollbackPendingSettingsConfig: manager.rollbackPendingSettingsConfig.bind(manager),
    rollbackSettingsChat: manager.rollbackSettingsChat.bind(manager),
    consumeSettingsCredentials: manager.consumeSettingsCredentials.bind(manager)
    // Do not launch derived runtime refresh work in this bounded file audit.
  };
  const captured: Array<{ envPresent: boolean; headerPresent: boolean; providerPresent: boolean; mode: number; payloadPath: string; before: AgentConfig; after: AgentConfig }> = [];
  class ProbeTransaction extends DesktopSettingsTransaction {
    protected override async writeJournal(journal: DesktopSettingsJournal): Promise<void> {
      await super.writeJournal(journal);
      if (!journal.recoveryPayload) return;
      const payloadPath = path.join(path.dirname(state.settingsTransactionJournalPath()), journal.recoveryPayload.fileName);
      const bytes = await fs.readFile(payloadPath, "utf8");
      const payload = JSON.parse(bytes) as { config: { before: AgentConfig; after: AgentConfig } };
      captured.push({ before: payload.config.before, after: payload.config.after, envPresent: bytes.includes(secrets.env), headerPresent: bytes.includes(secrets.header),
        providerPresent: bytes.includes(secrets.provider), mode: (await fs.stat(payloadPath)).mode & 0o777, payloadPath });
    }
  }
  return { root, workspace, configRoot, config, store, values, state, manager, bridge, project, captured, ProbeTransaction };
}

test("an unrelated settings save excludes referenced MCP bodies while preserving public fields and cleaning artifacts", async () => {
  await fixture(async f => {
    const transaction = new f.ProbeTransaction(f.state, f.bridge);
    const before = await transaction.snapshot(f.project.id);
    for (const secret of Object.values(secrets)) assert.equal(JSON.stringify(before).includes(secret), false);
    const saved = await transaction.save(f.project.id, {
      expectedPreferenceRevision: before.preferenceRevision, expectedConfigRevision: before.configRevision,
      chatParams: { ...before.chatParams, temperature: 0.2 }
    });
    assert.equal(saved.status, "committed");
    assertScrubbed(f);
    for (const observed of f.captured) await assert.rejects(fs.access(observed.payloadPath), { code: "ENOENT" });
    await assert.rejects(fs.access(f.state.settingsTransactionJournalPath()), { code: "ENOENT" });
    const stored = await f.store.load(f.workspace);
    assert.equal(stored.chat.temperature, 0.2);
    assert.equal(stored.extensions.mcp.fake?.env?.PRIVATE_ENV, secrets.env);
    assert.equal(stored.extensions.mcp.fake?.headers?.["X-Audit-Secret"], secrets.header);
    await assertNormalConfigIsPublic(f);
  });
});

test("a preference-only save does not create a config recovery payload", async () => {
  await fixture(async f => {
    const transaction = new f.ProbeTransaction(f.state, f.bridge);
    const before = await transaction.snapshot(f.project.id);
    const saved = await transaction.save(f.project.id, {
      expectedPreferenceRevision: before.preferenceRevision, expectedConfigRevision: before.configRevision,
      themePreference: "dark"
    });
    assert.equal(saved.status, "committed");
    assert.equal(f.captured.length, 0);
    assert.equal((await f.store.loadVersioned(f.workspace)).revision, before.configRevision);
    await assert.rejects(fs.access(f.state.settingsTransactionJournalPath()), { code: "ENOENT" });
  });
});

test("recoverable failure restores configuration and removes a scrubbed recovery payload", async () => {
  await fixture(async f => {
    const failingBridge: DesktopSettingsTransactionAgents = {
      ...f.bridge,
      commitSettingsChat: async () => { throw new Error("SYNTHETIC_AUDIT_CHAT_COMMIT_FAILURE"); }
    };
    const transaction = new f.ProbeTransaction(f.state, failingBridge);
    const before = await transaction.snapshot(f.project.id, "biny-audit-session");
    const result = await transaction.save(f.project.id, {
      expectedPreferenceRevision: before.preferenceRevision, expectedConfigRevision: before.configRevision,
      chatParams: { ...before.chatParams, temperature: 0.3 },
      chat: { sessionId: "biny-audit-session", expectedMetadataRevision: before.chat!.metadataRevision,
        personalization: { useMemories: false, contributeMemories: false } }
    });
    assert.equal(result.status, "rolled_back");
    assertScrubbed(f);
    assert.equal((await f.store.loadVersioned(f.workspace)).revision, before.configRevision);
    for (const item of f.captured) await assert.rejects(fs.access(item.payloadPath), { code: "ENOENT" });
    await assert.rejects(fs.access(f.state.settingsTransactionJournalPath()), { code: "ENOENT" });
  });
});

for (const legacyPayload of [false, true]) {
  test(legacyPayload
    ? "restart still recovers a hash-verified legacy payload containing referenced MCP values"
    : "failed compensation retains a scrubbed payload and restart restores credentials using references", async () => {
    await fixture(async f => {
      const failingBridge: DesktopSettingsTransactionAgents = {
        ...f.bridge,
        commitSettingsChat: async () => { throw new Error("SYNTHETIC_AUDIT_CHAT_COMMIT_FAILURE"); },
        rollbackSettingsConfig: async () => "failed"
      };
      const transaction = new f.ProbeTransaction(f.state, failingBridge);
      const before = await transaction.snapshot(f.project.id, "biny-audit-session");
      const failed = await transaction.save(f.project.id, {
        expectedPreferenceRevision: before.preferenceRevision, expectedConfigRevision: before.configRevision,
        chatParams: { ...before.chatParams, temperature: 0.3 },
        chat: { sessionId: "biny-audit-session", expectedMetadataRevision: before.chat!.metadataRevision,
          personalization: { useMemories: false, contributeMemories: false } }
      });
      assert.equal(failed.status, "recovery_required");
      const journalPath = f.state.settingsTransactionJournalPath();
      const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as DesktopSettingsJournal;
      assert.ok(journal.recoveryPayload);
      const payloadPath = path.join(f.root, journal.recoveryPayload.fileName);
      const raw = await fs.readFile(payloadPath, "utf8");
      assert.equal((await fs.stat(payloadPath)).mode & 0o777, 0o600);
      assert.equal((await f.store.load(f.workspace)).chat.temperature, 0.3);
      if (legacyPayload) {
        // Simulate bytes produced by an older writer. No production parser or
        // validator is replaced: the coordinator verifies this fixture's hash.
        const payload = JSON.parse(raw) as { config: { before: AgentConfig; after: AgentConfig } };
        for (const key of ["before", "after"] as const) {
          const original = structuredClone(payload.config[key]);
          const server = payload.config[key].extensions.mcp.fake!;
          server.env = { ...server.env, PRIVATE_ENV: secrets.env };
          server.headers = { ...server.headers, "X-Audit-Secret": secrets.header };
          assert.equal(configDocumentRevision(payload.config[key]), configDocumentRevision(original));
        }
        const serialized = JSON.stringify(payload, null, 2) + "\n";
        assert.equal(serialized.includes(secrets.env), true);
        assert.equal(serialized.includes(secrets.header), true);
        assert.equal(serialized.includes(secrets.provider), false);
        await fs.writeFile(payloadPath, serialized);
        journal.recoveryPayload.sha256 = createHash("sha256").update(serialized).digest("hex");
        await fs.writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
      } else {
        assertScrubbed(f);
        for (const secret of Object.values(secrets)) assert.equal(raw.includes(secret), false);
      }
      const restarted = new DesktopSettingsTransaction(f.state, f.bridge);
      assert.equal(await restarted.recoverAtStartup(), undefined);
      const restored = await f.store.loadVersioned(f.workspace);
      assert.equal(restored.revision, before.configRevision);
      assert.equal(restored.config.chat.temperature, 0.1);
      assert.equal(restored.config.extensions.mcp.fake?.env?.PRIVATE_ENV, secrets.env);
      assert.equal(restored.config.extensions.mcp.fake?.headers?.["X-Audit-Secret"], secrets.header);
      assert.deepEqual(stripReferencedValues(restored.config).extensions.mcp, f.config.extensions.mcp);
      assert.equal(f.values.get(refs.env), secrets.env);
      assert.equal(f.values.get(refs.header), secrets.header);
      await assert.rejects(fs.access(payloadPath), { code: "ENOENT" });
      await assert.rejects(fs.access(journalPath), { code: "ENOENT" });
      await assert.rejects(fs.access(path.join(f.configRoot, ".credentials.transaction.json")), { code: "ENOENT" });
      await assertNormalConfigIsPublic(f);
    });
  });
}

function assertScrubbed(f: Awaited<ReturnType<typeof setup>>): void {
  assert.ok(f.captured.length, "must observe the real recovery payload while it exists");
  for (const observed of f.captured) {
    assert.equal(observed.envPresent, false, "MCP env credential body must not enter recovery JSON");
    assert.equal(observed.headerPresent, false, "MCP header credential body must not enter recovery JSON");
    assert.equal(observed.providerPresent, false, "provider API key must remain excluded");
    assert.equal(observed.mode, 0o600);
    assert.deepEqual(observed.before.extensions.mcp, f.config.extensions.mcp);
    assert.deepEqual(observed.after.extensions.mcp, f.config.extensions.mcp);
  }
}

async function assertNormalConfigIsPublic(f: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const raw = await fs.readFile(path.join(f.configRoot, "config.json"), "utf8");
  for (const secret of Object.values(secrets)) assert.equal(raw.includes(secret), false);
  assert.deepEqual((await loadConfigFile(f.configRoot)).extensions.mcp, f.config.extensions.mcp);
}
