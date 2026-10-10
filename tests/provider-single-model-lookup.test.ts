import assert from "node:assert/strict";
import { ConfiguredProviderRuntime } from "../src/llm/ProviderRuntime.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import type { ModelAliasConfig, ProviderConfig } from "../src/config/schema.js";

const endpoint = "https://catalog-fixture.invalid/v1";
const failFetch: typeof globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
function entry(id: string, fields: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return { id, provider: "fixture", displayName: id, contextWindow: undefined,
    maxOutputTokens: undefined, capabilities: {}, reasoningEfforts: [], ...fields };
}
function runtime(baseline: ModelCatalogEntry[], live: ModelCatalogEntry[] = [],
  config: ProviderConfig = { type: "openai-compatible", baseUrl: endpoint }): ConfiguredProviderRuntime {
  const result = new ConfiguredProviderRuntime("fixture", config, new AiRegistry(), baseline, undefined, failFetch);
  result.restoreModels(live);
  return result;
}
function resolve(_name: string, target: ConfiguredProviderRuntime, model: Partial<ModelAliasConfig> = {}): ModelAliasConfig {
  const value = target.resolveModel({ provider: "fixture", model: "fixture-model", ...model });
  return value;
}

// Last baseline duplicate wins completely before live overlays inherit missing fields.
const baseline = [entry("fixture-model", { contextWindow: 99999, description: "discarded" }),
  entry("fixture-model", { contextWindow: 12000, maxOutputTokens: 4000, description: "baseline",
    capabilities: { tools: true, vision: true }, limits: { maxInputTokens: 9000, reasoningReserveTokens: 40 },
    pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 4 },
    apiBackend: "responses", baseUrl: endpoint, headers: { "x-fixture": "local" },
    compatibility: { supportsReasoning: false } })];
const live = [entry("fixture-model", { contextWindow: 16000, capabilities: { tools: false },
  limits: { reasoningReserveTokens: 0 }, pricing: { inputPerMillionTokens: 0 },
  apiBackend: "anthropic_messages", baseUrl: "https://untrusted.invalid/v1", headers: { "x-fixture": "remote" },
  compatibility: { supportsReasoning: true } }),
  entry("fixture-model", { displayName: "", maxOutputTokens: 0, capabilities: { tools: undefined },
    limits: { toolSchemaReserveTokens: 0 }, pricing: { cacheReadPerMillionTokens: 0 } })];
const merged = resolve("duplicate-fold", runtime(baseline, live));
assert.equal(merged.contextWindow, 16000);
assert.equal(merged.maxOutputTokens, 0);
assert.equal(merged.description, "baseline");
assert.equal(merged.capabilities?.tools, false);
assert.equal(merged.capabilities?.vision, true);
assert.equal(merged.limits?.maxInputTokens, 9000);
assert.equal(merged.limits?.reasoningReserveTokens, 0);
assert.equal(merged.limits?.toolSchemaReserveTokens, 0);
assert.equal(merged.pricing?.inputPerMillionTokens, 0);
assert.equal(merged.pricing?.outputPerMillionTokens, 4);
assert.equal(merged.pricing?.cacheReadPerMillionTokens, 0);
assert.equal(merged.apiBackend, "responses");
assert.equal(merged.baseUrl, endpoint);
assert.deepEqual(merged.headers, { "x-fixture": "local" });
assert.equal(merged.compatibility?.supportsReasoning, false);
assert.equal(resolve("baseline-only", runtime(baseline)).contextWindow, 12000);
assert.equal(resolve("live-only", runtime([], live)).contextWindow, 16000);
assert.equal(resolve("unknown", runtime(baseline, live), { model: "absent-fixture" }).contextWindow, undefined);

// Codex starts from the LAST live duplicate, then folds ALL live entries in order.
const codexConfig: ProviderConfig = { type: "openai-codex", baseUrl: endpoint };
const codexBaseline = [entry("fixture-model", { contextWindow: 99999, description: "not inherited" })];
const codexLive = [entry("fixture-model", { contextWindow: 17000 }),
  entry("fixture-model", { contextWindow: undefined, maxOutputTokens: 7000 })];
const codex = runtime(codexBaseline, codexLive, codexConfig);
assert.equal(resolve("codex-duplicates", codex).contextWindow, 17000);
assert.equal(resolve("codex-no-baseline-description", codex).description, undefined);
assert.equal(resolve("codex-empty-live", runtime(codexBaseline, [], codexConfig)).contextWindow, 99999);
assert.equal(resolve("codex-nonempty-no-target", runtime(codexBaseline, [entry("different")], codexConfig)).contextWindow, undefined);

// Declared empty reasoning is meaningful; inferred metadata follows production normalization.
for (const source of [undefined, "declared", "inferred"] as const) {
  const r = runtime([entry("fixture-model", { reasoningEfforts: ["low", "high"], capabilities: { reasoning: true } })],
    [entry("fixture-model", { reasoningEffortsSource: source, reasoningEfforts: [], capabilities: { reasoning: false } })]);
  assert.equal(resolve(`reasoning-${source ?? "absent"}`, r).capabilities?.reasoning, false);
}
for (const source of [undefined, "declared", "inferred"] as const) {
  const r = runtime([entry("fixture-model", { reasoningEfforts: ["low", "high"], capabilities: { reasoning: true } })],
    [entry("fixture-model", { reasoningEffortsSource: source, reasoningEfforts: [] })]);
  assert.deepEqual(resolve(`reasoning-inheritance-${source ?? "absent"}`, r).reasoning?.efforts,
    source === undefined ? ["low", "high"] : ["high", "max"]);
}
const declared = resolve("declared-map", runtime([], [entry("fixture-model", {
  capabilities: { reasoning: true }, reasoningEfforts: ["low", "high"], reasoningEffortsSource: "declared"
})]));
assert.deepEqual(declared.reasoning?.efforts, ["low", "high"]);
assert.equal(declared.thinkingLevelMap?.high, "high");
const generated = resolve("generated-inferred", runtime([], [entry("gpt-5", {
  reasoningEfforts: ["high"], reasoningEffortsSource: "inferred"
})], { type: "openai", baseUrl: "https://api.openai.com/v1" }), { model: "gpt-5" });
assert.equal(generated.contextWindow, 400000);
assert.equal(generated.maxOutputTokens, 128000);
assert.deepEqual(generated.reasoning?.efforts, ["minimal", "low", "medium", "high"]);

// The same object remains live: profiles, provider compatibility/type and endpoint can mutate.
const config: ProviderConfig = { type: "openai-compatible", baseUrl: endpoint,
  modelProfiles: { "fixture-model": { contextWindow: 22000, capabilities: { tools: false } } } };
const mutable = runtime(baseline, live, config);
assert.equal(resolve("profile-initial", mutable).contextWindow, 22000);
config.modelProfiles!["fixture-model"]!.contextWindow = 24000;
assert.equal(resolve("profile-mutated", mutable).contextWindow, 24000);
delete config.modelProfiles!["fixture-model"];
assert.equal(resolve("profile-removed", mutable).contextWindow, 16000);
config.compatibility = { supportsReasoning: true };
resolve("provider-compatibility-mutated", mutable);
assert.equal(resolve("endpoint-same-trailing-slash", mutable, { baseUrl: `${endpoint}/` }).contextWindow, 16000);
assert.equal(resolve("endpoint-override", mutable, { baseUrl: "https://override.invalid/v1" }).contextWindow, undefined);
config.baseUrl = "https://changed.invalid/v1";
assert.equal(resolve("provider-endpoint-mutated", mutable, { baseUrl: endpoint }).contextWindow, undefined);
config.type = "openai-codex";
assert.equal(resolve("provider-type-mutated", mutable).description, undefined);
mutable.restoreModels([entry("fixture-model", { contextWindow: 31000 })]);
assert.equal(resolve("restore-replacement", mutable).contextWindow, 31000);
mutable.restoreModels([]);
assert.equal(resolve("restore-empty", mutable).contextWindow, 12000);

// No private-field hooks: constructor preserves nested capability objects by shallow copy.
let unrelatedReads = 0;
const countedCapabilities = new Proxy<ModelCatalogEntry["capabilities"]>({ tools: true }, {
  get(target, key, receiver) {
    if (key === "tools") unrelatedReads += 1;
    return Reflect.get(target, key, receiver);
  }
});
const counted = runtime([entry("unrelated", { capabilities: countedCapabilities }), entry("fixture-model", { contextWindow: 42000 })],
  [entry("unrelated"), entry("fixture-model", { maxOutputTokens: 6000 })]);
unrelatedReads = 0;
assert.equal(resolve("cost-output", counted).contextWindow, 42000);
assert.equal(resolve("cost-repeat-output", counted).maxOutputTokens, 6000);
assert.equal(unrelatedReads, 0, "single-ID resolution must not read unrelated capabilities");
