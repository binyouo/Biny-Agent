/** Local registry JSON and deferred fetch/file operations; no plugin is installed or executed. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { BINY_PLUGIN_REGISTRY_URL, readPluginRegistryCache, writePluginRegistryCache } from "../src/extensions/pluginRegistry.js";
import { DesktopSkillService } from "../src/desktop/electron/main/DesktopSkillService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function registry(name: string) {
  return { format: 1 as const, plugins: [{ id: name, name, version: "1", category: "Tools", description: "",
    details: "", tags: [], featured: false, repository: "https://github.com/example/inert", path: name }] };
}
const response = (name: string) => new Response(JSON.stringify(registry(name)));

async function fixture(context: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-registry-reload-"));
  const state = new DesktopStateStore(path.join(root, "desktop.json"));
  const calls: Array<ReturnType<typeof deferred<Response>>> = [];
  const waiters: Array<(value: ReturnType<typeof deferred<Response>>) => void> = [];
  const service = new DesktopSkillService(state, {
    load: async () => configSchema.parse(defaultConfig), save: async () => { throw new Error("Unexpected config write"); }
  }, async (url) => {
    assert.equal(url, BINY_PLUGIN_REGISTRY_URL);
    const call = deferred<Response>();
    const waiter = waiters.shift();
    if (waiter) waiter(call); else calls.push(call);
    return await call.promise;
  });
  const project = async (id: string, directory = path.join(root, id)): Promise<string> => {
    await fs.mkdir(directory, { recursive: true });
    await state.upsertProject({ id, path: directory, name: id, dirty: false, missing: false, pinned: false,
      addedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" });
    return directory;
  };
  context.after(async () => { context.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, state, service, project,
    nextFetch: async () => calls.shift() ?? await new Promise<ReturnType<typeof deferred<Response>>>(resolve => waiters.push(resolve)),
    cacheName: async (directory: string) => (await readPluginRegistryCache(directory))?.document.plugins[0]?.name,
    seed: async (directory: string, name: string) => writePluginRegistryCache(directory, { fetchedAt: "2026-01-01T00:00:00.000Z", document: registry(name) })
  };
}

test("an older explicit registry refresh cannot replace the cache after a newer refresh completes", async (t) => {
  const h = await fixture(t); const directory = await h.project("project");
  const old = h.service.pluginRegistry("project", true); const first = await h.nextFetch();
  const latest = h.service.pluginRegistry("project", true); const second = await h.nextFetch();
  second.resolve(response("new-registry")); assert.equal((await latest).plugins[0]?.name, "new-registry");
  first.resolve(response("old-registry"));
  assert.equal((await old).plugins[0]?.name, "old-registry", "each caller still receives its own successful response");
  assert.equal(await h.cacheName(directory), "new-registry");
  assert.equal((await h.service.pluginRegistry("project")).plugins[0]?.name, "new-registry");
});

test("a cache lookup begun before an explicit refresh cannot later supersede it after a delayed miss", async (t) => {
  const h = await fixture(t); const directory = await h.project("project");
  const cacheFile = path.join(directory, ".biny/plugins/registry-cache.json");
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const readStarted = deferred<void>(); const releaseRead = deferred<void>();
  const lstat = fs.lstat; let delayed = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === cacheFile && !delayed) {
      delayed = true;
      try { return await lstat(...args); }
      catch (error) { readStarted.resolve(); await releaseRead.promise; throw error; }
    }
    return await lstat(...args);
  });
  const initial = h.service.pluginRegistry("project"); await readStarted.promise;
  const refresh = h.service.pluginRegistry("project", true); const freshFetch = await h.nextFetch();
  freshFetch.resolve(response("explicit-refresh")); await refresh;
  releaseRead.resolve(); const oldFetch = await h.nextFetch();
  oldFetch.resolve(response("late-initial-load")); await initial;
  assert.equal(await h.cacheName(directory), "explicit-refresh");
});

test("a cache hit during an explicit refresh does not revoke the refresh's cache ownership", async (t) => {
  const h = await fixture(t); const directory = await h.project("project"); await h.seed(directory, "cached");
  const refresh = h.service.pluginRegistry("project", true); const call = await h.nextFetch();
  const hit = await h.service.pluginRegistry("project");
  assert.equal(hit.plugins[0]?.name, "cached"); assert.equal(hit.stale, false);
  call.resolve(response("refreshed")); await refresh;
  assert.equal(await h.cacheName(directory), "refreshed");
});

test("independent workspaces do not invalidate one another's refreshes", async (t) => {
  const h = await fixture(t); const a = await h.project("a"); const b = await h.project("b");
  const first = h.service.pluginRegistry("a", true); const callA = await h.nextFetch();
  const second = h.service.pluginRegistry("b", true); const callB = await h.nextFetch();
  callB.resolve(response("registry-b")); await second;
  callA.resolve(response("registry-a")); await first;
  assert.equal(await h.cacheName(a), "registry-a"); assert.equal(await h.cacheName(b), "registry-b");
});

test("project aliases sharing one real workspace also share cache ordering", async (t) => {
  const h = await fixture(t); const directory = await h.project("project");
  const alias = path.join(h.root, "alias"); await fs.symlink(directory, alias);
  await h.project("alias", alias);
  const old = h.service.pluginRegistry("project", true); const first = await h.nextFetch();
  const latest = h.service.pluginRegistry("alias", true); const second = await h.nextFetch();
  second.resolve(response("alias-latest")); await latest;
  first.resolve(response("realpath-old")); await old;
  assert.equal(await h.cacheName(directory), "alias-latest");
});

test("request order survives delayed workspace identity lookup", async (t) => {
  const h = await fixture(t); const directory = await h.project("project");
  const started = deferred<void>(); const release = deferred<void>();
  const realpath = fs.realpath; let delayed = false;
  t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
    if (String(args[0]) === directory && !delayed) { delayed = true; started.resolve(); await release.promise; }
    return await realpath(...args);
  });
  const old = h.service.pluginRegistry("project", true);
  // On the baseline there is no identity lookup; observe whichever first step occurs.
  const firstFetch = h.nextFetch();
  const firstStep = await Promise.race([started.promise.then(() => "identity" as const), firstFetch]);
  const latest = h.service.pluginRegistry("project", true);
  const freshCall = firstStep === "identity" ? await firstFetch : await h.nextFetch();
  freshCall.resolve(response("newest-request")); await latest;
  release.resolve();
  const oldCall = firstStep === "identity" ? await h.nextFetch() : firstStep;
  oldCall.resolve(response("oldest-request")); await old;
  assert.equal(await h.cacheName(directory), "newest-request");
});

test("cache write failure reports the existing fallback, removes temporary files, and allows retry", async (t) => {
  const h = await fixture(t); const directory = await h.project("project"); await h.seed(directory, "fallback");
  const cacheFile = path.join(directory, ".biny/plugins/registry-cache.json");
  const rename = fs.rename; let fail = true;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === cacheFile && fail) { fail = false; throw new Error("fixture cache rename failed"); }
    return await rename(...args);
  });
  const failing = h.service.pluginRegistry("project", true); (await h.nextFetch()).resolve(response("cannot-persist"));
  const failed = await failing;
  assert.equal(failed.stale, true); assert.equal(failed.plugins[0]?.name, "fallback");
  assert.match(failed.loadingError ?? "", /fixture cache rename failed/);
  assert.deepEqual((await fs.readdir(path.dirname(cacheFile))).filter(name => name.endsWith(".tmp")), []);
  const retry = h.service.pluginRegistry("project", true); (await h.nextFetch()).resolve(response("retry"));
  assert.equal((await retry).loadingError, undefined); assert.equal(await h.cacheName(directory), "retry");
});

for (const withCache of [false, true]) {
  test(`registry fetch failure preserves ${withCache ? "stale cache" : "empty fallback"} semantics and releases ownership`, async (t) => {
    const h = await fixture(t); const directory = await h.project("project");
    if (withCache) await h.seed(directory, "last-good");
    const failed = h.service.pluginRegistry("project", true); (await h.nextFetch()).reject(new Error("offline fixture"));
    const result = await failed;
    assert.equal(result.stale, withCache); assert.equal(result.plugins[0]?.name, withCache ? "last-good" : undefined);
    assert.equal(result.loadingError, "offline fixture");
    const retry = h.service.pluginRegistry("project", true); (await h.nextFetch()).resolve(response("online")); await retry;
    assert.equal(await h.cacheName(directory), "online");
  });
}

test("a failed newer refresh cannot be silently replaced by an obsolete successful response", async (t) => {
  const h = await fixture(t); const directory = await h.project("project"); await h.seed(directory, "last-good");
  const old = h.service.pluginRegistry("project", true); const first = await h.nextFetch();
  const latest = h.service.pluginRegistry("project", true); const second = await h.nextFetch();
  second.reject(new Error("latest refresh failed"));
  const failed = await latest;
  assert.equal(failed.loadingError, "latest refresh failed"); assert.equal(failed.plugins[0]?.name, "last-good");
  first.resolve(response("obsolete-success")); await old;
  assert.equal(await h.cacheName(directory), "last-good");
});

for (const rejectOlderWrite of [false, true]) {
  test(`newer refresh waits for an already-started ${rejectOlderWrite ? "failing" : "successful"} cache commit`, async (t) => {
    const h = await fixture(t); const directory = await h.project("project"); await h.seed(directory, "seed");
    const biny = path.join(directory, ".biny"); const pluginRoot = path.join(biny, "plugins");
    const cacheFile = path.join(pluginRoot, "registry-cache.json");
    // Only cache writes are virtual, so every step after fetch is a resolved
    // microtask except the explicit older-commit barrier. No elapsed-time wait.
    const stats = new Map(await Promise.all([biny, pluginRoot, cacheFile].map(async file => [file, await fs.lstat(file)] as const)));
    const lstat = fs.lstat; const open = fs.open; const rename = fs.rename; const readFile = fs.readFile; const rm = fs.rm;
    let cached = await fs.readFile(cacheFile, "utf8"); const staged = new Map<string, string>();
    const olderCommitStarted = deferred<void>(); const releaseOlderCommit = deferred<void>();
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => stats.get(String(args[0])) ?? await lstat(...args));
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = String(args[0]);
      if (file.startsWith(`${cacheFile}.`) && file.endsWith(".tmp")) return {
        writeFile: async (value: string) => { staged.set(file, value); }, sync: async () => {}, close: async () => {}
      } as unknown as Awaited<ReturnType<typeof fs.open>>;
      return await open(...args);
    });
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) !== cacheFile) return await rename(...args);
      const value = staged.get(String(args[0])); assert.ok(value);
      if (JSON.parse(value).document.plugins[0].name === "older") {
        olderCommitStarted.resolve(); await releaseOlderCommit.promise;
        if (rejectOlderWrite) throw new Error("older commit failed");
      }
      cached = value;
    });
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => String(args[0]) === cacheFile ? cached : await readFile(...args));
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).startsWith(`${cacheFile}.`) && String(args[0]).endsWith(".tmp")) { staged.delete(String(args[0])); return; }
      return await rm(...args);
    });
    const old = h.service.pluginRegistry("project", true); (await h.nextFetch()).resolve(response("older"));
    await olderCommitStarted.promise;
    let latestSettled = false;
    const latest = h.service.pluginRegistry("project", true).then(value => { latestSettled = true; return value; });
    (await h.nextFetch()).resolve(response("newer"));
    await new Promise<void>(resolve => setImmediate(resolve));
    const settledBeforeRelease = latestSettled;
    releaseOlderCommit.resolve();
    const [oldResult, newResult] = await Promise.all([old, latest]);
    assert.equal(settledBeforeRelease, false, "the new result cannot finish while the older cache write can still overwrite it");
    if (rejectOlderWrite) assert.match(oldResult.loadingError ?? "", /older commit failed/);
    assert.equal(newResult.plugins[0]?.name, "newer"); assert.equal(newResult.loadingError, undefined);
    assert.equal(await h.cacheName(directory), "newer"); assert.equal(staged.size, 0);
  });
}
