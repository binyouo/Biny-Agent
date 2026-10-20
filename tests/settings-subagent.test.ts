import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import { prepareSubagentTask } from "../src/extensions/subagent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { InMemoryModelsStore } from "../src/llm/ModelsStore.js";

test("Subagent defaults round-trip through real settings transactions without losing limits; stale or invalid runtime saves cannot replace them", { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-settings-code-mode-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const configRoot = path.join(root, "agent");
  process.env.BINY_AGENT_DIR = configRoot;
  let manager: DesktopAgentManager | undefined;
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await mkdir(path.join(workspace, ".git"));
    const config = structuredClone(defaultConfig);
    config.providers.worker = { type: "acp", acp: { command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] } } as typeof config.providers[string];
    config.models.worker = { provider: "worker", model: "test", supportsTools: true } as typeof config.models[string];
    config.permission.mode = "full-access";
    config.permission.denyPaths = [];
    config.context.memory.enabled = false;
    config.context.identity.enabled = false;
    config.checkpoints.enabled = false;
    config.chat.skillExtraction.enabled = false;
    await saveConfigFile(configRoot, config);
    const credentials = new Map<string, string>();
    const store = new DesktopConfigStore(configRoot, { persistent: true,
      get: async (key) => credentials.get(key), set: async (key, value) => { credentials.set(key, value); },
      delete: async (key) => { credentials.delete(key); }
    });
    const state = new DesktopStateStore(path.join(root, "desktop.json"));
    await state.load();
    const projects = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "desktop")), store);
    const project = await projects.createProject(workspace);
    manager = new DesktopAgentManager(state, projects, store, () => {}, async () => {}, new InMemoryModelsStore(),
      async () => { throw new Error("Unexpected network request"); });
    const transaction = new DesktopSettingsTransaction(state, manager);
    const originalSubagent = (await loadConfigFile(configRoot)).extensions.subagent;
    const before = await transaction.snapshot(project.id);
    const input = { expectedPreferenceRevision: before.preferenceRevision, expectedConfigRevision: before.configRevision,
      subagent: { enabled: true, runtime: "codex" as const, model: "gpt-5.4" } };
    const saved = await transaction.save(project.id, settingsSaveInputSchema.parse(input));
    assert.equal(saved.status, "committed", JSON.stringify(saved));
    assert.deepEqual(saved.appliedFields, ["subagent"]);
    assert.deepEqual(saved.snapshot.subagent, { ...input.subagent, providerAlias: undefined });
    const stored = await loadConfigFile(configRoot);
    assert.deepEqual(stored.extensions.subagent, { ...originalSubagent, ...input.subagent });
    assert.deepEqual((await transaction.snapshot(project.id)).subagent, { ...input.subagent, providerAlias: undefined });
    const stale = await transaction.save(project.id, { ...input, subagent: { enabled: false, runtime: "builtin" } });
    assert.equal(stale.status, "rolled_back");
    assert.equal((await loadConfigFile(configRoot)).extensions.subagent.runtime, "codex");
    assert.throws(() => settingsSaveInputSchema.parse({ ...input, subagent: { enabled: true, runtime: "shell", model: "x" } }));
    assert.throws(() => settingsSaveInputSchema.parse({ ...input, subagent: { enabled: true, runtime: "codex" } }));
    const latest = await transaction.snapshot(project.id);
    const wrongProvider = await transaction.save(project.id, { expectedPreferenceRevision: latest.preferenceRevision,
      expectedConfigRevision: latest.configRevision, subagent: { enabled: true, runtime: "acp", model: stored.defaultModel } });
    assert.equal(wrongProvider.status, "rolled_back");
    assert.equal((await loadConfigFile(configRoot)).extensions.subagent.runtime, "codex");
    const mismatch = await transaction.save(project.id, { expectedPreferenceRevision: latest.preferenceRevision,
      expectedConfigRevision: latest.configRevision, subagent: { enabled: true, runtime: "acp", providerAlias: "another-worker", model: "worker" } });
    assert.equal(mismatch.status, "rolled_back", "The selected Agent and model must belong to the same connection");
    const current = await transaction.snapshot(project.id);
    const selected = await transaction.save(project.id, { expectedPreferenceRevision: current.preferenceRevision,
      expectedConfigRevision: current.configRevision, subagent: { enabled: true, runtime: "acp", providerAlias: "worker", model: "worker" } });
    assert.equal(selected.status, "committed", JSON.stringify(selected));
    assert.equal(selected.snapshot.subagent.providerAlias, "worker");
    const worker = await prepareSubagentTask({ workspaceRoot: workspace, config: await store.load(workspace),
      toolRegistry: new ToolRegistry(), getModelSettings: () => { throw new Error("Must use selected ACP runtime"); } }, "Inspect settings", "workspace");
    try { assert.match(await worker.run(), /Reply 1/); } finally { await worker.close(); }
    const providerDefaultBefore = await transaction.snapshot(project.id);
    const providerDefault = await transaction.save(project.id, { expectedPreferenceRevision: providerDefaultBefore.preferenceRevision,
      expectedConfigRevision: providerDefaultBefore.configRevision,
      subagent: { enabled: true, runtime: "acp", providerAlias: "worker" } });
    assert.equal(providerDefault.status, "committed", JSON.stringify(providerDefault));
    assert.deepEqual(providerDefault.snapshot.subagent, { enabled: true, runtime: "acp", providerAlias: "worker", model: undefined });
    assert.equal((await loadConfigFile(configRoot)).extensions.subagent.model, undefined);
    const defaultModelWorker = await prepareSubagentTask({ workspaceRoot: workspace, config: await store.load(workspace),
      toolRegistry: new ToolRegistry(), getModelSettings: () => { throw new Error("Must use the selected ACP provider default model"); } }, "Inspect settings", "workspace");
    try { assert.match(await defaultModelWorker.run(), /Reply 1/); } finally { await defaultModelWorker.close(); }
    const disconnected = await loadConfigFile(configRoot);
    disconnected.providers.worker!.enabled = false;
    await saveConfigFile(configRoot, disconnected);
    const unavailable = await transaction.snapshot(project.id);
    const disabled = await transaction.save(project.id, { expectedPreferenceRevision: unavailable.preferenceRevision,
      expectedConfigRevision: unavailable.configRevision, subagent: { ...unavailable.subagent, enabled: false } });
    assert.equal(disabled.status, "committed", "A disabled provider must not prevent turning subagents off");
    assert.equal((await loadConfigFile(configRoot)).extensions.subagent.enabled, false);
    const claudeBefore = await transaction.snapshot(project.id);
    const claude = await transaction.save(project.id, settingsSaveInputSchema.parse({ expectedPreferenceRevision: claudeBefore.preferenceRevision,
      expectedConfigRevision: claudeBefore.configRevision, subagent: { enabled: true, runtime: "claude-code" } }));
    assert.equal(claude.status, "committed", JSON.stringify(claude));
    assert.equal((await loadConfigFile(configRoot)).extensions.subagent.model, undefined);
    assert.equal(claude.snapshot.subagent.runtime, "claude-code");
    const autoBefore = await transaction.snapshot(project.id);
    const auto = await transaction.save(project.id, settingsSaveInputSchema.parse({ expectedPreferenceRevision: autoBefore.preferenceRevision,
      expectedConfigRevision: autoBefore.configRevision, subagent: { enabled: true, runtime: "auto" } }));
    assert.equal(auto.status, "committed", JSON.stringify(auto));
    assert.equal(auto.snapshot.subagent.runtime, "auto");
    assert.equal((await loadConfigFile(configRoot)).extensions.subagent.runtime, "auto");
  } finally {
    await manager?.closeAll();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
