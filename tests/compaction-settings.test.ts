// 压缩自定义额度回归：triggerPercent 触发、条数保留、reserve 优先级、摘要模型注入与项目级覆盖解析。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { ContextMemory, type ContextCompactionOptions } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { compactionSchema } from "../src/config/schema.js";
import { projectSettingsSchema } from "../src/config/projectSettings.js";

class RecordingModel {
  readonly requests: AgentMessage[][] = [];
  readonly model: AgentModel = {
    provider: "compaction-test",
    modelId: "compaction-test",
    stream: async (context: ModelStreamContext, options): Promise<AsyncIterable<ModelStreamEvent>> => {
      this.requests.push(context.messages);
      return (async function* (): AsyncIterable<ModelStreamEvent> {
        options?.signal?.throwIfAborted();
        yield { type: "start" as const };
        yield { type: "text-delta" as const, text: "## Goal\n测试压缩。\n## Next Steps\n继续当前任务。" };
        yield { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1 } };
      })();
    }
  };
}

async function withTempWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-compaction-"));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function makeMemory(workspaceRoot: string, provider: RecordingModel, options: ContextCompactionOptions, maxTokens = 4_000): ContextMemory {
  return new ContextMemory(
    () => provider.model,
    new WorkspaceContext(workspaceRoot, [], 32 * 1024),
    undefined,
    maxTokens,
    32 * 1024,
    undefined,
    undefined,
    options
  );
}

function userMessage(chars: number): AgentMessage {
  return { role: "user", content: "x".repeat(chars) };
}

/** 走 prepareTurn 自动触发路径，返回本轮实际压缩掉的消息数。 */
async function autoCompactedCount(memory: ContextMemory): Promise<number> {
  const prepared = await memory.prepareTurn("继续", "");
  return prepared.compaction?.compactedMessageCount ?? 0;
}

async function testTriggerPercentFiresAndHolds(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    // 阈值 80% × 4000 = 3200；~1000 token 的历史不应触发。
    const calm = makeMemory(workspaceRoot, new RecordingModel(), { triggerPercent: 0.8, keepRecentTokens: 100 });
    calm.replaceHistory([userMessage(3_000)]);
    assert.equal(await autoCompactedCount(calm), 0);

    // ~4000 token 的历史超过阈值，应触发。
    const busy = makeMemory(workspaceRoot, new RecordingModel(), { triggerPercent: 0.8, keepRecentTokens: 100 });
    busy.replaceHistory([userMessage(12_000), userMessage(10)]);
    assert.ok(await autoCompactedCount(busy) > 0);
  });
}

async function testActiveRunCompactsTheNextRequestCandidate(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new RecordingModel();
    const memory = makeMemory(workspaceRoot, provider, {
      triggerPercent: 0.8,
      keepRecentTokens: 100
    });
    const quietContext = {
      systemPrompt: "system",
      tools: [],
      messages: [userMessage(1_000), { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] }]
    };
    assert.equal(await memory.compactRunContextIfNeeded(quietContext), undefined);
    assert.equal(provider.requests.length, 0, "低于水位时不能调用摘要模型");

    memory.recordProviderUsage({ inputTokens: 100 });
    const busyContext = {
      ...quietContext,
      messages: [
        userMessage(8_000),
        { role: "assistant" as const, content: [{ type: "text" as const, text: "first" }] },
        userMessage(8_000),
        { role: "assistant" as const, content: [{ type: "text" as const, text: "second" }] }
      ]
    };
    const compacted = await memory.compactRunContextIfNeeded(busyContext);
    assert.ok(compacted && compacted.compactedMessageCount > 0);
    assert.equal(provider.requests.length, 1);
    assert.ok(compacted.messages.length < busyContext.messages.length);
  });
}

async function testExplicitReserveBeatsTriggerPercent(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    // triggerPercent 0.5 → 阈值 2000；显式 reserve 3900 → 阈值 100。
    // ~400 token 的历史只在 reserve 优先时触发。
    const memory = makeMemory(workspaceRoot, new RecordingModel(), { triggerPercent: 0.5, reserveTokens: 3_900, keepRecentTokens: 100 });
    memory.replaceHistory([userMessage(1_200), userMessage(10)]);
    assert.ok(await autoCompactedCount(memory) > 0);
  });
}

async function testKeepRecentMessagesBoundsRetainedHistory(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const memory = makeMemory(workspaceRoot, new RecordingModel(), { keepRecentTokens: 100_000, keepRecentMessages: 2 });
    const history: AgentMessage[] = [];
    for (let index = 0; index < 3; index += 1) {
      history.push({ role: "user", content: `问题 ${index}` });
      history.push({ role: "assistant", content: [{ type: "text", text: `回答 ${index}` }] });
    }
    memory.replaceHistory(history);
    const result = await memory.compact();
    assert.equal(result.compacted, true);
    assert.equal(result.compactedMessageCount, 4);
    assert.equal(memory.getHistory().length, 2);
  });
}

async function testSummaryModelInjection(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    // 配置了独立摘要模型时，摘要请求只打给该模型。
    const main = new RecordingModel();
    const summarizer = new RecordingModel();
    const injected = makeMemory(workspaceRoot, main, { keepRecentTokens: 100, resolveSummaryModel: () => summarizer.model });
    injected.replaceHistory([userMessage(3_000), userMessage(3_000)]);
    await injected.compact();
    assert.equal(summarizer.requests.length, 1);
    assert.equal(main.requests.length, 0);

    // 缺省回退当前对话模型。
    const fallback = new RecordingModel();
    const plain = makeMemory(workspaceRoot, fallback, { keepRecentTokens: 100 });
    plain.replaceHistory([userMessage(3_000), userMessage(3_000)]);
    await plain.compact();
    assert.equal(fallback.requests.length, 1);
  });
}

function testSchemaAndProjectOverrideParsing(): void {
  // 全局 schema：边界外拒绝，合法值通过。
  assert.throws(() => compactionSchema.parse({ enabled: true, triggerPercent: 0.3 }));
  assert.throws(() => compactionSchema.parse({ enabled: true, triggerPercent: 0.99 }));
  assert.throws(() => compactionSchema.parse({ enabled: true, keepRecentMessages: 0 }));
  const parsed = compactionSchema.parse({ enabled: true, triggerPercent: 0.8, keepRecentMessages: 8, summaryModel: "kimi-k3" });
  assert.equal(parsed.triggerPercent, 0.8);
  assert.equal(parsed.keepRecentMessages, 8);
  assert.equal(parsed.summaryModel, "kimi-k3");

  // 项目级覆盖：三个新字段都能解析。
  const override = projectSettingsSchema.parse({
    context: { compaction: { triggerPercent: 0.75, keepRecentMessages: 6, summaryModel: "deepseek-v4-flash" } }
  });
  assert.equal(override.context?.compaction?.triggerPercent, 0.75);
  assert.equal(override.context?.compaction?.keepRecentMessages, 6);
  assert.equal(override.context?.compaction?.summaryModel, "deepseek-v4-flash");
}

async function main(): Promise<void> {
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-compaction-global-"));
  const previousGlobalRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = globalRoot;
  try {
    await testTriggerPercentFiresAndHolds();
    await testActiveRunCompactsTheNextRequestCandidate();
    await testExplicitReserveBeatsTriggerPercent();
    await testKeepRecentMessagesBoundsRetainedHistory();
    await testSummaryModelInjection();
    testSchemaAndProjectOverrideParsing();
    console.log("compaction-settings tests passed");
  } finally {
    if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
    await rm(globalRoot, { recursive: true, force: true });
  }
}

await main();
