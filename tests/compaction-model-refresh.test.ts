import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";

const seed = "Preserve the request. " + "source evidence ".repeat(700);
const checkpoint = [
  "## Goal", "- Preserve the request. <!-- evidence:m0 -->", "## Constraints & Preferences", "- (none recorded)",
  "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
  "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
  "## All User Messages", "- Preserve the request. <!-- evidence:m0 -->", "## Next Steps", "- (none recorded)",
  "## Critical Context", "- (none recorded)"
].join("\n");

async function fixture(context: TestContext, automatic = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-summary-selection-"));
  const agents: AgentSession[] = [];
  context.after(async () => {
    try { for (const agent of agents) await agent.close(); }
    finally { await removeTestRoot(root, { recursive: true, force: true }); }
  });
  const config = configSchema.parse({ ...structuredClone(defaultConfig), heartbeat: { enabled: false }, activity: { enabled: false },
    providers: { summary: { type: "openai-compatible", api: "chat_completions", baseUrl: "https://summary.invalid/v1", requiresApiKey: false } },
    models: Object.fromEntries(["a", "b", "c"].map(id => [id, { provider: "summary", model: id, contextWindow: 32_768 }])), defaultModel: "a",
    context: { ...defaultConfig.context, maxInputTokens: 8_192, identity: { enabled: false, userEnabled: false },
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false },
      compaction: { enabled: automatic, triggerPercent: 0.5, keepRecentMessages: 2, keepRecentTokens: 256, maxSummaryTokens: 1024, summaryModel: "a" } },
    chat: { ...defaultConfig.chat, defaultToolSelection: "none", defaultSkillSelection: "none" }
  });
  const state = { config, requests: [] as string[], beforeReply: undefined as (() => Promise<void>) | undefined, finish: "stop", loadError: undefined as Error | undefined };
  context.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { model: string };
    state.requests.push(request.model);
    const finish = state.finish;
    await state.beforeReply?.();
    return new Response([
      { choices: [{ index: 0, delta: { content: checkpoint }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200 } }
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const model = testModel({ provider: "fixture", modelId: "main", async *stream() {
    yield { type: "text-delta" as const, text: "Seed answer." };
    yield { type: "finish" as const, reason: "stop" as const };
  } });
  const create = async () => {
    const workspaceRoot = path.join(root, `workspace-${agents.length}`);
    await mkdir(workspaceRoot);
    await ensureAgentDirs(workspaceRoot);
    const agent = new AgentSession({ workspaceRoot, config: structuredClone(config), model, toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(workspaceRoot),
      configStore: { load: async () => { if (state.loadError) throw state.loadError; return structuredClone(state.config); },
        save: async value => { state.config = structuredClone(value); } } });
    agents.push(agent);
    await agent.initialize();
    assert.equal((await agent.runTask(seed, { emotionAnalysis: false })).status, "completed");
    return agent;
  };
  return { state, create };
}

test("驻留会话手动压缩读取新摘要选择，在途摘要及修复固定模型", { timeout: 20_000 }, async context => {
  const f = await fixture(context);
  const first = await f.create();
  const second = await f.create();
  f.state.config.context.compaction.summaryModel = "b";
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.state.finish = "length";
  f.state.beforeReply = async () => { entered(); await gate; };
  const pending = first.compactConversation();
  try {
    await started;
    assert.deepEqual(f.state.requests, ["b"]);
    f.state.config.context.compaction.summaryModel = "c";
    f.state.finish = "stop";
    f.state.beforeReply = undefined;
    release();
    await pending;
    assert.deepEqual(f.state.requests, ["b", "b"], "有界修复沿用开始时的模型");
    await second.compactConversation();
    assert.deepEqual(f.state.requests, ["b", "b", "c"], "另一驻留会话无需重建即可读取最新选择");
  } finally { f.state.finish = "stop"; f.state.beforeReply = undefined; release(); await pending; }
});

test("下一次 root turn 的自动压缩读取保存后的摘要选择", { timeout: 20_000 }, async context => {
  const f = await fixture(context, true);
  const agent = await f.create();
  assert.deepEqual(f.state.requests, []);
  f.state.config.context.compaction.summaryModel = "b";
  assert.equal((await agent.runTask(seed, { emotionAnalysis: false })).status, "completed");
  assert.ok(f.state.requests.length > 0, "真实自动压缩入口必须发起摘要请求");
  assert.ok(f.state.requests.every(model => model === "b"));
});

test("手动压缩配置读取失败保留历史并释放独占，重试重新读取选择", { timeout: 20_000 }, async context => {
  const f = await fixture(context);
  const agent = await f.create();
  const before = await agent.contextStatus();
  f.state.loadError = new Error("config unavailable");
  await assert.rejects(agent.compactConversation(), /config unavailable/u);
  assert.deepEqual(f.state.requests, [], "读取失败不能回退到过期的摘要模型");
  assert.deepEqual(await agent.contextStatus(), before);
  f.state.loadError = undefined;
  f.state.config.context.compaction.summaryModel = "c";
  await agent.compactConversation();
  assert.deepEqual(f.state.requests, ["c"]);
});
