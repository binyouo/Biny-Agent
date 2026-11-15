/** 恢复历史会话后，旧预算不能覆盖当前模型容量或让 fallback 标记继续粘住。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopSessionDocument } from "../src/desktop/protocol.js";
import { formatContextUsage, resolveContextCapacity, resolveSessionContextUsage } from "../src/desktop/renderer/src/usagePresentation.js";

for (const [contextWindow, label, max, percent] of [
  [1_000_000, "1M", "1,000,000", 52.4], [1_048_576, "1M", "1,048,576", 50],
  [1_500_000, "1.5M", "1,500,000", 35], [262_144, "262.1K", "262,144", 200]
] as const) {
  test(`容量 ${contextWindow} 使用 K/M 简写，比例与精确数值保留原始窗口`, () => {
    const display = formatContextUsage({ usedTokens: 524_288, contextWindow, source: "provider" });
    assert.equal(display?.compactMax, label);
    assert.equal(display?.max, max);
    assert.equal(display?.percent, percent);
  });
}

test("历史 32K fallback 使用当前 1M 容量，保留已用 token", () => {
  const historical = { contextWindow: 32_768, contextWindowIsFallback: true };
  const model = { contextWindow: 1_000_000, contextWindowIsFallback: false };
  const capacity = resolveContextCapacity(undefined, model, historical)!;
  const usage = formatContextUsage({ usedTokens: 4_400, contextWindow: capacity.contextWindow!, contextWindowIsFallback: capacity.contextWindowIsFallback });
  assert.equal(usage?.percent, 0.4);
  assert.equal(usage?.contextWindowIsFallback, false);
  assert.deepEqual(historical, { contextWindow: 32_768, contextWindowIsFallback: true });
});

test("当前运行时声明优先于目录，运行时估算可由当前目录补齐", () => {
  const model = { contextWindow: 1_000_000, contextWindowIsFallback: false };
  const runtime = { contextWindow: 100_000, contextWindowIsFallback: false };
  assert.equal(resolveContextCapacity(runtime, model, undefined), runtime);
  assert.equal(resolveContextCapacity({ contextWindow: 32_768, contextWindowIsFallback: true }, model, undefined), model);
});

test("缺少当前信息时才能使用历史容量，未知容量仍保留估算标记", () => {
  const historical = { contextWindow: 32_768, contextWindowIsFallback: true };
  assert.equal(resolveContextCapacity(undefined, undefined, historical), historical);
  assert.equal(resolveContextCapacity(undefined, undefined, undefined), undefined);
  const current = { contextWindow: 32_768, contextWindowIsFallback: true };
  assert.equal(resolveContextCapacity(current, undefined, { contextWindow: 1_000_000, contextWindowIsFallback: false }), current);
});

function historicalHeartbeat(): DesktopSessionDocument {
  return {
    session: {
      id: "heartbeat", projectId: "project", fileName: "heartbeat.jsonl", title: "Heartbeat",
      firstUserMessage: "", lastAssistantMessage: "", eventCount: 1, createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z", pinned: false, status: "idle"
    },
    events: [{
      type: "assistant_message", content: "Done",
      usage: { pricingKnown: false, operation: "agent", modelAlias: "free/workbuddy-ai/deepseek-v4.1-flash", provider: "openai-compatible", model: "workbuddy-ai/deepseek-v4.1-flash" },
      contextState: {
        compactedMessages: 0, promptProvider: "openai-compatible", promptModel: "workbuddy-ai/deepseek-v4.1-flash",
        budget: {
          maxTokens: 32_768, usedTokens: 34_931, estimatedTokens: 14_000, contextWindow: 32_768,
          contextWindowIsFallback: true, source: "provider", omitted: [], autoCompacted: false
        }
      }
    }],
    liveEvents: []
  };
}

const currentModel = {
  alias: "free-workbuddy-ai-deepseek-v4.1-flash", provider: "free", providerType: "openai-compatible",
  model: "workbuddy-ai/deepseek-v4.1-flash", contextWindow: 1_048_576, contextWindowIsFallback: false
};

test("历史 heartbeat 的 synthetic alias 按真实连接和型号恢复当前目录容量", () => {
  const document = historicalHeartbeat();
  const usage = resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] });
  assert.equal(usage?.contextWindow, 1_048_576);
  assert.equal(usage?.contextWindowIsFallback, false);
  assert.equal(usage?.usedTokens, 34_931);
  assert.equal(usage?.source, "provider");
  assert.equal(formatContextUsage(usage)?.percent, 3.3);
  assert.equal(document.events[0]?.type === "assistant_message" && document.events[0].contextState?.budget.contextWindow, 32_768);
});

test("另一会话的 runtime 不能覆盖历史 heartbeat 的容量或用量来源", () => {
  const usage = resolveSessionContextUsage({ sessionId: "heartbeat", document: historicalHeartbeat(), models: [currentModel],
    runtimeInfo: { sessionId: "another-session", modelAlias: "other", contextWindow: 64_000, contextWindowIsFallback: false }
  });
  assert.equal(usage?.contextWindow, 1_048_576);
  assert.equal(usage?.usedTokens, 34_931);
  assert.equal(usage?.source, "provider");
});

test("旧预算的 synthetic alias 不会借用另一连接的同名模型", () => {
  const otherGateway = { ...currentModel, alias: "paid-flash", provider: "paid", contextWindow: 128_000 };
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document: historicalHeartbeat(), models: [otherGateway, currentModel] })?.contextWindow, 1_048_576);
  const unresolved = resolveSessionContextUsage({ sessionId: "heartbeat", document: historicalHeartbeat(), models: [otherGateway] });
  assert.equal(unresolved?.contextWindow, 32_768);
  assert.equal(unresolved?.contextWindowIsFallback, true);
});

test("历史 usage 的精确模型别名同样需要与请求型号一致", () => {
  const document = historicalHeartbeat();
  const event = document.events[0];
  assert.ok(event?.type === "assistant_message" && event.usage);
  event.usage.modelAlias = currentModel.alias;
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.contextWindow, 1_048_576);
  const reassigned = { ...currentModel, model: "a-different-model" };
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [reassigned] })?.contextWindow, 32_768);
});

for (const conflict of ["usage model", "usage provider", "missing usage", "missing prompt", "ambiguous aliases"] as const) {
  test(`历史请求身份不可靠时保留估算容量：${conflict}`, () => {
    const document = historicalHeartbeat();
    const event = document.events[0];
    assert.ok(event?.type === "assistant_message" && event.usage && event.contextState);
    const models = [currentModel];
    if (conflict === "usage model") event.usage.model = "old-model";
    else if (conflict === "usage provider") event.usage.provider = "anthropic";
    else if (conflict === "missing usage") event.usage = undefined;
    else if (conflict === "missing prompt") event.contextState.promptModel = undefined;
    else models.push({ ...currentModel, alias: "another-configured-alias" });
    const usage = resolveSessionContextUsage({ sessionId: "heartbeat", document, models });
    assert.equal(usage?.contextWindow, 32_768);
    assert.equal(usage?.contextWindowIsFallback, true);
    assert.equal(usage?.usedTokens, 34_931);
  });
}

test("最新无 usage 的上下文不借用更早 assistant 或 live 预算的模型身份", () => {
  const document = historicalHeartbeat();
  const event = document.events[0];
  assert.ok(event?.type === "assistant_message" && event.contextState);
  document.events.push({ type: "assistant_message", content: "", contextState: structuredClone(event.contextState) });
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.contextWindow, 32_768);
  document.events.pop();
  const liveBudget = { ...event.contextState.budget, usedTokens: 12_345 };
  const live = resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel], liveBudget });
  assert.equal(live?.contextWindow, 32_768);
  assert.equal(live?.usedTokens, 12_345);
});

test("新预算的明确 alias 与当前运行时仍按同模型保留 provider 用量", () => {
  const liveBudget = {
    maxTokens: 32_768, usedTokens: 23_456, estimatedTokens: 10_000, contextWindow: 32_768,
    contextWindowIsFallback: true, modelAlias: currentModel.alias, source: "provider" as const, omitted: [], autoCompacted: false
  };
  const runtimeInfo = { sessionId: "heartbeat", modelAlias: currentModel.alias, contextWindow: 32_768, contextWindowIsFallback: true };
  const usage = resolveSessionContextUsage({ sessionId: "heartbeat", models: [currentModel], runtimeInfo, liveBudget });
  assert.equal(usage?.contextWindow, 1_048_576);
  assert.equal(usage?.usedTokens, 23_456);
  assert.equal(usage?.source, "provider");
});

test("当前会话已换模型时沿用旧输入估算，不将旧 provider 用量当成新模型实测", () => {
  const usage = resolveSessionContextUsage({ sessionId: "heartbeat", document: historicalHeartbeat(), models: [currentModel],
    runtimeInfo: { sessionId: "heartbeat", modelAlias: "other", contextWindow: 64_000, contextWindowIsFallback: false }
  });
  assert.equal(usage?.contextWindow, 64_000);
  assert.equal(usage?.usedTokens, 14_000);
  assert.equal(usage?.source, "estimated");
});

test("切换会话期间旧文档不能为新会话提供容量或用量", () => {
  const usage = resolveSessionContextUsage({ sessionId: "new-session", document: historicalHeartbeat(), models: [currentModel] });
  assert.equal(usage, undefined);
});

test("旧模型身份无法恢复时，不能将其 provider 用量归给当前新模型", () => {
  const usage = resolveSessionContextUsage({ sessionId: "heartbeat", document: historicalHeartbeat(), models: [],
    runtimeInfo: { sessionId: "heartbeat", modelAlias: "new-model", contextWindow: 64_000, contextWindowIsFallback: false }
  });
  assert.equal(usage?.usedTokens, 14_000);
  assert.equal(usage?.source, "estimated");
  assert.equal(usage?.contextWindow, 64_000);
});

test("仅有历史 usage 时保留实测来源，但不能借给另一个模型", () => {
  const document = historicalHeartbeat();
  const event = document.events[0];
  assert.ok(event?.type === "assistant_message" && event.usage);
  event.contextState = undefined;
  event.usage.inputTokens = 34_931;
  const original = resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] });
  assert.equal(original?.usedTokens, 34_931);
  assert.equal(original?.source, "provider");
  assert.equal(formatContextUsage(original)?.estimated, false);
  const switched = resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel],
    runtimeInfo: { sessionId: "heartbeat", modelAlias: "other", contextWindow: 64_000, contextWindowIsFallback: false }
  });
  assert.equal(switched, undefined, "没有新模型估算时保持未知，不能用零冒充空上下文");
});

test("最新模型缺少 input usage 时，不使用更早另一模型的输入量", () => {
  const document = historicalHeartbeat();
  const previous = document.events[0];
  assert.ok(previous?.type === "assistant_message" && previous.usage);
  previous.contextState = undefined;
  previous.usage.inputTokens = 34_931;
  document.events.push({ type: "assistant_message", content: "New model reply", usage: {
    pricingKnown: false, operation: "agent", modelAlias: "new-model", provider: "openai-compatible", model: "different-model"
  } });
  const newModel = { ...currentModel, alias: "new-model", model: "different-model", contextWindow: 64_000 };
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel, newModel],
    runtimeInfo: { sessionId: "heartbeat", modelAlias: newModel.alias, contextWindow: 64_000, contextWindowIsFallback: false }
  }), undefined);
});

test("全新会话没有任何用量采样时仍展示容量和零输入", () => {
  const document = historicalHeartbeat();
  document.events = [];
  const usage = resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel],
    runtimeInfo: { sessionId: "heartbeat", modelAlias: currentModel.alias, contextWindow: 1_048_576, contextWindowIsFallback: false }
  });
  assert.equal(usage?.usedTokens, 0);
  assert.equal(usage?.contextWindow, 1_048_576);
});

for (const tokensAfter of [2_000, undefined]) {
  test(`checkpoint 已落盘但后续预算未写入时，不重用压缩前实测：${tokensAfter ?? "未知"}`, () => {
    const document = historicalHeartbeat();
    document.events.push({ type: "context_checkpoint", reason: "manual", summary: "Summary", firstKeptMessageIndex: 2,
      tokensBefore: 34_931, tokensAfter, compactedMessages: 2, createdAt: "2026-11-02T00:00:00Z"
    });
    const usage = resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] });
    if (tokensAfter === undefined) assert.equal(usage, undefined);
    else {
      assert.equal(usage?.usedTokens, 2_000);
      assert.equal(usage?.source, "estimated");
      assert.equal(usage?.breakdown, undefined);
    }
    const budget = { maxTokens: 900_000, usedTokens: 12_000, contextWindow: 1_048_576, contextWindowIsFallback: false,
      modelAlias: currentModel.alias, source: "provider" as const, omitted: [], autoCompacted: false };
    document.events.push({ type: "assistant_message", content: "New reply", contextState: { compactedMessages: 2, budget } });
    assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.usedTokens, 12_000);
  });
}


test("未知容量不生成窗口占比，输入分类以实际输入总量为分母", () => {
  const display = formatContextUsage({
    usedTokens: 48_538, contextWindow: 32_768, contextWindowIsFallback: true, source: "provider",
    breakdown: { messages: 3, mcpTools: 0, systemTools: 1, skills: 0, systemPrompt: 0, other: 0 }
  });
  assert.equal(display?.percent, undefined);
  assert.equal(display?.fillPercent, undefined);
  assert.equal(display?.compactUsed, "48.5K");
  assert.deepEqual(display?.categories.map(category => category.percent), ["75.0", "0.0", "25.0", "0.0", "0.0", "0.0"]);
  assert.deepEqual(display?.categories.map(category => category.width), [75, 0, 25, 0, 0, 0]);
});

test("context usage reads only the tail containing the latest persisted budget", () => {
  const document = historicalHeartbeat();
  const latest = document.events[0]!;
  const history: DesktopSessionDocument["events"] = Array.from({ length: 10_000 }, () => ({ type: "user_message", content: "old" }));
  history.push(latest);
  let reads = 0;
  document.events = new Proxy(history, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    }
  });
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.usedTokens, 34_931);
  assert.ok(reads <= 2, `latest budget required ${reads} event-index reads`);
  history.push({ type: "context_checkpoint", reason: "manual", summary: "Summary", firstKeptMessageIndex: 2,
    tokensBefore: 34_931, tokensAfter: 100, compactedMessages: 2, createdAt: "2026-11-02T00:00:00Z" });
  reads = 0;
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.usedTokens, 100);
  assert.ok(reads <= 3, `new checkpoint required ${reads} event-index reads`);
  // The same mutable events array must observe a subsequently appended budget.
  history.push(latest);
  reads = 0;
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.usedTokens, 34_931);
  assert.ok(reads <= 2, `appended budget required ${reads} event-index reads`);
});

test("tail scan ignores audit budgets and prefers persisted state over a newer unbudgeted reply", () => {
  const document = historicalHeartbeat();
  const prior = document.events[0]!;
  document.events.push({ type: "assistant_message", content: "later", usage: { operation: "agent", modelAlias: currentModel.alias, provider: currentModel.providerType, model: currentModel.model, pricingKnown: false, inputTokens: 999 } });
  assert.ok(prior.type === "assistant_message" && prior.contextState);
  document.events.push({ ...prior, auditOnly: true, contextState: { ...prior.contextState, budget: { ...prior.contextState.budget, usedTokens: 888 } } });
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.usedTokens, 34_931);
});

test("tail scan preserves newest checkpoint without searching past a newer user budget", () => {
  const document = historicalHeartbeat();
  const checkpoint = { type: "context_checkpoint" as const, reason: "manual" as const, summary: "Summary", firstKeptMessageIndex: 2,
    tokensBefore: 34_931, tokensAfter: 100, compactedMessages: 2, createdAt: "2026-11-02T00:00:00Z" };
  document.events.push(checkpoint, { ...checkpoint, tokensAfter: 200 });
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.usedTokens, 200);
  document.events.push({ type: "user_message", content: "new", contextState: { compactedMessages: 2,
    budget: { maxTokens: 900_000, usedTokens: 300, modelAlias: currentModel.alias, contextWindow: 1_048_576, source: "provider", omitted: [], autoCompacted: false }
  } });
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.usedTokens, 300);
});

test("usage fallback with no persisted budget scans each event at most once", () => {
  const document = historicalHeartbeat();
  const reply = document.events[0]!;
  assert.ok(reply.type === "assistant_message" && reply.usage);
  reply.contextState = undefined;
  reply.usage = { ...reply.usage, inputTokens: 1234 };
  const history: DesktopSessionDocument["events"] = [reply, ...Array.from({ length: 1000 }, (): DesktopSessionDocument["events"][number] => ({ type: "user_message", content: "unbudgeted" }))];
  let reads = 0;
  document.events = new Proxy(history, { get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/u.test(property)) reads++;
    return Reflect.get(target, property, receiver);
  } });
  assert.equal(resolveSessionContextUsage({ sessionId: "heartbeat", document, models: [currentModel] })?.usedTokens, 1234);
  assert.equal(reads, history.length);
  assert.equal(history[0], reply);
});
