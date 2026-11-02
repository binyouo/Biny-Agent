import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as capabilities from "../src/ai/capabilities.js";
import { isOrdinaryCatalogModelSupported } from "../src/ai/ordinaryModelCatalog.js";
import { generatedProviderModels, lookupModelMetadata } from "../src/ai/modelMetadata.js";
import { parseModelCatalog } from "../src/ai/modelCatalog.js";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import { configSchema, defaultConfig, type ModelAliasConfig, type ProviderConfig } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ModelRegistry, type ModelChoice } from "../src/llm/ModelRegistry.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";

const ids = ["deep-research-preview-04-2026", "deep-research-max-preview-04-2026"];
const nativeUrl = "https://generativelanguage.googleapis.com/v1beta";
const chatUrl = `${nativeUrl}/openai`;
const ordinaryId = "gemini-3.6-flash";
const cases: { name: string; provider: Partial<ProviderConfig> }[] = [
  { name: "builtin default Chat", provider: {} },
  { name: "native GenerateContent", provider: { apiBackend: "google_generative_ai", baseUrl: nativeUrl } },
  { name: "generic official endpoint", provider: { type: "openai-compatible", baseUrl: chatUrl } },
  { name: "legacy native endpoint", provider: { type: "google-native", baseUrl: nativeUrl } }
];
function fixture(provider: Partial<ProviderConfig> = {}, model?: Partial<ModelAliasConfig>, alias = "google-work") {
  const config = configSchema.parse({ ...structuredClone(defaultConfig), defaultModel: "selected",
    providers: { [alias]: { type: "gemini", requiresApiKey: false, ...provider } },
    models: { selected: { provider: alias, model: ordinaryId, ...model } } });
  const providers = new ProviderRegistry(config, [], new AiRegistry(), undefined, () => { throw new Error("Metadata must not fetch"); });
  const runtime = providers.require(alias);
  const registry = new ModelRegistry(config, providers);
  return { config, runtime, registry };
}
function rawEntry(id: string): ModelCatalogEntry {
  const entry = generatedProviderModels("gemini").find(value => value.id === id);
  assert.ok(entry);
  return structuredClone(entry);
}
function evaluate<T>(code: string, scope: Record<string, unknown> = {}): T {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, scope) as T;
}
function functions(path: string, names: readonly string[]): string {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return names.map(name => {
    const found = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(found.length, 1);
    return found[0]!.getText(ast).replace(/^export /u, "");
  }).join("\n");
}
// Only the actual pure picker group functions run. Presentation lookups are inert;
// no React render, Desktop bridge, native UI or model lifecycle is invoked.
const presentation = { catalogForConnection: () => undefined, resolveProviderIconId: () => undefined, URL };
const composerGroups = evaluate<(models: ModelChoice[]) => { models: ModelChoice[] }[]>(
  `${functions("../src/desktop/renderer/src/components/composer/ModelPickerMenu.tsx", ["groupModels", "hostLabel", "providerLabel"])}\ngroupModels;`, presentation);
const settingsGroups = evaluate<(models: ModelChoice[]) => { options: { value: string }[] }[]>(
  `${functions("../src/desktop/renderer/src/components/settings/settingsModelPickerData.ts", ["modelPickerGroups", "modelProviderPresentation"])}\nmodelPickerGroups;`, presentation);
function assertAbsent(registry: ModelRegistry, id: string): void {
  const reference = `google-work/${id}`;
  assert.equal(registry.resolve(reference), undefined);
  const choices = registry.listModels();
  assert.equal(choices.some(model => model.model === id), false);
  assert.equal(registry.listAvailableModels().some(model => model.model === id), false);
  assert.equal(composerGroups(choices).flatMap(group => group.models).some(model => model.model === id), false);
  assert.equal(settingsGroups(choices).flatMap(group => group.options).some(option => option.value === reference), false);
  assert.ok(registry.resolve("selected"));
}
for (const id of ids) for (const scenario of cases) {
  test(`${id}/${scenario.name}: builtin automatic catalog and both picker projections exclude Interactions-only agents`, () => {
    const { runtime, registry } = fixture(scenario.provider);
    assert.equal(runtime.getModels().some(entry => entry.id === id), false);
    assert.ok(runtime.getModels().some(entry => entry.id === ordinaryId));
    registry.registerCatalog("google-work", runtime.getModels());
    assertAbsent(registry, id);
    assert.equal(lookupModelMetadata("gemini", id)?.capabilities.tools, true);
    assert.ok(generatedProviderModels("gemini").some(entry => entry.id === id));
  });
  test(`${id}/${scenario.name}: parsed live input cannot reintroduce an automatic agent`, () => {
    const { runtime, registry } = fixture(scenario.provider);
    const live = parseModelCatalog({ models: [{ name: `models/${id}`, displayName: "synthetic live agent", supports_tools: true }] }, "google-work", "openai-compatible");
    assert.equal(live[0]?.id, id);
    // Supply only tiny synthetic catalog state; do not invoke refresh/restore/IO.
    Reflect.set(runtime, "baselineModels", []);
    Reflect.set(runtime, "liveModels", live);
    const before = JSON.stringify(live);
    assert.equal(runtime.getModels().some(entry => entry.id === id), false);
    registry.registerCatalog("google-work", runtime.getModels());
    assertAbsent(registry, id);
    assert.equal(JSON.stringify(live), before);
  });
  test(`${id}/${scenario.name}: public catalog registration is guarded without discarding raw metadata`, () => {
    const { registry } = fixture(scenario.provider);
    const entry = rawEntry(id);
    Object.freeze(entry.capabilities); Object.freeze(entry);
    registry.registerCatalog("google-work", [entry]);
    const before = JSON.stringify(registry.catalog("google-work"));
    assertAbsent(registry, id);
    assert.equal(registry.catalog("google-work")[0]?.id, id);
    assert.equal(JSON.stringify(registry.catalog("google-work")), before);
  });
  test(`${id}/${scenario.name}: explicit configured aliases and exact qualified references are preserved`, () => {
    const { registry, runtime } = fixture(scenario.provider, { model: id });
    registry.registerCatalog("google-work", [rawEntry(id)]);
    for (const reference of ["selected", "SELECTED", `google-work/${id}`]) {
      const resolved = registry.resolve(reference);
      assert.ok(resolved); assert.equal(resolved.source, "configured"); assert.equal(resolved.model.model, id);
    }
    assert.equal(registry.listModels().find(model => model.alias === "selected")?.supportsTools, true);
    assert.equal(runtime.resolveModel({ provider: "google-work", model: id }).model, id);
    assert.ok(composerGroups(registry.listModels()).flatMap(group => group.models).some(model => model.model === id));
    assert.ok(settingsGroups(registry.listModels()).flatMap(group => group.options).some(option => option.value === "selected"));
  });
}
for (const id of ids) {
  test(`${id}: showInPicker does not add a transport; configured alias visibility remains user-owned`, () => {
    for (const showInPicker of [false, true]) {
      const provider = { modelProfiles: { [id]: { showInPicker } } };
      const automatic = fixture(provider);
      automatic.registry.registerCatalog("google-work", [rawEntry(id)]);
      assertAbsent(automatic.registry, id);
      assert.equal(automatic.runtime.getModels().some(entry => entry.id === id), false);
      const explicit = fixture(provider, { model: id });
      const choice = explicit.registry.listModels().find(value => value.alias === "selected");
      assert.ok(choice); assert.equal(choice.showInPicker, showInPicker);
      assert.ok(explicit.registry.resolve("selected"));
    }
  });
  test(`${id}: custom endpoints and unknown API adapters retain automatic entries`, () => {
    for (const type of ["gemini", "google-native", "openai-compatible", "custom"]) {
      const f = fixture({ type, baseUrl: "https://relay.example/v1" });
      const entry = rawEntry(id);
      Reflect.set(f.runtime, "baselineModels", [entry]);
      assert.ok(f.runtime.getModels().some(value => value.id === id));
      f.registry.registerCatalog("google-work", [entry]);
      assert.equal(f.registry.resolve(`google-work/${id}`)?.source, "catalog");
      assert.ok(f.registry.listModels().some(model => model.model === id));
    }
    for (const apiBackend of ["example-interactions", "responses", "anthropic_messages"]) {
      const f = fixture({ apiBackend });
      assert.ok(f.runtime.getModels().some(entry => entry.id === id));
      f.registry.registerCatalog("google-work", [rawEntry(id)]);
      assert.equal(f.registry.resolve(`google-work/${id}`)?.source, "catalog");
    }
  });
  test(`${id}: catalog model endpoint overrides provider and same raw entry is reusable`, () => {
    const entry = rawEntry(id); Object.freeze(entry);
    for (const [providerUrl, modelUrl, supported] of [[chatUrl, "https://relay.example/v1", true], ["https://relay.example/v1", chatUrl, false]] as const) {
      const f = fixture({ baseUrl: providerUrl });
      const overridden = { ...entry, baseUrl: modelUrl };
      Reflect.set(f.runtime, "baselineModels", [overridden]);
      assert.equal(f.runtime.getModels().some(value => value.id === id), supported);
      f.registry.registerCatalog("google-work", [overridden]);
      assert.equal(f.registry.resolve(`google-work/${id}`) !== undefined, supported);
    }
    for (const baseUrl of [chatUrl, "https://relay.example/v1", chatUrl]) {
      const f = fixture({ baseUrl }); f.registry.registerCatalog("google-work", [entry]);
      assert.equal(f.registry.resolve(`google-work/${id}`) !== undefined, baseUrl !== chatUrl);
      assert.equal(f.registry.catalog("google-work")[0]?.id, id);
    }
  });
}
for (const api of ["chat_completions", "google_generative_ai"]) for (const endpoint of [nativeUrl, chatUrl]) {
  test(`${api}/${endpoint}: only exact official endpoints and exact IDs are excluded`, () => {
    for (const id of ids) {
      assert.equal(isOrdinaryCatalogModelSupported(id, api, endpoint), false);
      assert.equal(isOrdinaryCatalogModelSupported(id, api, `${endpoint}/`), false);
      for (const other of [undefined, `${endpoint}//`, `${endpoint}?v=1`, `${endpoint}#x`, `${endpoint}/other`, endpoint.replace("https:", "http:"), endpoint.replace(".com", ".com:443")]) {
        assert.equal(isOrdinaryCatalogModelSupported(id, api, other), true);
      }
      for (const other of [`models/${id}`, id.toUpperCase(), `${id}-other`, ordinaryId, "deep-research-preview-05-2026"]) {
        assert.equal(isOrdinaryCatalogModelSupported(other, api, endpoint), true);
      }
    }
  });
}

test("pure metadata regeneration preserves agent facts but cannot bypass the ordinary catalog policy", () => {
  const path = "../scripts/sync-model-metadata.mjs";
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = ast.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => ["PROVIDERS", "supportedEfforts", "ignoredEfforts"].includes(value.name.getText(ast))))
    .map(node => node.getText(ast).replace(/^export /u, "")).join("\n");
  const names = ["toMetadata", "toPricing", "assertModelShape", "parseReasoningOptions", "priceNumber", "positiveNumber", "finiteNumber", "isRecord", "buildGeneratedModule"];
  const generator = evaluate<{ toMetadata: (provider: string, id: string, model: unknown) => { capabilities: { tools: boolean } }; buildGeneratedModule: (data: unknown, aliases: unknown, providers: string[]) => string }>(
    `${declarations}\n${functions(path, names)}\n({toMetadata,buildGeneratedModule});`);
  const generated = Object.fromEntries(ids.map(id => [id, generator.toMetadata("google", id, {
    name: id, reasoning: true, tool_call: true, limit: { context: 1_048_576, output: 65_536 },
    modalities: { input: ["text", "image"], output: ["text"] }, api: { interactions: true }
  })]));
  for (const id of ids) assert.equal(generated[id]?.capabilities.tools, true);
  const module = generator.buildGeneratedModule({ gemini: generated }, {}, ["gemini"]);
  const moduleAst = ts.createSourceFile("generated.ts", module, ts.ScriptTarget.Latest, true);
  const declaration = moduleAst.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
    .find(node => node.name.getText(moduleAst) === "GENERATED_MODELS_DEV_METADATA");
  assert.ok(declaration?.initializer);
  const regenerated = JSON.parse(declaration.initializer.getText(moduleAst)) as unknown;
  const catalogFor = evaluate<(provider: string) => ModelCatalogEntry[]>(
    `${functions("../src/ai/modelMetadata.ts", ["generatedProviderModels", "generatedProviderType", "metadataToCatalogEntry"])}\ngeneratedProviderModels;`,
    { ...capabilities, GENERATED_MODELS_DEV_METADATA: regenerated, GENERATED_MODELS_DEV_PROVIDER_ALIASES: {} });
  const entries = catalogFor("gemini"); assert.equal(entries.length, 2);
  const f = fixture(); Reflect.set(f.runtime, "baselineModels", entries); Reflect.set(f.runtime, "liveModels", []);
  assert.deepEqual(f.runtime.getModels(), []);
  f.registry.registerCatalog("google-work", entries);
  for (const id of ids) assertAbsent(f.registry, id);
  for (const id of ids) assert.equal(lookupModelMetadata("gemini", id)?.capabilities.tools, true);
});

for (const id of ids) {
  for (const throws of [false, true]) test(`${id}: eligibility also applies after extension filters and their fallback (${throws})`, () => {
    const f = fixture();
    const definition = { ...f.runtime.definition, filterModels: (entries: readonly ModelCatalogEntry[]) => {
      if (throws) throw new Error("synthetic filter failure");
      return [...entries.filter(entry => entry.id !== id), rawEntry(id)];
    } };
    Reflect.set(f.runtime, "definition", definition);
    const result = f.runtime.getModels();
    assert.equal(result.some(entry => entry.id === id), false);
    assert.ok(result.some(entry => entry.id === ordinaryId));
  });
  test(`${id}: provider aliases with slashes cannot bypass the fallback catalog lookup`, () => {
    const alias = "google/work";
    const f = fixture({}, undefined, alias);
    f.registry.registerCatalog(alias, [rawEntry(id)]);
    assert.equal(f.registry.resolve(`${alias}/${id}`), undefined);
    assert.equal(f.registry.listModels().some(model => model.model === id), false);
    const explicit = fixture({}, { model: id }, alias);
    explicit.registry.registerCatalog(alias, [rawEntry(id)]);
    // The existing first-slash reference parser does not match this configured
    // alias by its qualified spelling; its direct alias remains authoritative.
    assert.equal(explicit.registry.resolve("selected")?.source, "configured");
  });
  test(`${id}: unchanged raw catalog can be projected again after in-memory endpoint changes`, () => {
    const f = fixture();
    f.registry.registerCatalog("google-work", [rawEntry(id)]);
    const before = JSON.stringify(f.registry.catalog("google-work"));
    for (const baseUrl of [chatUrl, "https://relay.example/v1", chatUrl]) {
      f.config.providers["google-work"]!.baseUrl = baseUrl;
      f.runtime.config.baseUrl = baseUrl;
      assert.equal(f.registry.resolve(`google-work/${id}`) !== undefined, baseUrl !== chatUrl);
      assert.equal(f.runtime.getModels().some(entry => entry.id === id), baseUrl !== chatUrl);
      assert.equal(JSON.stringify(f.registry.catalog("google-work")), before);
    }
  });
}

for (const id of ids) test(`${id}: catalog model API and connection API retain their resolver precedence`, () => {
  for (const [providerApi, entryApi, supported] of [["chat_completions", "example-interactions", true], ["example-interactions", "google_generative_ai", false]] as const) {
    const f = fixture({ apiBackend: providerApi });
    const entry = { ...rawEntry(id), apiBackend: entryApi };
    Reflect.set(f.runtime, "baselineModels", [entry]);
    assert.equal(f.runtime.getModels().some(value => value.id === id), supported);
    f.registry.registerCatalog("google-work", [entry]);
    assert.equal(f.registry.resolve(`google-work/${id}`) !== undefined, supported);
  }
  const f = fixture();
  Reflect.set(f.runtime, "definition", { ...f.runtime.definition, api: "example-interactions" });
  assert.ok(f.runtime.getModels().some(entry => entry.id === id));
  f.registry.registerCatalog("google-work", [rawEntry(id)]);
  assert.ok(f.registry.resolve(`google-work/${id}`));
});
