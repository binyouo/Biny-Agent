import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  installPluginFromRepository, parsePluginRegistry, projectPluginRoot,
  readProjectPluginManifest, setProjectPluginEnabled,
} from "../src/extensions/pluginRegistry.js";

const mainBytes = 'export const source = "EXPECTED MAIN";';
const masterBytes = 'export const source = "OTHER MASTER";';
const tree = { tree: [{ path: "plugins/example/index.js", type: "blob", size: 40 }] };
const plugin = parsePluginRegistry({ format: 1, plugins: [{
  id: "fallback-fixture", name: "Fixture", version: "1.0", category: "test",
  description: "synthetic", repository: "https://github.com/fixture/repo",
  path: "plugins/example", entry: "index.js",
}] }).plugins[0]!;

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-plugin-fallback-fix-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function contents(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else result[path.relative(root, file)] = (await fs.readFile(file)).toString("base64");
    }
  }
  try { await visit(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

function fetcherFor(main: () => Response | Promise<Response>, requests: string[], masterStatus = 200): typeof fetch {
  return async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/git/trees/main?")) return await main();
    if (url.includes("/git/trees/master?")) {
      return masterStatus === 200 ? Response.json(tree) : new Response("missing", { status: masterStatus });
    }
    if (url.includes("/main/")) return new Response(mainBytes);
    if (url.includes("/master/")) return new Response(masterBytes);
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
}

const failures: Array<{ name: string; response: () => Response | Promise<Response>; error: RegExp }> = [
  ...[500, 403, 429].map((status) => ({
    name: `HTTP ${status}`, response: () => new Response("synthetic failure", { status }),
    error: status === 500 ? /HTTP 500/ : /GitHub API 未认证限额耗尽/,
  })),
  { name: "transport", response: () => { throw new Error("synthetic transport failure"); }, error: /synthetic transport failure/ },
  { name: "JSON parsing", response: () => new Response("not-json"), error: /JSON|Unexpected token/ },
  { name: "truncated tree", response: () => Response.json({ ...tree, truncated: true }), error: /仓库目录超过/ },
  { name: "invalid tree shape", response: () => Response.json({ tree: {} }), error: /目录格式无效/ },
];

for (const failure of failures) {
  for (const installed of [false, true]) {
    test(`${failure.name}: ${installed ? "enabled reinstall unchanged" : "first install absent"}`, async (t) => {
      const root = await fixture(t);
      if (installed) {
        await installPluginFromRepository({ workspaceRoot: root, plugin, fetcher: fetcherFor(() => Response.json(tree), []) });
        await setProjectPluginEnabled(root, plugin.id, true);
      }
      const pluginsRoot = projectPluginRoot(root);
      const before = await contents(pluginsRoot);
      const manifest = await readProjectPluginManifest(root);
      const requests: string[] = [];
      let caught: unknown;
      try {
        await installPluginFromRepository({ workspaceRoot: root, plugin, fetcher: fetcherFor(failure.response, requests) });
      } catch (error) { caught = error; }
      // Capture all observations before assertions, including baseline replacement.
      const after = await contents(pluginsRoot);
      const afterManifest = await readProjectPluginManifest(root);
      t.diagnostic(JSON.stringify({ requests, before, after, manifest, afterManifest, error: caught instanceof Error ? caught.message : null }));
      assert.ok(caught instanceof Error, "main failure must reject rather than install master");
      assert.match(caught.message, failure.error);
      assert.equal(requests.length, 1);
      assert.ok(requests[0]!.includes("/git/trees/main?"));
      assert.deepEqual(after, before);
      assert.deepEqual(afterManifest, manifest);
      if (installed) assert.equal(afterManifest.plugins[0]!.enabled, true);
      else assert.deepEqual(after, {});
      assert.equal((await fs.readdir(pluginsRoot)).some((name) => name.startsWith(".install-")), false);
    });
  }
}

for (const branch of ["main", "master"] as const) {
  test(`normal ${branch} discovery succeeds disabled`, async (t) => {
    const root = await fixture(t);
    const requests: string[] = [];
    const result = await installPluginFromRepository({ workspaceRoot: root, plugin,
      fetcher: fetcherFor(() => branch === "main" ? Response.json(tree) : new Response("missing", { status: 404 }), requests) });
    assert.ok(result.source);
    assert.equal(result.source.branch, branch);
    assert.equal(result.enabled, false);
    assert.equal(await fs.readFile(path.join(projectPluginRoot(root), plugin.id, "index.js"), "utf8"), branch === "main" ? mainBytes : masterBytes);
    assert.equal(requests.length, branch === "main" ? 2 : 3);
    assert.deepEqual((await readProjectPluginManifest(root)).plugins, [JSON.parse(JSON.stringify(result))]);
  });
}

test("main 404 followed by master 404 preserves final HTTP error and no install", async (t) => {
  const root = await fixture(t);
  const requests: string[] = [];
  await assert.rejects(installPluginFromRepository({ workspaceRoot: root, plugin,
    fetcher: fetcherFor(() => new Response("missing", { status: 404 }), requests, 404) }), /GitHub 仓库目录请求失败：HTTP 404。/);
  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.includes("/git/trees/master?"));
  assert.deepEqual(await contents(projectPluginRoot(root)), {});
});

test("explicit files bypass tree discovery", async (t) => {
  const root = await fixture(t);
  const requests: string[] = [];
  const declared = parsePluginRegistry({ format: 1, plugins: [{
    ...plugin, branch: "release", files: ["index.js"],
  }] }).plugins[0]!;
  const result = await installPluginFromRepository({ workspaceRoot: root, plugin: declared,
    fetcher: async (input) => {
      const url = String(input);
      requests.push(url);
      assert.equal(url, "https://raw.githubusercontent.com/fixture/repo/release/plugins/example/index.js");
      return new Response(mainBytes);
    } });
  assert.equal(requests.length, 1);
  assert.ok(result.source);
  assert.equal(result.source.branch, "release");
  assert.equal(result.enabled, false);
  assert.equal(await fs.readFile(path.join(projectPluginRoot(root), plugin.id, "index.js"), "utf8"), mainBytes);
});

test("main 404 followed by master 500 preserves final HTTP error and no install", async (t) => {
  const root = await fixture(t);
  const requests: string[] = [];
  await assert.rejects(installPluginFromRepository({ workspaceRoot: root, plugin,
    fetcher: fetcherFor(() => new Response("missing", { status: 404 }), requests, 500) }), /GitHub 仓库目录请求失败：HTTP 500。/);
  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.includes("/git/trees/master?"));
  assert.deepEqual(await contents(projectPluginRoot(root)), {});
});
