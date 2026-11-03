/** 恢复历史会话后，旧预算不能覆盖当前模型容量或让 fallback 标记继续粘住。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopSessionDocument } from "../src/desktop/protocol.js";
import { formatContextUsage, resolveContextCapacity, resolveSessionContextUsage } from "../src/desktop/renderer/src/usagePresentation.js";

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
      usage: { operation: "agent", modelAlias: "free/workbuddy-ai/deepseek-v4.1-flash", provider: "openai-compatible", model: "workbuddy-ai/deepseek-v4.1-flash" },
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
