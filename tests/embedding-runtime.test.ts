import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import type { ProviderDefinition } from "../src/ai/types.js";
import { providerDefinition } from "../src/ai/provider.js";
import { configSchema, defaultConfig, type ProviderConfig } from "../src/config/schema.js";
import {
  embeddingModelFingerprint,
  embeddingProviderEndpointHash,
  listProviderEmbeddingModels,
  LocalEmbeddingManager,
  normalizeEmbedding,
  ProviderEmbeddingRuntime
} from "../src/llm/embedding/index.js";

await testVectorValidation();
testExplicitProviderCapabilities();
testConfiguredEmbeddingCatalog();
await testOpenAiEmbeddingWire();
await testGoogleEmbeddingWire();
await testLocalEmbeddingLifecycle();
await testSqliteVectorProjection();

console.log("embedding runtime tests passed");

async function testSqliteVectorProjection(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-vec-projection-"));
  let index: MemoryVectorIndex | undefined;
  let database: DatabaseSync | undefined;
  const storage = new MemoryStorage(root, { agentDir: root });
  try {
    const allowed = (await storage.writeEntry({ content: "Allowed projection entry" })).entry!;
    const excluded = (await storage.writeEntry({ content: "Excluded projection entry" })).entry!;
    const memoryRoot = root;
    index = new MemoryVectorIndex(memoryRoot);
    index.replaceAll("test-vector-model", 2, [
      { entryId: allowed.id, revision: allowed.revision, embedding: [0.8, 0.6] },
      { entryId: excluded.id, revision: excluded.revision, embedding: [1, 0] }
    ]);
    database = new DatabaseSync(path.join(memoryRoot, "agent.sqlite"), { allowExtension: true });
    loadSqliteVec(database);
    assert.match(String(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_embeddings'").get()?.sql), /vec0/u);
    index.upsertActiveVectors("test-vector-model", 2, [{ entryId: allowed.id, revision: allowed.revision, embedding: [0, 1] }]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?").get(allowed.id)?.count, 1);
    index.close();
    index = new MemoryVectorIndex(memoryRoot);
    assert.match(String(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_embeddings'").get()?.sql), /FLOAT\[2\]/u);
    assert.equal(index.status().active?.modelFingerprint, "test-vector-model");
    assert.match(String(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_embeddings'").get()?.sql), /FLOAT\[2\]/u);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get()?.count, 2);
    const results = index.search([1, 0], { modelFingerprint: "test-vector-model", limit: 1, entryIds: new Set([allowed.id]) });
    assert.deepEqual(results.map((row) => row.entryId), [allowed.id]);
    assert.ok(Math.abs(results[0]!.similarity) < 1e-6);
    assert.deepEqual(index.listActiveEmbeddings({ modelFingerprint: "test-vector-model" }).map((row) => row.entryId), [allowed.id, excluded.id].sort());
    index.close();
    database.exec("DROP TABLE memory_embedding_versions");
    assert.equal(MemoryVectorIndex.openReadOnly(memoryRoot), undefined, "没有来源版本的旧投影不能当成有效索引");
    index = new MemoryVectorIndex(memoryRoot);
    assert.equal(index.status().active?.vectorCount, 0);
    assert.equal((await storage.listEntries()).total, 2, "派生投影失效不能删除事实");
    index.replaceAll("test-vector-model", 2, [
      { entryId: allowed.id, revision: allowed.revision, embedding: [0, 1] },
      { entryId: excluded.id, revision: excluded.revision, embedding: [1, 0] }
    ]);
    assert.equal(index.status().active?.vectorCount, 2, "重新嵌入后恢复当前事实投影");
  } finally {
    database?.close();
    index?.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function testVectorValidation(): void {
  const normalized = normalizeEmbedding([3, 4]);
  assert.ok(Math.abs(normalized[0]! - 0.6) < 1e-6);
  assert.ok(Math.abs(normalized[1]! - 0.8) < 1e-6);
  assert.throws(() => normalizeEmbedding([0, 0]), /positive finite norm/u);
  assert.throws(() => normalizeEmbedding([1, Number.NaN]), /non-finite/u);
  const endpointFingerprint = embeddingModelFingerprint({
      ref: { kind: "provider", provider: "example", model: "embed" },
      wire: "openai-compatible",
      endpoint: "https://first:secret@example.com/v1?token=secret"
    });
  assert.notEqual(
    endpointFingerprint,
    embeddingModelFingerprint({
      ref: { kind: "provider", provider: "example", model: "embed" },
      wire: "openai-compatible",
      endpoint: "https://example.com/v1"
    })
  );
  assert.equal(endpointFingerprint.includes("secret"), false);
}
function testExplicitProviderCapabilities(): void {
  assert.equal(providerDefinition("openai").embedding?.wire, "openai-compatible");
  assert.equal(providerDefinition("gemini").embedding?.wire, "openai-compatible");
  assert.equal(providerDefinition("gemini").embedding?.models[0]?.id, "gemini-embedding-001");
  assert.equal(providerDefinition("anthropic").embedding, undefined);
  assert.equal(providerDefinition("unregistered-provider").embedding, undefined);
}

function testConfiguredEmbeddingCatalog(): void {
  const config = configSchema.parse({
    ...structuredClone(defaultConfig),
    providers: {
      compatible: {
        type: "openai-compatible",
        baseUrl: "https://compatible.example/v1",
        apiKey: "test-secret",
        embeddingModels: [{
          id: "multilingual-custom",
          displayName: "Multilingual Custom",
          dimensions: 1_024,
          recommendedThreshold: 0.4
        }]
      }
    },
    models: {
      chat: { provider: "compatible", model: "chat-only-model" }
    },
    defaultModel: "chat"
  });
  const descriptors = listProviderEmbeddingModels(
    "compatible",
    config.providers.compatible!,
    providerDefinition("openai-compatible")
  );
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.displayName, "Multilingual Custom");
  assert.equal(descriptors[0]?.dimensions, 1_024);
  assert.equal(descriptors[0]?.endpoint, "https://compatible.example/v1");
  assert.equal(
    descriptors[0]?.privacyEndpointHash,
    embeddingProviderEndpointHash("compatible", "https://compatible.example/v1")
  );
  assert.equal(descriptors.some((descriptor) => descriptor.ref.model === "chat-only-model"), false);
  assert.throws(() => new ProviderEmbeddingRuntime(
    "compatible",
    config.providers.compatible!,
    providerDefinition("openai-compatible"),
    "chat-only-model",
    { fetcher: async () => Response.json({ data: [] }) }
  ), /not explicitly declared/u);
  assert.throws(() => configSchema.parse({
    ...structuredClone(config),
    providers: {
      compatible: {
        ...config.providers.compatible,
        embeddingModels: [
          { id: "duplicate", displayName: "First" },
          { id: "duplicate", displayName: "Second" }
        ]
      }
    }
  }), /Duplicate embedding model id/u);
}

async function testOpenAiEmbeddingWire(): Promise<void> {
  let captured: { url: string; init?: RequestInit } | undefined;
  const runtime = new ProviderEmbeddingRuntime(
    "cloud",
    providerConfig("openai-compatible", "https://embeddings.example/v1", "secret"),
    embeddingDefinition("openai-compatible", 3),
    "embed-v1",
    {
      fetcher: async (input, init) => {
        captured = { url: String(input), init };
        return Response.json({
          data: [
            { index: 1, embedding: [0, 2, 0] },
            { index: 0, embedding: [3, 0, 0] }
          ]
        });
      }
    }
  );
  const result = await runtime.embed({ texts: ["first", "second"], inputType: "passage" });
  assert.equal(captured?.url, "https://embeddings.example/v1/embeddings");
  assert.equal(new Headers(captured?.init?.headers).get("authorization"), "Bearer secret");
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
    model: "embed-v1",
    input: ["first", "second"],
    encoding_format: "float",
    dimensions: 3
  });
  assert.deepEqual([...result.embeddings[0]!], [1, 0, 0]);
  assert.deepEqual([...result.embeddings[1]!], [0, 1, 0]);

  const malformed = new ProviderEmbeddingRuntime(
    "cloud",
    providerConfig("openai-compatible", "https://embeddings.example/v1", "secret"),
    embeddingDefinition("openai-compatible", 3),
    "embed-v1",
    { fetcher: async () => Response.json({ data: [{ index: 0, embedding: [1, Number.NaN, 0] }] }) }
  );
  await assert.rejects(
    malformed.embed({ texts: ["bad"], inputType: "query" }),
    /non-finite/u
  );
}

async function testGoogleEmbeddingWire(): Promise<void> {
  const bodies: unknown[] = [];
  const runtime = new ProviderEmbeddingRuntime(
    "google",
    providerConfig("gemini", "https://generativelanguage.googleapis.com/v1beta", "google-secret"),
    embeddingDefinition("google-generative-ai", 3),
    "gemini-embedding-test",
    {
      fetcher: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ embedding: { values: [1, 1, 0] } });
      }
    }
  );
  const result = await runtime.embed({ texts: ["one", "two"], inputType: "query" });
  assert.equal(result.embeddings.length, 2);
  assert.equal((bodies[0] as { taskType?: unknown }).taskType, "RETRIEVAL_QUERY");
  assert.equal((bodies[0] as { outputDimensionality?: unknown }).outputDimensionality, 3);
}

async function testLocalEmbeddingLifecycle(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-local-embedding-"));
  let installed = false;
  let disposed = 0;
  let cleared = 0;
  const seenTexts: string[][] = [];
  const modelCache = path.join(root, "Xenova", "multilingual-e5-small", "761b726dd34fb83930e26aab4e9ac3899aa1fa78");
  const manager = new LocalEmbeddingManager(root, {
    moduleLoader: async () => ({
      pipeline: async (_task, _model, options) => {
        options.progress_callback?.({
          status: "progress_total",
          name: "model",
          progress: 50,
          loaded: 50,
          total: 100,
          files: {}
        });
        installed = true;
        const extractor = async (texts: string[]) => {
          seenTexts.push(texts);
          const data = new Float32Array(texts.length * 384);
          for (let row = 0; row < texts.length; row += 1) data[row * 384] = 1;
          return { data, dims: [texts.length, 384] };
        };
        extractor.dispose = async () => { disposed += 1; };
        return extractor;
      },
      ModelRegistry: {
        is_pipeline_cached: async () => installed,
        clear_pipeline_cache: async () => {
          installed = false;
          cleared += 1;
          await fs.rm(modelCache, { recursive: true, force: true });
          return { filesDeleted: 3 };
        }
      }
    })
  });
  try {
    assert.deepEqual(manager.descriptors().map((descriptor) => descriptor.ref), [{ kind: "local", model: "multilingual-e5-small" }]);
    const progress: number[] = [];
    await manager.download("multilingual-e5-small", { onProgress: (event) => {
      if (event.progress !== undefined) progress.push(event.progress);
    } });
    await fs.mkdir(modelCache, { recursive: true });
    await fs.writeFile(path.join(modelCache, "model.bin"), Buffer.alloc(100));
    assert.deepEqual(progress, [0, 0.5, 1]);
    assert.equal(disposed, 1);
    const runtime = await manager.createRuntime("multilingual-e5-small");
    assert.equal(manager.isReady(), false);
    const result = await runtime.embed({ texts: ["天气"], inputType: "query" });
    assert.equal(manager.isReady(), true);
    assert.equal(result.dimensions, 384);
    assert.deepEqual(seenTexts.at(-1), ["天气"]);
    await assert.rejects(
      manager.remove("multilingual-e5-small", { activeModel: "multilingual-e5-small" }),
      /active embedding model/u
    );
    await manager.close();
    assert.equal(manager.isReady(), false);
    const removed = await manager.remove("multilingual-e5-small");
    assert.equal(cleared, 1);
    assert.equal(removed.bytesFreed, 100);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function providerConfig(type: string, baseUrl: string, apiKey: string): ProviderConfig {
  return { type, baseUrl, apiKey };
}

function embeddingDefinition(
  wire: "openai-compatible" | "google-generative-ai",
  dimensions: number
): ProviderDefinition {
  return {
    type: "test-provider",
    protocol: "openai-compatible",
    baseUrl: "https://unused.example/v1",
    requiresApiKey: true,
    authModes: ["api-key"],
    embedding: {
      wire,
      models: [{
        id: wire === "google-generative-ai" ? "gemini-embedding-test" : "embed-v1",
        displayName: "Embedding Test",
        dimensions,
        recommendedThreshold: 0.3
      }]
    }
  };
}
