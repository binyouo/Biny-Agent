/** Worker 的普通工具声明遵守暴露策略，同时保留来源、风险和具名白名单边界。 */
import assert from "node:assert/strict";
import { z } from "zod";
import { createReadOnlyTools, createSubagentTools } from "../src/extensions/subagent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool, ToolExposure, ToolRisk } from "../src/tools/types.js";

function fixture(name: string, exposure?: ToolExposure, risk: ToolRisk = "read"): Tool {
  return {
    name, description: `Use ${name}.`, exposure, risk,
    capability: risk === "read" ? "filesystem.read" : "filesystem.write",
    parameters: { type: "object", properties: {} }, schema: z.object({}),
    resolveExecution: () => ({ approvalRule: name, async execute() { return { ok: true }; } })
  };
}

const registry = new ToolRegistry();
const modes = ["direct", "model-only", "deferred", "codemode", "hidden"] as const;
const allowed: string[] = [];
for (const mode of modes) {
  for (const risk of ["read", "write"] as const) {
    const name = `${mode}_${risk}`;
    registry.registerBuiltinTool(fixture(name, mode, risk));
    allowed.push(name);
  }
}
registry.registerBuiltinTool(fixture("default_read"));
allowed.push("default_read");
registry.registerBuiltinTool(fixture("unselected_read"));
registry.registerMcpTool(fixture("remote_read", "direct"));
allowed.push("remote_read");

const visibleRead = ["default_read", "deferred_read", "direct_read", "model-only_read"].sort();
assert.deepEqual(createSubagentTools(registry, allowed).map((tool) => tool.name).sort(), visibleRead);
assert.deepEqual(createReadOnlyTools(registry, allowed).map((tool) => tool.name).sort(), visibleRead);
assert.deepEqual(createSubagentTools(registry, allowed, { accessMode: "workspace" }).map((tool) => tool.name).sort(), [
  ...visibleRead, "deferred_write", "direct_write", "model-only_write"
].sort());
assert.deepEqual(createSubagentTools(registry, []).map((tool) => tool.name), []);

console.log("worker tool exposure tests passed");
