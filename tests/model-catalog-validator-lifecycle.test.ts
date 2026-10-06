/** A new catalog body must never inherit validators belonging to the replaced body. */
import assert from "node:assert/strict";
import test from "node:test";
import { fetchModelCatalogSnapshot, type ModelCatalogValidators } from "../src/ai/modelCatalog.js";
import { providerDefinition } from "../src/ai/provider.js";
import { configSchema, defaultConfig, type ProviderConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { InMemoryModelsStore, modelCatalogCacheKey, readProviderCatalog, type ModelsStore, type ModelsStoreEntry } from "../src/llm/ModelsStore.js";

const alias = "gateway";
const provider: ProviderConfig = {
  type: "openai-compatible",
  baseUrl: "https://catalog.fixture.invalid/v1",
  requiresApiKey: false,
  retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }
};
const config = configSchema.parse({
  ...defaultConfig,
  defaultModel: "selected",
  providers: { [alias]: provider },
  models: { selected: { provider: alias, model: "fixture-chat" } },
  thinking: { enabled: false, effort: "medium" }
});
const oldValidators = { etag: '"catalog-a"', lastModified: Date.parse("2026-01-01T00:00:00Z") };
const newValidators = { etag: '"catalog-b"', lastModified: Date.parse("2026-02-01T00:00:00Z") };
const request = { alias, config: provider, definition: providerDefinition(provider.type) };

function headers(validators: ModelCatalogValidators): Record<string, string> {
  return {
    ...(validators.etag === undefined ? {} : { etag: validators.etag }),
    ...(validators.lastModified === undefined ? {} : { "last-modified": new Date(validators.lastModified).toUTCString() })
  };
}

function response(contextWindow: number, validators: ModelCatalogValidators = {}): Response {
  return Response.json({ data: [{ id: "fixture-chat", context_window: contextWindow, supports_tools: true }] }, {
    headers: headers(validators)
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const validatorCases: Array<[string, ModelCatalogValidators]> = [
  ["neither", {}],
  ["ETag only", { etag: newValidators.etag }],
  ["Last-Modified only", { lastModified: newValidators.lastModified }],
  ["both", newValidators]
];

for (const [label, returned] of validatorCases) {
  test(`200 replacement keeps only its own validators: ${label}`, async () => {
    const before = structuredClone(oldValidators);
    const snapshot = await fetchModelCatalogSnapshot(request, undefined, oldValidators, async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("if-none-match"), oldValidators.etag);
      assert.equal(new Headers(init?.headers).get("if-modified-since"), headers(oldValidators)["last-modified"]);
      return response(64_000, returned);
    });
    assert.equal(snapshot.notModified, false);
    assert.equal(snapshot.models?.[0]?.contextWindow, 64_000);
    assert.equal(snapshot.etag, returned.etag);
    assert.equal(snapshot.lastModified, returned.lastModified);
    assert.deepEqual(oldValidators, before, "caller-owned validators are not mutated");
  });

  test(`304 preserves omitted validators and overlays supplied fields: ${label}`, async () => {
    const snapshot = await fetchModelCatalogSnapshot(request, undefined, oldValidators, async () => (
      new Response(null, { status: 304, headers: headers(returned) })
    ));
    assert.equal(snapshot.notModified, true);
    assert.equal(snapshot.models, undefined);
    assert.equal(snapshot.etag, returned.etag ?? oldValidators.etag);
    assert.equal(snapshot.lastModified, returned.lastModified ?? oldValidators.lastModified);
  });
}

test("200 with an invalid Last-Modified does not revive the previous body's timestamp", async () => {
  const snapshot = await fetchModelCatalogSnapshot(request, undefined, oldValidators, async () => (
    Response.json({ data: [{ id: "fixture-chat" }] }, { headers: { "last-modified": "invalid-date" } })
  ));
  assert.equal(snapshot.lastModified, undefined);
  assert.equal(snapshot.etag, undefined);
});

/** Exercise the production Desktop catalog entry point with only its I/O dependencies substituted. */
function desktopCatalog(store: ModelsStore, fetcher: typeof fetch) {
  const manager = Object.create(DesktopAgentManager.prototype) as DesktopAgentManager;
  Object.assign(manager, {
    projects: { requireProject: (projectId: string) => {
      assert.equal(projectId, "fixture-project");
      return { path: "/synthetic/catalog-project" };
    } },
    configStore: { load: async () => structuredClone(config) },
    modelsStore: store,
    fetcher
  });
  return (force = false) => manager.fetchModelCatalog("fixture-project", alias, force);
}

for (const [label, initial] of [
  ["ETag only", { etag: oldValidators.etag }],
  ["Last-Modified only", { lastModified: oldValidators.lastModified }],
  ["both", oldValidators],
  ["neither", {}]
] as Array<[string, ModelCatalogValidators]>) {
  test(`Desktop refresh persists replacement validator absence: ${label}`, async () => {
    const store = new InMemoryModelsStore();
    const observed: Headers[] = [];
    const refresh = desktopCatalog(store, async (_input, init) => {
      observed.push(new Headers(init?.headers));
      return observed.length === 1 ? response(200_000, initial) : response(64_000);
    });
    await refresh();
    assert.equal((await refresh()).models.find((model) => model.id === "fixture-chat")?.contextWindow, 64_000);
    const stored = await readProviderCatalog(alias, provider, store);
    assert.equal(stored?.etag, undefined);
    assert.equal(stored?.lastModified, undefined);
    assert.deepEqual(await store.read(alias), await store.read(modelCatalogCacheKey(alias, provider)), "alias mirror remains consistent");
    await refresh();
    assert.equal(observed[2]?.get("if-none-match"), null);
    assert.equal(observed[2]?.get("if-modified-since"), null);
  });
}

for (const initial of [{ etag: oldValidators.etag }, oldValidators] satisfies ModelCatalogValidators[]) {
  test(`Desktop A → unvalidated B → A cannot attach A's 304 to B (${"lastModified" in initial ? "both validators" : "ETag"})`, async () => {
    const store = new InMemoryModelsStore();
    const observed: Headers[] = [];
    const refresh = desktopCatalog(store, async (_input, init) => {
      const sent = new Headers(init?.headers);
      observed.push(sent);
      if (observed.length === 1) return response(200_000, initial);
      if (observed.length === 2) return response(64_000);
      // A's representation and ETag recur. The server is entitled to answer 304 only if nominated.
      return sent.get("if-none-match") === oldValidators.etag
        ? new Response(null, { status: 304, headers: headers(initial) })
        : response(200_000, initial);
    });
    assert.equal((await refresh()).models.find((model) => model.id === "fixture-chat")?.contextWindow, 200_000);
    assert.equal((await refresh()).models.find((model) => model.id === "fixture-chat")?.contextWindow, 64_000);
    const latest = await refresh();
    assert.equal(latest.models.find((model) => model.id === "fixture-chat")?.contextWindow, 200_000);
    assert.equal(latest.source, "fetched");
    assert.equal(observed[2]?.get("if-none-match"), null);
    assert.equal((await readProviderCatalog(alias, provider, store))?.models[0]?.contextWindow, 200_000);
  });
}

test("conditional 304 keeps the cached body and omitted validators across fresh runtimes", async () => {
  const store = new InMemoryModelsStore();
  let calls = 0;
  const refresh = desktopCatalog(store, async (_input, init) => {
    if (++calls === 1) return response(200_000, oldValidators);
    assert.equal(new Headers(init?.headers).get("if-none-match"), oldValidators.etag);
    assert.equal(new Headers(init?.headers).get("if-modified-since"), headers(oldValidators)["last-modified"]);
    return new Response(null, { status: 304 });
  });
  await refresh();
  for (let index = 0; index < 2; index++) {
    assert.equal((await refresh()).models.find((model) => model.id === "fixture-chat")?.contextWindow, 200_000);
    const cached = await readProviderCatalog(alias, provider, store);
    assert.equal(cached?.etag, oldValidators.etag);
    assert.equal(cached?.lastModified, oldValidators.lastModified);
  }
});

test("force refresh still omits conditional headers and replaces absent validators", async () => {
  const store = new InMemoryModelsStore();
  let calls = 0;
  const refresh = desktopCatalog(store, async (_input, init) => {
    if (++calls === 1) return response(200_000, oldValidators);
    assert.equal(new Headers(init?.headers).get("if-none-match"), null);
    assert.equal(new Headers(init?.headers).get("if-modified-since"), null);
    return response(64_000);
  });
  await refresh();
  await refresh(true);
  assert.equal((await readProviderCatalog(alias, provider, store))?.etag, undefined);
  assert.equal((await readProviderCatalog(alias, provider, store))?.lastModified, undefined);
});

for (const [label, failed] of [
  ["HTTP error", () => new Response("fixture error", { status: 503 })],
  ["invalid JSON", () => new Response("{")],
  ["empty catalog", () => Response.json({ data: [] })]
] as const) {
  test(`failed ${label} refresh leaves stored body and validators intact`, async () => {
    const store = new InMemoryModelsStore();
    let calls = 0;
    const refresh = desktopCatalog(store, async () => ++calls === 1 ? response(200_000, oldValidators) : failed());
    await refresh();
    const before = await readProviderCatalog(alias, provider, store);
    await assert.rejects(refresh());
    assert.deepEqual(await readProviderCatalog(alias, provider, store), before);
  });
}

test("cancelled response does not replace the cached body or validators", async () => {
  const store = new InMemoryModelsStore();
  const pending = deferred<Response>();
  const started = deferred<void>();
  let calls = 0;
  const runtime = new ModelRuntime(structuredClone(config), [], undefined, store, async () => {
    if (++calls === 1) return response(200_000, oldValidators);
    started.resolve();
    return await pending.promise;
  });
  await runtime.refreshModels(alias);
  const before = await readProviderCatalog(alias, provider, store);
  const controller = new AbortController();
  const reason = new Error("fixture cancellation");
  const refreshing = runtime.refreshModels(alias, controller.signal);
  await started.promise;
  controller.abort(reason);
  pending.resolve(response(64_000));
  await assert.rejects(refreshing, (error) => error === reason);
  assert.deepEqual(await readProviderCatalog(alias, provider, store), before);
  assert.equal(runtime.listModels().find((model) => model.alias === "selected")?.contextWindow, 200_000);
});

for (const completionOrder of [[0, 1], [1, 0]]) {
  test(`concurrent refreshes keep each response's validator/body pair (${completionOrder.join(" → ")})`, async () => {
    const store = new InMemoryModelsStore();
    const responses = [deferred<Response>(), deferred<Response>()];
    const started = deferred<void>();
    let calls = 0;
    const refresh = desktopCatalog(store, async () => {
      const index = calls++;
      if (index === 0) return response(200_000, oldValidators);
      if (index === 2) started.resolve();
      return await responses[index - 1]!.promise;
    });
    await refresh();
    const requests = [refresh(), refresh()];
    await started.promise;
    const completed: Array<{ window: number | undefined; cached: ModelsStoreEntry | undefined }> = [];
    for (const index of completionOrder) {
      const currentValidators = index === 0 ? { etag: newValidators.etag } : {};
      const currentWindow = index === 0 ? 64_000 : 32_000;
      responses[index]!.resolve(response(currentWindow, currentValidators));
      const result = await requests[index]!;
      completed[index] = {
        window: result.models.find((model) => model.id === "fixture-chat")?.contextWindow,
        cached: await readProviderCatalog(alias, provider, store)
      };
    }
    for (const index of completionOrder) {
      const currentWindow = index === 0 ? 64_000 : 32_000;
      const observed = completed[index]!;
      assert.equal(observed.window, currentWindow);
      assert.equal(observed.cached?.models[0]?.contextWindow, currentWindow);
      assert.equal(observed.cached?.etag, index === 0 ? newValidators.etag : undefined);
      assert.equal(observed.cached?.lastModified, undefined);
    }
  });
}
