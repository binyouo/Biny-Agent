import { testModel } from "./helpers/model.js";
/** 预选请求保留任务与路由描述，模型选中的合法能力不再被独立字符或数量预算丢弃。 */
import assert from "node:assert/strict";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentModel, AgentContext, ModelStreamEvent } from "../src/agent/core/types.js";

const requests: AgentContext[] = [];
const names = Array.from({ length: 520 }, (_, index) => `tool_${index}`);
const skillIds = Array.from({ length: 520 }, (_, index) => `skill_${index}`);
const model: AgentModel = testModel({ provider: "test", modelId: "selection-content", async stream(context) {
  requests.push(context);
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: JSON.stringify({ tools: [...names, "unregistered"], skillIds }) };
    yield { type: "finish", reason: "stop" };
  })();
} });
const result = await preselectCapabilities({
  input: `${"x".repeat(8_000)}TASK_AT_END`,
  history: [{ role: "user", content: `${"h".repeat(1_000)}HISTORY_AT_END` }],
  previousTools: [], config: defaultConfig, models: [{ model, failureDomain: "fixture" }],
  tools: names.map((name, index) => ({ name, description: `${"d".repeat(400)}TOOL_ROUTE_AT_END`, parameters: { type: "object", description: index === 0 ? "x".repeat(70_000) : "fixture" } })),
  skills: skillIds.map((id) => ({ id, name: id, description: `${"d".repeat(400)}SKILL_ROUTE_AT_END` }))
});
assert.equal(requests.length, 2);
for (const request of requests) {
  const messages = JSON.stringify(request.messages);
  assert.match(messages, /TASK_AT_END/u, "the selector must receive the end of the current task");
  assert.match(messages, /HISTORY_AT_END/u, "recent messages must not lose their final constraints");
}
assert.match(requests.find((request) => request.systemPrompt.includes("扩展工具目录："))!.systemPrompt, /TOOL_ROUTE_AT_END/u);
assert.match(requests.find((request) => request.systemPrompt.includes("技能目录："))!.systemPrompt, /SKILL_ROUTE_AT_END/u);
assert.deepEqual(result.tools, names, "retain every registered model-selected tool even with large schemas");
assert.deepEqual(result.skills, skillIds, "skill selection is not capped below the available catalog");
console.log("capability selection content tests passed");
