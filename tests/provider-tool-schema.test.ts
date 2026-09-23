/** 四条真实 AI SDK adapter 的出站请求都必须携带相同、合法且互不污染的工具 schema。 */
import assert from "node:assert/strict";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentModel, AgentTool } from "../src/agent/core/types.js";
import type { ModelApiBackend } from "../src/config/schema.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import type { JsonObjectSchema } from "../src/tools/schema.js";

const parameters = {
  type: "object",
  properties: {
    optionalObject: {
      type: "object",
      properties: { value: { type: "string" } }
    },
    requiredObject: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"]
    }
  }
} as JsonObjectSchema;
const agentTool: AgentTool = {
  name: "schema_probe",
  description: "Schema adapter probe",
  parameters,
  executionMode: "parallel",
  execute: async () => ({ content: [] })
};
const fallbackModel: AgentModel = {
  provider: "fixture",
  modelId: "fixture",
  stream: async () => { throw new Error("The provider adapter must handle this request."); }
};

const adapters: Array<{ label: string; providerType: string; api: ModelApiBackend; supportsReasoning: boolean; omitEmptyRequired?: boolean }> = [
  { label: "OpenAI Chat", providerType: "openai", api: "chat_completions", supportsReasoning: true },
  { label: "OpenAI Compatible", providerType: "openai-compatible", api: "chat_completions", supportsReasoning: true, omitEmptyRequired: true },
  { label: "OpenAI Compatible Responses", providerType: "openai-compatible", api: "responses", supportsReasoning: true, omitEmptyRequired: true },
  { label: "OpenAI Responses", providerType: "openai", api: "responses", supportsReasoning: true },
  { label: "Anthropic", providerType: "anthropic", api: "anthropic_messages", supportsReasoning: false },
  { label: "Google", providerType: "google-native", api: "google_generative_ai", supportsReasoning: false }
];

for (const adapter of adapters) {
  const bodies: unknown[] = [];
  const model = createVercelLanguageModel({
    providerAlias: adapter.label,
    providerType: adapter.providerType,
    authMode: "api-key",
    api: adapter.api,
    modelId: "fixture-model",
    supportsReasoning: adapter.supportsReasoning,
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "test-key",
    headers: {},
    fetcher: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: "stop after request capture" } }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
  });
  for await (const _event of vercelAgentLoopContinue(
    { messages: [{ role: "user", content: "probe" }], tools: [agentTool] },
    { model: { ...fallbackModel, provider: adapter.providerType }, vercelModel: model, tools: [agentTool], maxSteps: 1, maxRetries: 0 }
  )) {
    // 400 只用于在首个出站请求后停止；断言目标是捕获到的 adapter request body。
  }
  assert.equal(bodies.length, 1, `${adapter.label} should make one captured request`);
  if (adapter.api === "chat_completions" || adapter.api === "responses") {
    assert.equal((bodies[0] as { tool_choice?: string }).tool_choice, "auto", `${adapter.label} must allow a text-only answer; a greeting must not be forced to call a tool`);
  }
  const schema = findSchema(bodies[0], "optionalObject");
  assert.ok(schema, `${adapter.label} request should contain the tool parameters schema`);
  assertObjectRequiredArrays(schema, adapter.label, "parameters", adapter.omitEmptyRequired === true);
  assert.deepEqual(schema.required, adapter.omitEmptyRequired === true ? undefined : []);
  assert.deepEqual((schema.properties as Record<string, Record<string, unknown>>).optionalObject?.required, adapter.omitEmptyRequired === true ? undefined : []);
  assert.deepEqual((schema.properties as Record<string, Record<string, unknown>>).requiredObject?.required, ["value"]);
}

assert.equal(parameters.required, undefined, "adapter projection must not mutate the registered schema");
assert.equal((parameters.properties?.optionalObject as JsonObjectSchema).required, undefined);
console.log("provider tool schema tests passed");

function findSchema(value: unknown, property: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSchema(item, property);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null && property in properties) return record;
  for (const child of Object.values(record)) {
    const found = findSchema(child, property);
    if (found) return found;
  }
  return undefined;
}

function assertObjectRequiredArrays(value: unknown, adapter: string, path = "parameters", allowMissing = false): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertObjectRequiredArrays(item, adapter, `${path}[${String(index)}]`, allowMissing));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (String(record.type).toLowerCase() === "object") {
    if (!allowMissing || record.required !== undefined) {
      assert.ok(Array.isArray(record.required), `${adapter} ${path}.required must be string[]`);
      assert.ok((record.required as unknown[]).every((item) => typeof item === "string"), `${adapter} ${path}.required must contain strings only`);
    }
  }
  for (const [key, child] of Object.entries(record)) assertObjectRequiredArrays(child, adapter, `${path}.${key}`, allowMissing);
}
