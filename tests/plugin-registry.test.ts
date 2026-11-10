import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  installGlobalPluginFromRepository,
  installPluginFromRepository,
  listEnabledGlobalPlugins,
  listEnabledProjectPlugins,
  parsePluginRegistry,
  readGlobalPluginManifest,
  readProjectPluginManifest,
  setGlobalPluginEnabled,
  setProjectPluginEnabled,
  writeProjectPluginManifest
} from "../src/extensions/pluginRegistry.js";
import { loadPluginsFromRoot } from "../src/extensions/plugins.js";
import { BINY_AGENT_DIR_ENV, globalPluginRoot } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ToolRegistry } from "../src/tools/registry.js";

interface MockRepo {
  tree: Array<{ path: string; type: string; size?: number }>;
  files: Record<string, string>;
}

function mockGitHub(repo: MockRepo): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.github.com") && url.includes("/git/trees/")) {
      if (url.includes("/trees/master")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ tree: repo.tree }), { status: 200 });
    }
    if (url.includes("raw.githubusercontent.com")) {
      const match = /\/main\/(.+)$/u.exec(url);
      const key = match?.[1] ? decodeURIComponent(match[1]) : undefined;
      const content = key !== undefined ? repo.files[key] : undefined;
      if (content === undefined) return new Response("not found", { status: 404 });
      return new Response(content, { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
}

const demoEntry = {
  id: "demo-plugin",
  name: "Demo Plugin",
  version: "1.0.0",
  category: "Tools",
  description: "测试插件",
  repository: "https://github.com/Thinkya1/Biny",
  path: "plugins/demo",
  entry: "index.mjs"
};

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-plugin-registry-"));
  try {
    // 1. registry 解析：合法条目 + 默认值填充
    const parsed = parsePluginRegistry({ format: 1, plugins: [demoEntry] });
    assert.equal(parsed.plugins[0]?.id, "demo-plugin");
    assert.equal(parsed.plugins[0]?.featured, false);
    assert.deepEqual(parsed.plugins[0]?.tags, []);
    assert.equal(parsed.plugins[0]?.details, "");

    // 2. 非 GitHub 仓库地址在解析阶段就被拒绝
    assert.throws(
      () => parsePluginRegistry({ format: 1, plugins: [{ ...demoEntry, repository: "https://example.com/owner/repo" }] }),
      /GitHub HTTPS/
    );
    assert.throws(
      () => parsePluginRegistry({ format: 1, plugins: [{ ...demoEntry, repository: "https://github.com/owner/repo/tree/main" }] }),
      /owner\/repo/
    );
    assert.throws(
      () => parsePluginRegistry({ format: 1, plugins: [demoEntry, demoEntry] }),
      /重复 id/
    );

    // 3. 目录式安装：目录外文件不落地，目录内文件按相对路径写入
    const repo: MockRepo = {
      tree: [
        { path: "plugins/demo/index.mjs", type: "blob", size: 45 },
        { path: "plugins/demo/README.md", type: "blob", size: 8 },
        { path: "plugins/demo/sub", type: "tree" },
        { path: "plugins/other/evil.mjs", type: "blob", size: 4 }
      ],
      files: {
        "plugins/demo/index.mjs": "export default function register() {}\n",
        "plugins/demo/README.md": "# demo\n",
        "plugins/other/evil.mjs": "bad!"
      }
    };
    const installed = await installPluginFromRepository({ workspaceRoot, plugin: demoEntry, fetcher: mockGitHub(repo) });
    assert.equal(installed.enabled, false);
    assert.equal(installed.entry, "index.mjs");
    assert.deepEqual(installed.source, { repository: "https://github.com/Thinkya1/Biny", path: "plugins/demo", branch: "main" });
    assert.equal(
      await readFile(path.join(workspaceRoot, ".biny", "plugins", "demo-plugin", "index.mjs"), "utf8"),
      "export default function register() {}\n"
    );
    await assert.rejects(fs.stat(path.join(workspaceRoot, ".biny", "plugins", "demo-plugin", "..", "evil.mjs")));

    // 4. 启用后进入加载路径；损坏插件被跳过
    assert.deepEqual(await listEnabledProjectPlugins(workspaceRoot), []);
    await setProjectPluginEnabled(workspaceRoot, "demo-plugin", true);
    const enabledPaths = await listEnabledProjectPlugins(workspaceRoot);
    assert.equal(enabledPaths.length, 1);
    assert.equal(enabledPaths[0]?.path, ".biny/plugins/demo-plugin/index.mjs");
    assert.deepEqual(enabledPaths[0]?.settings, {});
    const manifest = await readProjectPluginManifest(workspaceRoot);
    await writeProjectPluginManifest(workspaceRoot, {
      format: 1,
      plugins: [...manifest.plugins, { ...manifest.plugins[0]!, id: "broken-plugin", directory: "broken-plugin", enabled: true }]
    });
    assert.deepEqual(await listEnabledProjectPlugins(workspaceRoot), enabledPaths);

    // 5. tree 里的路径穿越条目被过滤（目录前缀拼不上）/ assertSafeRelativePath 双重兜底
    const traversalRepo: MockRepo = {
      tree: [
        { path: "plugins/demo/index.mjs", type: "blob" },
        { path: "plugins/demo/../../escape.mjs", type: "blob" }
      ],
      files: { "plugins/demo/index.mjs": "export default function register() {}\n" }
    };
    // "../" 条目不满足 isSafeRepoPath，被过滤后不参与下载——安装正常完成且只有合法文件
    const ws2 = await mkdtemp(path.join(os.tmpdir(), "biny-plugin-registry-2-"));
    try {
      await installPluginFromRepository({
        workspaceRoot: ws2,
        plugin: { ...demoEntry, id: "demo-two" },
        fetcher: mockGitHub(traversalRepo)
      });
      assert.equal(
        await readFile(path.join(ws2, ".biny", "plugins", "demo-two", "index.mjs"), "utf8"),
        "export default function register() {}\n"
      );
    } finally {
      await rm(ws2, { recursive: true, force: true });
    }

    // 6. entry 自动探测：目录内只有一个 js 模块时可省略 entry
    const ws3 = await mkdtemp(path.join(os.tmpdir(), "biny-plugin-registry-3-"));
    try {
      const auto = await installPluginFromRepository({
        workspaceRoot: ws3,
        plugin: { ...demoEntry, id: "demo-three", entry: undefined },
        fetcher: mockGitHub(repo)
      });
      assert.equal(auto.entry, "index.mjs");
    } finally {
      await rm(ws3, { recursive: true, force: true });
    }

    // 7. 仓库里不存在该目录 → 明确报错
    await assert.rejects(
      () => installPluginFromRepository({
        workspaceRoot,
        plugin: { ...demoEntry, id: "missing-plugin", path: "plugins/nope" },
        fetcher: mockGitHub(repo)
      }),
      /找不到目录/
    );

    // 8. 清单写操作串行化：并发安装与并发启停都不能丢失更新
    const ws4 = await mkdtemp(path.join(os.tmpdir(), "biny-plugin-registry-4-"));
    try {
      await Promise.all([
        installPluginFromRepository({ workspaceRoot: ws4, plugin: { ...demoEntry, id: "concurrent-a" }, fetcher: mockGitHub(repo) }),
        installPluginFromRepository({ workspaceRoot: ws4, plugin: { ...demoEntry, id: "concurrent-b" }, fetcher: mockGitHub(repo) })
      ]);
      assert.deepEqual(
        (await readProjectPluginManifest(ws4)).plugins.map((plugin) => plugin.id).sort(),
        ["concurrent-a", "concurrent-b"]
      );
      await Promise.all([
        setProjectPluginEnabled(ws4, "concurrent-a", true),
        setProjectPluginEnabled(ws4, "concurrent-b", true)
      ]);
      assert.deepEqual(
        (await readProjectPluginManifest(ws4)).plugins
          .map((plugin) => [plugin.id, plugin.enabled] as const)
          .sort((left, right) => left[0].localeCompare(right[0])),
        [["concurrent-a", true], ["concurrent-b", true]]
      );
    } finally {
      await rm(ws4, { recursive: true, force: true });
    }

    // 9. 全局 Plugin 使用 ~/.config/biny/plugins 的独立 manifest，并可被当前工作区加载。
    const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-plugin-"));
    process.env[BINY_AGENT_DIR_ENV] = globalRoot;
    try {
      const globalInstalled = await installGlobalPluginFromRepository({
        plugin: { ...demoEntry, id: "global-demo" },
        fetcher: mockGitHub(repo)
      });
      assert.equal(globalInstalled.enabled, false);
      assert.equal(path.dirname(globalPluginRoot()), globalRoot);
      assert.equal(await readFile(path.join(globalPluginRoot(), "global-demo", "index.mjs"), "utf8"), "export default function register() {}\n");
      await setGlobalPluginEnabled("global-demo", true);
      assert.deepEqual(
        (await listEnabledGlobalPlugins()).map((target) => target.path),
        [await fs.realpath(path.join(globalPluginRoot(), "global-demo", "index.mjs"))]
      );
      assert.equal((await readGlobalPluginManifest()).plugins[0]?.enabled, true);
      const loadedGlobal = await loadPluginsFromRoot(
        workspaceRoot,
        globalPluginRoot(),
        await listEnabledGlobalPlugins(),
        configSchema.parse(defaultConfig),
        new ToolRegistry()
      );
      assert.deepEqual(loadedGlobal, [await fs.realpath(path.join(globalPluginRoot(), "global-demo", "index.mjs"))]);
    } finally {
      if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
      await rm(globalRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await main();
console.log("plugin-registry tests passed");
