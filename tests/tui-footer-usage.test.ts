import assert from "node:assert/strict";
import { test } from "node:test";
import { footerUsageFromBudget } from "../src/tui/components/chrome.js";
import type { ContextBudgetStatus } from "../src/agent/context/types.js";

function budget(overrides: Partial<ContextBudgetStatus> = {}): ContextBudgetStatus {
  return {
    maxTokens: 100_000,
    usedTokens: 25_000,
    omitted: [],
    autoCompacted: false,
    ...overrides
  };
}

test("footer 水位优先用模型自身的上下文窗口做分母", () => {
  const usage = footerUsageFromBudget(budget({ contextWindow: 128_000, source: "provider" }));
  assert.deepEqual(usage, {
    contextUsedTokens: 25_000,
    contextMaxTokens: 128_000,
    contextSource: "provider"
  });
});

test("没有窗口信息时退回输入预算", () => {
  const usage = footerUsageFromBudget(budget({ maxTokens: 90_000 }));
  assert.equal(usage.contextMaxTokens, 90_000);
  assert.equal(usage.contextSource, undefined);
});
