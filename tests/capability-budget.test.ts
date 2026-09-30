/** Automatic schemas stay bounded; explicit choices and discovery remain authoritative. */
import assert from "node:assert/strict";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { recentAutomaticToolNames } from "../src/agent/automaticToolHistory.js";
import type { SessionEvent } from "../src/session/recorder.js";

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
  input: "Read the latest document", history: [], previousTools: catalog.map((tool) => tool.name),
  config: defaultConfig, tools: [...foundation, ...catalog], skills: [], model,
  automaticToolBudget: { maxTools: 2, maxSchemaCharacters: 1000, maxPreviousTools: 1 }
};
const result = await preselectCapabilities(input);
assert.ok(Array.isArray(result.tools));
assert.equal(result.tools.filter((name) => name.startsWith("mcp_")).length, 2,
  "auto mode must not expand one MCP selection into an entire server or retain unbounded history");
assert.ok(result.tools.includes("mcp_docs_199"), "current selection precedes retained history");
assert.ok(result.tools.includes("mcp_docs_0"), "previousTools are explicitly ordered most recent first");
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

const noModel = await preselectCapabilities({ ...input, model: undefined });
assert.ok(Array.isArray(noModel.tools));
assert.equal(noModel.tools.filter((name) => name.startsWith("mcp_")).length, 1, "selector failure fallback has its own retention cap");
selection = [];
const freshChat = await preselectCapabilities(input);
assert.ok(Array.isArray(freshChat.tools));
assert.equal(freshChat.tools.filter((name) => name.startsWith("mcp_")).length, 1);
const turns: SessionEvent[] = [{ type: "user_message", messageId: "original", content: "docs", metadata: {
  automaticToolSelection: true, capabilitySelection: { tools: ["mcp_docs_0"], skills: [] }
} }];
const active = new Set(["original"]);
for (let index = 0; index < 5; index++) {
  let fresh: string[] | undefined;
  const next = await preselectCapabilities({ ...input,
    previousTools: recentAutomaticToolNames(turns, active),
    onAutomaticToolsSelected: (names: readonly string[]) => { fresh = [...names]; }
  });
  const id = `turn${index}`;
  active.add(id);
  turns.push({ type: "user_message", messageId: id, content: "unrelated greeting", metadata: {
    automaticToolSelection: true, capabilitySelection: next, automaticToolFreshSelection: fresh
  } });
  if (index >= 3) {
    assert.ok(Array.isArray(next.tools));
    assert.ok(!next.tools.includes("mcp_docs_0"), "retained history cannot renew its own three-turn lifetime");
  }
}
console.log("capability budget tests passed");
