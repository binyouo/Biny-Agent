import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConfig, loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import type { CredentialStore } from "../src/config/credentials.js";

const credentials: CredentialStore = {
  persistent: false,
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined
};

for (const operation of ["initialize", "save", "file update", "desktop update"] as const) {
  test(`${operation} omits unused image generation settings for older Desktop readers`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-image-config-")));
    try {
      if (operation === "initialize") {
        await ensureConfig(root, { globalDir: root });
      } else {
        await saveConfigFile(root, configSchema.parse(defaultConfig));
        if (operation !== "save") {
          // A newer client previously materialized an empty imageGen section.
          const file = path.join(root, "config.json");
          const document = JSON.parse(await fs.readFile(file, "utf8"));
          document.imageGen = {};
          await fs.writeFile(file, JSON.stringify(document));
          const store = operation === "file update"
            ? createFileConfigStore(root, { globalDir: root, credentialStore: credentials })
            : new DesktopConfigStore(root, credentials);
          await updateConfig(store, root, config => ({ ...config, toolModel: "deepseek-v4-pro" }));
          assert.equal((await loadConfigFile(root)).toolModel, "deepseek-v4-pro");
        }
      }
      const document = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8"));
      assert.equal(Object.hasOwn(document, "imageGen"), false,
        "an unused feature must not add a root key rejected by released Desktop builds");
      assert.deepEqual((await loadConfigFile(root)).imageGen, { model: undefined, aspectRatio: undefined });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("saving preserves explicit image generation settings and does not mutate the caller", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-image-config-")));
  try {
    for (const imageGen of [
      { model: "gem:gemini-2.5-flash-image" },
      { aspectRatio: "16:9" },
      { model: "oai:gpt-image-1", aspectRatio: "1:1" }
    ]) {
      const config = configSchema.parse({ ...defaultConfig, imageGen });
      const before = structuredClone(config);
      await saveConfigFile(root, config);
      const document = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8"));
      assert.deepEqual(document.imageGen, imageGen);
      assert.deepEqual((await loadConfigFile(root)).imageGen, before.imageGen);
      assert.deepEqual(config, before);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
