/** Bound new automatic choices without evicting accumulated tools or widening MCP servers. */
import assert from "node:assert/strict";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const catalog = Array.from({ length: 200 }, (_, index) => ({
  name: `mcp_docs_${index}`, description: `Read document ${index}`, source: "mcp" as const,
  capability: "mcp:docs", parameters: { type: "object" as const, properties: { query: { type: "string" as const } } }
}));
const foundation = ["Read", "ToolSearch", "TodoWrite", "AskUserQuestion", "read_tool_result"].map((name) => ({ name, description: name }));
let selection = [catalog[199]!.name];
const model: AgentModel = {
  provider: "test", modelId: "bounded-selector",
  stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: JSON.stringify({ tools: selection }) };
    yield { type: "finish", reason: "stop" };
  })()
};
const input = {
  input: "Read the latest document", history: [], previousTools: catalog.slice(0, 10).map((tool) => tool.name),
  config: defaultConfig, tools: [...foundation, ...catalog], skills: [], models: [{ model, failureDomain: "test-selector" }],
  automaticToolBudget: { maxTools: 2, maxSchemaCharacters: 1000 }
};
const result = await preselectCapabilities(input);
assert.ok(Array.isArray(result.tools));
assert.equal(result.tools.filter((name) => name.startsWith("mcp_")).length, 11,
  "retain every historical choice beyond eight tools while adding only the selected MCP tool");
assert.ok(result.tools.includes("mcp_docs_199"), "newly selected tools join accumulated history");
assert.ok(result.tools.includes("mcp_docs_0"), "the oldest selection remains available");
for (const tool of foundation) assert.ok(result.tools.includes(tool.name), `${tool.name} stays available`);

const huge = { ...catalog[0]!, name: "huge", description: "x".repeat(2000) };
selection = [huge.name, "mcp_docs_1"];
const sized = await preselectCapabilities({ ...input, tools: [...input.tools, huge], previousTools: [] });
assert.ok(Array.isArray(sized.tools));
assert.ok(!sized.tools.includes("huge"), "oversized auto schema is deferred to ToolSearch");
assert.ok(sized.tools.includes("mcp_docs_1"));
const schemaHuge = { ...catalog[0]!, name: "schemaHuge", parameters: { type: "object" as const, description: "x".repeat(2000) } };
selection = [schemaHuge.name];
const parameterBounded = await preselectCapabilities({ ...input, tools: [...input.tools, schemaHuge], previousTools: [] });
assert.ok(Array.isArray(parameterBounded.tools));
assert.ok(!parameterBounded.tools.includes(schemaHuge.name), "budget includes parameters, not only description");

const explicit = [huge.name, ...catalog.map((tool) => tool.name)];
assert.deepEqual((await preselectCapabilities({ ...input, tools: [...input.tools, huge], selection: { tools: explicit, skills: "none" } })).tools,
  explicit, "explicit lists are never reduced by automatic budgets");
assert.equal((await preselectCapabilities({ ...input, selection: { tools: "all", skills: "none" } })).tools, "all");
assert.equal((await preselectCapabilities({ ...input, selection: { tools: "none", skills: "none" } })).tools, "none");

const noModel = await preselectCapabilities({ ...input, models: [] });
assert.ok(Array.isArray(noModel.tools));
assert.equal(noModel.tools.filter((name) => name.startsWith("mcp_")).length, 10, "missing selector must preserve accumulated history");
selection = [];
const freshChat = await preselectCapabilities({ ...input, previousTools: [] });
assert.ok(Array.isArray(freshChat.tools));
assert.equal(freshChat.tools.filter((name) => name.startsWith("mcp_")).length, 0);
const largeHistory = await preselectCapabilities({ ...input, models: [],
  previousTools: [...catalog.map((tool) => tool.name), huge.name, "removed_tool"],
  tools: [...input.tools, huge], automaticToolBudget: { maxTools: 0, maxSchemaCharacters: 0 }
});
assert.ok(Array.isArray(largeHistory.tools));
assert.deepEqual(largeHistory.tools, [...foundation.map((tool) => tool.name), ...catalog.map((tool) => tool.name), huge.name],
  "new-selection budgets cannot evict any previously admitted tool; missing registrations stay excluded");
console.log("capability budget tests passed");
