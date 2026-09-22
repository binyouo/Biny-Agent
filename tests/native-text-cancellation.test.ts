/** 辅助模型即使忽略取消，也不能拖住停止或返回迟到结果。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { generateNativeText } from "../src/llm/nativeJson.js";

let calls = 0;
let release!: () => void;
let pending = new Promise<void>((resolve) => { release = resolve; });
const model: AgentModel = {
  provider: "test", modelId: "ignores-abort",
  stream: async () => {
    calls++;
    await pending;
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: "late result" };
    })();
  }
};
const preaborted = new AbortController();
preaborted.abort();
await assert.rejects(generateNativeText(model, [], { signal: preaborted.signal }), { name: "AbortError" });
assert.equal(calls, 0);
const controller = new AbortController();
const result = generateNativeText(model, [], { signal: controller.signal });
controller.abort();
await assert.rejects(result, { name: "AbortError" });
release();
await delay(0);
pending = new Promise<void>((resolve) => { release = resolve; });
try {
  await assert.rejects(generateNativeText(model, [], { timeoutMs: 20 }), { name: "TimeoutError" });
} finally {
  release();
}
await delay(0);
console.log("native text cancellation tests passed");

test("持续输出刷新空闲期限，但总期限仍然生效", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let advance!: () => void;
  let consumed!: () => void;
  let acknowledged = new Promise<void>((resolve) => { consumed = resolve; });
  const streaming: AgentModel = {
    provider: "test", modelId: "active-stream",
    async stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        while (true) {
          const next = new Promise<void>((resolve) => { advance = resolve; });
          yield { type: "text-delta", text: "progress" };
          consumed();
          await next;
        }
      })();
    }
  };
  const result = generateNativeText(streaming, [], { idleTimeoutMs: 30, timeoutMs: 100 });
  const rejected = assert.rejects(result, { name: "TimeoutError", message: "Auxiliary model request timed out." });
  await acknowledged;
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(25);
    acknowledged = new Promise<void>((resolve) => { consumed = resolve; });
    advance();
    await acknowledged;
  }
  t.mock.timers.tick(25);
  await rejected;
  advance();
});

test("空闲期限覆盖首包等待，取消后不能重试或接收迟到输出", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const neverStarts: AgentModel = { provider: "test", modelId: "stalled", stream: async () => await new Promise(() => undefined) };
  const result = generateNativeText(neverStarts, [], { idleTimeoutMs: 30, timeoutMs: 100 });
  const rejected = assert.rejects(result, { name: "TimeoutError", message: "Auxiliary model stream stalled." });
  t.mock.timers.tick(30);
  await rejected;
});

test("真实 SDK 消费路径同样受空闲期限约束", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let close!: () => void;
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "test", modelId: "stalled-sdk", supportedUrls: {},
    doGenerate: async () => { throw new Error("streaming required"); },
    doStream: async () => ({ stream: new ReadableStream({
      start(controller) {
        close = () => controller.close();
        started();
      }
    }) })
  };
  const result = generateNativeText({ provider: "test", modelId: "stalled-sdk", vercelModel: provider }, [{ role: "user", content: "summarize" }], { idleTimeoutMs: 30 });
  const rejected = assert.rejects(result, { name: "TimeoutError" });
  await ready;
  t.mock.timers.tick(30);
  await rejected;
  close();
});
