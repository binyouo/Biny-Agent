import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import * as capabilities from "../src/ai/capabilities.js";
import { applyOpenAIProThinkingDefaults } from "../src/ai/openAIModelDefaults.js";
import { providerDefinition } from "../src/ai/provider.js";
import type { ProviderDefinition } from "../src/ai/types.js";
import { configSchema, defaultConfig, type AgentConfig, type ModelAliasConfig, type ModelApiBackend, type ModelProfile, type ProviderConfig } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { modelThinkingSelections } from "../src/llm/modelThinking.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";

const official: ProviderConfig = { type: "openai", requiresApiKey: false };
const endpoint = "https://api.openai.com/v1";
interface SelectionOptions {
  catalogOnly?: boolean;
  provider?: ProviderConfig;
  alias?: Partial<ModelAliasConfig>;
  profile?: ModelProfile;
  thinking?: Partial<AgentConfig["thinking"]>;
}
function selection(id: string, options: SelectionOptions = {}) {
  const config = configSchema.parse({ ...structuredClone(defaultConfig), defaultModel: "selected",
    providers: { official: { ...official, ...options.provider, modelProfiles: options.profile ? { [id]: options.profile } : undefined } },
    models: { selected: { provider: "official", model: options.catalogOnly ? "gpt-4.1" : id, ...options.alias } },
    thinking: { ...defaultConfig.thinking, ...options.thinking }
  });
  const providers = new ProviderRegistry(config, [], new AiRegistry(), undefined, () => {
    throw new Error("Metadata selection must not make network requests");
  });
  const runtime = providers.require("official");
  const registry = new ModelRegistry(config, providers);
  registry.registerCatalog("official", runtime.getModels());
  const resolved = registry.resolve(options.catalogOnly ? `official/${id}` : "selected");
  const choice = registry.listModels().find(model => model.model === id);
  assert.ok(resolved);
  assert.ok(choice);
  return { config, runtime, registry, resolved, choice, provider: config.providers.official! };
}

for (const id of ["gpt-5.2-pro", "gpt-5.4-pro"]) {
  for (const catalogOnly of [false, true]) {
    test(`${id}/${catalogOnly ? "catalog" : "configured"}: actual default and saved global off select a supported effort`, () => {
      for (const thinking of [undefined, { enabled: false, effort: "low" as const }, { enabled: true, effort: "medium" as const }]) {
        const { config, runtime, resolved, choice, provider } = selection(id, { catalogOnly, thinking });
        assert.equal(resolved.model.thinkingLevelMap?.off, null);
        assert.equal(choice.thinkingLevelMap.off, null);
        assert.equal(choice.source, catalogOnly ? "catalog" : "configured");
        assert.equal(modelThinkingSelections(choice).includes("off"), false);
        assert.ok(["medium", "high", "xhigh"].includes(capabilities.effectiveThinkingSelection(resolved.model, config.thinking)));
        assert.equal(resolveProviderRequestRoute(resolved.model, provider, runtime.definition).apiBackend, "responses");
        assert.equal(choice.apiBackend, undefined);
        assert.equal(resolved.model.apiBackend, undefined);
        assert.deepEqual(runtime.resolveModel(resolved.model, resolved.source), resolved.model);
        assert.deepEqual(runtime.resolveModel(resolved.model), resolved.model);
        assert.equal(runtime.getModels().find(model => model.id === id)?.thinkingLevelMap?.off, "none");
      }
    });
  }

  for (const off of ["none", null, undefined]) {
    test(`${id}: explicit map off=${String(off)} wins for alias and catalog profile`, () => {
      const thinkingLevelMap = { high: "high", ...(off === undefined ? {} : { off }) };
      for (const options of [{ alias: { thinkingLevelMap } }, { catalogOnly: true, profile: { thinkingLevelMap } }]) {
        const { resolved, choice } = selection(id, options);
        assert.equal(resolved.model.thinkingLevelMap?.off, off);
        assert.equal(choice.thinkingLevelMap.off, off);
      }
    });
  }

  test(`${id}: explicit reasoning, disabled profile and compatibility keep their prior behavior`, () => {
    const reasoning = { efforts: ["high" as const], defaultEffort: "high" as const };
    const explicit = selection(id, { alias: { reasoning } });
    assert.deepEqual(explicit.resolved.model.reasoning?.efforts, ["high"]);
    assert.equal(explicit.resolved.model.thinkingLevelMap?.off, "none");
    for (const options of [
      { profile: { capabilities: { reasoning: false } } },
      { provider: { ...official, compatibility: { supportsReasoning: false } } },
      { alias: { compatibility: { supportsReasoning: false } } }
    ]) {
      const { resolved } = selection(id, options);
      assert.equal(resolved.model.thinkingLevelMap?.off, "none");
      assert.equal(capabilities.modelReasoningConfig(resolved.model), undefined);
    }
  });

  for (const apiBackend of ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"] satisfies ModelApiBackend[]) {
    test(`${id}/${apiBackend}: explicit wire format stays authoritative`, () => {
      for (const options of [{ provider: { ...official, apiBackend } },
        { alias: { apiBackend }, provider: { ...official, apiBackend: "responses" as const } }]) {
        const { resolved, runtime, provider } = selection(id, options);
        assert.equal(resolveProviderRequestRoute(resolved.model, provider, runtime.definition).apiBackend, apiBackend);
        assert.equal(resolved.model.thinkingLevelMap?.off, apiBackend === "responses" ? null : "none");
      }
    });
  }

  test(`${id}: original catalog can switch routes without sticky no-off`, () => {
    const original = selection(id).runtime.getModels().find(model => model.id === id);
    assert.ok(original);
    const before = JSON.stringify(original);
    Object.freeze(original.thinkingLevelMap);
    Object.freeze(original);
    for (const apiBackend of [undefined, "chat_completions", "responses", "anthropic_messages", undefined] as const) {
      const { registry, runtime, provider } = selection(id, { catalogOnly: true, provider: { ...official, apiBackend } });
      registry.registerCatalog("official", [original]);
      const resolved = registry.resolve(`official/${id}`);
      assert.ok(resolved);
      const expectedOff = apiBackend === undefined || apiBackend === "responses" ? null : "none";
      assert.equal(resolved.model.thinkingLevelMap?.off, expectedOff);
      assert.equal(registry.listModels().find(model => model.model === id)?.thinkingLevelMap.off, expectedOff);
      assert.equal(resolveProviderRequestRoute(resolved.model, provider, runtime.definition).apiBackend, apiBackend ?? "responses");
      assert.equal(JSON.stringify(original), before);
    }
  });

  test(`${id}: effective endpoint and supplier strictly scope both defaults`, () => {
    for (const options of [
      { provider: { ...official, baseUrl: "https://relay.example/v1" } },
      { alias: { baseUrl: "https://relay.example/v1" } },
      { provider: { type: "openai-compatible", baseUrl: endpoint, requiresApiKey: false } },
      { provider: { type: "openrouter", baseUrl: endpoint, requiresApiKey: false } }
    ]) {
      const { resolved, runtime, provider } = selection(id, options);
      assert.equal(resolveProviderRequestRoute(resolved.model, provider, runtime.definition).apiBackend, "chat_completions");
      assert.equal(resolved.model.thinkingLevelMap?.off, "none");
    }
    for (const options of [
      { provider: { ...official, baseUrl: `${endpoint}/`, protocol: "openai-compatible" as const } },
      { provider: { ...official, baseUrl: "https://relay.example/v1" }, alias: { baseUrl: endpoint } }
    ]) {
      const { resolved, runtime, provider } = selection(id, options);
      assert.equal(resolveProviderRequestRoute(resolved.model, provider, runtime.definition).apiBackend, "responses");
      assert.equal(resolved.model.thinkingLevelMap?.off, null);
    }
    const legacy = selection(id, { provider: { ...official, protocol: "anthropic" } });
    assert.equal(resolveProviderRequestRoute(legacy.resolved.model, legacy.provider, legacy.runtime.definition).apiBackend, "anthropic_messages");
    assert.equal(legacy.resolved.model.thinkingLevelMap?.off, "none");
  });
}

for (const id of ["gpt-5-pro", "gpt-5.2", "gpt-5.4", "gpt-5.2-pro-2025-12-11", "gpt-5.4-pro-latest", "GPT-5.4-PRO", "openai/gpt-5.4-pro"]) {
  test(`${id}: no family, alias or snapshot inference`, () => {
    const model: ModelAliasConfig = { provider: "official", model: id, capabilities: { reasoning: true }, thinkingLevelMap: { off: "none", high: "high" } };
    assert.equal(resolveProviderRequestRoute(model, official, providerDefinition("openai")).apiBackend, "chat_completions");
    assert.equal(applyOpenAIProThinkingDefaults(model, "openai", endpoint, "responses"), model);
  });
}

test("automatic correction is immutable, idempotent and preserves all supported map entries", () => {
  const model: ModelAliasConfig = { provider: "official", model: "gpt-5.4-pro", capabilities: { reasoning: true },
    thinkingLevelMap: { off: "none", medium: "medium", high: "high", xhigh: "xhigh" } };
  Object.freeze(model.capabilities);
  Object.freeze(model.thinkingLevelMap);
  Object.freeze(model);
  const result = applyOpenAIProThinkingDefaults(model, "openai", endpoint, "responses");
  assert.deepEqual(result.thinkingLevelMap, { ...model.thinkingLevelMap, off: null });
  assert.equal(model.thinkingLevelMap?.off, "none");
  assert.equal(result.capabilities, model.capabilities);
  assert.equal(applyOpenAIProThinkingDefaults(result, "openai", endpoint, "responses"), result);
  assert.equal(applyOpenAIProThinkingDefaults(model, "openai", endpoint, "responses", true), model);
});

for (const type of ["gemini", "google-native"]) {
  for (const id of ["gemini-2.5-pro", "gemini-3.1-pro-preview", "gemini-2.5-flash"]) {
    test(`${type}/${id}: actual Google metadata is not altered by the OpenAI projection`, () => {
      for (const apiBackend of ["chat_completions", "google_generative_ai"] as const) {
        const { resolved, runtime, provider } = selection(id, { provider: { type, requiresApiKey: false, apiBackend } });
        const before = JSON.stringify(resolved.model);
        const route = resolveProviderRequestRoute(resolved.model, provider, runtime.definition);
        assert.equal(route.apiBackend, apiBackend);
        assert.equal(applyOpenAIProThinkingDefaults(resolved.model, type, runtime.definition.baseUrl, route.apiBackend), resolved.model);
        assert.equal(JSON.stringify(resolved.model), before);
        assert.deepEqual(runtime.resolveModel(resolved.model, resolved.source), resolved.model);
        assert.ok(capabilities.modelReasoningConfig(resolved.model));
      }
    });
  }
}

// Exercise the actual pure option function without credential preparation or an
// Agent runtime. AST extraction is deliberate; SDK requests use an injected fetch.
const runtimeSource = readFileSync(new URL("../src/llm/ProviderRuntime.ts", import.meta.url), "utf8");
const runtimeAst = ts.createSourceFile("ProviderRuntime.ts", runtimeSource, ts.ScriptTarget.Latest, true);
const functions = ["mergeCompatibility", "createProviderOptions"].map(name => {
  const nodes = runtimeAst.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1);
  return nodes[0]!.getText(runtimeAst);
}).join("\n");
const createOptions = runInNewContext(ts.transpileModule(`${functions}\ncreateProviderOptions;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText, capabilities) as (protocol: ProviderDefinition["reasoningProtocol"], provider: ProviderConfig, model: ModelAliasConfig,
  api: ModelApiBackend, enabled: boolean, effort: AgentConfig["thinking"]["effort"] | undefined) => LanguageModelV4CallOptions["providerOptions"];
const adapterSource = readFileSync(new URL("../src/agent/core/vercelModelAdapter.ts", import.meta.url), "utf8");
const adapterAst = ts.createSourceFile("vercelModelAdapter.ts", adapterSource, ts.ScriptTarget.Latest, true);
const reasoningFunctions = adapterAst.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "toVercelReasoning");
assert.equal(reasoningFunctions.length, 1);
const toReasoning = runInNewContext(ts.transpileModule(`${reasoningFunctions[0]!.getText(adapterAst).replace(/^export\s+/u, "")}\ntoVercelReasoning;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText) as (selection: "off" | AgentConfig["thinking"]["effort"]) => LanguageModelV4CallOptions["reasoning"];

function response(stream: boolean, id: string): Response {
  const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const payload = { id: "resp_fixture", created_at: 1, model: id, status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
  const events = [{ type: "response.created", response: { ...payload, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: payload }];
  return new Response(stream ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify(payload),
    { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
}

for (const id of ["gpt-5.2-pro", "gpt-5.4-pro"]) {
  for (const stream of [false, true]) {
    for (const options of [{}, { catalogOnly: true }, { provider: { ...official, apiBackend: "responses" as const } },
      { thinking: { enabled: true, effort: "medium" as const } },
      { alias: { thinkingLevelMap: { off: "none", high: "high" } } }]) {
      test(`${id}/${stream ? "stream" : "generate"}/${JSON.stringify(options)}: actual selector/options/factory/SDK wire`, async () => {
        const { config, resolved, runtime, provider } = selection(id, options);
        const model = resolved.model;
        const route = resolveProviderRequestRoute(model, provider, runtime.definition);
        assert.equal(route.apiBackend, "responses");
        const selected = capabilities.effectiveThinkingSelection(model, config.thinking);
        const expected = "alias" in options ? "none" : "thinking" in options ? "medium" : "high";
        assert.equal(selected === "off" ? "none" : selected, expected);
        const providerOptions = createOptions(runtime.definition.reasoningProtocol, provider, model, route.apiBackend,
          selected !== "off", selected === "off" ? undefined : selected);
        const captured: Array<{ url: string; body: { reasoning?: { effort: string }; tools?: Array<{ name: string }>;
          input?: Array<{ type?: string; call_id?: string; output?: Array<{ type: string; text?: string; image_url?: string }> }> } }> = [];
        const sdk = createVercelLanguageModel({ providerAlias: "official", providerType: "openai", authMode: "api-key", api: route.apiBackend,
          modelId: id, supportsReasoning: capabilities.modelCapabilities(model).reasoning === true,
          baseUrl: endpoint, apiKey: "synthetic", headers: {}, fetcher: async (url, init) => {
            assert.ok(typeof init?.body === "string");
            captured.push({ url: String(url), body: JSON.parse(init.body) as (typeof captured)[number]["body"] });
            return response(stream, id);
          } });
        const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aI2QAAAAASUVORK5CYII=";
        const args: LanguageModelV4CallOptions = { prompt: [
          { role: "user", content: [{ type: "text", text: "Inspect the inert sample." }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_pro", toolName: "Inspect", input: {} }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "call_pro", toolName: "Inspect", output: { type: "content", value: [
            { type: "text", text: "sample before" }, { type: "file", mediaType: "image/png", data: { type: "data", data: image } },
            { type: "text", text: "sample after" }
          ] } }] }
        ],
          tools: [{ type: "function", name: "Inspect", inputSchema: { type: "object", properties: {} } }],
          reasoning: toReasoning(selected), providerOptions };
        const before = JSON.stringify(args);
        let text = "";
        if (stream) {
          const result = await sdk.doStream(args);
          for await (const part of result.stream) {
            assert.notEqual(part.type, "error");
            if (part.type === "text-delta") text += part.delta;
          }
        } else {
          const result = await sdk.doGenerate(args);
          text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
        }
        assert.equal(text, "OK");
        assert.equal(JSON.stringify(args), before);
        assert.equal(captured.length, 1);
        assert.equal(captured[0]?.url, `${endpoint}/responses`);
        assert.equal(captured[0]?.body.reasoning?.effort, expected);
        assert.equal(captured[0]?.body.tools?.[0]?.name, "Inspect");
        assert.equal(captured[0]?.body.input?.find(item => item.type === "function_call")?.call_id, "call_pro");
        const result = captured[0]?.body.input?.find(item => item.type === "function_call_output");
        assert.equal(result?.call_id, "call_pro");
        assert.deepEqual(result?.output, [{ type: "input_text", text: "sample before" },
          { type: "input_image", image_url: `data:image/png;base64,${image}` }, { type: "input_text", text: "sample after" }]);
      });
    }
  }
}
