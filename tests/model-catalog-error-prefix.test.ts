import assert from "node:assert/strict";
import test from "node:test";
import { fetchModelCatalogSnapshot, ModelCatalogRequestError } from "../src/ai/modelCatalog.js";
import { providerDefinition } from "../src/ai/provider.js";
import { configSchema, defaultConfig, type ProviderConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { InMemoryModelsStore, readProviderCatalog } from "../src/llm/ModelsStore.js";

const provider: ProviderConfig = {
  type: "openai-compatible", baseUrl: "https://catalog.fixture.invalid/v1", requiresApiKey: false,
  retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }
};
const request = { alias: "fixture", config: provider, definition: providerDefinition(provider.type) };
const encoder = new TextEncoder();
async function catalogError(response: Response, signal?: AbortSignal): Promise<ModelCatalogRequestError> {
  try {
    await fetchModelCatalogSnapshot(request, signal, {}, async () => response);
    assert.fail("HTTP failure must reject");
  } catch (error) {
    assert.ok(error instanceof ModelCatalogRequestError);
    assert.equal(error.statusCode, 402);
    assert.equal(error.url, "https://catalog.fixture.invalid/v1/models");
    assert.equal(error.message, "Model catalog request failed (402).");
    return error;
  }
}

test("catalog error reads only the diagnostic prefix and does not wait for cancellation", { timeout: 2_000 }, async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls <= 8) controller.enqueue(encoder.encode("x".repeat(1_024)));
      else controller.error(new Error("unread tail failure"));
    },
    cancel() { cancelled = true; return new Promise<void>(() => {}); }
  }, { highWaterMark: 0 });
  const error = await catalogError(new Response(body, { status: 402 }));
  assert.equal(error.responseBody, "x".repeat(8_192));
  assert.equal(pulls, 8, "no read after the prefix has been acquired");
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("a later read failure retains the diagnostic bytes already received", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(encoder.encode("quota denied: 可用诊断"));
      else controller.error(new Error("broken tail"));
    }
  }, { highWaterMark: 0 });
  assert.equal((await catalogError(new Response(body, { status: 402 }))).responseBody, "quota denied: 可用诊断");
  assert.equal(body.locked, false);
});

test("aborting a pending body read keeps the original HTTP failure and acquired prefix", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  let signalPending!: () => void;
  const pending = new Promise<void>((resolve) => { signalPending = resolve; });
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      if (++pulls === 1) stream.enqueue(encoder.encode("quota denied"));
      else { signalPending(); return new Promise<void>(() => {}); }
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  const result = catalogError(new Response(body, { status: 402 }), controller.signal);
  await pending;
  controller.abort(new Error("fixture cancellation"));
  assert.equal((await result).responseBody, "quota denied");
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

for (const text of ["\uFEFF你好🙂diagnostic", "a".repeat(8_191) + "🙂tail", "🙂".repeat(4_097), "a".repeat(1024 * 1024)]) {
  test(`error prefix decodes UTF-8 and preserves the UTF-16 display boundary (${text.length})`, async () => {
    const bytes = encoder.encode(text);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        const next = Math.min(offset + (text.length > 8_192 ? bytes.length : 1), bytes.length);
        controller.enqueue(bytes.subarray(offset, next));
        offset = next;
      }
    }, { highWaterMark: 0 });
    const expected = new TextDecoder().decode(bytes).slice(0, 8_192);
    assert.equal((await catalogError(new Response(body, { status: 402 }))).responseBody, expected);
    assert.equal(body.locked, false);
  });
}

test("empty and unreadable bodies retain HTTP status without fabricated diagnostics", async () => {
  assert.equal((await catalogError(new Response(null, { status: 402 }))).responseBody, undefined);
  assert.equal((await catalogError(new Response("", { status: 402 }))).responseBody, undefined);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("early failure")); } });
  assert.equal((await catalogError(new Response(body, { status: 402 }))).responseBody, undefined);
  const locked = new Response("held by another reader", { status: 402 });
  const reader = locked.body!.getReader();
  try { assert.equal((await catalogError(locked)).responseBody, undefined); }
  finally { await reader.cancel(); reader.releaseLock(); }
});

test("successful catalogs still consume and parse their complete response", async () => {
  const snapshot = await fetchModelCatalogSnapshot(request, undefined, {}, async () => Response.json({
    data: [{ id: "fixture-chat", description: "x".repeat(16_000), context_window: 128_000 }]
  }));
  assert.equal(snapshot.models?.[0]?.id, "fixture-chat");
  assert.equal(snapshot.models?.[0]?.contextWindow, 128_000);
});

test("Desktop catalog refresh exposes the acquired prefix without replacing a valid cached catalog", async () => {
  const store = new InMemoryModelsStore();
  const config = configSchema.parse({
    ...defaultConfig, defaultModel: "selected", providers: { fixture: provider },
    models: { selected: { provider: "fixture", model: "fixture-chat" } }
  });
  let calls = 0;
  const manager = Object.create(DesktopAgentManager.prototype) as DesktopAgentManager;
  Object.assign(manager, {
    projects: { requireProject: () => ({ path: "/synthetic/catalog-project" }) },
    configStore: { load: async () => structuredClone(config) }, modelsStore: store,
    fetcher: async () => {
      if (++calls === 1) return Response.json({ data: [{ id: "fixture-chat", context_window: 128_000 }] });
      let received = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!received) { received = true; controller.enqueue(encoder.encode("account quota exceeded")); }
          else controller.error(new Error("unreadable diagnostic tail"));
        }
      }, { highWaterMark: 0 }), { status: 402 });
    }
  });
  await manager.fetchModelCatalog("project", "fixture");
  const before = await readProviderCatalog("fixture", provider, store);
  await assert.rejects(manager.fetchModelCatalog("project", "fixture"), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 402.*account quota exceeded/u);
    assert.ok(error.cause instanceof ModelCatalogRequestError);
    assert.equal(error.cause.responseBody, "account quota exceeded");
    return true;
  });
  assert.deepEqual(await readProviderCatalog("fixture", provider, store), before);
});
