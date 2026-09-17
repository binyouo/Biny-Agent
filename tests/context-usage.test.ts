/** 请求计量回归：最新请求、来源分类、缓存完整性和恢复后的展示不能相互冒充。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { estimateContextBreakdown, estimateTokens, messageTokenCost } from "../src/agent/context/tokenUsage.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession } from "../src/agent/AgentSession.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { replaySessionEvents } from "../src/session/replay.js";
import type { AgentModel, AgentTool, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { createSessionUsage, summarizeUsage, sumSessionUsage } from "../src/observability/usage.js";
import { formatContextUsage } from "../src/desktop/renderer/src/usagePresentation.js";
import type { ToolSource } from "../src/tools/types.js";

const tool = (name: string): AgentTool => ({
  name, description: `Description for ${name}`, parameters: { type: "object" },
  execute: async () => ({ content: [{ type: "text", text: "tool result" }] })
});
const sources = new Map<string, ToolSource>([["remote", "mcp"], ["Read", "builtin"], ["Skill", "skill"]]);
const input = {
  systemPrompt: "System rules\nAvailable skills: testing",
  skillPrompt: "Available skills: testing",
  messages: [
    { role: "user" as const, content: "Runtime context\nHello", originalContent: "Hello" },
    { role: "assistant" as const, content: [{ type: "reasoning" as const, text: "reason once" }] },
    { role: "toolResult" as const, toolName: "Skill", toolCallId: "skill-1", content: [{ type: "text" as const, text: "Loaded skill instructions" }] }
  ],
  tools: [tool("remote"), tool("Read"), tool("Skill")],
  toolSources: sources
};

function testClassification(): void {
  const breakdown = estimateContextBreakdown(input);
  for (const count of Object.values(breakdown)) assert.ok(count > 0);
  const withoutRemote = estimateContextBreakdown({ ...input, tools: [tool("Read")] });
  assert.equal(withoutRemote.mcpTools, 0, "disabled schemas must disappear");
  assert.ok(withoutRemote.skills > 0, "already loaded skills remain even if Skill is disabled");
  assert.equal(messageTokenCost({ role: "assistant", content: [{ type: "reasoning", text: "reason once" }] }), estimateTokens("reason once") + 4);
  const imageCost = (data: string) => messageTokenCost({ role: "user", content: [{ type: "image", data, mimeType: "image/png" }] });
  assert.equal(imageCost("small"), imageCost("x".repeat(100_000)), "base64 is not text input");
  const spoofed = estimateContextBreakdown({ ...input, systemPrompt: undefined, tools: [], messages: [{ role: "user", content: input.skillPrompt }] });
  assert.equal(spoofed.skills, 0, "user content cannot forge skill attribution");
  const truncated = estimateContextBreakdown({ ...input, systemPrompt: "System rules", tools: [], messages: [] });
  assert.equal(truncated.skills, 0, "omitted metadata must not count");
}

function testCacheAndDisplay(): void {
  const info = { modelAlias: "test", provider: "test", model: "test" };
  const records = [createSessionUsage({ inputTokens: 100, cacheReadTokens: 0 }, "agent", info), createSessionUsage({ inputTokens: 900, cacheReadTokens: 900 }, "agent", info)];
  assert.equal(summarizeUsage(records).sessionCacheHitRate, 0.9, "weighted average must not become 50%");
  records.push(createSessionUsage({ inputTokens: 100 }, "agent", info));
  assert.equal(summarizeUsage(records).sessionCacheHitRate, undefined);
  const restoredAggregate = sumSessionUsage(records);
  assert.equal(restoredAggregate.cacheReadTokens, undefined, "partial cache totals cannot turn into known values on replay");
  assert.equal(summarizeUsage([restoredAggregate]).sessionCacheHitRate, undefined);
  assert.equal(summarizeUsage([records[0]!, createSessionUsage({}, "agent", info)]).sessionCacheHitRate, undefined);
  const display = formatContextUsage({ usedTokens: 109_000, contextWindow: 1_000_000, breakdown: estimateContextBreakdown(input), source: "provider", cacheHitRate: 0.896 });
  assert.equal(display?.percent, 10.9);
  assert.equal(display?.cacheHitRate, "89.6%");
  assert.equal(display?.categories.reduce((sum, category) => sum + Math.round(Number(category.percent) * 10), 0), 1000);
  assert.ok(Math.abs((display?.categories.reduce((sum, category) => sum + category.width, 0) ?? 0) - 10.9) < 1e-9);
  assert.equal(formatContextUsage({ usedTokens: 0, contextWindow: 1_000_000 })?.percent, 0, "the indicator remains visible before usage arrives");
  assert.equal(formatContextUsage({ usedTokens: 2_000, contextWindow: 1_000 })?.percent, 200, "do not hide overflow by clamping the reported percentage");
  assert.equal(formatContextUsage({ usedTokens: NaN, contextWindow: 1_000 }), undefined);
}

async function testRequestLifecycle(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-context-usage-"));
  const calls: ModelStreamContext[] = [];
  const observed: ModelStreamContext[] = [];
  let alias = "first";
  const model: AgentModel = {
    provider: "test", modelId: "test",
    stream: async (context) => {
      calls.push(structuredClone({ ...context, tools: [] }));
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (calls.length === 1) yield { type: "tool-call", id: "read-1", name: "Read", arguments: {} };
        else yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: calls.length === 1 ? "tool-calls" : "stop", usage: { inputTokens: calls.length === 1 ? 100 : 240, cacheReadTokens: 80 } };
      })();
    }
  };
  const makeMemory = () => new ContextMemory(() => model, new WorkspaceContext(root, [], 32_768), undefined, 900, 32_768, undefined, () => ({
    contextWindow: 1_000, contextWindowIsFallback: false, maxInputTokens: 900, modelAlias: alias, toolSchemaReserveTokens: 50_000
  }));
  const memory = makeMemory();
  try {
    for await (const event of vercelAgentLoopContinue({ messages: [{ role: "user", content: "Read" }], systemPrompt: "System", tools: [tool("Read")] }, {
      model, tools: [tool("Read")], maxSteps: 3,
      transformContext: async (messages) => messages.map((message) => message.role === "toolResult" ? { ...message, content: [{ type: "text" as const, text: "pruned" }] } : message),
      prepareNextTurn: async ({ context }) => ({ context: { ...context, systemPrompt: "Updated system" }, tools: [] }),
      onRequestContext: (context) => {
        observed.push(structuredClone({ ...context, tools: [] }));
        memory.recordRequest({ ...context, toolSources: sources });
        assert.equal(memory.getBudget().source, "estimated");
      }
    })) {
      if (event.type === "turn_end") memory.recordProviderUsage(event.message.usage ?? {});
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(observed, calls, "sample the actual post-transform context once per request");
    assert.equal(memory.getBudget().usedTokens, 240, "latest request, not 100 + 240");
    assert.equal(memory.getBudget().breakdown?.systemTools, 0, "use the next step's tools");
    assert.ok((memory.getBudget().estimatedTokens ?? 0) < 50_000, "tool reserve is not usage");
    const snapshot = memory.snapshot();
    const restored = makeMemory();
    restored.restore([], snapshot);
    assert.deepEqual(restored.getBudget().breakdown, snapshot.budget.breakdown);
    assert.equal(restored.getBudget().source, "provider");
    if (snapshot.budget.breakdown) snapshot.budget.breakdown.messages = -1;
    assert.ok((restored.getBudget().breakdown?.messages ?? 0) >= 0, "restoration must not retain mutable references");
    alias = "second";
    assert.equal(restored.getBudget().source, "estimated", "a different model cannot inherit measured tokens as its own");
    memory.setCheckpoint({ summary: "Short summary", compactedMessages: 2, firstKeptMessageIndex: 2, tokensBefore: 240, createdAt: new Date().toISOString() });
    assert.equal(memory.getBudget().breakdown, undefined, "compaction invalidates old proportions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDirectProviderSampling(): Promise<void> {
  const vercelModel = new MockLanguageModelV4({ doStream: async () => ({
    stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "text" });
      controller.enqueue({ type: "text-delta", id: "text", delta: "done" });
      controller.enqueue({ type: "text-end", id: "text" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 }
      } });
      controller.close();
    } })
  }) });
  const observed: ModelStreamContext[] = [];
  for await (const _event of vercelAgentLoopContinue({ systemPrompt: "system", messages: [{ role: "user", content: "unprojected" }], tools: [] }, {
    model: { provider: "test", modelId: "test", stream: async () => { throw new Error("unexpected adapter route"); } },
    vercelModel, tools: [], maxSteps: 1,
    transformContext: async () => [{ role: "user", content: "actual projected message" }],
    onRequestContext: (context) => { observed.push(context); }
  })) { /* 消费真实 loop，SDK mock 只替换网络边界。 */ }
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.messages[0]?.content, "actual projected message");
  assert.ok(JSON.stringify(vercelModel.doStreamCalls[0]?.prompt).includes("actual projected message"));
}

async function testSessionPersistence(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-context-usage-session-"));
  const previousGlobal = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  let calls = 0;
  const model: AgentModel = { provider: "test", modelId: "test", stream: async () => {
    calls++;
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: "ok" };
      yield { type: "finish", reason: "stop", usage: { inputTokens: calls === 1 ? 100 : 900, cacheReadTokens: calls === 1 ? 0 : 900 } };
    })();
  } };
  const config = configSchema.parse({
    ...defaultConfig, defaultModel: "test",
    providers: { test: { type: "openai", apiKey: "test-placeholder" } },
    models: { test: { provider: "test", model: "test", contextWindow: 1_000_000 } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({ workspaceRoot: root, config, model, toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission), recorder, skillPrompt: input.skillPrompt });
  try {
    await agent.initialize();
    let updates = 0;
    const preparation: string[] = [];
    for (const prompt of ["hi", "continue"]) {
      for await (const event of agent.prompt(prompt, { emotionAnalysis: false, messageId: `submitted-${prompt}` })) {
        if (event.type === "preparation.updated") preparation.push(event.stage);
        if (event.type === "context.updated") {
          updates++;
          assert.equal(event.context.memoryInjectedCount, 0, "关闭记忆时仍发布明确的零注入结果");
          assert.deepEqual(event.context.memoryInjectedSummaries, [], "关闭记忆时不发布记忆摘要");
        }
      }
    }
    assert.deepEqual(preparation, ["workspace", "ready", "workspace", "ready"], "关闭记忆时不发送检索进度，准备完成必须清除状态");
    assert.equal(calls, 2);
    assert.equal(updates, 6, "each request emits prepared context, request estimate and provider correction");
    const budget = (await agent.contextStatus()).budget;
    assert.equal(budget.usedTokens, 900);
    assert.equal(budget.cacheHitRate, 0.9);
    assert.ok((budget.breakdown?.skills ?? 0) > 0);
    await recorder.flush();
    const storedEvents = await readSessionEvents(recorder.filePath);
    assert.deepEqual(storedEvents.filter((event) => event.type === "user_message" && !event.auditOnly).map((event) => event.messageId), ["submitted-hi", "submitted-continue"], "落盘用户消息沿用提交回执 ID");
    const replies = storedEvents.filter((event) => event.type === "assistant_message" && !event.auditOnly);
    assert.ok(replies.length > 0);
    assert.ok(replies.every((event) => event.metadata?.memoryInjectedCount === 0), "回复持久化真实的零注入结果");
    assert.ok(replies.every((event) => Array.isArray(event.metadata?.memoryInjectedSummaries) && event.metadata.memoryInjectedSummaries.length === 0), "回复持久化空的记忆摘要清单");
    const replay = replaySessionEvents(storedEvents);
    assert.deepEqual(replay.contextState?.budget.breakdown, budget.breakdown);
    assert.equal(replay.contextState?.budget.cacheHitRate, 0.9);
    assert.equal(replay.contextState?.budget.usedTokens, 900);
    assert.equal(JSON.stringify(budget).includes(input.skillPrompt), false, "persist counts, not prompt bodies");
  } finally {
    await agent.close();
    if (previousGlobal === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousGlobal;
    await rm(root, { recursive: true, force: true });
  }
}

testClassification();
testCacheAndDisplay();
await testRequestLifecycle();
await testDirectProviderSampling();
await testSessionPersistence();
console.log("context usage tests passed");
