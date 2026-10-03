/** 自动预选只能声明允许向模型暴露的目录，显式准入模式由运行时继续执行。 */
import assert from "node:assert/strict";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import type { ToolExposure } from "../src/tools/types.js";

const entries: { name: string; exposure?: ToolExposure }[] = [
  { name: "Read", exposure: "hidden" },
  { name: "Bash", exposure: "codemode" },
  { name: "hidden_extension", exposure: "hidden" },
  { name: "script_extension", exposure: "codemode" },
  { name: "direct_extension", exposure: "direct" },
  { name: "model_extension", exposure: "model-only" },
  { name: "deferred_extension", exposure: "deferred" },
  { name: "default_extension", exposure: undefined }
];
const tools = entries.map((tool) => ({ ...tool, description: `Description for ${tool.name}`, source: "builtin" as const }));
const excludedNames = tools.slice(0, 4).map((tool) => tool.name);
const visibleNames = tools.slice(4).map((tool) => tool.name);
const options = {
  input: `Use ${[...excludedNames, ...visibleNames].join(" ")}`,
  config: defaultConfig, history: [], previousTools: excludedNames,
  selection: { tools: "auto" as const, skills: "none" as const }, tools, skills: []
};

const explicit = await preselectCapabilities({ ...options, models: [] });
assert.deepEqual(explicit.tools, visibleNames, "explicit names and previous selections cannot admit hidden or script-only tools into automatic declarations");

let requestedPrompt = "";
const model: AgentModel = {
  provider: "fixture", modelId: "capability-exposure",
  async stream(context) {
    requestedPrompt = context.systemPrompt ?? "";
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: JSON.stringify({ tools: [...excludedNames, ...visibleNames] }) };
      yield { type: "finish", reason: "stop" };
    })();
  }
};
const selected = await preselectCapabilities({
  ...options, input: "Choose useful extensions", models: [{ model, failureDomain: "fixture-selection" }]
});
assert.deepEqual(selected.tools, visibleNames, "model answers are checked against the filtered catalog, including retained history");
assert.ok(requestedPrompt.includes("deferred_extension"), "deferred tools remain eligible for explicit automatic disclosure");
for (const name of excludedNames) assert.equal(requestedPrompt.includes(`Description for ${name}`), false, `${name} metadata must not appear in the auxiliary catalog`);

assert.deepEqual(await preselectCapabilities({ ...options, selection: { tools: ["hidden_extension"], skills: "none" } }), {
  tools: ["hidden_extension"], skills: "none"
}, "manual admission choices are preserved for runtime exposure validation");
assert.deepEqual(await preselectCapabilities({ ...options, selection: { tools: "none", skills: "none" } }), {
  tools: "none", skills: "none"
});
console.log("capability exposure tests passed");
