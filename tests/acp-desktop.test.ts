import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { settingsSaveInputSchema, modelConfigurationSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";

test("Desktop saves ACP through its settings transaction, exposes launch configuration and probes without an API request", { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-desktop-"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config"), credentialStore: {
    persistent: true, get: async () => undefined, set: async () => {}, delete: async () => {}
  } });
  const projects = new DesktopProjectService(state, storage, configStore);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  try {
    await storage.initialize(); await state.load();
    const project = await projects.createEmptyProject(path.join(root, "workspace"));
    const input = modelConfigurationSchema.parse({ alias: "external", providerAlias: "external", providerType: "acp", displayName: "External", model: "default",
      makeDefault: true, supportsTools: true, requiresApiKey: false, acp: { command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] } });
    const settings = new DesktopSettingsTransaction(state, manager);
    const before = await settings.snapshot(project.id);
    const saved = await settings.save(project.id, settingsSaveInputSchema.parse({
      expectedPreferenceRevision: before.preferenceRevision, expectedConfigRevision: before.configRevision,
      models: { upserts: [input], removeAliases: [] }
    }));
    assert.equal(saved.status, "committed");
    const after = await settings.snapshot(project.id);
    assert.deepEqual(after.models.connections.find((connection) => connection.providerAlias === "external")?.acp, input.acp);
    assert.equal(after.models.configured.find((model) => model.alias === "external")?.available, true);
    assert.equal((await configStore.load(project.path)).providers.external?.acp?.command, process.execPath);
    const connected = await manager.testModelConfiguration(project.id, input);
    assert.equal(connected.ok, true, connected.message);
    assert.deepEqual(connected.acp?.models, [{ id: "test", name: "Test model" }]);
    // 真实探测失败必须说明登录的下一步，且候选启动参数不能污染已保存连接。
    const needsLogin = await manager.testModelConfiguration(project.id, {
      ...input, acp: { ...input.acp!, args: [...input.acp!.args, "--auth-required"] }
    });
    assert.equal(needsLogin.ok, false);
    assert.match(needsLogin.message, /登录.*重新连接/u);
    assert.deepEqual((await configStore.load(project.path)).providers.external?.acp, input.acp);
  } finally { await manager.closeAll(); await rm(root, { recursive: true, force: true }); }
});
