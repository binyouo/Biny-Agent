import assert from "node:assert/strict";
import { providerDefinition } from "../src/ai/provider.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { memoryPolicySchema } from "../src/personalization/index.js";
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
const localDefault = { kind: "local", model: "multilingual-e5-small" };
assert.deepEqual(defaultConfig.context.memory.embeddingModel, localDefault);
assert.deepEqual(configSchema.parse({ ...defaultConfig, context: undefined }).context.memory.embeddingModel, localDefault);
assert.deepEqual(memoryPolicySchema.parse({}).embeddingModel, localDefault);
assert.deepEqual(selectMemoryEmbeddingModel(undefined, models), localDefault,
  "omitted selection must not send facts to an available provider");
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

for (const selection of [localDefault, { kind: "local", model: "all-MiniLM-L6-v2" },
  { kind: "auto" }, { kind: "provider", provider: "google", model: "gemini-embedding-001" }]) {
  const parsed = configSchema.parse({ ...defaultConfig, context: { memory: { embeddingModel: selection } } });
  assert.deepEqual(parsed.context.memory.embeddingModel, selection);
}
assert.equal(configSchema.safeParse({ ...defaultConfig, configVersion: 1 }).success, false);
console.log("memory provider selection passed");
