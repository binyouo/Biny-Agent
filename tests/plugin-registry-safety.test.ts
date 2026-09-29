import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  installPluginFromRepository, parsePluginRegistry, projectPluginRoot,
  readProjectPluginManifest, setProjectPluginEnabled, uninstallProjectPlugin, writeProjectPluginManifest
} from "../src/extensions/pluginRegistry.js";

if (process.argv[2] === "enable-worker") {
  process.once("message", () => {
    void setProjectPluginEnabled(process.argv[3]!, process.argv[4]!, true).then(
      () => process.disconnect(),
      (error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect(); }
    );
  });
  process.send?.("ready");
} else {
  for (const kind of ["file", "symlink"] as const) {
    test(`refusing to replace a plugin ${kind} preserves the original entry`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-plugin-refused-"));
      try {
        const pluginRoot = projectPluginRoot(root);
        await fs.mkdir(pluginRoot, { recursive: true });
        const target = path.join(pluginRoot, "example");
        const source = path.join(root, "user-data");
        await fs.writeFile(source, "keep this data");
        if (kind === "file") await fs.writeFile(target, "keep this entry");
        else await fs.symlink(source, target);
        const plugin = parsePluginRegistry({ format: 1, plugins: [{
          id: "example", name: "Example", version: "1", category: "Tools", description: "Fixture",
          repository: "https://github.com/example/plugins", path: "example", files: ["index.mjs"], entry: "index.mjs"
        }] }).plugins[0]!;
        await assert.rejects(installPluginFromRepository({
          workspaceRoot: root, plugin, fetcher: async () => new Response("export default () => {};")
        }), /不安全/u);
        if (kind === "file") assert.equal(await fs.readFile(target, "utf8"), "keep this entry");
        else assert.equal(await fs.readlink(target), source);
        assert.equal(await fs.readFile(source, "utf8"), "keep this data");
        assert.deepEqual((await readProjectPluginManifest(root)).plugins, []);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  test("a failed manifest write during uninstall restores the installed files", async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-plugin-uninstall-"));
    try {
      const directory = path.join(projectPluginRoot(root), "example");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "index.mjs"), "original plugin");
      await writeProjectPluginManifest(root, { format: 1, plugins: [{
        id: "example", directory: "example", name: "Example", version: "1", category: "Tools",
        description: "Fixture", entry: "index.mjs", enabled: true, installedAt: new Date().toISOString()
      }] });
      const rename = fs.rename;
      const fault = context.mock.method(fs, "rename", async (source: string, target: string) => {
        if (target === path.join(projectPluginRoot(root), "manifest.json")) throw new Error("manifest unavailable");
        await rename(source, target);
      });
      await assert.rejects(uninstallProjectPlugin(root, "example"), /manifest unavailable/u);
      fault.mock.restore();
      assert.equal(await fs.readFile(path.join(directory, "index.mjs"), "utf8"), "original plugin");
      assert.equal((await readProjectPluginManifest(root)).plugins[0]?.enabled, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  for (const failure of ["manifest", "cleanup"] as const) {
    test(`plugin update ${failure} failure keeps files consistent with the manifest`, async (context) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-plugin-update-"));
      try {
        const plugin = parsePluginRegistry({ format: 1, plugins: [{
          id: "example", name: "Example", version: "1", category: "Tools", description: "Fixture",
          repository: "https://github.com/example/plugins", path: "example", files: ["index.mjs"], entry: "index.mjs"
        }] }).plugins[0]!;
        await installPluginFromRepository({ workspaceRoot: root, plugin, fetcher: async () => new Response("version 1") });
        await setProjectPluginEnabled(root, plugin.id, true);
        const rename = fs.rename;
        const remove = fs.rm;
        const fault = failure === "manifest"
          ? context.mock.method(fs, "rename", async (source: string, target: string) => {
            if (target === path.join(projectPluginRoot(root), "manifest.json")) throw new Error("manifest unavailable");
            await rename(source, target);
          })
          : context.mock.method(fs, "rm", async (target: string, options?: Parameters<typeof fs.rm>[1]) => {
            if (path.basename(target).startsWith(".backup-")) throw new Error("cleanup unavailable");
            await remove(target, options);
          });
        await assert.rejects(installPluginFromRepository({
          workspaceRoot: root, plugin: { ...plugin, version: "2" }, fetcher: async () => new Response("version 2")
        }), new RegExp(`${failure} unavailable`, "u"));
        fault.mock.restore();
        const expectedVersion = failure === "manifest" ? "1" : "2";
        const entry = (await readProjectPluginManifest(root)).plugins[0]!;
        assert.equal(entry.version, expectedVersion);
        assert.equal(entry.enabled, true);
        assert.equal(await fs.readFile(path.join(projectPluginRoot(root), "example", "index.mjs"), "utf8"), `version ${expectedVersion}`);
      } finally {
        context.mock.restoreAll();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  test("concurrent processes retain each independent plugin enablement", { timeout: 20_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-plugin-processes-"));
    const children: ReturnType<typeof fork>[] = [];
    try {
      const plugins = Array.from({ length: 8 }, (_, index) => ({
        id: `plugin-${index}`, directory: `plugin-${index}`, name: "Example", version: "1",
        category: "Tools", description: "Fixture", entry: "index.mjs", enabled: false,
        installedAt: new Date().toISOString()
      }));
      for (const plugin of plugins) await fs.mkdir(path.join(projectPluginRoot(root), plugin.directory), { recursive: true });
      await writeProjectPluginManifest(root, { format: 1, plugins });
      const ready: Promise<void>[] = [];
      const completed: Promise<void>[] = [];
      for (const plugin of plugins) {
        const child = fork(fileURLToPath(import.meta.url), ["enable-worker", root, plugin.id], {
          stdio: ["ignore", "ignore", "pipe", "ipc"], signal: AbortSignal.timeout(15_000)
        });
        children.push(child);
        ready.push(new Promise((resolve, reject) => {
          child.once("message", () => resolve());
          child.once("error", reject);
        }));
        let stderr = "";
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        completed.push(new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
        }));
      }
      await Promise.all(ready);
      for (const child of children) child.send("enable");
      await Promise.all(completed);
      const result = await readProjectPluginManifest(root);
      assert.deepEqual(result.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id).sort(), plugins.map((plugin) => plugin.id).sort());
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
