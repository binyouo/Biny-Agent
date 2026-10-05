import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopSkillService } from "../src/desktop/electron/main/DesktopSkillService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import {
  listEnabledGlobalPluginPaths,
  listEnabledProjectPluginPaths,
  type ManagedPlugin
} from "../src/extensions/pluginRegistry.js";

for (const scope of ["project", "global"] as const) {
  test(`${scope} plugin metadata checks the declared entry without executing modules`, async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-plugin-metadata-"));
    const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
    process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
    context.mock.method(os, "homedir", () => path.join(root, "home"));
    try {
      const projectRoot = path.join(root, "project");
      await fs.mkdir(projectRoot);
      const state = new DesktopStateStore(path.join(root, "desktop.json"));
      await state.upsertProject({
        id: "project", path: projectRoot, name: "Project", dirty: false, missing: false, pinned: false,
        addedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z"
      });
      const pluginRoot = scope === "global"
        ? path.join(root, "global", "plugins")
        : path.join(projectRoot, ".biny", "plugins");
      const plugins: ManagedPlugin[] = ["active", "disabled", "failed", "legacy"].map((id) => ({
        id,
        name: `${id} fixture`,
        version: "1.0.0",
        category: "Tools",
        description: "Public metadata fixture",
        directory: id === "legacy" ? "legacy-version-directory" : id,
        entry: "dist/index.mjs",
        enabled: id !== "disabled",
        installedAt: "2026-01-01T00:00:00.000Z",
        error: id === "failed" ? "Recorded load failure" : undefined,
        ...(id === "legacy"
          ? { sizeBytes: 123, sha256: "a".repeat(64) }
          : { source: { repository: "https://github.com/example/plugins", path: id, branch: "main" } })
      }));
      // Inert files are only counted/stat'ed. Never install, import or execute a plugin.
      for (const plugin of plugins) {
        const directory = path.join(pluginRoot, plugin.directory);
        await fs.mkdir(path.join(directory, "dist"), { recursive: true });
        await fs.writeFile(path.join(directory, "helper.mjs"), "// inert helper fixture\n");
        await fs.writeFile(path.join(directory, plugin.entry), "// inert entry fixture\n");
      }
      const manifestPath = path.join(pluginRoot, "manifest.json");
      const manifestText = `${JSON.stringify({ format: 1, plugins }, null, 2)}\n`;
      await fs.writeFile(manifestPath, manifestText);
      const service = new DesktopSkillService(state, {
        load: async () => configSchema.parse(defaultConfig),
        save: async () => { throw new Error("Unexpected configuration write"); }
      }, async () => { throw new Error("Unexpected network request"); });
      const snapshot = async () => (await service.snapshot("project")).plugins.filter((plugin) => plugin.scope === scope);
      const enabledPaths = async () => scope === "global"
        ? await listEnabledGlobalPluginPaths()
        : await listEnabledProjectPluginPaths(projectRoot);
      const initial = await snapshot();
      assert.deepEqual(initial.map((plugin) => plugin.status), ["configured", "disabled", "failed", "configured"]);
      assert.deepEqual(initial.map((plugin) => plugin.moduleCount), [2, 2, 2, 2]);
      assert.equal(initial[2]?.error, "Recorded load failure");
      assert.equal((await enabledPaths()).length, 3);

      // Helpers remain, so a directory-wide module count cannot detect these missing entries.
      for (const plugin of [plugins[0]!, plugins[1]!, plugins[3]!]) {
        await fs.rm(path.join(pluginRoot, plugin.directory, plugin.entry));
      }
      const legacyEntry = path.join(pluginRoot, plugins[3]!.directory, plugins[3]!.entry);
      await fs.mkdir(legacyEntry);
      await fs.writeFile(path.join(legacyEntry, "unrelated.mjs"), "// inert nested fixture\n");
      const broken = await snapshot();
      assert.deepEqual(broken.map((plugin) => plugin.status), ["missing", "missing", "failed", "missing"]);
      assert.deepEqual(broken.map((plugin) => plugin.moduleCount), [1, 1, 2, 2]);
      assert.deepEqual(broken.map((plugin) => plugin.enabled), initial.map((plugin) => plugin.enabled));
      assert.deepEqual(broken.map((plugin) => plugin.path), initial.map((plugin) => plugin.path));
      assert.equal(broken[2]?.error, "Recorded load failure");
      const available = await enabledPaths();
      assert.equal(available.length, 1);
      assert.ok(available[0]?.endsWith("/failed/dist/index.mjs"));

      // A fresh snapshot recovers when the same files reappear; legacy metadata is untouched.
      await fs.rm(legacyEntry, { recursive: true });
      for (const plugin of [plugins[0]!, plugins[1]!, plugins[3]!]) {
        await fs.writeFile(path.join(pluginRoot, plugin.directory, plugin.entry), "// restored inert entry\n");
      }
      assert.deepEqual(await snapshot(), initial);
      assert.equal(await fs.readFile(manifestPath, "utf8"), manifestText);
    } finally {
      context.mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
