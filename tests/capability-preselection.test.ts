/** 自动筛选的能力边界、配套工具、历史累积、显式选择和失败处理。 */
import assert from "node:assert/strict";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";

let calls = 0;
let answer = JSON.stringify({ tools: ["WebSearch", "Task", "mcp_docs_read", "unavailable"], skillIds: ["review"] });
const model: AgentModel = {
  provider: "test", modelId: "selector",
  stream: async (context) => {
    calls += 1;
    assert.equal(context.tools.length, 0, "筛选阶段只产出名单，不执行工具");
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: answer };
      yield { type: "finish", reason: "stop" };
    })();
  }
};
const tools = ["ToolSearch", "Read", "Write", "WebSearch", "WebFetch", "Task", "Skill", "read_skill_resource", "skill_lookup"].map((name) => ({ name, description: name, source: "builtin" as const }));
const options = {
  input: "查看文档并评审", config: defaultConfig, history: [], previousTools: ["Read", "removed"], model,
  tools: [...tools, { name: "mcp_docs_read", description: "Read docs", source: "mcp" as const, capability: "mcp:docs" },
    { name: "mcp_docs_search", description: "Search docs", source: "mcp" as const, capability: "mcp:docs" },
    { name: "mcp_other_read", description: "Unrelated server", source: "mcp" as const, capability: "mcp:other" }],
  skills: [{ id: "review-id", name: "review", description: "Review changes" }]
};
const result = await preselectCapabilities(options);
assert.equal(calls, 2, "工具与技能分别调用同一辅助模型");
assert.deepEqual(new Set(result.tools), new Set(["ToolSearch", "Read", "Write", "WebSearch", "WebFetch", "Task", "mcp_docs_read", "mcp_docs_search", "Skill", "read_skill_resource", "skill_lookup"]));
assert.deepEqual(result.skills, ["review-id"]);
const before = calls;
assert.deepEqual(await preselectCapabilities({ ...options, selection: { tools: ["Write"], skills: "none" } }), { tools: ["Write"], skills: "none" });
assert.equal(calls, before, "显式名单不再请求辅助模型");
assert.deepEqual(await preselectCapabilities({ ...options, selection: { tools: "all", skills: "all" } }), { tools: "all", skills: "all" });
answer = JSON.stringify({ tools: [], skillIds: [] });
assert.deepEqual(await preselectCapabilities({ ...options, input: "你好", previousTools: [] }), { tools: ["Read", "Write", "ToolSearch"], skills: [] });
answer = "invalid JSON";
assert.deepEqual(await preselectCapabilities(options), { tools: ["Read", "Write", "ToolSearch"], skills: [] });
assert.deepEqual(await preselectCapabilities({ ...options, model: undefined, input: "/skill:review" }), { tools: ["Read", "Write", "ToolSearch", "Skill", "read_skill_resource", "skill_lookup"], skills: ["review-id"] });
assert.deepEqual(await preselectCapabilities({ ...options, model: undefined, input: "$review", previousTools: [], selection: { tools: "auto", skills: "none" } }), { tools: ["Read", "Write", "ToolSearch"], skills: "none" }, "显式关闭技能不能被点名检测重新启用");
const controller = new AbortController();
controller.abort();
await assert.rejects(preselectCapabilities({ ...options, signal: controller.signal }), { name: "AbortError" });
assert.equal(calls, before + 4, "预先取消不能发起额外请求");

let concurrentCalls = 0;
let release!: () => void;
const bothStarted = new Promise<void>((resolve) => { release = resolve; });
const parallelModel: AgentModel = {
  provider: "test", modelId: "parallel-selector",
  stream: async (context) => {
    concurrentCalls++;
    if (concurrentCalls === 2) release();
    await bothStarted;
    const skillRequest = context.systemPrompt?.includes("技能目录：");
    assert.equal(context.systemPrompt?.includes("扩展工具目录："), !skillRequest, "只发送本次分析需要的目录");
    if (!skillRequest) {
      assert.equal(context.systemPrompt?.includes('"Read"'), false, "基础工具不进入扩展筛选目录");
      assert.equal(context.systemPrompt?.includes('"Write"'), false, "基础工具不进入扩展筛选目录");
    }
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: skillRequest ? '{"skillIds":["review"]}' : "invalid" };
      yield { type: "finish", reason: "stop" };
    })();
  }
};
assert.deepEqual(await preselectCapabilities({ ...options, model: parallelModel, signal: AbortSignal.timeout(1_000) }), {
  tools: ["Read", "Write", "ToolSearch", "Skill", "read_skill_resource", "skill_lookup"], skills: ["review-id"]
}, "工具解析失败不影响并发成功的技能选择");
let isolatedCalls = 0;
const isolatedModel: AgentModel = { ...parallelModel, stream: async () => {
  isolatedCalls++;
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: '{"tools":["Write"],"skillIds":["review"]}' };
  })();
} };
await preselectCapabilities({ ...options, model: isolatedModel, selection: { tools: "auto", skills: "none" } });
assert.equal(isolatedCalls, 1, "显式关闭技能时只分析工具");
await preselectCapabilities({ ...options, model: isolatedModel, tools: tools.filter((tool) => ["Read", "Write"].includes(tool.name)), skills: [] });
assert.equal(isolatedCalls, 1, "只有基础工具时不调用模型");
console.log("capability preselection tests passed");
