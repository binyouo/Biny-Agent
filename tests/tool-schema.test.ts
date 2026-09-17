import assert from "node:assert/strict";
import type { AgentTool } from "../src/agent/core/types.js";
import { canonicalToolSchemas, stableAgentTools } from "../src/llm/promptCache.js";
import { normalizeToolParameters, type JsonObjectSchema } from "../src/tools/schema.js";

const parameters = {
  type: "object",
  properties: {
    optionalObject: {
      type: "object",
      properties: { value: { type: "string" } }
    },
    list: {
      type: "array",
      items: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"]
      }
    },
    choice: {
      oneOf: [
        { type: "object", properties: { left: { type: "string" } } },
        { type: "object", properties: { right: { type: "string" } }, required: ["right"] }
      ]
    }
  }
} as unknown as JsonObjectSchema;

const normalized = normalizeToolParameters("nested", parameters) as unknown as Record<string, unknown>;
assert.deepEqual(normalized.required, []);
const properties = normalized.properties as Record<string, Record<string, unknown>>;
assert.deepEqual(properties.optionalObject?.required, []);
assert.deepEqual((properties.list?.items as Record<string, unknown>).required, ["value"]);
assert.deepEqual(((properties.choice?.oneOf as Array<Record<string, unknown>>)[0]?.required), []);
assert.deepEqual(((properties.choice?.oneOf as Array<Record<string, unknown>>)[1]?.required), ["right"]);
assert.equal("required" in (parameters.properties?.optionalObject as unknown as Record<string, unknown>), false, "normalization must not mutate registered tools");

const tool = {
  name: "nested",
  description: "Nested schema fixture",
  parameters,
  executionMode: "parallel",
  execute: async () => ({ content: [] })
} satisfies AgentTool;
const providerTool = stableAgentTools([tool])[0]!;
assert.deepEqual(providerTool.parameters, normalized);
assert.deepEqual((canonicalToolSchemas([tool])[0] as { parameters: unknown }).parameters, normalized);

const malformed = {
  type: "object",
  properties: {
    payload: { type: "object", required: { value: true } }
  }
} as unknown as JsonObjectSchema;
assert.throws(
  () => normalizeToolParameters("broken", malformed),
  /Tool broken has invalid JSON Schema at parameters\.properties\.payload\.required: expected string\[\]\./u
);

const cyclic = { type: "object" } as unknown as JsonObjectSchema & { properties?: Record<string, unknown> };
cyclic.properties = { self: cyclic };
assert.throws(() => normalizeToolParameters("cyclic", cyclic), /cyclic JSON Schema at parameters\.properties\.self/u);

console.log("tool schema tests passed");
