import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import * as capabilities from "../src/ai/capabilities.js";
import { applyZaiThinkingDefaults, automaticZaiThinkingOptions } from "../src/ai/zaiThinkingDefaults.js";
import { configSchema, defaultConfig, type ModelAliasConfig, type ProviderConfig, type ReasoningEffort, type ModelProfile } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { modelThinkingSelections } from "../src/llm/modelThinking.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { toModelMessages, toVercelReasoning } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentMessage } from "../src/agent/core/types.js";

type ProviderOptions = Record<string, { reasoningEffort?: string; [field: string]: unknown } | undefined> | undefined;
type Selection = "off" | ReasoningEffort;
const modern = ["glm-5.3", "glm-5.3-flash"];
const endpoint = "https://api.z.ai/api/paas/v4";
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
const createOptions = evaluate<(...args: unknown[]) => ProviderOptions>(`${functions}\ncreateProviderOptions;`, { ...capabilities, automaticZaiThinkingOptions });
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
  const providerAlias = options.providerAlias ?? "zai-work";
  const config = configSchema.parse({ ...structuredClone(defaultConfig), defaultModel: "selected",
    ...(selected === undefined ? {} : { thinking: { enabled: selected !== "off", effort: selected === "off" ? "high" : selected } }),
    providers: { [providerAlias]: { type: "zai", requiresApiKey: false, ...options.provider, modelProfiles: options.profile ? { [id]: options.profile } : undefined } },
    models: { selected: { provider: providerAlias, model: options.catalogOnly ? "glm-5.2" : id, ...options.alias } } });
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
function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

for (const id of modern) {
  for (const catalogOnly of [false, true]) {
    test(`${id}/${catalogOnly ? "catalog" : "configured"}: actual defaults and global off use supported choices`, () => {
      for (const selected of [undefined, "off", "low", "high", "max"] as const) {
        const f = fixture(id, selected, { catalogOnly });
        assert.equal(f.normalizedModel.thinkingLevelMap?.off, null);
        assert.equal(f.choice.thinkingLevelMap.off, null);
        assert.equal(f.choice.source, catalogOnly ? "catalog" : "configured");
        assert.equal(modelThinkingSelections(f.choice).includes("off"), false);
        assert.equal(f.selection, selected === undefined || selected === "off" ? "high" : selected);
        assert.equal(f.api, "chat_completions");
        assert.equal(f.normalizedModel.apiBackend, undefined);
        assert.deepEqual(f.runtime.resolveModel(f.normalizedModel, f.resolved.source), f.normalizedModel);
        assert.deepEqual(f.runtime.resolveModel(f.normalizedModel), f.normalizedModel);
        assert.equal(f.runtime.getModels().find(value => value.id === id)?.thinkingLevelMap?.off, "none");
      }
    });
  }
  for (const effort of ["low", "high", "max"] as const) {
    test(`${id}/${effort}: actual normal and auxiliary options preserve native effort`, () => {
      const f = fixture(id, effort);
      const expected = { openai: { reasoningEffort: effort }, zai: { reasoningEffort: effort }, openaiCompatible: { reasoningEffort: effort } };
      assert.deepEqual(plain(f.normal.providerOptions), expected);
      assert.deepEqual(plain(f.normal.resolveTextReasoning(effort)), { reasoning: effort, providerOptions: expected });
    });
  }
  test(`${id}: max to auxiliary off/high/low and back has no stale namespace or mutation`, () => {
    const f = fixture(id, "max");
    const model = { ...f.normal, vercelOptions: { providerOptions: { ...f.normal.providerOptions,
      zai: { ...f.normal.providerOptions?.zai, marker: "keep" }, other: { keep: true } } } };
    const before = JSON.stringify(model.vercelOptions);
    for (const requested of ["off", "high", "low", "max", "off", "max"] as const) {
      const result = mergeAuxiliary(model, { reasoning: requested });
      const expected = requested === "off" ? "high" : requested;
      assert.equal(result.reasoning, expected);
      assert.equal(result.providerOptions?.zai?.reasoningEffort, expected);
      assert.equal(result.providerOptions?.openaiCompatible?.reasoningEffort, expected);
      assert.equal(result.providerOptions?.zai?.marker, "keep");
      assert.deepEqual(plain(result.providerOptions?.other), { keep: true });
      assert.equal(JSON.stringify(model.vercelOptions), before);
    }
    const explicit = { openaiCompatible: { reasoningEffort: "low" } };
    assert.equal(mergeAuxiliary(model, { reasoning: "max", providerOptions: explicit }).providerOptions, explicit);
    assert.equal(mergeAuxiliary(model, { reasoning: "max", providerOptions: undefined }).providerOptions, undefined);
    assert.equal(mergeAuxiliary(model, {}).providerOptions, model.vercelOptions.providerOptions);
  });
  for (const off of ["none", null, undefined]) {
    test(`${id}: explicit off=${String(off)} remains authoritative on alias and profile`, () => {
      const thinkingLevelMap = { low: "low", high: "high", max: "max", ...(off === undefined ? {} : { off }) };
      for (const options of [{ alias: { thinkingLevelMap } }, { catalogOnly: true, profile: { thinkingLevelMap } }]) {
        const f = fixture(id, "max", options);
        assert.equal(f.normalizedModel.thinkingLevelMap?.off, off);
        assert.equal(f.choice.thinkingLevelMap.off, off);
        assert.equal(f.normal.providerOptions?.openaiCompatible?.reasoningEffort, off === "none" ? undefined : "max");
        const aux = mergeAuxiliary({ ...f.normal, vercelOptions: { providerOptions: f.normal.providerOptions } }, { reasoning: "off" });
        if (off === "none") {
          assert.equal(aux.reasoning, "off");
          assert.deepEqual(plain(aux.providerOptions), { openai: { reasoningEffort: "none" } });
        } else assert.equal(aux.providerOptions?.openaiCompatible?.reasoningEffort, "high");
      }
    });
  }
  test(`${id}: explicit reasoning and unknown non-current native keep the whole old option path`, () => {
    for (const alias of [
      { reasoning: { efforts: ["high" as const, "max" as const], defaultEffort: "high" as const } },
      { thinkingLevelMap: { off: null, low: "vendor-custom", high: "high", max: "max" } }
    ]) {
      const f = fixture(id, "max", { alias });
      assert.deepEqual(plain(f.normal.providerOptions), { openai: { reasoningEffort: "max" } });
      const aux = mergeAuxiliary({ ...f.normal, vercelOptions: { providerOptions: f.normal.providerOptions } }, { reasoning: "high" });
      assert.deepEqual(plain(aux.providerOptions), { openai: { reasoningEffort: "high" } });
    }
    const mapped = fixture(id, "high", { alias: { thinkingLevelMap: { off: null, high: "max" } } });
    assert.equal(mapped.normal.providerOptions?.openaiCompatible?.reasoningEffort, "max");
  });
  test(`${id}: fresh catalog can switch actual routes without sticky automatic capability`, () => {
    const original = fixture(id).runtime.getModels().find(value => value.id === id);
    assert.ok(original);
    const before = JSON.stringify(original);
    Object.freeze(original.thinkingLevelMap); Object.freeze(original);
    for (const apiBackend of [undefined, "responses", "anthropic_messages", "google_generative_ai", "chat_completions", undefined] as const) {
      const f = fixture(id, "high", { catalogOnly: true, provider: { apiBackend } });
      f.registry.registerCatalog(f.providerAlias, [original]);
      const resolved = f.registry.resolve(`${f.providerAlias}/${id}`); assert.ok(resolved);
      const target = apiBackend === undefined || apiBackend === "chat_completions";
      assert.equal(resolved.model.thinkingLevelMap?.off, target ? null : "none");
      assert.equal(f.registry.listModels().find(value => value.model === id)?.thinkingLevelMap.off, target ? null : "none");
      assert.equal(JSON.stringify(original), before);
    }
  });
  test(`${id}: endpoint precedence and supplier boundaries are exact`, () => {
    for (const provider of [
      { baseUrl: "https://api.z.ai/api/coding/paas/v4" },
      { baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
      { baseUrl: "https://relay.example/v1" },
      { type: "openai-compatible", baseUrl: endpoint },
      { type: "openrouter", baseUrl: endpoint }
    ]) {
      const f = fixture(id, "max", { provider });
      assert.notEqual(f.normalizedModel.thinkingLevelMap?.off, null);
      assert.equal(f.normal.providerOptions?.zai, undefined);
      assert.equal(f.normal.providerOptions?.openaiCompatible, undefined);
    }
    const remote = fixture(id, "max", { alias: { baseUrl: "https://relay.example/v1" } });
    assert.equal(remote.normal.providerOptions?.zai, undefined);
    const official = fixture(id, "max", { provider: { baseUrl: "https://relay.example/v1" }, alias: { baseUrl: endpoint } });
    assert.equal(official.normal.providerOptions?.zai?.reasoningEffort, "max");
    for (const options of [{ provider: { protocol: "anthropic" as const } },
      { alias: { apiBackend: "responses" as const } }, { provider: { apiBackend: "responses" as const } }]) {
      assert.equal(fixture(id, "max", options).normal.providerOptions?.zai, undefined);
    }
  });
}
for (const id of ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-5.3-highspeed", "glm-5.3-flashx", "glm-5.3-20260814", "GLM-5.3", "zai/glm-5.3"]) {
  test(`${id}: no family, route or alias inference`, () => {
    const model: ModelAliasConfig = { provider: "work", model: id, thinkingLevelMap: { off: null, high: "high", max: "max" } };
    assert.equal(applyZaiThinkingDefaults(model, "chat_completions", { providerType: "zai", baseUrl: endpoint }), model);
    assert.equal(automaticZaiThinkingOptions(model, "chat_completions", true, "max", { providerType: "zai", baseUrl: endpoint }), undefined);
  });
}
for (const baseUrl of [`${endpoint}//`, `${endpoint}?x=1`, `${endpoint}/extra`, "https://API.Z.AI/api/paas/v4", "https://api.z.ai:443/api/paas/v4", "http://api.z.ai/api/paas/v4"]) {
  test(`${baseUrl}: nonexact endpoints keep old options`, () => {
    const f = fixture("glm-5.3", "max", { provider: { baseUrl } });
    assert.equal(f.normal.providerOptions?.openaiCompatible, undefined);
    assert.equal(f.normalizedModel.thinkingLevelMap?.off, "none");
  });
}
test("empty, disabled and incompatible maps are not projected", () => {
  const disabledAliases: Array<Partial<ModelAliasConfig>> = [
    { thinkingLevelMap: {} },
    { compatibility: { supportsReasoning: false } },
    { thinkingLevelMap: { off: "none", high: null, max: null } }
  ];
  for (const alias of disabledAliases) assert.equal(fixture("glm-5.3", "off", { alias }).normal.providerOptions?.zai, undefined);
  assert.equal(fixture("glm-5.3", "off", { profile: { capabilities: { reasoning: false } } }).normal.providerOptions, undefined);
  const model: ModelAliasConfig = { provider: "work", model: "glm-5.3", capabilities: { reasoning: false }, thinkingLevelMap: { off: null, high: "high" } };
  assert.equal(automaticZaiThinkingOptions(model, "chat_completions", true, "high", { providerType: "zai", baseUrl: endpoint }), undefined);
});
test("automatic helpers are immutable and idempotent, and absent context does nothing", () => {
  const model: ModelAliasConfig = { provider: "work", model: "glm-5.3", thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" } };
  Object.freeze(model.thinkingLevelMap); Object.freeze(model);
  const context = Object.freeze({ providerType: "zai", baseUrl: endpoint });
  const projected = applyZaiThinkingDefaults(model, "chat_completions", context);
  assert.equal(projected.thinkingLevelMap?.off, null);
  assert.equal(model.thinkingLevelMap?.off, "none");
  assert.equal(applyZaiThinkingDefaults(projected, "chat_completions", context), projected);
  assert.equal(applyZaiThinkingDefaults(model, "chat_completions", context, true), model);
  assert.equal(automaticZaiThinkingOptions(projected, "chat_completions", true, "max", undefined), undefined);
  assert.equal(automaticZaiThinkingOptions(projected, "chat_completions", false, undefined, context), undefined);
  assert.deepEqual(automaticZaiThinkingOptions(projected, "chat_completions", true, "max", context), { zai: { reasoningEffort: "max" }, openaiCompatible: { reasoningEffort: "max" } });
});

function response(stream: boolean): Response {
  const head = { id: "fixture", created: 1, model: "fixture" }, usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
  const chunks = [{ ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
    { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }];
  return new Response(stream ? chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
    : JSON.stringify({ ...head, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage }),
  { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
}
const messages: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "Inspect the inert sample." }] },
  { role: "assistant", content: [{ type: "toolCall", id: "call_fixture", name: "Inspect", arguments: { value: "sample" } }] },
  { role: "toolResult", toolCallId: "call_fixture", toolName: "Inspect", content: [{ type: "text", text: "sample" }], isError: false }
];
interface WireBody { reasoning_effort?: string; messages: Array<{ role: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>; tools: Array<{ function: { name: string } }> }
async function wire(f: ReturnType<typeof fixture>, stream: boolean, effective: { reasoning?: Selection; providerOptions?: ProviderOptions }): Promise<WireBody> {
  const captured: WireBody[] = [];
  const sdk = createVercelLanguageModel({ providerAlias: f.providerAlias, providerType: f.config.providers[f.providerAlias]!.type, authMode: "api-key", api: f.api, modelId: f.normalizedModel.model,
    supportsReasoning: true, baseUrl: f.baseUrl, apiKey: "synthetic", headers: {}, fetcher: async (url, init) => {
      assert.equal(String(url), `${f.baseUrl.replace(/\/$/u, "")}/chat/completions`); assert.equal(typeof init?.body, "string"); captured.push(JSON.parse(init!.body as string) as WireBody); return response(stream);
    } });
  const options: LanguageModelV4CallOptions = { prompt: toModelMessages(messages) as LanguageModelV4CallOptions["prompt"], reasoning: toVercelReasoning(effective.reasoning),
    providerOptions: effective.providerOptions as LanguageModelV4CallOptions["providerOptions"], tools: [{ type: "function", name: "Inspect", inputSchema: { type: "object", properties: { value: { type: "string" } } } }], toolChoice: { type: "auto" } };
  const before = JSON.stringify(options); let text = "";
  if (stream) { const result = await sdk.doStream(options); for await (const part of result.stream) { assert.notEqual(part.type, "error"); if (part.type === "text-delta") text += part.delta; } }
  else { const result = await sdk.doGenerate(options); text = result.content.filter(part => part.type === "text").map(part => part.text).join(""); }
  assert.equal(text, "OK"); assert.equal(JSON.stringify(options), before); assert.equal(captured.length, 1);
  const body = captured[0]!;
  assert.equal(body.tools[0]?.function.name, "Inspect");
  assert.equal(body.messages.find(message => message.role === "tool")?.tool_call_id, "call_fixture");
  const call = body.messages.find(message => message.role === "assistant")?.tool_calls?.[0];
  assert.equal(call?.id, "call_fixture"); assert.equal(call?.function.name, "Inspect"); assert.equal(call?.function.arguments, '{"value":"sample"}');
  return body;
}
for (const id of modern) for (const providerAlias of ["zai", "zai-work", "zai_work", "openai", "openaiCompatible"]) {
  for (const stream of [false, true]) for (const effort of ["off", "low", "high", "max"] as const) for (const auxiliary of [false, true]) {
    test(`${id}/${providerAlias}/${stream ? "stream" : "generate"}/${effort}/${auxiliary ? "auxiliary" : "normal"}: actual SDK wire`, async () => {
      const f = fixture(id, auxiliary ? "max" : effort, { providerAlias });
      const effective = auxiliary ? mergeAuxiliary({ ...f.normal, vercelOptions: { providerOptions: f.normal.providerOptions } }, { reasoning: effort })
        : { reasoning: f.selection, providerOptions: f.normal.providerOptions };
      assert.equal((await wire(f, stream, effective)).reasoning_effort, effort === "off" ? "high" : effort);
    });
  }
}
for (const stream of [false, true]) {
  test(`explicit raw/camel and whole-map options preserve SDK precedence/${stream}`, async () => {
    const f = fixture("glm-5.3", "max");
    const defaults = f.normal.providerOptions;
    const model = { ...f.normal, vercelOptions: { providerOptions: defaults } };
    for (const providerOptions of [
      { ...defaults, "zai-work": { reasoningEffort: "low" } },
      { ...defaults, "zai-work": { reasoningEffort: "low" }, zaiWork: { reasoningEffort: "high" } },
      { openaiCompatible: { reasoningEffort: "low" } }
    ]) {
      const effective = mergeAuxiliary(model, { reasoning: "max", providerOptions });
      assert.equal(effective.providerOptions, providerOptions);
      const expected = "zaiWork" in providerOptions ? "high" : "low";
      assert.equal((await wire(f, stream, effective)).reasoning_effort, expected);
    }
    assert.equal((await wire(f, stream, mergeAuxiliary(model, { reasoning: "max", providerOptions: undefined }))).reasoning_effort, "xhigh");
  });
  test(`official trailing slash uses the same SDK endpoint/${stream}`, async () => {
    const f = fixture("glm-5.3", "max", { provider: { baseUrl: `${endpoint}/` } });
    assert.equal((await wire(f, stream, { reasoning: f.selection, providerOptions: f.normal.providerOptions })).reasoning_effort, "max");
  });
}
for (const stream of [false, true]) {
  for (const options of [
    { provider: { baseUrl: "https://api.z.ai/api/coding/paas/v4" } },
    { provider: { baseUrl: "https://relay.example/v1" } },
    { provider: { type: "openai-compatible", baseUrl: endpoint } },
    { alias: { thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" } } },
    { alias: { thinkingLevelMap: { off: null, low: "custom-native", high: "high", max: "max" } } }
  ] satisfies FixtureOptions[]) {
    test(`${JSON.stringify(options)}/${stream}: explicit and alternate-route wires equal prior option behavior`, async () => {
      for (const effort of ["off", "high", "max"] as const) {
        const f = fixture("glm-5.3", effort, options);
        // The optional-context API retains the exact prior option path. Compare
        // both with the same real factory, including in composed-PR runs.
        const previous = createOptions("openai", f.config.providers[f.providerAlias], f.normalizedModel, f.api,
          f.selection !== "off", f.selection === "off" ? undefined : f.selection);
        assert.deepEqual(plain(f.normal.providerOptions), plain(previous));
        const currentWire = await wire(f, stream, { reasoning: f.selection, providerOptions: f.normal.providerOptions });
        assert.deepEqual(currentWire, await wire(f, stream, { reasoning: f.selection, providerOptions: previous }));
      }
    });
  }
  test(`GLM-5.2 retains supported old none/xhigh serialization/${stream}`, async () => {
    for (const effort of ["off", "high", "max"] as const) {
      const f = fixture("glm-5.2", effort);
      const previous = createOptions("openai", f.config.providers[f.providerAlias], f.normalizedModel, f.api,
        f.selection !== "off", f.selection === "off" ? undefined : f.selection);
      assert.deepEqual(plain(f.normal.providerOptions), plain(previous));
      assert.deepEqual(await wire(f, stream, { reasoning: f.selection, providerOptions: f.normal.providerOptions }),
        await wire(f, stream, { reasoning: f.selection, providerOptions: previous }));
    }
  });
}
