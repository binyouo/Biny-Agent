import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { providerDefinition } from "../src/ai/provider.js";
import { defaultConfig, type AgentConfig, type ModelAliasConfig, type ModelApiBackend, type ProviderConfig } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";

const astra: ModelAliasConfig = { provider: "official", model: "gpt-6-astra" };
const official: ProviderConfig = { type: "openai", requiresApiKey: false };

for (const protocol of [undefined, "openai-compatible"] as const) {
  for (const baseUrl of [undefined, "https://api.openai.com/v1", "https://api.openai.com/v1/"]) {
    test(`Astra default ${protocol ?? "unset"}/${baseUrl ?? "builtin"} uses Responses`, () => {
      const config = Object.freeze({ ...official, protocol, baseUrl });
      const model = Object.freeze({ ...astra });
      assert.deepEqual(resolveProviderRequestRoute(model, config, providerDefinition(config.type)), {
        apiBackend: "responses", protocol: "openai-compatible", source: "model-default"
      });
      assert.equal(model.apiBackend, undefined);
    });
  }
}

for (const apiBackend of ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"] satisfies ModelApiBackend[]) {
  test(`explicit ${apiBackend} stays authoritative at either scope`, () => {
    const definition = providerDefinition("openai");
    const provider = resolveProviderRequestRoute(astra, { ...official, apiBackend }, definition);
    assert.equal(provider.apiBackend, apiBackend);
    assert.equal(provider.source, "provider");
    const model = resolveProviderRequestRoute({ ...astra, apiBackend }, { ...official, apiBackend: "responses", protocol: "anthropic" }, definition);
    assert.equal(model.apiBackend, apiBackend);
    assert.equal(model.source, "model");
  });
}

test("legacy Anthropic protocol keeps its prior default", () => {
  assert.deepEqual(resolveProviderRequestRoute(astra, { ...official, protocol: "anthropic" }, providerDefinition("openai")), {
    apiBackend: "anthropic_messages", protocol: "anthropic", source: "provider"
  });
});

for (const model of [undefined, {}, { model: "gpt-5.2" }, { model: "gpt-6-sol" }, { model: "gpt-6.1-sol" },
  { model: "openai/gpt-6-astra" }, { model: "gpt-6-astra-latest" }, { model: "GPT-6-ASTRA" }]) {
  test(`${model?.model ?? "no ID"}: no family-wide inference`, () => {
    assert.deepEqual(resolveProviderRequestRoute(model, official, providerDefinition("openai")), {
      apiBackend: "chat_completions", protocol: "openai-compatible", source: "definition"
    });
  });
}

for (const baseUrl of ["https://relay.example/v1", "https://api.openai.com/custom", "http://api.openai.com/v1"]) {
  test(`${baseUrl}: provider and model endpoint overrides retain Chat`, () => {
    for (const modelOverride of [false, true]) {
      const model = modelOverride ? { ...astra, baseUrl } : astra;
      const config = modelOverride ? official : { ...official, baseUrl };
      assert.equal(resolveProviderRequestRoute(model, config, providerDefinition(config.type)).apiBackend, "chat_completions");
    }
  });
}

test("effective model endpoint is used without mutating either configuration", () => {
  const model = Object.freeze({ ...astra, baseUrl: "https://api.openai.com/v1" });
  const config = Object.freeze({ ...official, baseUrl: "https://relay.example/v1" });
  assert.equal(resolveProviderRequestRoute(model, config, providerDefinition(config.type)).apiBackend, "responses");
  assert.equal(config.baseUrl, "https://relay.example/v1");
});

for (const type of ["openai-compatible", "openrouter", "gemini"]) {
  test(`${type}: the same model and endpoint do not opt a different provider into this policy`, () => {
    const config = { type, baseUrl: "https://api.openai.com/v1" };
    assert.equal(resolveProviderRequestRoute(astra, config, providerDefinition(type)).apiBackend, "chat_completions");
  });
}

function modelSelection(catalogOnly: boolean, provider: ProviderConfig = official, model: ModelAliasConfig = astra) {
  const alias = catalogOnly ? `official/${model.model}` : "selected";
  const config: AgentConfig = { ...defaultConfig, defaultModel: alias, providers: { official: provider }, models: catalogOnly ? {} : { selected: model } };
  const providers = new ProviderRegistry(config, [], new AiRegistry(), undefined, () => {
    throw new Error("Model metadata selection must not make network requests");
  });
  const registry = new ModelRegistry(config, providers);
  const runtime = providers.require("official");
  registry.registerCatalog("official", runtime.getModels());
  const choice = registry.listModels().find(entry => entry.model === model.model);
  const resolved = registry.resolve(alias);
  assert.ok(choice);
  assert.ok(resolved);
  return { choice, resolved, runtime, provider };
}

for (const catalogOnly of [false, true]) {
  test(`${catalogOnly ? "catalog" : "configured"}: actual selection uses the policy without storing an override`, () => {
    const { choice, resolved, runtime } = modelSelection(catalogOnly);
    assert.equal(choice.supportsTools, true);
    assert.equal(choice.source, catalogOnly ? "catalog" : "configured");
    assert.equal(choice.apiBackend, undefined);
    assert.equal(resolved.model.apiBackend, undefined);
    assert.equal(runtime.getModels().find(entry => entry.id === astra.model)?.apiBackend, undefined);
    assert.equal(resolveProviderRequestRoute(resolved.model, official, runtime.definition).apiBackend, "responses");
    for (const apiBackend of ["chat_completions", "responses", undefined] as const) {
      assert.equal(resolveProviderRequestRoute(resolved.model, { ...official, apiBackend }, runtime.definition).apiBackend,
        apiBackend ?? "responses");
    }
  });
}

function fixtureResponse(responses: boolean, stream: boolean): Response {
  if (!responses) {
    const payload = { id: "fixture", created: 1, model: astra.model,
      choices: [{ index: 0, ...(stream ? { delta: { content: "OK" } } : { message: { role: "assistant", content: "OK" } }), finish_reason: "stop" }] };
    return new Response(stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload),
      { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
  }
  const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const response = { id: "resp_fixture", created_at: 1, model: astra.model, status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } };
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
  return new Response(stream ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify(response),
    { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
}

interface Wire {
  url: string;
  body: {
    tools: Array<{ name?: string; function?: { name: string } }>;
    input?: Array<{ type?: string; call_id?: string; name?: string; output?: string | Array<{ type: string; text?: string; image_url?: string }> }>;
    messages?: Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
  };
}

for (const stream of [false, true]) {
  for (const apiBackend of [undefined, "chat_completions", "responses"] as const) {
    for (const reasoning of ["none", "high"] as const) {
      test(`actual factory/SDK ${stream ? "stream" : "generate"}/${apiBackend ?? "automatic"}/${reasoning}: tools and call IDs survive`, async () => {
        const { resolved, runtime } = modelSelection(false, official, { ...astra, apiBackend });
        const route = resolveProviderRequestRoute(resolved.model, official, runtime.definition);
        const expected = apiBackend ?? "responses";
        assert.equal(route.apiBackend, expected);
        const captured: Wire[] = [];
        const sdk = createVercelLanguageModel({ providerAlias: "official", providerType: "openai", authMode: "api-key", api: route.apiBackend,
          modelId: astra.model, supportsReasoning: true, baseUrl: "https://api.openai.com/v1", apiKey: "synthetic", headers: {},
          fetcher: async (url, init) => {
            assert.ok(typeof init?.body === "string");
            captured.push({ url: String(url), body: JSON.parse(init.body) as Wire["body"] });
            return fixtureResponse(expected === "responses", stream);
          } }); // No privacy context, credential preparation, real tool or network is used.
        const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aI2QAAAAASUVORK5CYII=";
        const options: LanguageModelV4CallOptions = { reasoning, prompt: [
          { role: "user", content: [{ type: "text", text: "Read the inert sample." }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_fixture", toolName: "Inspect", input: { path: "sample.txt" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "call_fixture", toolName: "Inspect", output: apiBackend === undefined
            ? { type: "content", value: [{ type: "text", text: "sample contents" }, { type: "file", mediaType: "image/png", data: { type: "data", data: image } }] }
            : { type: "text", value: "sample contents" } }] },
          { role: "user", content: [{ type: "text", text: "Summarize it." }] }
        ], tools: [{ type: "function", name: "Inspect", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] };
        const before = JSON.stringify(options);
        let text = "";
        if (stream) {
          const result = await sdk.doStream(options);
          for await (const part of result.stream) {
            assert.notEqual(part.type, "error");
            if (part.type === "text-delta") text += part.delta;
          }
        } else {
          const result = await sdk.doGenerate(options);
          text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
        }
        assert.equal(text, "OK");
        assert.equal(JSON.stringify(options), before);
        assert.equal(captured.length, 1);
        const wire = captured[0]!;
        assert.equal(wire.url, `https://api.openai.com/v1/${expected === "responses" ? "responses" : "chat/completions"}`);
        assert.equal(wire.body.tools.length, 1);
        if (expected === "responses") {
          assert.equal(wire.body.tools[0]?.name, "Inspect");
          assert.equal(wire.body.input?.find(item => item.type === "function_call")?.call_id, "call_fixture");
          assert.equal(wire.body.input?.find(item => item.type === "function_call_output")?.call_id, "call_fixture");
          assert.deepEqual(wire.body.input?.find(item => item.type === "function_call_output")?.output, apiBackend === undefined
            ? [{ type: "input_text", text: "sample contents" }, { type: "input_image", image_url: `data:image/png;base64,${image}` }]
            : "sample contents");
        } else {
          assert.equal(wire.body.tools[0]?.function?.name, "Inspect");
          assert.equal(wire.body.messages?.find(item => item.role === "assistant")?.tool_calls?.[0]?.id, "call_fixture");
          assert.equal(wire.body.messages?.find(item => item.role === "tool")?.tool_call_id, "call_fixture");
        }
      });
    }
  }
}
