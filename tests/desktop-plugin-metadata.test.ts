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
  listEnabledGlobalPlugins,
  listEnabledProjectPlugins,
  readGlobalPluginManifest,
  readProjectPluginManifest,
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
        ...(id === "active"
          ? {
            author: "Fixture Author",
            homepage: "https://example.com/active",
            configuration: {
              title: "Active",
              properties: {
                mode: { type: "string" as const, enum: ["fast", "safe"], default: "fast" },
                retries: { type: "number" as const, minimum: 0, maximum: 5 }
              }
            },
            settings: { mode: "safe" }
          }
          : {}),
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
      const snapshot = async () => (await service.pluginCatalog("project")).plugins.filter((plugin) => plugin.scope === scope);
      const enabledPaths = async () => scope === "global"
        ? await listEnabledGlobalPlugins()
        : await listEnabledProjectPlugins(projectRoot);
      const initial = await snapshot();
      assert.deepEqual(initial.map((plugin) => plugin.status), ["configured", "disabled", "failed", "configured"]);
      assert.deepEqual(initial.map((plugin) => plugin.moduleCount), [2, 2, 2, 2]);
      assert.equal(initial[2]?.error, "Recorded load failure");
      // 受管清单里的元数据字段透传到 summary，其中 settings 只含存储值，不合并默认值。
      assert.equal(initial[0]?.pluginId, "active");
      assert.equal(initial[0]?.entry, "dist/index.mjs");
      assert.deepEqual(initial[0]?.source, { repository: "https://github.com/example/plugins", path: "active", branch: "main" });
      assert.equal(initial[0]?.installedAt, "2026-01-01T00:00:00.000Z");
      assert.equal(initial[0]?.author, "Fixture Author");
      assert.equal(initial[0]?.homepage, "https://example.com/active");
      assert.deepEqual(initial[0]?.configuration, {
        title: "Active",
        properties: {
          mode: { type: "string", enum: ["fast", "safe"], default: "fast" },
          retries: { type: "number", minimum: 0, maximum: 5 }
        }
      });
      assert.deepEqual(initial[0]?.settings, { mode: "safe" });
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
      assert.ok(available[0]?.path.endsWith("/failed/dist/index.mjs"));

      // A fresh snapshot recovers when the same files reappear; legacy metadata is untouched.
      await fs.rm(legacyEntry, { recursive: true });
      for (const plugin of [plugins[0]!, plugins[1]!, plugins[3]!]) {
        await fs.writeFile(path.join(pluginRoot, plugin.directory, plugin.entry), "// restored inert entry\n");
      }
      assert.deepEqual(await snapshot(), initial);
      assert.equal(await fs.readFile(manifestPath, "utf8"), manifestText);

      const directories: string[] = [];
      const readDirectory = fs.readdir.bind(fs);
      context.mock.method(fs, "readdir", ((...args: Parameters<typeof fs.readdir>) => {
        directories.push(String(args[0]));
        return readDirectory(...args);
      }) as typeof fs.readdir);
      const target = path.join(pluginRoot, "legacy-version-directory");
      const disabled = await service.setPluginEnabled("project", "legacy", false, scope);
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.status, "disabled");
      assert.equal(disabled.moduleCount, 2);
      assert.equal(disabled.path, initial[3]?.path, "the manifest owns the installed directory, not the plugin id");
      assert.deepEqual(directories, [target, path.join(target, "dist")], "one toggle inspects only the target plugin once");

      directories.length = 0;
      await fs.rm(path.join(target, "dist", "index.mjs"));
      const missing = await service.setPluginEnabled("project", "legacy", true, scope);
      assert.equal(missing.enabled, true);
      assert.equal(missing.status, "missing", "successful persistence does not hide a missing entry");
      assert.equal(missing.moduleCount, 1);
      assert.deepEqual(directories, [target, path.join(target, "dist")]);
      const savedManifest = await fs.readFile(manifestPath, "utf8");
      await assert.rejects(service.setPluginEnabled("project", "absent", true, scope), /Plugin 不存在/u);
      assert.equal(await fs.readFile(manifestPath, "utf8"), savedManifest, "a failed toggle preserves the manifest");

      // 设置 IPC 校验声明后写入清单，返回该作用域内目标插件的最新 summary。
      const configured = await service.setPluginSettings("project", "active", { retries: 4 }, scope);
      assert.equal(configured.pluginId, "active");
      assert.deepEqual(configured.settings, { retries: 4 });
      const persistedSettings = (scope === "global" ? await readGlobalPluginManifest() : await readProjectPluginManifest(projectRoot))
        .plugins.find((plugin) => plugin.id === "active")?.settings;
      assert.deepEqual(persistedSettings, { retries: 4 });
    } finally {
      context.mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
