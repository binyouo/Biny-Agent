import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import * as capabilities from "../src/ai/capabilities.js";
import { applyAnthropicThinkingDefaults, automaticAnthropicThinkingOptions } from "../src/ai/anthropicThinkingDefaults.js";
import { configSchema, defaultConfig, type ModelAliasConfig, type ProviderConfig, type ReasoningEffort } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { modelThinkingSelections } from "../src/llm/modelThinking.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { toModelMessages, toVercelReasoning } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentMessage } from "../src/agent/core/types.js";

type ProviderOptions = {
  [namespace: string]: Record<string, unknown> | undefined;
  anthropic?: { thinking?: { type?: string; budgetTokens?: number; display?: string }; effort?: string };
} | undefined;
type Selection = "off" | ReasoningEffort;
const fableModels = ["claude-fable-5", "claude-fable-5-1"];
const endpoint = "https://api.anthropic.com/v1";
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
const createOptions = evaluate<(...args: unknown[]) => ProviderOptions>(`${functions}\ncreateProviderOptions;`, { ...capabilities, automaticAnthropicThinkingOptions });
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

interface FixtureOptions { provider?: Partial<ProviderConfig>; alias?: Partial<ModelAliasConfig>; catalogOnly?: boolean; providerAlias?: string; useDefaultThinking?: boolean }
function fixture(id: string, selected: Selection = "high", options: FixtureOptions = {}) {
  const providerAlias = options.providerAlias ?? "work";
  const config = configSchema.parse({ ...structuredClone(defaultConfig), defaultModel: "selected",
    thinking: options.useDefaultThinking ? structuredClone(defaultConfig.thinking)
      : { enabled: selected !== "off", effort: selected === "off" ? "high" : selected },
    providers: { [providerAlias]: { type: "anthropic", requiresApiKey: false, ...options.provider } },
    models: { selected: { provider: providerAlias, model: options.catalogOnly ? "claude-opus-4-5" : id, ...options.alias } } });
  const providers = new ProviderRegistry(config, [], new AiRegistry(), undefined, () => { throw new Error("Metadata must not fetch"); });
  const runtime = providers.require(providerAlias);
  const registry = new ModelRegistry(config, providers);
  const catalog = runtime.getModels();
  const catalogBefore = JSON.stringify(catalog);
  registry.registerCatalog(providerAlias, catalog);
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
  return { config, normalizedModel, selection, api, baseUrl, runtime, normal, registry, catalog, catalogBefore, providerAlias };
}
function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
for (const id of fableModels) {
  for (const catalogOnly of [false, true]) {
    for (const requested of ["off", "low", "medium", "high", "xhigh", "max"] as const) {
      test(`${id}/${catalogOnly ? "catalog" : "configured"}/${requested}: actual Runtime and Registry agree on automatic no-off and adaptive options`, () => {
        const f = fixture(id, requested, { catalogOnly });
        const expectedEffort = requested === "off" ? "high" : requested;
        assert.equal(f.selection, expectedEffort);
        assert.equal(f.normalizedModel.thinkingLevelMap?.off, null);
        const choice = f.registry.listModels().find(model => model.model === id);
        assert.ok(choice);
        assert.equal(choice.thinkingLevelMap.off, null);
        assert.equal(modelThinkingSelections(choice).includes("off"), false);
        assert.equal(choice.supportsTools, true);
        assert.equal(choice.available, true);
        const expected = { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: expectedEffort } };
        assert.deepEqual(plain(f.normal.providerOptions), expected);
        assert.deepEqual(plain(f.normal.resolveTextReasoning(requested)), { reasoning: expectedEffort, providerOptions: expected });
        assert.equal(JSON.stringify(f.catalog), f.catalogBefore);
        assert.equal(f.catalog.find(model => model.id === id)?.thinkingLevelMap?.off, "none");
      });
    }
    test(`${id}/${catalogOnly ? "catalog" : "configured"}: fresh default and repeated resolution stay on high without mutating automatic metadata`, () => {
      const f = fixture(id, "off", { catalogOnly, useDefaultThinking: true });
      assert.equal(f.config.thinking.enabled, false);
      assert.equal(f.selection, "high");
      assert.deepEqual(f.runtime.resolveModel(f.normalizedModel), f.normalizedModel);
      assert.equal(JSON.stringify(f.catalog), f.catalogBefore);
      assert.equal(f.catalog.find(entry => entry.id === id)?.thinkingLevelMap?.off, "none");
    });
  }
  test(`${id}: slash-containing provider catalog reference retains source provenance`, () => {
    const f = fixture(id, "off", { catalogOnly: true, providerAlias: "work/team" });
    assert.equal(f.selection, "high");
    assert.equal(f.registry.resolve(`work/team/${id}`)?.source, "catalog");
    assert.equal(f.registry.resolve(`work/team/${id}`)?.model.thinkingLevelMap?.off, null);
  });
  test(`${id}: explicit alias maps/reasoning and profile maps retain off or disabled capability`, () => {
    const maps: NonNullable<ModelAliasConfig["thinkingLevelMap"]>[] = [{ off: "none", high: "high" }, { off: null, high: "max" }, { high: "custom-effort" }];
    for (const thinkingLevelMap of maps) {
      const f = fixture(id, "off", { alias: { thinkingLevelMap } });
      assert.deepEqual(f.normalizedModel.thinkingLevelMap, f.runtime.resolveModel(f.config.models.selected!).thinkingLevelMap);
      for (const [level, value] of Object.entries(thinkingLevelMap)) assert.equal(f.normalizedModel.thinkingLevelMap?.[level as keyof typeof thinkingLevelMap], value);
      if (thinkingLevelMap.off === "none") {
        assert.equal(f.selection, "off");
        assert.equal(f.normal.providerOptions?.anthropic?.thinking?.type, "disabled");
      }
    }
    const profile = fixture(id, "off", { catalogOnly: true, provider: { modelProfiles: { [id]: { thinkingLevelMap: { off: "none", high: "low" } } } } });
    assert.equal(profile.selection, "off");
    assert.equal(profile.normalizedModel.thinkingLevelMap?.off, "none");
    assert.equal(profile.normal.providerOptions?.anthropic?.thinking?.type, "disabled");
    const disabled = fixture(id, "off", { provider: { modelProfiles: { [id]: { capabilities: { reasoning: false } } } } });
    assert.equal(disabled.selection, "off");
    assert.equal(disabled.normal.providerOptions, undefined);
    for (const budgetTokens of [{ high: 2048 }, { low: 1536 }, {}]) {
      const f = fixture(id, "high", { alias: { reasoning: { efforts: ["low", "high"], defaultEffort: "high", budgetTokens } } });
      assert.notEqual(f.normalizedModel.thinkingLevelMap?.off, null);
      assert.equal(f.normal.providerOptions?.anthropic?.thinking?.type, "enabled");
      assert.equal(f.normal.providerOptions?.anthropic?.thinking?.budgetTokens, budgetTokens.high ?? 4096);
    }
  });
  test(`${id}: supported explicit native effort mappings remain exact`, () => {
    const f = fixture(id, "high", { alias: { thinkingLevelMap: { off: null, high: "max" } } });
    assert.equal(f.normalizedModel.thinkingLevelMap?.high, "max");
    assert.equal(f.normal.providerOptions?.anthropic?.effort, "max");
    const unknown = fixture(id, "high", { alias: { thinkingLevelMap: { high: "custom-effort" } } });
    assert.equal(unknown.normal.providerOptions?.anthropic?.thinking?.type, "enabled");
  });
  test(`${id}: max → auxiliary off → max uses legal high and preserves original options; caller options win`, () => {
    const f = fixture(id, "max");
    const model = { ...f.normal, vercelOptions: { providerOptions: { anthropic: { ...f.normal.providerOptions?.anthropic, marker: "keep" }, other: { keep: true } } } };
    const before = JSON.stringify(model.vercelOptions);
    const off = mergeAuxiliary(model, { reasoning: "off" });
    assert.deepEqual(plain(off), { reasoning: "high", providerOptions: { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high", marker: "keep" }, other: { keep: true } } });
    assert.equal(mergeAuxiliary(model, { reasoning: "max" }).providerOptions?.anthropic?.effort, "max");
    const explicit = { anthropic: { thinking: { type: "disabled" }, effort: "low" } };
    assert.equal(mergeAuxiliary(model, { reasoning: "max", providerOptions: explicit }).providerOptions, explicit);
    assert.equal(mergeAuxiliary(model, { reasoning: "off", providerOptions: undefined }).providerOptions, undefined);
    assert.equal(JSON.stringify(model.vercelOptions), before);
  });
  for (const baseUrl of ["https://api.anthropic.com", "https://api.anthropic.com/", endpoint, `${endpoint}/`]) {
    test(`${id}/${baseUrl}: official native endpoint opts into both layers`, () => {
      const f = fixture(id, "off", { provider: { baseUrl } });
      assert.equal(f.selection, "high");
      assert.equal(f.normal.providerOptions?.anthropic?.thinking?.type, "adaptive");
    });
  }
  for (const baseUrl of ["https://relay.example/v1", "https://API.ANTHROPIC.COM/v1", "https://api.anthropic.com:443/v1", `${endpoint}//`, `${endpoint}?x=1`, `${endpoint}/extra`]) {
    test(`${id}/${baseUrl}: custom/nonexact endpoint keeps prior automatic map and options`, () => {
      const f = fixture(id, "off", { provider: { baseUrl } });
      assert.equal(f.selection, "off");
      assert.equal(f.normalizedModel.thinkingLevelMap?.off, "none");
      assert.equal(f.normal.providerOptions?.anthropic?.thinking?.type, "disabled");
    });
  }
  test(`${id}: final model endpoint and API overrides win over provider defaults`, () => {
    assert.equal(fixture(id, "off", { provider: { baseUrl: "https://relay.example/v1" }, alias: { baseUrl: endpoint } }).selection, "high");
    assert.equal(fixture(id, "off", { alias: { baseUrl: "https://relay.example/v1" } }).selection, "off");
    for (const apiBackend of ["chat_completions", "responses", "google_generative_ai"] as const) {
      for (const options of [{ provider: { apiBackend } }, { alias: { apiBackend } }]) {
        const f = fixture(id, "off", options);
        assert.equal(f.selection, "off");
        assert.equal(f.normalizedModel.thinkingLevelMap?.off, "none");
      }
    }
  });
}

test("non-target providers/models and absent route context do not get Fable automatic defaults", () => {
  const ids = ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5-2", "claude-fable-5-1-20260901", "vendor/claude-fable-5", "CLAUDE-FABLE-5"];
  for (const id of ids) {
    const model: ModelAliasConfig = { provider: "work", model: id, thinkingLevelMap: { off: "none", high: "high" } };
    assert.equal(applyAnthropicThinkingDefaults(model, "anthropic_messages", { providerType: "anthropic", baseUrl: endpoint }), model);
  }
  const model: ModelAliasConfig = { provider: "work", model: "claude-fable-5", thinkingLevelMap: { off: "none", high: "high" } };
  for (const providerType of ["openai-compatible", "openrouter", "claude-subscription"]) assert.equal(applyAnthropicThinkingDefaults(model, "anthropic_messages", { providerType, baseUrl: endpoint }), model);
  assert.equal(applyAnthropicThinkingDefaults(model, "anthropic_messages", { providerType: "anthropic", baseUrl: undefined }), model);
  assert.equal(automaticAnthropicThinkingOptions(model, "anthropic_messages", true, "high", undefined), undefined);
  Object.freeze(model.thinkingLevelMap); Object.freeze(model);
  const context = Object.freeze({ providerType: "anthropic", baseUrl: endpoint });
  const projected = applyAnthropicThinkingDefaults(model, "anthropic_messages", context);
  assert.equal(projected.thinkingLevelMap?.off, null);
  assert.equal(model.thinkingLevelMap?.off, "none");
  assert.deepEqual(applyAnthropicThinkingDefaults(projected, "anthropic_messages", context), projected);
});

function response(id: string, stream: boolean): Response {
  const message = { id: "msg_fixture", type: "message", role: "assistant", model: id, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } };
  const events = [{ type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  return new Response(stream ? events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify(message), { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
}
const messages: AgentMessage[] = [
  { role: "user", content: "Inspect the inert sample." },
  { role: "assistant", content: [
    { type: "reasoning", text: "Synthetic summary", providerMetadata: { anthropic: { signature: "fixture-signature" } } },
    { type: "toolCall", id: "call_fixture", name: "Inspect", arguments: {} }
  ] },
  { role: "toolResult", toolCallId: "call_fixture", toolName: "Inspect", content: [{ type: "text", text: "sample" }], isError: false }
];
for (const id of fableModels) for (const stream of [false, true]) for (const effort of ["off", "high", "max"] as const) for (const auxiliary of [false, true]) {
  test(`${id}/${stream ? "stream" : "generate"}/${effort}/${auxiliary ? "aux" : "normal"}: actual factory/SDK uses adaptive and preserves native effort and tool association`, async () => {
    const f = fixture(id, auxiliary ? "max" : effort);
    const effective = auxiliary ? mergeAuxiliary({ ...f.normal, vercelOptions: { providerOptions: f.normal.providerOptions } }, { reasoning: effort })
      : { reasoning: f.selection, providerOptions: f.normal.providerOptions };
    let captured: Record<string, unknown> | undefined;
    const sdk = createVercelLanguageModel({ providerAlias: "work", providerType: "anthropic", authMode: "api-key", api: f.api, modelId: id, supportsReasoning: true,
      baseUrl: f.baseUrl, apiKey: "synthetic", headers: {}, fetcher: async (url, init) => {
        assert.equal(String(url), `${endpoint}/messages`); assert.equal(typeof init?.body, "string"); captured = JSON.parse(init!.body as string) as Record<string, unknown>; return response(id, stream);
      } });
    const options: LanguageModelV4CallOptions = { prompt: toModelMessages(messages) as LanguageModelV4CallOptions["prompt"], reasoning: toVercelReasoning(effective.reasoning), providerOptions: effective.providerOptions as LanguageModelV4CallOptions["providerOptions"],
      maxOutputTokens: 4096, tools: [{ type: "function", name: "Inspect", inputSchema: { type: "object", properties: {} } }], toolChoice: { type: "auto" } };
    const before = JSON.stringify(options); let text = "";
    if (stream) { const result = await sdk.doStream(options); for await (const part of result.stream) { assert.notEqual(part.type, "error"); if (part.type === "text-delta") text += part.delta; } }
    else { const result = await sdk.doGenerate(options); text = result.content.filter(part => part.type === "text").map(part => part.text).join(""); }
    assert.equal(text, "OK"); assert.equal(JSON.stringify(options), before); assert.ok(captured);
    assert.deepEqual(captured.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(captured.output_config, { effort: effort === "off" ? "high" : effort });
    const blocks = (captured.messages as Array<{ content: Array<Record<string, unknown>> }>).flatMap(message => message.content);
    assert.equal(blocks.find(block => block.type === "thinking")?.signature, "fixture-signature");
    assert.equal(blocks.find(block => block.type === "tool_use")?.id, "call_fixture");
    assert.equal(blocks.find(block => block.type === "tool_result")?.tool_use_id, "call_fixture");
  });
}
for (const id of fableModels) {
  test(`${id}: reuse raw automatic catalog metadata across native/Chat/native routes without writing the default into it`, () => {
    const f = fixture(id, "off", { catalogOnly: true });
    const entry = f.catalog.find(model => model.id === id);
    assert.ok(entry);
    const before = JSON.stringify(entry);
    const raw: ModelAliasConfig = { provider: f.providerAlias, model: id, capabilities: entry.capabilities, thinkingLevelMap: entry.thinkingLevelMap };
    const native = f.runtime.resolveModel({ ...raw, apiBackend: "anthropic_messages" }, "catalog");
    const chat = f.runtime.resolveModel({ ...raw, apiBackend: "chat_completions" }, "catalog");
    const nativeAgain = f.runtime.resolveModel({ ...raw, apiBackend: "anthropic_messages" }, "catalog");
    assert.equal(native.thinkingLevelMap?.off, null);
    assert.equal(chat.thinkingLevelMap?.off, "none");
    assert.deepEqual(nativeAgain, native);
    assert.equal(JSON.stringify(entry), before);
  });
  for (const stream of [false, true]) for (const variant of ["explicit-off", "explicit-budget", "caller-options"] as const) {
    test(`${id}/${stream ? "stream" : "generate"}/${variant}: actual wire preserves explicit user settings, even unsupported ones`, async () => {
      const f = variant === "explicit-off" ? fixture(id, "off", { alias: { thinkingLevelMap: { off: "none", high: "high" } } })
        : variant === "explicit-budget" ? fixture(id, "high", { alias: { reasoning: { efforts: ["high"], defaultEffort: "high", budgetTokens: { high: 2048 } } } })
          : fixture(id, "high");
      const explicit = { anthropic: { thinking: { type: "disabled" }, effort: "low" } };
      const effective = variant === "caller-options" ? mergeAuxiliary({ ...f.normal, vercelOptions: { providerOptions: f.normal.providerOptions } }, { reasoning: "max", providerOptions: explicit })
        : { reasoning: f.selection, providerOptions: f.normal.providerOptions };
      let body: Record<string, unknown> | undefined;
      const sdk = createVercelLanguageModel({ providerAlias: "work", providerType: "anthropic", authMode: "api-key", api: f.api, modelId: id, supportsReasoning: true,
        baseUrl: f.baseUrl, apiKey: "synthetic", headers: {}, fetcher: async (url, init) => {
          assert.equal(String(url), `${endpoint}/messages`); body = JSON.parse(init!.body as string) as Record<string, unknown>; return response(id, stream);
        } });
      const args: LanguageModelV4CallOptions = { prompt: [{ role: "user", content: [{ type: "text", text: "Inert sample." }] }], maxOutputTokens: 4096,
        reasoning: toVercelReasoning(effective.reasoning), providerOptions: effective.providerOptions as LanguageModelV4CallOptions["providerOptions"] };
      if (stream) { const result = await sdk.doStream(args); for await (const part of result.stream) assert.notEqual(part.type, "error"); }
      else await sdk.doGenerate(args);
      assert.ok(body);
      assert.deepEqual(body.thinking, variant === "explicit-budget" ? { type: "enabled", budget_tokens: 2048 } : { type: "disabled" });
      if (variant === "caller-options") assert.deepEqual(body.output_config, { effort: "low" });
    });
  }
}
