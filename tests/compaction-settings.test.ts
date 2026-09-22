// 压缩自定义额度回归：triggerPercent 触发、条数保留、reserve 优先级、摘要模型注入与项目级覆盖解析。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentModel, AgentStopReason, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { ContextMemory, type ContextCompactionOptions } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { compactionSchema } from "../src/config/schema.js";
import { projectSettingsSchema } from "../src/config/projectSettings.js";
import { estimateTokens, estimateMessageTokens } from "../src/agent/context/tokenUsage.js";
import { parseSessionEvents } from "../src/session/events.js";

function citeCheckpoint(summary: string, source = "m0"): string {
  return summary.split("\n").map((line) => {
    const item = line.replace(/^(?:[-*]|\d+\.)\s+/u, "").replace(/^\[[ xX]\]\s*/u, "").trim();
    if (!/^(?:[-*]|\d+\.)\s+/u.test(line) || /^\((?:none|not recorded|none verified|unknown)\b/iu.test(item)) return line;
    return `${line} <!-- evidence:${source} -->`;
  }).join("\n");
}

const checkpointSummary = [
  "## Goal",
  "- 测试压缩。",
  "## Constraints & Preferences",
  "- 保留已验证事实。",
  "## Progress",
  "### Done",
  "- (none verified)",
  "### In Progress",
  "- [ ] 继续当前任务。",
  "### Blocked",
  "- (unknown)",
  "## Key Decisions",
  "- (none recorded)",
  "## Errors & Fixes",
  "- (none recorded)",
  "## All User Messages",
  "- 继续",
  "## Next Steps",
  "1. 继续当前任务。",
  "## Critical Context",
  "- (none recorded)"
].join("\n");

class RecordingModel {
  readonly requests: AgentMessage[][] = [];
  readonly systemPrompts: Array<string | undefined> = [];
  readonly outputLimits: Array<number | undefined> = [];

  constructor(
    private readonly response = citeCheckpoint(checkpointSummary),
    private readonly failure?: Error,
    private readonly finishReason: AgentStopReason | null = "stop"
  ) {}

  readonly model: AgentModel = {
    provider: "compaction-test",
    modelId: "compaction-test",
    stream: async (context: ModelStreamContext, options): Promise<AsyncIterable<ModelStreamEvent>> => {
      this.requests.push(context.messages);
      this.systemPrompts.push(context.systemPrompt);
      this.outputLimits.push(options?.maxOutputTokens);
      if (this.failure) throw this.failure;
      return (async function* (): AsyncIterable<ModelStreamEvent> {
        options?.signal?.throwIfAborted();
        yield { type: "start" as const };
        yield { type: "text-delta" as const, text: this.response };
        if (this.finishReason !== null) yield { type: "finish" as const, reason: this.finishReason, usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1 } };
      }).call(this);
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
    // 历史低于 2000 token，但足够容纳带来源元数据的 checkpoint，只有 reserve 优先才触发。
    const memory = makeMemory(workspaceRoot, new RecordingModel(), { triggerPercent: 0.5, reserveTokens: 3_900, keepRecentTokens: 100 });
    memory.replaceHistory([userMessage(5_500), userMessage(10)]);
    assert.ok(await autoCompactedCount(memory) > 0);

    const small = makeMemory(workspaceRoot, new RecordingModel(), { reserveTokens: 3_900, keepRecentTokens: 100 });
    small.replaceHistory([userMessage(1_200), userMessage(10)]);
    assert.equal(await autoCompactedCount(small), 0, "正文缩短但含引用的完整 checkpoint 更大时，不能算压缩成功");
    assert.equal(small.snapshot().compactionFailure?.kind, "no_savings");
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
    const injected = makeMemory(workspaceRoot, main, {
      keepRecentTokens: 100, resolveSummaryModel: () => summarizer.model,
      resolveSummaryBudget: () => ({ contextWindow: 8_000, contextWindowIsFallback: false, maxInputTokens: 7_000, maxOutputTokens: 1_000 })
    });
    injected.replaceHistory([userMessage(3_000), userMessage(3_000)]);
    await injected.compact();
    assert.equal(summarizer.requests.length, 1);
    assert.equal(main.requests.length, 0);
    const unknownCapacity = makeMemory(workspaceRoot, main, { keepRecentTokens: 100, resolveSummaryModel: () => summarizer.model });
    unknownCapacity.replaceHistory([userMessage(3_000)]);
    await assert.rejects(unknownCapacity.compact(), /input_budget/u, "独立模型缺少容量时不能套用主模型窗口");

    // 缺省回退当前对话模型。
    const fallback = new RecordingModel();
    const plain = makeMemory(workspaceRoot, fallback, { keepRecentTokens: 100 });
    plain.replaceHistory([userMessage(3_000), userMessage(3_000)]);
    await plain.compact();
    assert.equal(fallback.requests.length, 1);
  });
}

async function testSummaryAuthorityAndFailurePolicy(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new RecordingModel();
    const memory = makeMemory(workspaceRoot, provider, { keepRecentTokens: 100 });
    memory.replaceHistory([userMessage(3_000), userMessage(3_000)]);
    assert.equal((await memory.compact()).compacted, true);
    assert.match(provider.systemPrompts.at(-1) ?? "", /durable context checkpoint/u);
    assert.doesNotMatch(String(provider.requests.at(-1)?.at(-1)?.content ?? ""), /You create a durable context checkpoint/u);

    const failing = makeMemory(
      workspaceRoot,
      new RecordingModel(undefined, new Error("401 invalid api key")),
      { triggerPercent: 0.5, keepRecentTokens: 100 }
    );
    failing.replaceHistory([userMessage(8_000), userMessage(8_000)]);
    const automatic = await failing.prepareTurn("继续", "system");
    assert.equal(automatic.compaction, undefined, "普通摘要失败不能写入有损 checkpoint");
    assert.equal(failing.getHistory().length, 2);

    const uncited = makeMemory(workspaceRoot, new RecordingModel(checkpointSummary), { triggerPercent: 0.5, keepRecentTokens: 100 });
    uncited.replaceHistory([userMessage(8_000), userMessage(8_000)]);
    assert.equal((await uncited.prepareTurn("继续", "system")).compaction, undefined, "缺少逐条来源的摘要不能成为 checkpoint");
    assert.equal(uncited.getHistory().length, 2);

    const fabricated = makeMemory(workspaceRoot, new RecordingModel(citeCheckpoint(checkpointSummary, "m999")), { triggerPercent: 0.5, keepRecentTokens: 100 });
    fabricated.replaceHistory([userMessage(8_000), userMessage(8_000)]);
    assert.equal((await fabricated.prepareTurn("继续", "system")).compaction, undefined, "引用不存在 source ID 的摘要不能成为 checkpoint");
    assert.equal(fabricated.getHistory().length, 2);

    const overflow = await failing.compactRunContext([
      { role: "user", content: `完成修复并验证 ${"旧上下文 ".repeat(800)}` },
      { role: "assistant", content: [{ type: "text", text: `我准备开始检查 ${"过程 ".repeat(800)}` }] },
      { role: "user", content: "继续" },
      { role: "assistant", content: [{ type: "text", text: "仍在检查" }] }
    ]);
    assert.ok(overflow);
    assert.doesNotMatch(overflow.summary, /\[x\].*仍在检查/u);
    assert.match(overflow.summary, /No completion was inferred/u);
  });
}

async function testEvidenceIsBoundPerStateItem(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const response = citeCheckpoint(checkpointSummary)
      .replace("- (none verified)", "- [x] 工具验证完成。 <!-- evidence:m2.result -->")
      .replaceAll("<!-- evidence:m0 --> <!-- evidence:m2.result -->", "<!-- evidence:m2.result -->");
    const memory = makeMemory(workspaceRoot, new RecordingModel(response), { keepRecentTokens: 1 });
    memory.replaceHistory([
      { role: "user", content: "执行检查" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "Read", arguments: { path: "src/a.ts" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "Read", content: [{ type: "text", text: "检查通过" }] },
      { role: "user", content: "继续后续任务" }
    ]);
    const compacted = await memory.compact();
    assert.equal(compacted.compacted, true);
    const goal = compacted.checkpoint?.evidence.find((claim) => claim.field === "goal" && claim.itemIndex === 0);
    const done = compacted.checkpoint?.evidence.find((claim) => claim.field === "done" && claim.itemIndex === 0);
    assert.deepEqual(goal?.references.map((item) => item.kind), ["message"]);
    assert.deepEqual(done?.references.map((item) => item.kind), ["tool_result"]);
    assert.equal(goal?.references[0]?.relativeMessageIndex, 0);
    assert.equal(done?.references[0]?.relativeMessageIndex, 2);
  });
}

async function testProjectedRequestControlsActiveCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new RecordingModel();
    const memory = makeMemory(workspaceRoot, provider, { triggerPercent: 0.8, keepRecentTokens: 100 });
    const raw = {
      systemPrompt: "system",
      tools: [],
      messages: [userMessage(12_000), { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] }]
    };
    const projected = {
      ...raw,
      messages: [{ role: "user" as const, content: "small projected request" }]
    };
    assert.equal(await memory.compactRunContextIfNeeded(raw, undefined, projected), undefined);
    assert.equal(provider.requests.length, 0, "投影后低于水位时不能摘要原始历史");
  });
}

async function testRequestAnchorAndPersistentFailure(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    // Given 相同 wire 候选由 provider 确认远小于本地估算，When 追加少量消息并恢复，Then 不误压缩。
    const provider = new RecordingModel();
    const options = { triggerPercent: 0.8, keepRecentTokens: 100 };
    const memory = makeMemory(workspaceRoot, provider, options);
    const checkpoint = { summary: checkpointSummary, firstKeptMessageIndex: 1, tokensBefore: 5_000, compactedMessages: 1, createdAt: "2026-09-21T00:00:00.000Z" };
    memory.setCheckpoint(checkpoint);
    const context = { systemPrompt: "system", tools: [], messages: [userMessage(12_000)] };
    memory.recordRequest({ ...context, toolSources: new Map() });
    memory.recordProviderUsage({ inputTokens: 200 });
    const restored = makeMemory(workspaceRoot, provider, options);
    restored.restore(context.messages, memory.snapshot());
    restored.setCheckpoint(checkpoint);
    assert.deepEqual(restored.snapshot().usageAnchor, memory.snapshot().usageAnchor, "真实 resume 重设相同 checkpoint 后仍须保留压缩后的 usage");
    assert.equal(restored.shouldCompactRunContext({ ...context, messages: [...context.messages, userMessage(20)] }), false);
    assert.equal(restored.shouldCompactRunContext({ ...context, systemPrompt: "different" }), true, "system 变化必须废弃 usage anchor");
    assert.equal(restored.shouldCompactRunContext({ ...context, messages: [userMessage(12_001)] }), true, "编辑已有消息必须废弃 anchor");
    const prepared = await restored.prepareTurn("continue", "system", undefined, [], false);
    assert.equal(prepared.compaction, undefined, "完整工具尚未装配时应延迟到最终候选判断");
    assert.ok(prepared.messages.some((message) => message.content === context.messages[0]!.content), "不能在 usage 校验前提前丢弃历史");
    const changedProvider = makeMemory(workspaceRoot, provider, { ...options, configurationIdentity: () => "new-endpoint" });
    changedProvider.restore(context.messages, memory.snapshot());
    assert.equal(changedProvider.shouldCompactRunContext(context), true);
    restored.recordRequest({ ...context, toolSources: new Map() });
    restored.recordProviderUsage({});
    assert.equal(restored.shouldCompactRunContext(context), true, "无 usage 响应不能复用前一次实测");

    // Given 无效 evidence 导致自动压缩失败，When 重启，Then 同一输入冷却且历史原样保留。
    let now = 1_000;
    const bad = makeMemory(workspaceRoot, new RecordingModel(checkpointSummary), { ...options, now: () => now });
    const busy = { ...context, messages: [userMessage(12_000), userMessage(12_000)] };
    assert.equal(await bad.compactRunContextIfNeeded(busy), undefined);
    assert.equal(bad.snapshot().compactionFailure?.kind, "invalid_evidence");
    assert.equal(bad.snapshot().compactionFailure?.retryAfter, 61_000);
    const forced = makeMemory(workspaceRoot, provider, { ...options, now: () => now });
    forced.restore(busy.messages, bad.snapshot());
    assert.equal((await forced.compact()).compacted, true, "手动压缩绕过冷却");
    const overflow = makeMemory(workspaceRoot, provider, { ...options, now: () => now });
    overflow.restore(busy.messages, bad.snapshot());
    assert.ok(await overflow.compactRunContext(busy.messages), "provider overflow 仍允许恢复");
    const good = makeMemory(workspaceRoot, provider, { ...options, now: () => now });
    good.restore(busy.messages, bad.snapshot());
    assert.equal(await good.compactRunContextIfNeeded(busy), undefined);
    assert.deepEqual(good.getHistory(), busy.messages);
    now = 61_001;
    assert.ok(await good.compactRunContextIfNeeded(busy), "到期后应能恢复压缩");
    assert.equal(good.snapshot().compactionFailure, undefined);

    const recoveringProvider = new RecordingModel();
    const originalStream = recoveringProvider.model.stream!;
    recoveringProvider.model.stream = async (context, streamOptions) => {
      const stream = await originalStream(context, streamOptions);
      const truncatedAttempt = recoveringProvider.requests.length === 1;
      return (async function* () {
        for await (const event of stream) yield event.type === "finish" && truncatedAttempt ? { ...event, reason: "length" as const } : event;
      })();
    };
    const recovered = makeMemory(workspaceRoot, recoveringProvider, options);
    recovered.replaceHistory(busy.messages);
    assert.equal((await recovered.compact()).compacted, true, "截断后用同一材料重写更短摘要，而不是接受半截结果");
    assert.match(recoveringProvider.systemPrompts[1] ?? "", /shorter/iu);
    const truncatedProvider = new RecordingModel(citeCheckpoint(checkpointSummary), undefined, "length");
    const truncated = makeMemory(workspaceRoot, truncatedProvider, options);
    truncated.replaceHistory(busy.messages);
    await assert.rejects(truncated.compact(), /output_truncated/u);
    assert.deepEqual(truncated.getHistory(), busy.messages, "结构碰巧完整也不能接受被输出上限截断的摘要");
    assert.equal(truncated.snapshot().compactionFailure?.kind, "output_truncated");
    assert.equal(truncatedProvider.requests.length, 2, "截断修复最多一次，不能无限重试");
    const invalid = makeMemory(workspaceRoot, new RecordingModel("missing headings"), options);
    invalid.replaceHistory(busy.messages);
    await assert.rejects(invalid.compact(), /invalid_structure/u);
    const cancelled = makeMemory(workspaceRoot, provider, options);
    cancelled.replaceHistory(busy.messages);
    await assert.rejects(cancelled.compact(undefined, AbortSignal.abort()));
    assert.equal(cancelled.snapshot().compactionFailure, undefined, "取消不记作摘要故障");
  });
}

async function testSummaryProtocolAndVisibleSources(): Promise<void> {
  await withTempWorkspace(async (root) => {
    const emptyResponse = checkpointSummary.split("\n").filter((line) => line.startsWith("#")).join("\n");
    const empty = makeMemory(root, new RecordingModel(emptyResponse), { keepRecentTokens: 1 });
    const emptyHistory = [userMessage(12_000), userMessage(12_000)];
    empty.replaceHistory(emptyHistory);
    await assert.rejects(empty.compact(), /empty_checkpoint/u);
    assert.deepEqual(empty.getHistory(), emptyHistory);
    assert.equal(empty.snapshot().promptEpoch, 0);
    assert.equal(await empty.compactRunContextIfNeeded({ systemPrompt: "system", tools: [], messages: emptyHistory }), undefined);
    assert.deepEqual(empty.getHistory(), emptyHistory);
    const valid = empty.snapshot();
    for (const broken of [
      { ...valid, usageAnchor: { fixedFingerprint: "a".repeat(64), messageFingerprints: "not-an-array", inputTokens: 2, measuredAt: new Date().toISOString() } },
      { ...valid, compactionFailure: { inputFingerprint: "b".repeat(64), kind: "provider_error", failedAt: 100, retryAfter: 50 } },
      { ...valid, budget: { ...valid.budget, omitted: "not-an-array" } },
      { ...valid, budget: { ...valid.budget, usedTokens: -1 } }
    ]) {
      assert.throws(() => parseSessionEvents(JSON.stringify({ type: "assistant_message", content: "", contextState: broken })), /Invalid session event/u);
      assert.throws(() => empty.restore([], broken as unknown as typeof valid));
      assert.deepEqual(empty.getHistory(), emptyHistory, "恢复输入失败时不能先清空当前历史");
    }
    for (const reason of [null, "error", "tool-calls", "aborted", "other"] as const) {
      const memory = makeMemory(root, new RecordingModel(citeCheckpoint(checkpointSummary), undefined, reason), { keepRecentTokens: 1 });
      const history = [userMessage(12_000), userMessage(12_000)];
      memory.replaceHistory(history);
      await assert.rejects(memory.compact(), /incomplete_response/u, "没有正常结束事件的正文不能被接受");
      assert.deepEqual(memory.getHistory(), history);
    }
    // Given 中间消息未进入有界摘要输入，When 输出猜中它的真实 ID，Then 引用仍须拒绝。
    const provider = new RecordingModel(citeCheckpoint(checkpointSummary, "m10"));
    const memory = makeMemory(root, provider, { keepRecentTokens: 1 });
    memory.replaceHistory(Array.from({ length: 21 }, () => userMessage(10_000)));
    await assert.rejects(memory.compact(), /invalid_evidence/u);
    assert.doesNotMatch(JSON.stringify(provider.requests), /\[source m10 /u);

    // 主模型窗口很大，摘要模型只有 4K；输入、输出与协议预留之和不能越过摘要窗口。
    const boundedProvider = new RecordingModel();
    const bounded = makeMemory(root, boundedProvider, {
      keepRecentTokens: 1,
      resolveSummaryBudget: () => ({ contextWindow: 4_000, contextWindowIsFallback: false, maxInputTokens: 3_500, maxOutputTokens: 700, protocolSafetyMarginTokens: 100 })
    }, 100_000);
    bounded.replaceHistory(Array.from({ length: 21 }, () => userMessage(10_000)));
    assert.equal((await bounded.compact()).compacted, true);
    const inputTokens = estimateTokens(boundedProvider.systemPrompts.at(-1) ?? "") + estimateMessageTokens(boundedProvider.requests.at(-1)!);
    assert.equal(boundedProvider.outputLimits.at(-1), 700);
    assert.ok(inputTokens + 700 + 100 <= 4_000);
    assert.equal(bounded.getBudget().usedTokens, estimateMessageTokens(bounded.projectCompactionCheckpoint(bounded.getHistory())), "刷新水位与完整 checkpoint 投影使用同一口径");

    bounded.replaceHistory([userMessage(5_000)]);
    const original = bounded.getHistory();
    await assert.rejects(bounded.compact("fixed context ".repeat(5_000)), /input_budget/u);
    assert.deepEqual(bounded.getHistory(), original);
    assert.equal((await bounded.status()).compaction.lastFailure?.kind, "input_budget");
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
    await testSummaryAuthorityAndFailurePolicy();
    await testEvidenceIsBoundPerStateItem();
    await testProjectedRequestControlsActiveCompaction();
    await testRequestAnchorAndPersistentFailure();
    await testSummaryProtocolAndVisibleSources();
    testSchemaAndProjectOverrideParsing();
    console.log("compaction-settings tests passed");
  } finally {
    if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
    await rm(globalRoot, { recursive: true, force: true });
  }
}

await main();
