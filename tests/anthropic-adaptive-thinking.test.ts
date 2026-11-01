import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import * as capabilities from "../src/ai/capabilities.js";
import { automaticAnthropicThinkingOptions } from "../src/ai/anthropicThinkingDefaults.js";
import { configSchema, defaultConfig, type ModelAliasConfig, type ProviderConfig, type ReasoningEffort } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { toModelMessages, toVercelReasoning } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentMessage } from "../src/agent/core/types.js";

type ProviderOptions = {
  [namespace: string]: Record<string, unknown> | undefined;
  anthropic?: { thinking?: { type?: string; budgetTokens?: number; display?: string }; effort?: string };
} | undefined;
type Selection = "off" | ReasoningEffort;
const modern = ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"];
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

interface FixtureOptions { provider?: Partial<ProviderConfig>; alias?: Partial<ModelAliasConfig>; catalogOnly?: boolean }
function fixture(id: string, selected: Selection = "high", options: FixtureOptions = {}) {
  const config = configSchema.parse({ ...structuredClone(defaultConfig), defaultModel: "selected",
    thinking: { enabled: selected !== "off", effort: selected === "off" ? "high" : selected },
    providers: { work: { type: "anthropic", requiresApiKey: false, ...options.provider } },
    models: { selected: { provider: "work", model: options.catalogOnly ? "claude-opus-4-5" : id, ...options.alias } } });
  const providers = new ProviderRegistry(config, [], new AiRegistry(), undefined, () => { throw new Error("Metadata must not fetch"); });
  const runtime = providers.require("work");
  const registry = new ModelRegistry(config, providers);
  registry.registerCatalog("work", runtime.getModels());
  const resolved = registry.resolve(options.catalogOnly ? `work/${id}` : "selected");
  assert.ok(resolved);
  const normalizedModel = resolved.model;
  const selection = capabilities.effectiveThinkingSelection(normalizedModel, config.thinking);
  const route = resolveProviderRequestRoute(normalizedModel, config.providers.work!, runtime.definition);
  const api = route.apiBackend;
  const baseUrl = normalizedModel.baseUrl ?? config.providers.work!.baseUrl ?? runtime.definition.baseUrl;
  assert.ok(baseUrl);
  const scope = { ...capabilities, createProviderOptions: createOptions, normalizedModel, api, protocol: route.protocol, baseUrl,
    enabled: selection !== "off", effort: selection === "off" ? undefined : selection,
    reasoningProtocol: runtime.definition.reasoningProtocol, compatibility: normalizedModel.compatibility,
    capabilities: capabilities.modelCapabilities(normalizedModel) };
  // Select actual option statements/callback, never credential preparation,
  // createModelSettings, a model request lifecycle, or unrelated method bodies.
  const normal = evaluate<(this: { config: ProviderConfig; definition: unknown }) => { providerOptions: ProviderOptions; resolveTextReasoning: (requested: Selection) => unknown }>(
    `(function () { ${normalStatements.map(node => node.getText(ast)).join("\n")}\nreturn { providerOptions, ${auxiliaryMethod!.getText(ast)} }; });`, scope)
    .call({ config: config.providers.work!, definition: runtime.definition });
  return { config, normalizedModel, selection, api, baseUrl, runtime, normal };
}
function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

for (const id of modern) {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    test(`${id}/${effort}: actual normal and auxiliary defaults retain native effort`, () => {
      const f = fixture(id, effort);
      const expected = { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort } };
      assert.deepEqual(plain(f.normal.providerOptions), expected);
      assert.deepEqual(plain(f.normal.resolveTextReasoning(effort)), { reasoning: effort, providerOptions: expected });
      assert.equal(f.api, "anthropic_messages");
      assert.equal(f.normalizedModel.apiBackend, undefined);
    });
  }
  test(`${id}: catalog and model URL overrides feed the same precise context`, () => {
    assert.equal(fixture(id, "high", { catalogOnly: true }).normal.providerOptions?.anthropic?.thinking?.type, "adaptive");
    assert.equal(fixture(id, "high", { provider: { baseUrl: "https://relay.example/v1" }, alias: { baseUrl: endpoint } }).normal.providerOptions?.anthropic?.thinking?.type, "adaptive");
    assert.equal(fixture(id, "high", { alias: { baseUrl: "https://relay.example/v1" } }).normal.providerOptions?.anthropic?.thinking?.type, "enabled");
  });
  test(`${id}: auxiliary off clears inherited max; explicit native provider options still win`, () => {
    const f = fixture(id, "max");
    const model = { ...f.normal, vercelOptions: { providerOptions: { anthropic: { ...f.normal.providerOptions?.anthropic, marker: "keep" }, other: { keep: true } } } };
    const before = JSON.stringify(model.vercelOptions);
    const off = mergeAuxiliary(model, { reasoning: "off" });
    assert.deepEqual(plain(off), { providerOptions: { anthropic: { thinking: { type: "disabled" }, marker: "keep" }, other: { keep: true } }, reasoning: "off" });
    assert.equal(JSON.stringify(model.vercelOptions), before);
    const again = mergeAuxiliary(model, { reasoning: "max" });
    assert.equal(again.providerOptions?.anthropic?.effort, "max");
    assert.equal(JSON.stringify(model.vercelOptions), before);
    const explicit = { anthropic: { thinking: { type: "enabled", budgetTokens: 2048 }, effort: "low" } };
    assert.equal(mergeAuxiliary(model, { reasoning: "max", providerOptions: explicit }).providerOptions, explicit);
    assert.equal(mergeAuxiliary(model, { reasoning: "high", providerOptions: undefined }).providerOptions, undefined);
    assert.equal(mergeAuxiliary(model, {}).providerOptions, model.vercelOptions.providerOptions);
  });
  test(`${id}: explicit budget maps including empty/other effort remain manual`, () => {
    for (const budgetTokens of [{ high: 2048 }, { low: 1536 }, {}]) {
      const f = fixture(id, "high", { alias: { reasoning: { efforts: ["low", "high"], defaultEffort: "high", budgetTokens } } });
      assert.equal(f.normal.providerOptions?.anthropic?.thinking?.type, "enabled");
      assert.equal(f.normal.providerOptions?.anthropic?.thinking?.budgetTokens, budgetTokens.high ?? 4096);
      assert.equal((f.normal.resolveTextReasoning("high") as { providerOptions: ProviderOptions }).providerOptions?.anthropic?.thinking?.type, "enabled");
    }
  });
  test(`${id}: supported native alias maps are honored; unknown mappings are not guessed`, () => {
    const f = fixture(id, "high", { alias: { thinkingLevelMap: { off: "none", high: "max" } } });
    assert.equal(f.normal.providerOptions?.anthropic?.effort, "max");
    const unknown = fixture(id, "high", { alias: { thinkingLevelMap: { high: "custom-effort" } } });
    assert.equal(unknown.normal.providerOptions?.anthropic?.thinking?.type, "enabled");
  });
}
for (const id of ["claude-opus-4-5", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-7-20260416", "claude-opus-5-5", "claude-sonnet-5-5", "vendor/claude-opus-5", "CLAUDE-OPUS-5"]) {
  test(`${id}: no family or snapshot inference`, () => {
    const model: ModelAliasConfig = { provider: "work", model: id, thinkingLevelMap: { high: "high" } };
    assert.equal(automaticAnthropicThinkingOptions(model, "anthropic_messages", true, "high", { providerType: "anthropic", baseUrl: endpoint }), undefined);
  });
}
for (const baseUrl of ["https://API.ANTHROPIC.COM/v1", "https://api.anthropic.com:443/v1", `${endpoint}?x=1`, `${endpoint}/extra`, `${endpoint}///`, "https://relay.example/v1"]) {
  test(`${baseUrl}: nonexact endpoint keeps prior normal and auxiliary modes`, () => {
    const f = fixture("claude-opus-5", "high", { provider: { baseUrl } });
    assert.equal(f.normal.providerOptions?.anthropic?.thinking?.type, "enabled");
    assert.equal((f.normal.resolveTextReasoning("high") as { providerOptions: ProviderOptions }).providerOptions?.anthropic?.thinking?.type, "enabled");
  });
}
test("alternate suppliers/routes and disabled capabilities remain unchanged", () => {
  const model: ModelAliasConfig = { provider: "work", model: "claude-opus-5", thinkingLevelMap: { high: "high" } };
  for (const providerType of ["openai-compatible", "openrouter", "claude-subscription"]) assert.equal(automaticAnthropicThinkingOptions(model, "anthropic_messages", true, "high", { providerType, baseUrl: endpoint }), undefined);
  for (const api of ["responses", "chat_completions", "google_generative_ai"] as const) assert.equal(automaticAnthropicThinkingOptions(model, api, true, "high", { providerType: "anthropic", baseUrl: endpoint }), undefined);
  assert.equal(fixture("claude-opus-5", "off", { alias: { compatibility: { supportsReasoning: false } } }).normal.providerOptions, undefined);
  assert.equal(createOptions("anthropic", {}, { ...model, capabilities: { reasoning: false } }, "anthropic_messages", true, "high", { providerType: "anthropic", baseUrl: endpoint }), undefined);
});
test("actual API overrides do not receive the adaptive projection", () => {
  for (const apiBackend of ["chat_completions", "responses", "google_generative_ai"] as const) {
    for (const options of [{ provider: { apiBackend } }, { alias: { apiBackend } }]) {
      const f = fixture("claude-opus-5", "high", options);
      assert.equal(f.api, apiBackend);
      assert.notEqual(f.normal.providerOptions?.anthropic?.thinking?.type, "adaptive");
      assert.notEqual((f.normal.resolveTextReasoning("high") as { providerOptions: ProviderOptions }).providerOptions?.anthropic?.thinking?.type, "adaptive");
    }
  }
});
test("projection is immutable and repeated calls preserve explicit maps", () => {
  const model: ModelAliasConfig = { provider: "work", model: "claude-opus-5", thinkingLevelMap: { high: "max" } };
  Object.freeze(model.thinkingLevelMap); Object.freeze(model);
  const context = Object.freeze({ providerType: "anthropic", baseUrl: endpoint + "/" });
  assert.deepEqual(automaticAnthropicThinkingOptions(model, "anthropic_messages", true, "high", context), automaticAnthropicThinkingOptions(model, "anthropic_messages", true, "high", context));
  assert.equal(model.thinkingLevelMap?.high, "max");
});

function response(id: string, stream: boolean): Response {
  const message = { id: "msg_fixture", type: "message", role: "assistant", model: id, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } };
  const events = [{ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
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
for (const id of modern) for (const stream of [false, true]) for (const effort of ["off", "high", "max"] as const) for (const auxiliary of [false, true]) {
  test(`${id}/${stream ? "stream" : "generate"}/${effort}/${auxiliary ? "auxiliary" : "normal"}: actual factory/SDK retains signatures and tool association`, async () => {
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
    assert.deepEqual(captured.thinking, effort === "off" ? { type: "disabled" } : { type: "adaptive", display: "summarized" });
    assert.deepEqual(captured.output_config, effort === "off" ? undefined : { effort });
    const blocks = (captured.messages as Array<{ content: Array<Record<string, unknown>> }>).flatMap(message => message.content);
    assert.equal(blocks.find(block => block.type === "thinking")?.signature, "fixture-signature");
    assert.equal(blocks.find(block => block.type === "tool_use")?.id, "call_fixture");
    assert.equal(blocks.find(block => block.type === "tool_result")?.tool_use_id, "call_fixture");
  });
}
for (const baseUrl of ["https://api.anthropic.com", "https://api.anthropic.com/", endpoint, `${endpoint}/`]) {
  test(`${baseUrl}: official endpoint spellings reach the same actual SDK URL`, async () => {
    const f = fixture("claude-opus-5", "high", { provider: { baseUrl } });
    let captured: Record<string, unknown> | undefined;
    const sdk = createVercelLanguageModel({ providerAlias: "work", providerType: "anthropic", authMode: "api-key", api: f.api, modelId: "claude-opus-5", supportsReasoning: true,
      baseUrl, apiKey: "synthetic", headers: {}, fetcher: async (url, init) => {
        assert.equal(String(url), `${endpoint}/messages`); captured = JSON.parse(init!.body as string) as Record<string, unknown>; return response("claude-opus-5", false);
      } });
    await sdk.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Inert sample." }] }], maxOutputTokens: 256,
      reasoning: "high", providerOptions: f.normal.providerOptions as LanguageModelV4CallOptions["providerOptions"] });
    assert.deepEqual(captured?.thinking, { type: "adaptive", display: "summarized" });
  });
}
