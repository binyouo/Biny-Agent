import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { providerCredentialAccount, CREDENTIAL_TRANSACTION_JOURNAL, type CredentialStore } from "../src/config/credentials.js";
import { saveConfigFile } from "../src/config/loader.js";
import { defaultConfig } from "../src/config/schema.js";
import { saveProjectSettings } from "../src/config/projectSettings.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";

for (const kind of ["file", "desktop"] as const) {
  for (const mode of ["persistent", "unavailable", "partial-failure"] as const) {
    test(`${kind}: inline credentials migrate atomically or retain their source (${mode})`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-contract-"));
      const values = new Map<string, string>();
      let fail = mode === "partial-failure";
      const credentials: CredentialStore = {
        persistent: mode !== "unavailable",
        get: async key => values.get(key),
        set: async (key, value) => {
          values.set(key, value);
          if (fail && key === providerCredentialAccount("deepseek", "refreshToken")) {
            fail = false;
            throw new Error("Injected partial write failure");
          }
        },
        delete: async key => { values.delete(key); }
      };
      try {
        const config = structuredClone(defaultConfig);
        config.providers.deepseek!.apiKey = "synthetic-inline-key";
        config.providers.deepseek!.oauth = { provider: "synthetic", expiresAt: 1, refreshToken: "synthetic-inline-refresh" };
        await fs.writeFile(path.join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
        const store = kind === "file" ? createFileConfigStore(root, { globalDir: root, credentialStore: credentials }) : new DesktopConfigStore(root, credentials);
        const source = await fs.readFile(path.join(root, "config.json"), "utf8");
        if (mode !== "persistent") {
          await assert.rejects(store.load(), mode === "unavailable" ? /apiKeyEnv/ : /Injected partial write failure/);
          assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), source);
          if (mode === "unavailable") return;
        }
        const loaded = await store.load();
        assert.equal(loaded.providers.deepseek?.apiKey, "synthetic-inline-key");
        assert.equal(loaded.providers.deepseek?.oauth?.refreshToken, "synthetic-inline-refresh");
        const document = await fs.readFile(path.join(root, "config.json"), "utf8");
        assert.equal(document.includes("synthetic-inline"), false);
        assert.equal(values.get(providerCredentialAccount("deepseek", "apiKey")), "synthetic-inline-key");
        const revision = store.revision!();
        assert.deepEqual(await store.load(), loaded);
        assert.equal(store.revision!(), revision, "repeat load must not migrate again");
        await assert.rejects(fs.access(path.join(root, CREDENTIAL_TRANSACTION_JOURNAL)), { code: "ENOENT" });
        for (const file of await fs.readdir(root)) {
          if (file.endsWith(".json")) assert.equal((await fs.readFile(path.join(root, file), "utf8")).includes("synthetic-inline"), false);
        }
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
  }
  test(`${kind}: deferred save rejects hidden global edits before publication`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-deferred-"));
    try {
      const credentials: CredentialStore = { persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {} };
      await saveConfigFile(root, structuredClone(defaultConfig));
      await saveProjectSettings(root, { defaultModel: "deepseek-v4-flash" });
      const store = kind === "file" ? createFileConfigStore(root, { globalDir: root, credentialStore: credentials }) : new DesktopConfigStore(root, credentials);
      const before = await store.loadVersioned!();
      const candidate = structuredClone(before.config);
      candidate.defaultModel = "deepseek-v4-pro";
      await assert.rejects(store.saveVersionedDeferred!(candidate, before.revision, "settings-test"), /项目设置覆盖/);
      assert.deepEqual(await store.loadVersioned!(), before);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8")).defaultModel, defaultConfig.defaultModel);
      await assert.rejects(fs.access(path.join(root, CREDENTIAL_TRANSACTION_JOURNAL)), { code: "ENOENT" });
      candidate.defaultModel = before.config.defaultModel;
      candidate.agent.maxConcurrentTools += 1;
      const saved = await store.saveVersionedDeferred!(candidate, before.revision, "settings-test");
      assert.equal(saved.config.defaultModel, "deepseek-v4-flash");
      assert.deepEqual(saved, await store.loadVersioned!());
      await store.finalizeDeferredCredentials!("settings-test");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const kind of ["file", "desktop"] as const) {
  test(`${kind}: deferred credentials use the effective revision and protect third-party writes`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-deferred-credentials-"));
    const values = new Map<string, string>();
    const credentials: CredentialStore = { persistent: true, get: async key => values.get(key), set: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); } };
    try {
      await saveConfigFile(root, structuredClone(defaultConfig));
      await saveProjectSettings(root, { defaultModel: "deepseek-v4-flash" });
      const file = createFileConfigStore(root, { globalDir: root, credentialStore: credentials });
      const desktop = new DesktopConfigStore(root, credentials);
      const [writer, reader] = kind === "file" ? [file, desktop] : [desktop, file];
      const before = await writer.loadVersioned!();
      const target = structuredClone(before.config);
      target.providers.deepseek!.apiKey = "synthetic-deferred-key";
      const saved = await writer.saveVersionedDeferred!(target, before.revision, "settings-finalize");
      assert.equal(saved.config.defaultModel, "deepseek-v4-flash");
      assert.notEqual(saved.revision, before.revision);
      assert.deepEqual(await reader.loadVersioned!(), saved);
      assert.equal(await reader.deferredCredentialStatus!("settings-finalize"), "target");
      await reader.finalizeDeferredCredentials!("settings-finalize");
      assert.equal(values.get(providerCredentialAccount("deepseek", "apiKey")), "synthetic-deferred-key");
      const rollbackTarget = structuredClone(saved.config);
      rollbackTarget.agent.maxConcurrentTools += 1;
      rollbackTarget.providers.deepseek!.apiKey = "synthetic-rollback-key";
      const second = await writer.saveVersionedDeferred!(rollbackTarget, saved.revision, "settings-rollback");
      assert.equal(await reader.rollbackVersionedDeferred!(saved.config, second.revision, "settings-rollback"), "completed");
      assert.deepEqual(await writer.loadVersioned!(), saved);
      const third = await writer.saveVersionedDeferred!(rollbackTarget, saved.revision, "settings-third-party");
      const outsider = structuredClone(third.config);
      outsider.agent.maxConcurrentTools += 1;
      await saveConfigFile(root, outsider);
      assert.equal(await reader.rollbackVersionedDeferred!(saved.config, third.revision, "settings-third-party"), "failed");
      assert.equal(values.get(providerCredentialAccount("deepseek", "apiKey")), "synthetic-rollback-key");
      assert.equal(JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8")).agent.maxConcurrentTools, outsider.agent.maxConcurrentTools);
      await fs.access(path.join(root, CREDENTIAL_TRANSACTION_JOURNAL));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
