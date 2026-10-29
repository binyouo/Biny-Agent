/** Outbound serialization regressions: synthetic transport deliberately stops before any response. */
import assert from "node:assert/strict";
import test from "node:test";
import { configSchema, defaultConfig, type ModelApiBackend } from "../src/config/schema.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentEvent } from "../src/agent/core/types.js";

const boundaryMessage = "Synthetic transport: outbound serialization captured";
const endpoint = "https://provider-wire.invalid/v1";
type Mode = "main" | "auxiliary";
interface Fixture {
  type: string;
  alias?: string;
  model?: string;
  api?: ModelApiBackend;
  modelApi?: ModelApiBackend;
  enabled?: boolean;
  mode?: Mode;
  options?: Record<string, unknown>;
  clearOptions?: boolean;
  priority?: boolean;
}
interface Capture { url: string; body: Record<string, unknown> }
function freeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
async function capture(fixture: Fixture): Promise<Capture> {
  const alias = fixture.alias ?? `custom-${fixture.type}`;
  const enabled = fixture.enabled ?? true;
  const config = configSchema.parse({
    ...structuredClone(defaultConfig), defaultModel: "fixture", toolModel: "fixture",
    thinking: { enabled, effort: "high" }, redaction: { enabled: false },
    providers: { [alias]: { type: fixture.type, baseUrl: endpoint, apiKey: "synthetic-fixture-key", apiBackend: fixture.api,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 } } },
    models: { fixture: { provider: alias, model: fixture.model ?? "fixture-reasoner", apiBackend: fixture.modelApi,
      capabilities: { reasoning: true }, thinkingLevelMap: { off: "none", low: "low", high: "high" } } }
  });
  const requests: Capture[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: await request.json() as Record<string, unknown> });
    throw new Error(boundaryMessage);
  };
  const settings = new ProviderRegistry(config, [], undefined, undefined, fetcher).createModelSettings();
  const before = structuredClone(settings.model.vercelOptions);
  freeze(settings.model.vercelOptions);
  freeze(fixture.options);
  const override = fixture.clearOptions ? { providerOptions: undefined }
    : fixture.options === undefined ? {} : { providerOptions: fixture.options };
  if (fixture.mode === "auxiliary") {
    await assert.rejects(generateNativeText(settings.model, [{ role: "user", content: "Serialize a fixture request." }], {
      reasoning: enabled ? "high" : "off", maxRetries: 0, ...override
    }), new RegExp(boundaryMessage, "u"));
  } else {
    const events: AgentEvent[] = [];
    for await (const event of vercelAgentLoopContinue({ messages: [{ role: "user", content: "Serialize a fixture request." }], tools: [] }, {
      model: settings.model, vercelModel: settings.vercelModel, tools: [], maxSteps: 1, maxRetries: 0,
      modelOptions: { providerOptions: settings.providerOptions, reasoning: settings.reasoning, serviceTier: fixture.priority ? "priority" : undefined, ...override }
    })) events.push(event);
    assert.equal(events.some(event => event.type === "error" && event.error.includes(boundaryMessage)), true);
  }
  assert.deepEqual(settings.model.vercelOptions, before, "request mapping must not mutate shared defaults");
  assert.equal(requests.length, 1, "serialization boundary must not retry or contact another endpoint");
  return requests[0]!;
}

for (const type of ["anthropic", "claude-subscription", "google-native"]) {
  for (const api of ["chat_completions", "responses"] as const) {
    for (const mode of ["main", "auxiliary"] as const) {
      test(`${type}: ${api} override selects wire and options in ${mode}`, async () => {
        const { url, body } = await capture({ type, api, enabled: false, mode });
        assert.equal(url, `${endpoint}/${api === "responses" ? "responses" : "chat/completions"}`);
        assert.equal(body.thinking, undefined);
        assert.equal(body.generationConfig, undefined);
        assert.equal(body.messages !== undefined, api === "chat_completions");
        assert.equal(body.input !== undefined, api === "responses");
      });
    }
  }
}
for (const mode of ["main", "auxiliary"] as const) {
  test(`google-native legacy default still selects native wire in ${mode}`, async () => {
    const { url, body } = await capture({ type: "google-native", mode, enabled: false });
    assert.equal(url, `${endpoint}/models/fixture-reasoner:streamGenerateContent?alt=sse`);
    assert.deepEqual((body.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 0, includeThoughts: false });
  });
  test(`model override outranks native connection default in ${mode}`, async () => {
    const { url } = await capture({ type: "gemini", api: "google_generative_ai", modelApi: "chat_completions", mode });
    assert.equal(url, `${endpoint}/chat/completions`);
  });
}
for (const type of ["deepseek", "kimi", "qwen"]) {
  for (const enabled of [false, true]) {
    for (const mode of ["main", "auxiliary"] as const) {
      test(`${type}: ${enabled ? "on" : "off"} reaches compatible wire in ${mode}`, async () => {
        const { body } = await capture({ type, model: type === "kimi" ? "kimi-k2.5" : undefined, enabled, mode });
        if (type === "qwen") {
          assert.equal(body.enable_thinking, enabled);
          assert.equal(body.thinking_budget, enabled ? 4096 : undefined);
          assert.equal(body.enableThinking, undefined);
          assert.equal(body.thinkingBudget, undefined);
          assert.equal(body.reasoning_effort, undefined);
        } else assert.deepEqual(body.thinking, { type: enabled ? "enabled" : "disabled" });
      });
    }
  }
}
for (const model of ["gemini-2.5-flash", "gemini-3-flash", "models/gemini-3-pro", "gemini-3", "GEMINI-3-Flash", "gemini-3-pro-image-preview"]) {
  for (const api of ["chat_completions", "google_generative_ai"] as const) {
    for (const enabled of [false, true]) {
      for (const mode of ["main", "auxiliary"] as const) {
        test(`gemini ${model} ${api} ${enabled ? "on" : "off"} ${mode}`, async () => {
          const { body } = await capture({ type: "gemini", model, api, enabled, mode });
          const level = /gemini-3(?:[.-]|$)/iu.test(model) && !model.includes("pro-image");
          if (api === "google_generative_ai") {
            assert.deepEqual((body.generationConfig as Record<string, unknown>).thinkingConfig, {
              ...(level ? { thinkingLevel: enabled ? "high" : "minimal" } : { thinkingBudget: enabled ? 4096 : 0 }),
              includeThoughts: enabled
            });
          } else {
            assert.deepEqual(body.extra_body, { google: { thinking_config: {
              ...(level ? { thinking_level: enabled ? "high" : "minimal" } : { thinking_budget: enabled ? 4096 : 0 }),
              include_thoughts: enabled
            } } });
            assert.equal(body.reasoning_effort, undefined, "Google forbids effort together with a budget/level");
            assert.equal(body.thinkingConfig, undefined);
          }
        });
      }
    }
  }
}
for (const mode of ["main", "auxiliary"] as const) {
  test(`explicit alias options win and retain unknown fields in ${mode}`, async () => {
    const { body } = await capture({ type: "deepseek", alias: "custom", enabled: false, mode,
      options: { deepseek: { thinking: { type: "disabled" } }, custom: { thinking: { type: "enabled" }, fixture: "preserved" } } });
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.fixture, "preserved");
  });
  test(`explicit undefined clears default provider options in ${mode}`, async () => {
    const { body } = await capture({ type: "deepseek", enabled: false, mode, clearOptions: true });
    assert.equal(body.thinking, undefined);
  });
  test(`native Anthropic remains native in ${mode}`, async () => {
    const { url, body } = await capture({ type: "anthropic", enabled: false, mode });
    assert.equal(url, `${endpoint}/messages`);
    assert.deepEqual(body.thinking, { type: "disabled" });
  });
}

for (const type of ["deepseek", "kimi", "qwen", "gemini"]) {
  test(`${type}: main priority preserves vendor thinking controls`, async () => {
    const { body } = await capture({ type, model: type === "kimi" ? "kimi-k2.5" : type === "gemini" ? "gemini-2.5-flash" : undefined,
      enabled: false, priority: true });
    assert.equal(body.service_tier, "priority");
    if (type === "qwen") assert.equal(body.enable_thinking, false);
    else if (type === "gemini") assert.deepEqual(body.extra_body, { google: { thinking_config: { thinking_budget: 0, include_thoughts: false } } });
    else assert.deepEqual(body.thinking, { type: "disabled" });
  });
}

for (const mode of ["main", "auxiliary"] as const) {
  test(`Google explicit wire control replaces inherited native control in ${mode}`, async () => {
    const { body } = await capture({ type: "gemini", alias: "custom", mode, options: {
      google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
      custom: { extra_body: { marker: "outer", google: { marker: "inner", thinking_config: { thinking_budget: 1024 } } } }
    } });
    assert.deepEqual(body.extra_body, { marker: "outer", google: { marker: "inner", thinking_config: {
      thinking_budget: 1024, include_thoughts: true
    } } });
    assert.equal(body.reasoning_effort, undefined);
  });
}

for (const alias of ["custom-qwen", "custom_qwen"]) {
  for (const mode of ["main", "auxiliary"] as const) {
    test(`Qwen ${alias}: camel native fields override raw wire fields in ${mode}`, async () => {
      const { body } = await capture({ type: "qwen", alias, mode, options: {
        alibaba: { enableThinking: true, thinkingBudget: 4096 },
        [alias]: { enable_thinking: true, thinking_budget: 2048, marker: "raw" },
        customQwen: { enableThinking: false, thinkingBudget: 512, marker: "camel" }
      } });
      assert.equal(body.enable_thinking, false);
      assert.equal(body.thinking_budget, 512);
      assert.equal(body.marker, "camel");
      assert.equal(body.enableThinking, undefined);
      assert.equal(body.thinkingBudget, undefined);
    });
    test(`Qwen ${alias}: camel wire fields override raw native fields in ${mode}`, async () => {
      const { body } = await capture({ type: "qwen", alias, mode, options: {
        alibaba: { enableThinking: true, thinkingBudget: 4096 },
        [alias]: { enableThinking: true, thinkingBudget: 2048 },
        customQwen: { enable_thinking: false, thinking_budget: 512 }
      } });
      assert.equal(body.enable_thinking, false);
      assert.equal(body.thinking_budget, 512);
      assert.equal(body.enableThinking, undefined);
      assert.equal(body.thinkingBudget, undefined);
    });
  }
}
for (const mode of ["main", "auxiliary"] as const) {
  test(`DeepSeek camel alias overrides raw alias in ${mode}`, async () => {
    const { body } = await capture({ type: "deepseek", alias: "custom-deepseek", mode, options: {
      deepseek: { thinking: { type: "enabled" }, marker: "vendor" },
      "custom-deepseek": { thinking: { type: "enabled" }, marker: "raw" },
      customDeepseek: { thinking: { type: "disabled" }, marker: "camel" }
    } });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.marker, "camel");
  });
  test(`Google camel native controls replace raw wire controls in ${mode}`, async () => {
    const { body } = await capture({ type: "gemini", alias: "custom-gemini", mode, options: {
      google: { thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } },
      "custom-gemini": { extra_body: { google: { thinking_config: { thinking_budget: 2048 } } } },
      customGemini: { thinkingConfig: { thinkingLevel: "low" } }
    } });
    assert.deepEqual(body.extra_body, { google: { thinking_config: { thinking_level: "low", include_thoughts: true } } });
    assert.equal(body.thinkingConfig, undefined);
    assert.equal(body.reasoning_effort, undefined);
  });
  test(`Google camel effort replaces inherited budget in ${mode}`, async () => {
    const { body } = await capture({ type: "gemini", alias: "custom-gemini", mode, options: {
      google: { thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } },
      customGemini: { reasoningEffort: "low" }
    } });
    assert.equal(body.reasoning_effort, "low");
    assert.deepEqual(body.extra_body, { google: { thinking_config: { include_thoughts: true } } });
  });
}

for (const key of ["openai-compatible", "openaiCompatible"]) {
  test(`Google explicit budget wins over SDK-wide ${key} effort`, async () => {
    const { body } = await capture({ type: "gemini", mode: "auxiliary", options: {
      google: { thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } },
      [key]: { reasoningEffort: "high", user: "preserved-fixture" }
    } });
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.user, "preserved-fixture");
    assert.deepEqual(body.extra_body, { google: { thinking_config: { thinking_budget: 1024, include_thoughts: true } } });
  });
}
