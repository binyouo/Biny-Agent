/** Deterministic request/body deadlines with inert fetch; real cache filesystem is CI-only. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { DesktopSkillService } from "../src/desktop/electron/main/DesktopSkillService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { BINY_PLUGIN_REGISTRY_URL, readPluginRegistryCache, writePluginRegistryCache } from "../src/extensions/pluginRegistry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function registry(name: string) {
  return { format: 1 as const, plugins: [{ id: name, name, version: "1", category: "Tools", description: "",
    details: "", tags: [], featured: false, repository: "https://github.com/example/inert", path: name }] };
}

async function fixture(t: TestContext, phase: "headers" | "body" | "success") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-registry-deadline-"));
  const workspace = path.join(root, "project");
  await fs.mkdir(workspace);
  const state = new DesktopStateStore(path.join(root, "desktop.json"));
  await state.upsertProject({ id: "project", path: workspace, name: "project", dirty: false, missing: false, pinned: false,
    addedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" });
  const deadlines: Array<{ milliseconds: number; controller: AbortController }> = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  const requests: Array<ReturnType<DesktopSkillService["pluginRegistry"]>> = [];
  const started = deferred<AbortSignal | null | undefined>();
  const reading = deferred<void>();
  let calls = 0;
  const service = new DesktopSkillService(state, {
    load: async () => { throw new Error("Unexpected config read"); },
    save: async () => { throw new Error("Unexpected config write"); }
  }, async (url, init) => {
    assert.equal(url, BINY_PLUGIN_REGISTRY_URL);
    calls += 1;
    const signal = init?.signal;
    if (calls === 1) started.resolve(signal);
    assert.ok(signal, "registry fetch must receive its deadline signal");
    signal.throwIfAborted();
    if (calls > 1 || phase === "success") return new Response(JSON.stringify(registry("fresh")));
    if (phase === "headers") {
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"format":1,"plugins":['));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
      pull() {
        reading.resolve();
        return new Promise<void>(() => {});
      }
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
  t.after(async () => {
    for (const deadline of deadlines) deadline.controller.abort(new DOMException("Fixture cleanup", "AbortError"));
    await Promise.allSettled(requests);
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    request: (refresh = false) => {
      const request = service.pluginRegistry("project", refresh);
      requests.push(request);
      return request;
    },
    deadlines, started: started.promise, reading: reading.promise, calls: () => calls,
    seed: () => writePluginRegistryCache(workspace, { fetchedAt: "2026-01-01T00:00:00.000Z", document: registry("cached") }),
    cache: () => readPluginRegistryCache(workspace)
  };
}

for (const phase of ["headers", "body"] as const) {
  for (const cached of [false, true]) {
    test(`registry deadline during ${phase} preserves ${cached ? "cached" : "empty"} fallback and permits retry`, async (t) => {
      const h = await fixture(t, phase);
      if (cached) await h.seed();
      const before = await h.cache();
      const pending = h.request(cached);
      const signal = await h.started;
      assert.equal(h.deadlines.length, 1);
      assert.equal(h.deadlines[0]!.milliseconds, 15_000);
      assert.equal(signal, h.deadlines[0]!.controller.signal);
      if (phase === "body") await h.reading;
      h.deadlines[0]!.controller.abort(new DOMException("Registry deadline fixture", "TimeoutError"));
      const result = await pending;
      assert.equal(result.stale, cached);
      assert.equal(result.plugins[0]?.name, cached ? "cached" : undefined);
      assert.equal(result.loadingError, "Registry deadline fixture");
      assert.deepEqual(await h.cache(), before, "timed-out requests must not replace the cache");
      const retry = await h.request(true);
      assert.equal(retry.plugins[0]?.name, "fresh");
      assert.equal(retry.stale, false);
      assert.equal(retry.loadingError, undefined);
      assert.equal((await h.cache())?.document.plugins[0]?.name, "fresh");
      assert.equal(h.calls(), 2);
      assert.equal(h.deadlines.length, 2);
    });
  }
}

test("a registry cache hit creates neither an HTTP request nor a deadline", async (t) => {
  const h = await fixture(t, "success");
  await h.seed();
  const result = await h.request();
  assert.equal(result.plugins[0]?.name, "cached");
  assert.equal(result.stale, false);
  assert.equal(result.loadingError, undefined);
  assert.equal(h.calls(), 0);
  assert.equal(h.deadlines.length, 0);
});

test("a successful registry response still persists its parsed document", async (t) => {
  const h = await fixture(t, "success");
  const result = await h.request();
  assert.equal(h.deadlines[0]?.milliseconds, 15_000);
  assert.equal(result.plugins[0]?.name, "fresh");
  assert.equal(result.stale, false);
  assert.equal(result.loadingError, undefined);
  assert.equal((await h.cache())?.document.plugins[0]?.name, "fresh");
});

test("a newer successful refresh is not blocked by an older body awaiting its deadline", async (t) => {
  const h = await fixture(t, "body");
  await h.seed();
  const old = h.request(true);
  await h.started;
  assert.equal(h.deadlines.length, 1);
  await h.reading;
  const latest = await h.request(true);
  assert.equal(latest.plugins[0]?.name, "fresh");
  assert.equal((await h.cache())?.document.plugins[0]?.name, "fresh");
  h.deadlines[0]!.controller.abort(new DOMException("Older deadline fixture", "TimeoutError"));
  const expired = await old;
  assert.equal(expired.loadingError, "Older deadline fixture");
  assert.equal(expired.plugins[0]?.name, "fresh");
  assert.equal(expired.stale, true);
  assert.equal((await h.cache())?.document.plugins[0]?.name, "fresh");
});
