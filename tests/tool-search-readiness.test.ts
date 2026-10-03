import assert from "node:assert/strict";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import type { Tool, ToolExecutionContext } from "../src/tools/types.js";

const registry = new ToolRegistry();
const remote: Tool = {
  name: "mcp_records_list", description: "List records", exposure: "deferred",
  namespace: { name: "records" }, risk: "read",
  parameters: { type: "object", properties: {} }, schema: z.object({}),
  resolveExecution: () => ({ approvalRule: "records", async execute() { return {}; } })
};
const search = createToolSearchTool(() => registry.listEntries());
const context: ToolExecutionContext = {
  toolCallId: "discovery", operationId: "discovery",
  prepareToolDiscovery: async (query) => {
    assert.equal(query, "mcp_records_list");
    registry.registerMcpTool(remote);
    return { pending: [], timedOut: false };
  }
};
const execution = search.resolveExecution({ query: "mcp_records_list" });
if ("isError" in execution) throw new Error("Expected local discovery");
const found = await execution.execute(context);
assert.equal(found.status, "completed");
assert.deepEqual(found.tools.map((tool) => tool.name), [remote.name], "discovery refreshes pending MCP before matching");

registry.registerMcpTool({ ...remote, name: "hidden_record", exposure: "hidden" });
registry.registerMcpTool({ ...remote, name: "script_record", exposure: "codemode" });
const query = search.resolveExecution({ query: "hidden_record script_record mcp_records_list" });
if ("isError" in query) throw new Error("Expected local discovery");
assert.deepEqual((await query.execute({ ...context, prepareToolDiscovery: undefined })).tools.map((tool) => tool.name), [remote.name]);
assert.deepEqual((await query.execute({ ...context, prepareToolDiscovery: undefined, toolDiscoveryNames: new Set(["script_record"]), toolDiscoveryNamespace: "records" })).tools.map((tool) => tool.name), ["script_record"]);

const timed = search.resolveExecution({ query: "pending tool" });
if ("isError" in timed) throw new Error("Expected local discovery");
const unavailable = await timed.execute({ ...context, prepareToolDiscovery: async () => ({ pending: ["slow"], timedOut: true }) });
assert.equal(unavailable.code, "mcp_discovery_timeout");
assert.equal(unavailable.retryable, true);
console.log("tool search readiness tests passed");
