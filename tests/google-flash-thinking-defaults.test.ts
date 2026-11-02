import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import * as capabilities from "../src/ai/capabilities.js";
import { applyGoogleProThinkingDefaults } from "../src/ai/googleThinkingDefaults.js";
import { configSchema, defaultConfig, type ModelAliasConfig, type ProviderConfig, type ReasoningEffort, type ModelProfile } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { modelThinkingSelections } from "../src/llm/modelThinking.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { toVercelReasoning } from "../src/agent/core/vercelModelAdapter.js";

type ProviderOptions = Record<string, { reasoningEffort?: string; [field: string]: unknown } | undefined> | undefined;
type Selection = "off" | ReasoningEffort;
const modern = ["gemini-3.7-flash", "gemini-3.8-flash"];
const nativeEndpoint = "https://generativelanguage.googleapis.com/v1beta";
const endpoint = `${nativeEndpoint}/openai`;
const source = readFileSync(new URL("../src/llm/ProviderRuntime.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("ProviderRuntime.ts", source, ts.ScriptTarget.Latest, true);
function functionText(name: string, tree = ast): string {
  const nodes = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1);
  return nodes[0]!.getText(tree);
}
const functions = ["mergeCompatibility", "createProviderOptions"].map(name => functionText(name)).join("\n");
function evaluate<T>(code: string, scope: Record<string, unknown>): T {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, scope) as T;
}
const createOptions = evaluate<(...args: unknown[]) => ProviderOptions>(`${functions}\ncreateProviderOptions;`, { ...capabilities });
const runtimeClass = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ConfiguredProviderRuntime");
assert.ok(runtimeClass);
const createSettings = runtimeClass.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(ast) === "createModelSettings");
assert.ok(createSettings?.body);
const normalStatements = createSettings.body.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => ["reasoningProtocol", "thinkingContext", "providerOptions"].includes(declaration.name.getText(ast))));
assert.ok(normalStatements.length > 0);
let auxiliaryMethod: ts.MethodDeclaration | undefined;
function findAuxiliary(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === "resolveTextReasoning") auxiliaryMethod = node;
  ts.forEachChild(node, findAuxiliary);
}
findAuxiliary(createSettings);
assert.ok(auxiliaryMethod);
const nativeSource = readFileSync(new URL("../src/llm/nativeJson.ts", import.meta.url), "utf8");
const nativeAst = ts.createSourceFile("nativeJson.ts", nativeSource, ts.ScriptTarget.Latest, true);
const mergeAuxiliary = evaluate<(model: unknown, options: Record<string, unknown>) => { providerOptions?: ProviderOptions; reasoning?: Selection }>(
  `${functionText("nativeTextRequestOptions", nativeAst)}\nnativeTextRequestOptions;`, {});

interface FixtureOptions { provider?: Partial<ProviderConfig>; alias?: Partial<ModelAliasConfig>; profile?: ModelProfile; catalogOnly?: boolean; providerAlias?: string }
function fixture(id: string, selected: Selection | undefined = undefined, options: FixtureOptions = {}) {
  const providerAlias = options.providerAlias ?? "google-work";
  const config = configSchema.parse({ ...structuredClone(defaultConfig), defaultModel: "selected",
    ...(selected === undefined ? {} : { thinking: { enabled: selected !== "off", effort: selected === "off" ? "high" : selected } }),
    providers: { [providerAlias]: { type: "gemini", requiresApiKey: false, ...options.provider, modelProfiles: options.profile ? { [id]: options.profile } : undefined } },
    models: { selected: { provider: providerAlias, model: options.catalogOnly ? "gemini-3.6-flash" : id, ...options.alias } } });
  const providers = new ProviderRegistry(config, [], new AiRegistry(), undefined, () => { throw new Error("Metadata must not fetch"); });
  const runtime = providers.require(providerAlias);
  const registry = new ModelRegistry(config, providers);
  registry.registerCatalog(providerAlias, runtime.getModels());
  const resolved = registry.resolve(options.catalogOnly ? `${providerAlias}/${id}` : "selected");
  assert.ok(resolved);
  const normalizedModel = resolved.model;
  const selection = capabilities.effectiveThinkingSelection(normalizedModel, config.thinking);
  const route = resolveProviderRequestRoute(normalizedModel, config.providers[providerAlias]!, runtime.definition);
  const api = route.apiBackend;
  const baseUrl = normalizedModel.baseUrl ?? config.providers[providerAlias]!.baseUrl ?? runtime.definition.baseUrl;
  assert.ok(baseUrl);
  const scope = { ...capabilities, createProviderOptions: createOptions, normalizedModel, api, protocol: route.protocol, baseUrl,
    enabled: selection !== "off", effort: selection === "off" ? undefined : selection,
    reasoningProtocol: runtime.definition.reasoningProtocol, compatibility: normalizedModel.compatibility,
    capabilities: capabilities.modelCapabilities(normalizedModel) };
  // Select actual option statements/callback, never credential preparation,
  // createModelSettings, a model request lifecycle, or unrelated method bodies.
  const normal = evaluate<(this: { config: ProviderConfig; definition: unknown }) => { providerOptions: ProviderOptions; resolveTextReasoning: (requested: Selection) => unknown }>(
    `(function () { ${normalStatements.map(node => node.getText(ast)).join("\n")}\nreturn { providerOptions, ${auxiliaryMethod!.getText(ast)} }; });`, scope)
    .call({ config: config.providers[providerAlias]!, definition: runtime.definition });
  const choice = registry.listModels().find(value => value.model === id);
  assert.ok(choice);
  return { config, normalizedModel, selection, api, baseUrl, runtime, registry, normal, providerAlias, choice, resolved };
}
function routeOptions(native: boolean): FixtureOptions {
  return native ? { provider: { apiBackend: "google_generative_ai", baseUrl: nativeEndpoint } } : {};
}
for (const id of modern) {
  for (const native of [false, true]) for (const catalogOnly of [false, true]) {
    test(`${id}/${native ? "native" : "Chat"}/${catalogOnly ? "catalog" : "configured"}: actual defaults and saved off resolve supported thinking`, () => {
      for (const selected of [undefined, "off", "low", "medium", "high", "max"] as const) {
        const f = fixture(id, selected, { ...routeOptions(native), catalogOnly });
        assert.equal(f.normalizedModel.thinkingLevelMap?.off, null);
        assert.equal(f.choice.thinkingLevelMap.off, null);
        assert.equal(f.choice.source, catalogOnly ? "catalog" : "configured");
        assert.equal(modelThinkingSelections(f.choice).includes("off"), false);
        assert.equal(f.selection, selected === "low" || selected === "medium" ? selected : "high");
        assert.deepEqual(f.runtime.resolveModel(f.normalizedModel, f.resolved.source), f.normalizedModel);
        assert.deepEqual(f.runtime.resolveModel(f.normalizedModel), f.normalizedModel);
        assert.equal(f.runtime.getModels().find(value => value.id === id)?.thinkingLevelMap?.off, "none");
      }
    });
  }
  test(`${id}: explicit alias and profile maps retain complete authority`, () => {
    for (const off of ["none", null, undefined]) for (const native of [false, true]) {
      const thinkingLevelMap = { low: "low", medium: "medium", high: "high", ...(off === undefined ? {} : { off }) };
      for (const options of [{ alias: { thinkingLevelMap } }, { catalogOnly: true, profile: { thinkingLevelMap } }]) {
        const f = fixture(id, undefined, { ...routeOptions(native), ...options });
        assert.equal(f.normalizedModel.thinkingLevelMap?.off, off);
        assert.equal(f.choice.thinkingLevelMap.off, off);
        assert.equal(f.selection, off === "none" ? "off" : "high");
      }
    }
    const f = fixture(id, undefined, { alias: { thinkingLevelMap: { off: "none", low: "low", high: "high" } }, profile: { thinkingLevelMap: { off: null, low: "low", high: "high" } } });
    assert.equal(f.normalizedModel.thinkingLevelMap?.off, null);
  });
  test(`${id}: explicit reasoning and disabled capability are not repaired`, () => {
    const explicit = fixture(id, undefined, { alias: { reasoning: { efforts: ["high"], defaultEffort: "high" } } });
    assert.notEqual(explicit.normalizedModel.thinkingLevelMap?.off, null);
    for (const options of [{ profile: { capabilities: { reasoning: false } } }, { alias: { compatibility: { supportsReasoning: false } } }]) {
      const f = fixture(id, undefined, options);
      assert.equal(f.normalizedModel.thinkingLevelMap?.off, "none");
      assert.equal(f.selection, "off");
    }
  });
  test(`${id}: effective model endpoint overrides connection endpoint`, () => {
    for (const native of [false, true]) {
      const apiBackend = native ? "google_generative_ai" : "chat_completions";
      const official = native ? nativeEndpoint : endpoint;
      const proxy = "https://relay.example/v1";
      const foreignModel = fixture(id, undefined, { provider: { apiBackend, baseUrl: official }, alias: { baseUrl: proxy } });
      assert.equal(foreignModel.normalizedModel.thinkingLevelMap?.off, "none");
      const officialModel = fixture(id, undefined, { provider: { apiBackend, baseUrl: proxy }, alias: { baseUrl: official } });
      assert.equal(officialModel.normalizedModel.thinkingLevelMap?.off, null);
      for (const type of ["openrouter", "openai-compatible", "custom"]) {
        const f = fixture(id, undefined, { provider: { type, apiBackend, baseUrl: official } });
        assert.notEqual(f.normalizedModel.thinkingLevelMap?.off, null);
      }
      const direct = fixture(id, undefined, { provider: { type: "google-native", apiBackend: "google_generative_ai", baseUrl: nativeEndpoint } });
      assert.equal(direct.normalizedModel.thinkingLevelMap?.off, null);
    }
  });
  test(`${id}: original catalog remains reusable across routes and endpoints`, () => {
    const original = fixture(id).runtime.getModels().find(value => value.id === id);
    assert.ok(original);
    const before = JSON.stringify(original);
    Object.freeze(original.thinkingLevelMap); Object.freeze(original);
    for (const [apiBackend, baseUrl, expected] of [
      ["chat_completions", endpoint, null], ["responses", endpoint, "none"],
      ["anthropic_messages", endpoint, "none"], ["google_generative_ai", nativeEndpoint, null],
      ["chat_completions", "https://relay.example/v1", "none"], ["chat_completions", endpoint, null]
    ] as const) {
      const f = fixture(id, undefined, { catalogOnly: true, provider: { apiBackend, baseUrl } });
      f.registry.registerCatalog(f.providerAlias, [original]);
      const resolved = f.registry.resolve(`${f.providerAlias}/${id}`);
      assert.ok(resolved);
      assert.equal(resolved.model.thinkingLevelMap?.off, expected);
      assert.equal(f.registry.listModels().find(value => value.model === id)?.thinkingLevelMap.off, expected);
      assert.equal(JSON.stringify(original), before);
    }
  });
  test(`${id}: max -> auxiliary off -> low -> max keeps actual supported selection and explicit options`, () => {
    for (const native of [false, true]) {
      const f = fixture(id, "max", routeOptions(native));
      const model = { ...f.normal, vercelOptions: { providerOptions: f.normal.providerOptions } };
      const before = JSON.stringify(model.vercelOptions);
      for (const requested of ["max", "off", "low", "max"] as const) {
        const result = mergeAuxiliary(model, { reasoning: requested });
        assert.equal(result.reasoning, requested === "low" ? "low" : "high");
        const google = result.providerOptions?.google;
        const thinkingConfig = google?.thinkingConfig;
        const native = thinkingConfig !== null && typeof thinkingConfig === "object"
          ? (thinkingConfig as { thinkingLevel?: unknown }).thinkingLevel
          : google?.reasoningEffort;
        assert.equal(native, requested === "low" ? "low" : "high");
        assert.equal(JSON.stringify(model.vercelOptions), before);
      }
      const explicit = { google: { thinkingBudget: 0 } };
      assert.equal(mergeAuxiliary(model, { reasoning: "off", providerOptions: explicit }).providerOptions, explicit);
      assert.equal(mergeAuxiliary(model, { reasoning: "off", providerOptions: undefined }).providerOptions, undefined);
    }
  });
}
for (const native of [false, true]) {
  const official = native ? nativeEndpoint : endpoint;
  for (const baseUrl of [official, `${official}/`]) {
    test(`${baseUrl}: exact official endpoint with optional single slash is supported`, () => {
      const f = fixture(modern[0]!, undefined, { provider: { apiBackend: native ? "google_generative_ai" : "chat_completions", baseUrl } });
      assert.equal(f.normalizedModel.thinkingLevelMap?.off, null);
    });
  }
  for (const baseUrl of [`${official}//`, `${official}?version=1`, `${official}/other`, official.replace("https:", "http:"), official.replace(".com", ".com:443"), native ? endpoint : nativeEndpoint]) {
    test(`${native ? "native" : "Chat"}/${baseUrl}: other endpoint contracts remain unchanged`, () => {
      const f = fixture(modern[0]!, undefined, { provider: { apiBackend: native ? "google_generative_ai" : "chat_completions", baseUrl } });
      assert.equal(f.normalizedModel.thinkingLevelMap?.off, "none");
    });
  }
}
for (const id of ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.8-flash-preview", "gemini-3.8-flash-extra", "gemini-3.9-flash", "GEMINI-3.8-FLASH", "models/gemini-3.8-flash"]) {
  test(`${id}: earlier Flash and unverified identifiers retain automatic off`, () => {
    for (const native of [false, true]) assert.equal(fixture(id, undefined, routeOptions(native)).normalizedModel.thinkingLevelMap?.off, "none");
  });
}
test("new automatic projection is immutable and requires known endpoint; existing Pro policy is unchanged", () => {
  const model: ModelAliasConfig = { provider: "g", model: modern[0]!, thinkingLevelMap: { off: "none", low: "low", high: "high" } };
  Object.freeze(model.thinkingLevelMap); Object.freeze(model);
  assert.equal(applyGoogleProThinkingDefaults(model, "gemini", "chat_completions"), model);
  const projected = applyGoogleProThinkingDefaults(model, "gemini", "chat_completions", false, endpoint);
  assert.notEqual(projected, model); assert.equal(projected.thinkingLevelMap?.off, null); assert.equal(model.thinkingLevelMap?.off, "none");
  assert.equal(applyGoogleProThinkingDefaults(projected, "gemini", "chat_completions", false, endpoint), projected);
  for (const id of ["gemini-2.5-pro", "gemini-3.1-pro-preview"]) assert.equal(applyGoogleProThinkingDefaults({ ...model, model: id }, "gemini", "chat_completions", false, "https://relay.example/v1").thinkingLevelMap?.off, null);
});

interface WireBody {
  generationConfig?: { thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number } };
  extra_body?: { google?: { thinking_config?: { thinking_level?: string } } };
  reasoning_effort?: string;
}
function response(native: boolean, streaming: boolean): Response {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const data = native
    ? { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }
    : { id: "fixture", created: 1, model: "fixture", object: streaming ? "chat.completion.chunk" : "chat.completion", choices: [{ index: 0, ...(streaming ? { delta: { content: "OK" } } : { message: { role: "assistant", content: "OK" } }), finish_reason: "stop" }], usage };
  return new Response(streaming ? `data: ${JSON.stringify(data)}\n\n${native ? "" : "data: [DONE]\n\n"}` : JSON.stringify(data), { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } });
}
async function wire(id: string, native: boolean, streaming: boolean, mode: "default" | "high" | "aux-off" | "explicit-off"): Promise<void> {
  const f = fixture(id, mode === "high" || mode === "aux-off" ? "high" : undefined, { ...routeOptions(native), ...(mode === "explicit-off" ? { alias: { thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" } } } : {}) });
  const auxiliary = mode === "aux-off" ? mergeAuxiliary({ ...f.normal, vercelOptions: { providerOptions: f.normal.providerOptions } }, { reasoning: "off" }) : undefined;
  const selection = auxiliary?.reasoning ?? f.selection;
  const providerOptions = auxiliary?.providerOptions ?? f.normal.providerOptions;
  const shouldBeOff = mode === "explicit-off" || (id === "gemini-3.6-flash" && mode === "default");
  assert.equal(selection, shouldBeOff ? "off" : "high");
  const bodies: WireBody[] = [];
  const model = createVercelLanguageModel({ providerAlias: f.providerAlias, providerType: f.config.providers[f.providerAlias]!.type, api: f.api, authMode: "api-key", modelId: id, supportsReasoning: true, baseUrl: f.baseUrl, apiKey: "inert-fixture", headers: {}, fetcher: async (url, init) => {
    assert.equal(new URL(String(url)).hostname, "generativelanguage.googleapis.com");
    bodies.push(JSON.parse(String(init?.body)) as WireBody); assert.equal(bodies.length, 1);
    return response(native, streaming);
  } });
  const params: LanguageModelV4CallOptions = { prompt: [{ role: "user", content: [{ type: "text", text: "Return OK." }] }], reasoning: toVercelReasoning(selection), providerOptions: providerOptions as LanguageModelV4CallOptions["providerOptions"] };
  const before = JSON.stringify(params);
  let text = "";
  if (streaming) { const result = await model.doStream(params); for await (const part of result.stream) { assert.notEqual(part.type, "error"); if (part.type === "text-delta") text += part.delta; } }
  else { const result = await model.doGenerate(params); text = result.content.filter(part => part.type === "text").map(part => part.text).join(""); }
  assert.equal(text, "OK"); assert.equal(JSON.stringify(params), before); assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  if (native) assert.equal(body.generationConfig?.thinkingConfig?.thinkingLevel, shouldBeOff ? "minimal" : "high");
  // Both the current compatible SDK and the #523 composed projection are valid
  // test targets. Check the actual emitted control rather than assume a wrapper.
  else if (body.extra_body?.google?.thinking_config) assert.equal(body.extra_body.google.thinking_config.thinking_level, shouldBeOff ? "minimal" : "high");
  else assert.equal(body.reasoning_effort, shouldBeOff ? undefined : "high");
}
for (const id of modern) for (const native of [false, true]) for (const streaming of [false, true]) for (const mode of ["default", "high", "aux-off", "explicit-off"] as const) {
  test(`${id}/${native ? "native" : "Chat"}/${streaming ? "stream" : "generate"}/${mode}: actual factory and fixed SDK wire`, () => wire(id, native, streaming, mode));
}
for (const native of [false, true]) for (const streaming of [false, true]) test(`3.6 Flash keeps minimal/${native ? "native" : "Chat"}/${streaming ? "stream" : "generate"}`, () => wire("gemini-3.6-flash", native, streaming, "default"));
