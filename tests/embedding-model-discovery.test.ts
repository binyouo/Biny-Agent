import assert from "node:assert/strict";
import test from "node:test";
import { parseModelCatalog } from "../src/ai/modelCatalog.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { FileModelsStore, modelCatalogCacheKey, restoreProviderCatalogs } from "../src/llm/ModelsStore.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentMemoryOwner } from "../src/runtime/memory/owner.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor } from "../src/llm/embedding/types.js";

const config = configSchema.parse({ ...defaultConfig, defaultModel: "chat", models: { chat: { provider: "gateway", model: "chat-001" } }, providers: {
  gateway: { type: "openai-compatible", baseUrl: "https://embedding.example.test/v1", requiresApiKey: false },
  messages: { type: "anthropic", apiKey: "test-key" }
} });
const catalog = () => parseModelCatalog({ data: [
  { id: "vector-001", display_name: "Vector One", capabilities: { embedding: true } },
  { id: "BAAI/bge-m3", display_name: "Multilingual vectors" },
  { id: "text-embedding-disabled", capabilities: { embedding: false } },
  { id: "chat-001" }
] }, "gateway", "openai-compatible");

test("provider catalog embedding candidates survive storage and can execute on the same connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-embedding-catalog-"));
  try {
    const store = new FileModelsStore(path.join(root, "models.json"));
    const key = modelCatalogCacheKey("gateway", config.providers.gateway!);
    await store.write(key, { sourceKey: key, models: catalog() });
    const restored = await restoreProviderCatalogs(["gateway"], store, config.providers);
    const requests: Array<{ url: string; body: unknown }> = [];
    const registry = new ProviderRegistry(config, restored, undefined, store, async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ data: [{ index: 0, embedding: [3, 4] }] });
    });
    assert.deepEqual(registry.listEmbeddingModels().map(model => model.ref), [
      { kind: "provider", provider: "gateway", model: "vector-001" },
      { kind: "provider", provider: "gateway", model: "BAAI/bge-m3" }
    ]);
    const runtime = registry.createEmbeddingRuntime({ kind: "provider", provider: "gateway", model: "vector-001" });
    const result = await runtime.embed({ texts: ["a durable fact"], inputType: "passage" });
    assert.equal(result.dimensions, 2);
    assert.deepEqual(requests, [{ url: "https://embedding.example.test/v1/embeddings",
      body: { model: "vector-001", input: ["a durable fact"], encoding_format: "float" } }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("catalog names do not grant an unsupported provider an embedding transport", () => {
  const registry = new ProviderRegistry(config, [["messages", catalog()]]);
  assert.deepEqual(registry.listEmbeddingModels().filter(model => model.ref.kind === "provider" && model.ref.provider === "messages"), []);
  assert.throws(() => registry.createEmbeddingRuntime({ kind: "provider", provider: "messages", model: "BAAI/bge-m3" }), /embedding/iu);
});

test("a resident memory owner adopts discovered models and rejects another endpoint's catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-owner-embedding-catalog-"));
  const store = new FileModelsStore(path.join(root, "models.json"));
  const current = structuredClone(config);
  current.context.memory.embeddingModel = { kind: "provider", provider: "gateway", model: "vector-001" };
  const owner = new AgentMemoryOwner(root, { load: async () => structuredClone(current), save: async () => {} },
    new LocalEmbeddingManager(path.join(root, "local")), store);
  try {
    assert.equal(await owner.execute("embedding.runtime"), null);
    const key = modelCatalogCacheKey("gateway", current.providers.gateway!);
    await store.write(key, { sourceKey: key, models: catalog() });
    const descriptor = await owner.execute("embedding.runtime") as EmbeddingModelDescriptor;
    assert.deepEqual(descriptor.ref, { kind: "provider", provider: "gateway", model: "vector-001" });
    current.providers.gateway!.baseUrl = "https://another.example.test/v1";
    assert.equal(await owner.execute("embedding.runtime"), null);
    current.context.memory.embeddingModel = { kind: "local", model: "multilingual-e5-small" };
    let catalogReads = 0;
    const readMany = store.readMany.bind(store);
    store.readMany = async keys => { catalogReads++; return readMany(keys); };
    assert.equal(await owner.execute("embedding.runtime", { localReadyOnly: true }), null);
    assert.equal(catalogReads, 0, "local embedding does not depend on provider catalog reads");
  } finally { await owner.close(); await rm(root, { recursive: true, force: true }); }
});
