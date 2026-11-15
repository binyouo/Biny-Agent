/** Real installer/manifest/filesystem; downloads are inert synthetic responses. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { globalPluginRoot } from "../src/config/paths.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopSkillService } from "../src/desktop/electron/main/DesktopSkillService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import {
  BINY_PLUGIN_REGISTRY_URL, installGlobalPluginFromRepository, installPluginFromRepository,
  parsePluginRegistry, projectPluginRoot, readGlobalPluginManifest, readProjectPluginManifest,
  setGlobalPluginEnabled, setProjectPluginEnabled, writeGlobalPluginManifest, writeProjectPluginManifest,
  type ManagedPlugin, type ProjectPluginManifest
} from "../src/extensions/pluginRegistry.js";

const plugin = parsePluginRegistry({ format: 1, plugins: [{
  id: "example", name: "Market Example", version: "2", category: "Tools", description: "Synthetic fixture",
  repository: "https://github.com/example/plugins", path: "example", files: ["index.mjs"], entry: "index.mjs"
}] }).plugins[0]!;
const replacement = "/* SYNTHETIC REPLACEMENT; NEVER IMPORTED */";

async function fixture(t: TestContext, scope: "project" | "global") {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-plugin-ownership-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  t.after(async () => {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const pluginsRoot = scope === "project" ? projectPluginRoot(workspace) : globalPluginRoot();
  await mkdir(pluginsRoot, { recursive: true });
  const target = path.join(pluginsRoot, plugin.id);
  const fetcher: typeof fetch = async input => {
    assert.equal(String(input), "https://raw.githubusercontent.com/example/plugins/main/example/index.mjs");
    return new Response(replacement);
  };
  const install = (download = fetcher) => scope === "project"
    ? installPluginFromRepository({ workspaceRoot: workspace, plugin, fetcher: download })
    : installGlobalPluginFromRepository({ plugin, fetcher: download });
  const manifest = () => scope === "project" ? readProjectPluginManifest(workspace) : readGlobalPluginManifest();
  const writeManifest = (value: ProjectPluginManifest) => scope === "project"
    ? writeProjectPluginManifest(workspace, value) : writeGlobalPluginManifest(value);
  const enable = () => scope === "project" ? setProjectPluginEnabled(workspace, plugin.id, true) : setGlobalPluginEnabled(plugin.id, true);
  const createUnmanaged = async () => {
    await mkdir(target);
    await writeFile(path.join(target, "local.mjs"), "/* LOCAL CUSTOM SOURCE; NEVER IMPORTED */");
    await writeFile(path.join(target, "notes.txt"), "UNSELECTED USER CONTENT");
  };
  const assertUnmanagedRetained = async () => {
    assert.equal(await readFile(path.join(target, "notes.txt"), "utf8"), "UNSELECTED USER CONTENT");
    assert.equal(await readFile(path.join(target, "local.mjs"), "utf8"), "/* LOCAL CUSTOM SOURCE; NEVER IMPORTED */");
    assert.deepEqual((await readdir(target)).sort(), ["local.mjs", "notes.txt"]);
    assert.deepEqual((await readdir(pluginsRoot)).filter(name => /^\.(install|backup)-/u.test(name)), []);
  };
  return { root, workspace, pluginsRoot, target, fetcher, install, manifest, writeManifest, enable,
    createUnmanaged, assertUnmanagedRetained };
}

for (const scope of ["project", "global"] as const) {
  for (const scenario of ["unmanaged", "wrong-directory", "appeared-during-download"] as const) {
    test(`${scope} install preserves an existing ${scenario} directory`, async t => {
      const h = await fixture(t, scope);
      if (scenario !== "appeared-during-download") await h.createUnmanaged();
      if (scenario === "wrong-directory") {
        await mkdir(path.join(h.pluginsRoot, "original"));
        await writeFile(path.join(h.pluginsRoot, "original", "index.mjs"), "ORIGINAL MANAGED SOURCE");
        const old: ManagedPlugin = {
          id: plugin.id, name: "Original", version: "1", category: "Tools", description: "fixture",
          directory: "original", entry: "index.mjs", enabled: true, installedAt: "2026-01-01T00:00:00.000Z"
        };
        await h.writeManifest({ format: 1, plugins: [old] });
      }
      const before = await h.manifest();
      const manifestPath = path.join(h.pluginsRoot, "manifest.json");
      const beforeBytes = scenario === "wrong-directory" ? await readFile(manifestPath) : undefined;
      const download: typeof fetch = async (...args) => {
        if (scenario === "appeared-during-download") await h.createUnmanaged();
        return h.fetcher(...args);
      };
      await assert.rejects(h.install(download), /受管|所有权|未登记/u);
      await h.assertUnmanagedRetained();
      assert.deepEqual(await h.manifest(), before);
      if (beforeBytes) {
        assert.deepEqual(await readFile(manifestPath), beforeBytes);
        assert.equal(await readFile(path.join(h.pluginsRoot, "original", "index.mjs"), "utf8"), "ORIGINAL MANAGED SOURCE");
      } else {
        await assert.rejects(access(manifestPath), { code: "ENOENT" });
      }
    });
  }

  test(`${scope} fresh install and genuine managed replacement remain supported`, async t => {
    const h = await fixture(t, scope);
    await h.install(async () => new Response("/* FIRST MANAGED VERSION */"));
    await h.enable();
    const updated = await h.install();
    assert.equal(updated.enabled, true);
    assert.equal(updated.directory, plugin.id);
    assert.equal(await readFile(path.join(h.target, "index.mjs"), "utf8"), replacement);
    assert.equal((await h.manifest()).plugins.length, 1);
    assert.deepEqual((await readdir(h.pluginsRoot)).filter(name => /^\.(install|backup)-/u.test(name)), []);
  });

  test(`${scope} reinstall repairs a missing managed directory`, async t => {
    const h = await fixture(t, scope);
    await h.install();
    await h.enable();
    await rm(h.target, { recursive: true });
    const repaired = await h.install();
    assert.equal(repaired.enabled, true);
    assert.equal(await readFile(path.join(h.target, "index.mjs"), "utf8"), replacement);
    assert.equal((await h.manifest()).plugins.length, 1);
  });
}

test("Desktop market installation cannot replace a configured unmanaged plugin", async t => {
  const h = await fixture(t, "project");
  await h.createUnmanaged();
  const state = new DesktopStateStore(path.join(h.root, "state.json"));
  await state.load();
  await state.upsertProject({
    id: "project", path: h.workspace, name: "Fixture", addedAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z", missing: false, pinned: false
  });
  const config = createFileConfigStore(h.workspace, { globalDir: path.join(h.root, "config") });
  await config.save({
    ...structuredClone(defaultConfig),
    extensions: { ...defaultConfig.extensions, plugins: [".biny/plugins/example"] }
  });
  const service = new DesktopSkillService(state, config, async (...args) => {
    if (String(args[0]) === BINY_PLUGIN_REGISTRY_URL) return Response.json({ format: 1, plugins: [plugin] });
    return h.fetcher(...args);
  });
  const before = await service.pluginCatalog("project");
  assert.ok(before.plugins.some(item => item.path === ".biny/plugins/example" && item.status === "configured"));
  await assert.rejects(service.installPlugin("project", plugin.id), /受管|所有权|未登记/u);
  await h.assertUnmanagedRetained();
  assert.deepEqual((await h.manifest()).plugins, []);
});
