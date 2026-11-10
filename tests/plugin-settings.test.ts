import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BINY_AGENT_DIR_ENV, globalPluginRoot } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import {
  installGlobalPluginFromRepository,
  installPluginFromRepository,
  listEnabledGlobalPlugins,
  listEnabledProjectPlugins,
  readGlobalPluginManifest,
  readProjectPluginManifest,
  setGlobalPluginEnabled,
  setGlobalPluginSettings,
  setProjectPluginEnabled,
  setProjectPluginSettings,
  type ManagedPlugin,
  type PluginMarketEntry,
  type ProjectPluginManifest
} from "../src/extensions/pluginRegistry.js";
import { loadPluginsFromRoot, type PluginLoadTarget } from "../src/extensions/plugins.js";
import { ToolRegistry } from "../src/tools/registry.js";

function mockGitHub(files: Record<string, string>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("raw.githubusercontent.com")) {
      const match = /\/main\/(.+)$/u.exec(url);
      const key = match?.[1] ? decodeURIComponent(match[1]) : undefined;
      const content = key !== undefined ? files[key] : undefined;
      if (content === undefined) return new Response("not found", { status: 404 });
      return new Response(content, { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
}

const configurableEntry = {
  id: "configurable-plugin",
  name: "Configurable Plugin",
  version: "1.0.0",
  category: "Tools",
  description: "插件设置测试",
  repository: "https://github.com/Thinkya1/Biny",
  path: "plugins/configurable",
  files: ["index.mjs", "biny-plugin.json"],
  entry: "index.mjs",
  author: { name: "Biny Test" },
  homepage: "https://plugins.example.com/configurable"
};

const plainEntry: PluginMarketEntry = {
  ...configurableEntry,
  id: "plain-plugin",
  files: ["index.mjs"],
  author: undefined,
  homepage: undefined
};

const declaration = {
  configuration: {
    title: "Configurable",
    properties: {
      flag: { type: "boolean", title: "开关", default: true },
      mode: { type: "string", default: "fast", enum: ["fast", "safe"] },
      retries: { type: "number", default: 2, minimum: 0, maximum: 5 },
      note: { type: "string" }
    }
  }
};

function pluginFiles(packageJson: unknown = declaration): Record<string, string> {
  return {
    "plugins/configurable/index.mjs": "export default function register() {}\n",
    "plugins/configurable/biny-plugin.json": JSON.stringify(packageJson)
  };
}

interface ScopeOps {
  pluginRoot: string;
  install(plugin: PluginMarketEntry, files: Record<string, string>): Promise<ManagedPlugin>;
  setEnabled(pluginId: string, enabled: boolean): Promise<ManagedPlugin>;
  setSettings(pluginId: string, settings: unknown): Promise<ManagedPlugin>;
  readManifest(): Promise<ProjectPluginManifest>;
  listEnabled(): Promise<PluginLoadTarget[]>;
}

function scopeOps(scope: "project" | "global", projectRoot: string): ScopeOps {
  const pluginRoot = scope === "global" ? globalPluginRoot() : path.join(projectRoot, ".biny", "plugins");
  return {
    pluginRoot,
    install: async (plugin, files) => scope === "global"
      ? await installGlobalPluginFromRepository({ plugin, fetcher: mockGitHub(files) })
      : await installPluginFromRepository({ workspaceRoot: projectRoot, plugin, fetcher: mockGitHub(files) }),
    setEnabled: async (pluginId, enabled) => scope === "global"
      ? await setGlobalPluginEnabled(pluginId, enabled)
      : await setProjectPluginEnabled(projectRoot, pluginId, enabled),
    setSettings: async (pluginId, settings) => scope === "global"
      ? await setGlobalPluginSettings(pluginId, settings)
      : await setProjectPluginSettings(projectRoot, pluginId, settings),
    readManifest: async () => scope === "global"
      ? await readGlobalPluginManifest()
      : await readProjectPluginManifest(projectRoot),
    listEnabled: async () => scope === "global"
      ? await listEnabledGlobalPlugins()
      : await listEnabledProjectPlugins(projectRoot)
  };
}

async function withScopeRoot(context: TestContext, run: (projectRoot: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-plugin-settings-"));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  context.mock.method(os, "homedir", () => path.join(root, "home"));
  try {
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    await run(projectRoot);
  } finally {
    context.mock.restoreAll();
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const scope of ["project", "global"] as const) {
  test(`${scope} persisted settings reach the registered plugin tool on its next load`, async (context) => {
    await withScopeRoot(context, async (projectRoot) => {
      const ops = scopeOps(scope, projectRoot);
      await ops.install(configurableEntry, {
        ...pluginFiles(),
        "plugins/configurable/index.mjs": `export default function register(context) {
          context.registerTool({
            name: "settings_probe", description: "Read plugin settings", parameters: { type: "object" },
            schema: { parse: () => ({}) },
            resolveExecution: () => ({ approvalRule: "settings_probe", execute: async () => JSON.stringify(context.settings) })
          });
        }`
      });
      await ops.setEnabled("configurable-plugin", true);
      const loadedToolResult = async () => {
        const registry = new ToolRegistry();
        await loadPluginsFromRoot(projectRoot, scope === "project" ? projectRoot : ops.pluginRoot,
          await ops.listEnabled(), configSchema.parse(defaultConfig), registry);
        const execution = await registry.get("settings_probe").resolveExecution({});
        assert.ok(!("isError" in execution));
        return JSON.parse(await execution.execute({ toolCallId: "settings-probe" }) as string) as unknown;
      };
      await ops.setSettings("configurable-plugin", { mode: "safe", retries: 0.5 });
      assert.deepEqual(await loadedToolResult(), { flag: true, mode: "safe", retries: 0.5 });
      await ops.setSettings("configurable-plugin", {});
      assert.deepEqual(await loadedToolResult(), { flag: true, mode: "fast", retries: 2 });
    });
  });

  test(`${scope} plugin install stores the declared configuration and resolves defaults`, async (context) => {
    await withScopeRoot(context, async (projectRoot) => {
      const ops = scopeOps(scope, projectRoot);
      const installed = await ops.install(configurableEntry, pluginFiles());
      assert.equal(installed.author, "Biny Test");
      assert.equal(installed.homepage, "https://plugins.example.com/configurable");
      const manifest = await ops.readManifest();
      const plugin = manifest.plugins[0];
      assert.ok(plugin);
      assert.deepEqual(plugin.configuration, declaration.configuration);
      assert.equal(plugin.settings, undefined, "安装时只记录声明，不预写默认值");
      assert.deepEqual(await ops.listEnabled(), []);
      await ops.setEnabled("configurable-plugin", true);
      const targets = await ops.listEnabled();
      assert.equal(targets.length, 1);
      assert.deepEqual(targets[0]?.settings, { flag: true, mode: "fast", retries: 2 });
    });
  });

  test(`${scope} plugin settings persist validated values and reject invalid input without touching the manifest`, async (context) => {
    await withScopeRoot(context, async (projectRoot) => {
      const ops = scopeOps(scope, projectRoot);
      await ops.install(configurableEntry, pluginFiles());
      await ops.install(plainEntry, { "plugins/configurable/index.mjs": "export default function register() {}\n" });
      await ops.setEnabled("configurable-plugin", true);
      const manifestPath = path.join(ops.pluginRoot, "manifest.json");
      const manifestText = async () => await fs.readFile(manifestPath, "utf8");

      const stored = await ops.setSettings("configurable-plugin", { mode: "safe", note: "hello" });
      assert.deepEqual(stored.settings, { mode: "safe", note: "hello" });
      const targets = await ops.listEnabled();
      assert.equal(targets.length, 1);
      assert.deepEqual(targets[0]?.settings, { flag: true, mode: "safe", retries: 2, note: "hello" });
      const cleared = await ops.setSettings("configurable-plugin", {});
      assert.equal(cleared.settings, undefined, "清空后回到纯默认值，不写空对象");

      const rejections: Array<{ input: unknown; message: RegExp }> = [
        { input: { undeclared: 1 }, message: /未声明/u },
        { input: { constructor: "x" }, message: /未声明/u },
        { input: { mode: 42 }, message: /无效/u },
        { input: { mode: "turbo" }, message: /无效/u },
        { input: { retries: -1 }, message: /无效/u },
        { input: { retries: 99 }, message: /无效/u }
      ];
      for (const { input, message } of rejections) {
        const before = await manifestText();
        await assert.rejects(ops.setSettings("configurable-plugin", input), message);
        assert.equal(await manifestText(), before);
      }
      const before = await manifestText();
      await assert.rejects(ops.setSettings("plain-plugin", { mode: "fast" }), /没有可配置项/u);
      await assert.rejects(ops.setSettings("missing-plugin", { mode: "fast" }), /Plugin 不存在/u);
      assert.equal(await manifestText(), before);
    });
  });

  test(`${scope} plugin update keeps only settings that still satisfy the new declaration`, async (context) => {
    await withScopeRoot(context, async (projectRoot) => {
      const ops = scopeOps(scope, projectRoot);
      const firstDeclaration = {
        configuration: {
          properties: {
            mode: { type: "string", enum: ["fast", "safe"] },
            retries: { type: "number", minimum: 0, maximum: 5 },
            color: { type: "string", enum: ["red", "blue"] }
          }
        }
      };
      await ops.install(configurableEntry, pluginFiles(firstDeclaration));
      await ops.setEnabled("configurable-plugin", true);
      await ops.setSettings("configurable-plugin", { mode: "safe", retries: 3, color: "red" });

      const secondDeclaration = {
        configuration: {
          properties: {
            retries: { type: "number", minimum: 0, maximum: 5 },
            color: { type: "string", enum: ["blue", "green"] },
            speed: { type: "string" }
          }
        }
      };
      const updated = await ops.install(configurableEntry, pluginFiles(secondDeclaration));
      assert.equal(updated.enabled, true, "更新保留启用状态");
      assert.deepEqual(updated.settings, { retries: 3 }, "已删除或不再合法的设置被丢弃");
      const manifest = await ops.readManifest();
      assert.deepEqual(manifest.plugins[0]?.settings, { retries: 3 });
      assert.deepEqual((await ops.listEnabled())[0]?.settings, { retries: 3 });
    });
  });

  test(`${scope} plugin install rejects invalid biny-plugin.json without touching manifest or plugin root`, async (context) => {
    await withScopeRoot(context, async (projectRoot) => {
      const ops = scopeOps(scope, projectRoot);
      const invalidDeclarations: Array<{ name: string; packageJson: unknown }> = [
        { name: "default outside enum", packageJson: { configuration: { properties: { mode: { type: "string", default: "x", enum: ["a", "b"] } } } } },
        { name: "minimum above maximum", packageJson: { configuration: { properties: { retries: { type: "number", minimum: 5, maximum: 1 } } } } },
        { name: "unknown property type", packageJson: { configuration: { properties: { mode: { type: "date" } } } } },
        { name: "extra top-level field", packageJson: { configuration: { properties: { mode: { type: "string" } } }, extra: true } },
        { name: "zero properties", packageJson: { configuration: { properties: {} } } }
      ];
      let index = 0;
      for (const { name, packageJson } of invalidDeclarations) {
        index += 1;
        const pluginId = `bad-${index}`;
        await assert.rejects(
          ops.install({ ...configurableEntry, id: pluginId }, pluginFiles(packageJson)),
          /biny-plugin\.json/u,
          name
        );
        assert.deepEqual((await ops.readManifest()).plugins, []);
        const entries = await fs.readdir(ops.pluginRoot);
        assert.deepEqual(
          entries.filter((entry) => entry === pluginId || entry.startsWith(".install-")),
          [],
          `${name}: failed install must not leave a plugin or temp directory`
        );
      }
    });
  });
}
