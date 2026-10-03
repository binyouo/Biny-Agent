/** 自动筛选的能力边界、配套工具、受限历史、显式选择和失败处理。 */
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
  input: "查看文档并评审", config: defaultConfig, history: [], previousTools: ["Read", "removed"], models: candidates(model),
  tools: [...tools, { name: "mcp_docs_read", description: "Read docs", source: "mcp" as const, capability: "mcp:docs" },
    { name: "mcp_docs_search", description: "Search docs", source: "mcp" as const, capability: "mcp:docs" },
    { name: "mcp_other_read", description: "Unrelated server", source: "mcp" as const, capability: "mcp:other" }],
  skills: [{ id: "review-id", name: "review", description: "Review changes" }]
};
const result = await preselectCapabilities(options);
assert.equal(calls, 2, "工具与技能分别调用同一辅助模型");
assert.deepEqual(new Set(result.tools), new Set(["ToolSearch", "Read", "Write", "WebSearch", "WebFetch", "Task", "mcp_docs_read", "Skill", "read_skill_resource", "skill_lookup"]));
assert.deepEqual(result.skills, ["review-id"]);
const before = calls;
assert.deepEqual(await preselectCapabilities({ ...options, selection: { tools: ["Write"], skills: "none" } }), { tools: ["Write"], skills: "none" });
assert.equal(calls, before, "显式名单不再请求辅助模型");
assert.deepEqual(await preselectCapabilities({ ...options, selection: { tools: "all", skills: "all" } }), { tools: "all", skills: "all" });
answer = JSON.stringify({ tools: [], skillIds: [] });
assert.deepEqual(await preselectCapabilities({ ...options, input: "你好", previousTools: [] }), { tools: ["Read", "Write", "ToolSearch"], skills: [] });
answer = "invalid JSON";
assert.deepEqual(await preselectCapabilities(options), { tools: ["Read", "Write", "ToolSearch"], skills: [] });
assert.deepEqual(await preselectCapabilities({ ...options, models: [], input: "/skill:review" }), { tools: ["Read", "Write", "ToolSearch", "Skill", "read_skill_resource", "skill_lookup"], skills: ["review-id"] });
assert.deepEqual(await preselectCapabilities({ ...options, models: [], input: "$review", previousTools: [], selection: { tools: "auto", skills: "none" } }), { tools: ["Read", "Write", "ToolSearch"], skills: "none" }, "显式关闭技能不能被点名检测重新启用");
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
assert.deepEqual(await preselectCapabilities({ ...options, models: candidates(parallelModel), signal: AbortSignal.timeout(1_000) }), {
  tools: ["Read", "Write", "ToolSearch", "Skill", "read_skill_resource", "skill_lookup"], skills: ["review-id"]
}, "工具解析失败不影响并发成功的技能选择");
let isolatedCalls = 0;
const isolatedModel: AgentModel = { ...parallelModel, stream: async () => {
  isolatedCalls++;
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: '{"tools":["Write"],"skillIds":["review"]}' };
  })();
} };
await preselectCapabilities({ ...options, models: candidates(isolatedModel), selection: { tools: "auto", skills: "none" } });
assert.equal(isolatedCalls, 1, "显式关闭技能时只分析工具");
await preselectCapabilities({ ...options, models: candidates(isolatedModel), tools: tools.filter((tool) => ["Read", "Write"].includes(tool.name)), skills: [] });
assert.equal(isolatedCalls, 1, "只有基础工具时不调用模型");
const recallTools = ["save_memory", "recall_memory", "search_history"].map((name) => ({ name, description: name, source: "builtin" as const }));
const recallOptions = { ...options, tools: [...tools, ...recallTools], skills: [], previousTools: [] };
const ordinarySelection = await preselectCapabilities({ ...recallOptions, models: [], input: "修复解析器" });
assert.equal(Array.isArray(ordinarySelection.tools) && ordinarySelection.tools.some((name) => recallTools.some((tool) => tool.name === name)), false, "注册记忆和历史工具不等于每回合注入定义");
answer = JSON.stringify({ tools: ["recall_memory", "search_history"] });
const recallSelection = await preselectCapabilities({ ...recallOptions, input: "上次讨论的约束是什么" });
assert.equal(Array.isArray(recallSelection.tools) && recallSelection.tools.includes("recall_memory") && recallSelection.tools.includes("search_history"), true, "按需选择仍能启用记忆和历史检索");
const computerTools = ["ComputerList", "ComputerObserve", "ComputerAction"].map((name) => ({ name, description: name, source: "builtin" as const }));
let unavailableCalls = 0;
const unavailableModel: AgentModel = {
  provider: "test", modelId: "unavailable-selector",
  stream: async () => { unavailableCalls += 1; throw new Error("Insufficient Balance"); }
};
const computerOptions = { ...options, tools: [...tools, ...computerTools], skills: [], previousTools: [], models: candidates(unavailableModel) };
for (const input of ["使用 computeruse", "Use computer use", "使用 Computer-Use", "使用 CUA", "请调用 ComputerObserve"]) {
  const selection = await preselectCapabilities({ ...computerOptions, input, automaticToolBudget: { maxTools: 0, maxSchemaCharacters: 0 } });
  assert.ok(Array.isArray(selection.tools));
  const selectedTools = selection.tools;
  assert.equal(computerTools.every((tool) => selectedTools.includes(tool.name)), true, input);
}
const noEndpoint = await preselectCapabilities({ ...computerOptions, input: "使用 computeruse", tools, models: [] });
assert.equal(Array.isArray(noEndpoint.tools) && noEndpoint.tools.some((name) => computerTools.some((tool) => tool.name === name)), false, "Missing desktop registration must not invent Computer tools.");
const noModelComputer = await preselectCapabilities({ ...computerOptions, input: "使用computeruse", models: [] });
assert.ok(Array.isArray(noModelComputer.tools));
const noModelTools = noModelComputer.tools;
assert.equal(computerTools.every((tool) => noModelTools.includes(tool.name)), true, "Explicit Computer Use remains visible without a configured selector.");
const ordinary = await preselectCapabilities({ ...computerOptions, input: "修复解析器", models: [] });
assert.equal(Array.isArray(ordinary.tools) && ordinary.tools.some((name) => computerTools.some((tool) => tool.name === name)), false, "Ordinary coding requests keep Computer tools optional.");
const denied = await preselectCapabilities({ ...computerOptions, input: "使用 computeruse", selection: { tools: "none", skills: "none" } });
assert.equal(denied.tools, "none", "Explicitly disabled tools remain disabled.");
const named = await preselectCapabilities({ ...options, input: "调用 mcp_docs_read", models: [], previousTools: [], automaticToolBudget: { maxTools: 0, maxSchemaCharacters: 0 }, skills: [] });
assert.equal(Array.isArray(named.tools) && named.tools.includes("mcp_docs_read"), true, "Explicit registered tools are not dependent on automatic selection budgets.");
assert.ok(unavailableCalls > 0, "The selector failure cases must exercise an actual injected model failure.");

const failedSelector: AgentModel = {
  provider: "test", modelId: "no-credit",
  stream: async () => { throw Object.assign(new Error("Insufficient Balance"), { statusCode: 402 }); }
};
const backupSelector: AgentModel = {
  provider: "backup", modelId: "backup-selector",
  stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: '{"tools":["WebSearch"],"skillIds":["review"]}' };
    yield { type: "finish", reason: "stop" };
  })()
};
const failoverOptions = {
  ...options,
  models: [
    { model: failedSelector, failureDomain: "empty-account" },
    { model: backupSelector, failureDomain: "backup-account" }
  ]
};
const fallbackSelection = await preselectCapabilities(failoverOptions);
assert.ok(Array.isArray(fallbackSelection.tools) && fallbackSelection.tools.includes("WebSearch"), "Automatic selection must try an eligible backup after an account balance failure.");
assert.deepEqual(fallbackSelection.skills, ["review-id"], "Skill selection must use the same bounded fallback policy.");
console.log("capability preselection tests passed");

function candidates(model: AgentModel) {
  return [{ model, failureDomain: `${model.provider}/${model.modelId}` }];
}
