import assert from "node:assert/strict";
import { providerDefinition } from "../src/ai/provider.js";
import { migrateGlobalConfigDocument } from "../src/config/migrations.js";
import { selectMemoryEmbeddingModel } from "../src/llm/embedding/selectMemoryModel.js";
import type { EmbeddingModelDescriptor } from "../src/llm/embedding/types.js";

function provider(type: string, alias: string, model: string, available = true): EmbeddingModelDescriptor {
  return {
    ref: { kind: "provider", provider: alias, model }, source: "provider", providerType: type,
    fingerprint: `${alias}/${model}`, displayName: model, recommendedThreshold: 0.3, available
  };
}

const models = [
  provider("gemini", "google", "gemini-embedding-001"),
  provider("openrouter", "router", "openai/text-embedding-3-small", false),
  provider("openai", "openai-main", "text-embedding-3-small")
];
assert.deepEqual(providerDefinition("openrouter").embedding?.models.map((model) => model.id), [
  "openai/text-embedding-3-small", "openai/text-embedding-3-large"
]);
assert.deepEqual(selectMemoryEmbeddingModel({ kind: "auto" }, models), {
  kind: "provider", provider: "openai-main", model: "text-embedding-3-small"
});
assert.deepEqual(selectMemoryEmbeddingModel({ kind: "auto" }, models.slice(0, 2)), {
  kind: "provider", provider: "google", model: "gemini-embedding-001"
});
assert.equal(selectMemoryEmbeddingModel({ kind: "auto" }, models.slice(1, 2)), undefined);
assert.equal(selectMemoryEmbeddingModel({ kind: "provider", provider: "router", model: "openai/text-embedding-3-small" }, models), undefined);
assert.deepEqual(selectMemoryEmbeddingModel({ kind: "auto" }, [
  provider("openrouter", "router", "openai/text-embedding-3-large"),
  provider("openrouter", "router", "openai/text-embedding-3-small")
]), { kind: "provider", provider: "router", model: "openai/text-embedding-3-small" });

const migrated = migrateGlobalConfigDocument({
  format: "biny-config", configVersion: 1,
  context: { memory: { embeddingModel: { kind: "local", model: "multilingual-e5-small" }, cloudEmbeddingConsents: { old: { endpointHash: "old" } } } }
}).document as { configVersion: number; context: { memory: Record<string, unknown> } };
assert.equal(migrated.configVersion, 2);
assert.deepEqual(migrated.context.memory.embeddingModel, { kind: "auto" });
assert.equal(migrated.context.memory.cloudEmbeddingConsents, undefined);
const explicit = migrateGlobalConfigDocument({
  format: "biny-config", configVersion: 2,
  context: { memory: { embeddingModel: { kind: "local", model: "multilingual-e5-small" } } }
}).document as { context: { memory: Record<string, unknown> } };
assert.deepEqual(explicit.context.memory.embeddingModel, { kind: "local", model: "multilingual-e5-small" });

console.log("memory provider selection passed");
