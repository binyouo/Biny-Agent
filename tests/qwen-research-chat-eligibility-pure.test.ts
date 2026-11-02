/** Actual pure metadata/Registry bodies; no product Runtime import, credentials, SDK or network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import ts from "typescript";
import type { AgentConfig, ModelAliasConfig, ProviderConfig } from "../src/config/schema.js";
import type { ModelCatalogEntry, ProviderDefinition } from "../src/ai/types.js";
import type { ModelChoice, RegisteredModel } from "../src/llm/ModelRegistry.js";

const root = process.env.BINY_QWEN_CHAT_SOURCE_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
function source(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, readFileSync(path.join(root, "src", relative), "utf8"), ts.ScriptTarget.Latest, true);
}
function evaluate<T>(code: string, bindings: Record<string, unknown> = {}): T {
  const emitted = ts.transpileModule(code.replace(/\bexport /gu, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true
  });
  assert.equal(emitted.diagnostics?.length ?? 0, 0);
  const context = createContext({ ...bindings, URL }, { codeGeneration: { strings: false, wasm: false } });
  return new Script(emitted.outputText).runInContext(context, { timeout: 1000 }) as T;
}
function pureModule(relative: string, allowedImports: string[], bindings: Record<string, unknown> = {}): Record<string, unknown> {
  const file = source(relative);
  assert.deepEqual(file.statements.filter(ts.isImportDeclaration).filter(node => !node.importClause?.isTypeOnly)
    .map(node => (node.moduleSpecifier as ts.StringLiteral).text), allowedImports);
  const names: string[] = [];
  for (const node of file.statements) {
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) { assert.ok(ts.isIdentifier(declaration.name)); names.push(declaration.name.text); }
    } else if (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) { assert.ok(node.name); names.push(node.name.text); }
  }
  const code = file.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)).map(node => node.getText(file)).join("\n");
  return evaluate(`${code}\n;({${names.join(",")}})`, bindings);
}
const capabilities = pureModule("ai/capabilities.ts", []);
const generated = pureModule("ai/modelMetadata.generated.ts", []);
const codex = pureModule("ai/codexModels.ts", []);
const metadata = pureModule("ai/modelMetadata.ts", ["./modelMetadata.generated.js", "./capabilities.js", "./codexModels.js"], { ...capabilities, ...generated, ...codex });
const builtin = pureModule("ai/builtinModels.ts", ["./capabilities.js", "./codexModels.js", "./modelMetadata.js"], { ...capabilities, ...metadata, ...codex });
const providers = pureModule("ai/provider.ts", ["./builtinModels.js"], builtin);
const route = pureModule("llm/providerRequest.ts", ["../ai/provider.js"], providers);
const availability = pureModule("llm/modelChatAvailability.ts", ["../ai/provider.js", "./providerRequest.js"], { ...providers, ...route });
const reason = availability.modelChatUnavailabilityReason as (model: ModelAliasConfig | undefined, config: ProviderConfig, definition: ProviderDefinition) => string | undefined;
const registration = (providers.createBuiltinProviderRegistry as () => { get(type: string): { definition: ProviderDefinition; models: ModelCatalogEntry[] } })().get("qwen");
const definition = registration.definition;

const schema = source("config/schema.ts");
const removed = schema.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText(schema) === "removedModelIds")
  || ts.isFunctionDeclaration(node) && node.name?.text === "isRemovedModelId");
assert.equal(removed.length, 2);
const isRemovedModelId = evaluate(removed.map(node => node.getText(schema)).join("\n") + "\n;isRemovedModelId");
const registrySource = source("llm/ModelRegistry.ts");
interface Registry {
  registerCatalog(alias: string, entries: ModelCatalogEntry[]): void;
  listModels(): ModelChoice[];
  listAvailableModels(): ModelChoice[];
  resolve(alias: string): RegisteredModel | undefined;
  isAvailable(model: RegisteredModel): boolean;
}
const Registry = evaluate<new (config: AgentConfig, providers: { get(): Runtime }) => Registry>(registrySource.statements
  .filter(node => ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)).map(node => node.getText(registrySource)).join("\n") + "\n;ModelRegistry",
{ ...capabilities, ...providers, ...availability, isRemovedModelId });
const runtimeSource = source("llm/ProviderRuntime.ts");
const runtimeClass = runtimeSource.statements.filter(ts.isClassDeclaration).find(node => node.name?.text === "ConfiguredProviderRuntime");
assert.ok(runtimeClass);
const methods = ["isConfigured", "validate", "resolveModel", "normalizeCatalogEntry", "mergedCatalogEntry", "mergedCatalog"].map(name => {
  const method = runtimeClass.members.find(node => node.name?.getText(runtimeSource) === name); assert.ok(method); return method.getText(runtimeSource);
});
interface Runtime {
  config: ProviderConfig;
  definition: ProviderDefinition;
  isConfigured(model?: ModelAliasConfig): boolean;
  validate(model?: ModelAliasConfig): void;
  resolveModel(model: ModelAliasConfig): ModelAliasConfig;
  normalizeCatalogEntry(entry: ModelCatalogEntry): ModelCatalogEntry;
  mergedCatalog(): ModelCatalogEntry[];
}
const Runtime = evaluate<new () => Runtime>(runtimeSource.statements.filter(ts.isFunctionDeclaration)
  .map(node => node.getText(runtimeSource)).join("\n") + `\nclass PureRuntime {${methods.join("\n")}}\n;PureRuntime`,
{ ...capabilities, ...metadata, ...availability });

const target = "qwen-deep-research";
const model: ModelAliasConfig = { provider: "bailian", model: target };
const provider: ProviderConfig = { type: "qwen", requiresApiKey: false } as ProviderConfig;
function fixture(options: { id?: string; catalog?: boolean; live?: boolean; provider?: Partial<ProviderConfig>; model?: Partial<ModelAliasConfig>; definition?: ProviderDefinition } = {}) {
  const id = options.id ?? target;
  const config = {
    defaultModel: "selected", providers: { bailian: { ...provider, ...options.provider } },
    models: { selected: { provider: "bailian", model: options.catalog ? "ordinary-default" : id, ...options.model } },
    thinking: { enabled: false, effort: "high" }, context: {}
  } as unknown as AgentConfig;
  const runtime = new Runtime();
  Object.assign(runtime, {
    id: "bailian", config: config.providers.bailian, definition: options.definition ?? definition,
    baselineModels: registration.models.map(entry => ({ ...entry, provider: "bailian" })),
    liveModels: options.live ? [{ id, provider: "bailian", displayName: "Live research", capabilities: { tools: true }, showInPicker: true, reasoningEfforts: [] }] : [],
    resolveApiKey() { throw new Error("credential lookup is outside this pure fixture"); }
  });
  const registry = new Registry(config, { get: () => runtime });
  registry.registerCatalog("bailian", runtime.mergedCatalog().map(entry => runtime.normalizeCatalogEntry(entry)));
  const resolved = registry.resolve(options.catalog ? `bailian/${id}` : "selected"); assert.ok(resolved);
  const choice = registry.listModels().find(entry => entry.model === id); assert.ok(choice);
  return { config, runtime, registry, resolved, choice };
}

for (const baseUrl of [undefined, "https://dashscope.aliyuncs.com/compatible-mode/v1/", "https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"]) {
  for (const catalog of [false, true]) for (const live of [false, true]) {
    test(`official research is not an ordinary choice: ${baseUrl ?? "builtin"}, catalog=${catalog}, live=${live}`, () => {
      const h = fixture({ catalog, live, provider: { baseUrl, modelProfiles: { [target]: { showInPicker: true, capabilities: { tools: true } } } } });
      assert.equal(h.resolved.source, catalog ? "catalog" : "configured");
      assert.equal(h.choice.available, false);
      assert.equal(h.choice.showInPicker, false);
      assert.equal(h.registry.isAvailable(h.resolved), false);
      assert.equal(h.registry.listAvailableModels().some(entry => entry.model === target), false);
      assert.throws(() => h.runtime.validate(h.resolved.model), /qwen-deep-research.*DashScope/u);
      assert.equal(h.runtime.isConfigured(), true, "the qwen connection itself remains usable");
      assert.doesNotThrow(() => h.runtime.validate());
      assert.equal(h.choice.supportsTools, true, "eligibility does not rewrite raw metadata or explicit tool profiles");
    });
  }
}
for (const [name, options] of [
  ["provider gateway", { provider: { baseUrl: "https://gateway.example/v1" } }],
  ["model gateway overrides official provider", { model: { baseUrl: "https://gateway.example/v1" } }],
  ["generic compatible provider", { provider: { type: "openai-compatible", baseUrl: definition.baseUrl } }],
  ["plugin replaces builtin definition", { definition: { ...definition } }],
  ["explicit model API", { model: { apiBackend: "responses" } }],
  ["explicit provider API", { provider: { apiBackend: "responses" } }],
  ["explicit provider protocol", { provider: { protocol: "anthropic" } }],
  ["custom path on official host", { provider: { baseUrl: "https://dashscope.aliyuncs.com/custom/v1" } }],
  ["custom port on official host", { provider: { baseUrl: "https://dashscope.aliyuncs.com:8443/compatible-mode/v1" } }]
] as const) {
  test(`preserve explicit transport: ${name}`, () => {
    const h = fixture(options);
    assert.equal(h.choice.available, true); assert.equal(h.choice.showInPicker, true);
    assert.equal(h.registry.isAvailable(h.resolved), true);
    assert.doesNotThrow(() => h.runtime.validate(h.resolved.model));
  });
}
test("a model-level official endpoint takes precedence over a provider gateway", () => {
  const h = fixture({ provider: { baseUrl: "https://gateway.example/v1" }, model: { baseUrl: definition.baseUrl } });
  assert.equal(h.choice.available, false); assert.equal(h.choice.showInPicker, false);
});
for (const catalog of [false, true]) {
  test(`ordinary Qwen chat remains available, catalog=${catalog}`, () => {
    const h = fixture({ id: "qwen3.8-max", catalog, live: true });
    assert.equal(h.choice.available, true); assert.equal(h.choice.showInPicker, true);
    assert.doesNotThrow(() => h.runtime.validate(h.resolved.model));
  });
}
test("eligibility matches only the verified model and documented compatible endpoints", () => {
  for (const baseUrl of ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "https://dashscope-us.aliyuncs.com/compatible-mode/v1"]) {
    assert.match(reason(model, { ...provider, baseUrl }, definition) ?? "", /DashScope/u);
  }
  for (const id of ["qwen-deep-research-custom", "vendor/qwen-deep-research", "qwen-deep-research-2025-12-30"]) {
    assert.equal(reason({ ...model, model: id }, provider, definition), undefined);
  }
  for (const baseUrl of ["https://dashscope.aliyuncs.com.example/compatible-mode/v1", "https://example.com/compatible-mode/v1", "not-a-url"]) {
    assert.equal(reason(model, { ...provider, baseUrl }, definition), undefined);
  }
  assert.equal(reason(undefined, provider, definition), undefined);
});
