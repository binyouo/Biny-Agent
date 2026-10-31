import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { installGlobalPluginFromRepository, installPluginFromRepository, parsePluginRegistry, projectPluginRoot,
  readGlobalPluginManifest, readProjectPluginManifest, setProjectPluginEnabled } from "../src/extensions/pluginRegistry.js";
import { globalPluginRoot } from "../src/config/paths.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-plugin-branch-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
function entry(branch?: string, files?: string[]) {
  return parsePluginRegistry({ format: 1, plugins: [{ id: "branch-fixture", name: "Branch fixture", version: "1.0",
    category: "test", description: "fixture", repository: "https://github.com/fixture/repo", path: "plugins/example",
    branch, files, entry: "index.js" }] }).plugins[0]!;
}
function github(options: { fail?: Record<string, number>; throwBranch?: string } = {}) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); requests.push(url);
    const tree = /\/git\/trees\/([^?]+)\?recursive=1$/u.exec(url);
    if (tree) {
      const branch = decodeURIComponent(tree[1]!);
      if (branch === options.throwBranch) throw new Error("fixture transport failed");
      if (options.fail?.[branch]) return new Response("fixture failure", { status: options.fail[branch] });
      return Response.json({ tree: [{ path: "plugins/example/index.js", type: "blob", size: 32 }] });
    }
    const raw = /raw\.githubusercontent\.com\/fixture\/repo\/([^/]+)\/plugins\/example\/index\.js$/u.exec(url);
    assert.ok(raw, `unexpected fixture URL: ${url}`);
    return new Response(`export const source = ${JSON.stringify(decodeURIComponent(raw[1]!))};`);
  };
  return { requests, fetcher };
}
for (const branch of ["release", "master", "release/v2"]) {
  test(`tree discovery installs only the declared ${branch} branch`, async t => {
    const root = await fixture(t), remote = github();
    const installed = await installPluginFromRepository({ workspaceRoot: root, plugin: entry(branch), fetcher: remote.fetcher });
    assert.equal(installed.source?.branch, branch);
    assert.equal(installed.enabled, false);
    assert.equal(await fs.readFile(path.join(projectPluginRoot(root), "branch-fixture/index.js"), "utf8"), `export const source = ${JSON.stringify(branch)};`);
    assert.equal((await readProjectPluginManifest(root)).plugins[0]?.source?.branch, branch);
    assert.deepEqual(remote.requests, [
      `https://api.github.com/repos/fixture/repo/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      `https://raw.githubusercontent.com/fixture/repo/${encodeURIComponent(branch)}/plugins/example/index.js`
    ]);
  });
}
for (const status of [404, 403, 500]) {
  test(`explicit main HTTP ${status} does not install another branch`, async t => {
    const root = await fixture(t), remote = github({ fail: { main: status } });
    await assert.rejects(installPluginFromRepository({ workspaceRoot: root, plugin: entry("main"), fetcher: remote.fetcher }));
    assert.deepEqual(remote.requests, ["https://api.github.com/repos/fixture/repo/git/trees/main?recursive=1"]);
    assert.deepEqual((await readProjectPluginManifest(root)).plugins, []);
    assert.deepEqual(await fs.readdir(projectPluginRoot(root)), []);
  });
}
test("explicit branch transport failure leaves installed enabled version intact", async t => {
  const root = await fixture(t);
  await installPluginFromRepository({ workspaceRoot: root, plugin: entry("main", ["index.js"]), fetcher: github().fetcher });
  await setProjectPluginEnabled(root, "branch-fixture", true);
  const before = await readProjectPluginManifest(root);
  const file = path.join(projectPluginRoot(root), "branch-fixture/index.js");
  const bytes = await fs.readFile(file);
  const remote = github({ throwBranch: "release" });
  await assert.rejects(installPluginFromRepository({ workspaceRoot: root, plugin: entry("release"), fetcher: remote.fetcher }), /fixture transport failed/u);
  assert.deepEqual(await readProjectPluginManifest(root), before);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(remote.requests.length, 1);
});
for (const fallback of [false, true]) {
  test(`omitted branch preserves ${fallback ? "main to master fallback" : "main discovery"}`, async t => {
    const root = await fixture(t), remote = github({ fail: fallback ? { main: 404 } : undefined });
    const installed = await installPluginFromRepository({ workspaceRoot: root, plugin: entry(), fetcher: remote.fetcher });
    assert.equal(installed.source?.branch, fallback ? "master" : "main");
    assert.equal(remote.requests.length, fallback ? 3 : 2);
  });
}
test("explicit files continue to bypass tree discovery and retain branch", async t => {
  const root = await fixture(t), remote = github();
  const installed = await installPluginFromRepository({ workspaceRoot: root, plugin: entry("release/v2", ["index.js"]), fetcher: remote.fetcher });
  assert.equal(installed.source?.branch, "release/v2");
  assert.equal(remote.requests.length, 1);
  assert.ok(remote.requests[0]?.includes("/release%2Fv2/"));
});
test("empty files list still discovers the declared branch", async t => {
  const root = await fixture(t), remote = github();
  const installed = await installPluginFromRepository({ workspaceRoot: root, plugin: entry("release", []), fetcher: remote.fetcher });
  assert.equal(installed.source?.branch, "release");
});
test("global installation uses the same explicit branch contract", async t => {
  await fixture(t); const remote = github();
  const installed = await installGlobalPluginFromRepository({ plugin: entry("release"), fetcher: remote.fetcher });
  assert.equal(installed.source?.branch, "release");
  assert.equal((await readGlobalPluginManifest()).plugins[0]?.source?.branch, "release");
  assert.equal(await fs.readFile(path.join(globalPluginRoot(), "branch-fixture/index.js"), "utf8"), 'export const source = "release";');
});
