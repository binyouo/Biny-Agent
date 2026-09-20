/** Prompt 缓存标记：协议路由、instructions 包装与尾部断言点都按请求形状稳定。 */
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { applyCacheMarkers, cacheMarkerPlanFor, markInstructions } from "../src/agent/core/cacheMarkers.js";

function testProtocolRouting(): void {
  assert.deepEqual(cacheMarkerPlanFor("anthropic_messages"), { protocol: "anthropic" });
  assert.deepEqual(cacheMarkerPlanFor("openai_completions"), { protocol: "openai-compatible" });
  assert.deepEqual(cacheMarkerPlanFor("custom-wire"), { protocol: "openai-compatible" });
  assert.equal(cacheMarkerPlanFor("responses"), undefined);
  assert.equal(cacheMarkerPlanFor("google_generative_ai"), undefined);
}

function testMarkInstructions(): void {
  assert.equal(markInstructions("You are Biny.", undefined), "You are Biny.");
  assert.equal(markInstructions(undefined, { protocol: "anthropic" }), undefined);
  const marked = markInstructions("You are Biny.", { protocol: "anthropic" });
  assert.equal(Array.isArray(marked), true);
  if (Array.isArray(marked)) {
    assert.equal(marked[0]?.providerOptions?.anthropic?.cacheControl?.type, "ephemeral");
    assert.equal(marked[0]?.content, "You are Biny.");
  }
}

function testOpenAICompatibleTail(): void {
  const messages: ModelMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: "second" }
  ];
  const marked = applyCacheMarkers(messages, { protocol: "openai-compatible" });
  assert.equal(marked.length, 3);
  assert.equal(marked[0]?.providerOptions, undefined);
  assert.equal(marked[1]?.providerOptions?.openaiCompatible?.cache_control?.type, "ephemeral");
  assert.equal(marked[2]?.providerOptions?.openaiCompatible?.cache_control?.type, "ephemeral");
  // canonical 消息不能被改写
  assert.equal(messages[1]?.providerOptions, undefined);
}

function testAnthropicTail(): void {
  const messages: ModelMessage[] = [
    { role: "user", content: "question" },
    { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "reply" }] },
    { role: "user", content: "follow-up" }
  ];
  const marked = applyCacheMarkers(messages, { protocol: "anthropic" });
  // 断言点在倒数第二条（assistant）的最后一个稳定块，思考分块被跳过；末条消息不打标
  const assistant = marked[1];
  assert.ok(Array.isArray(assistant?.content));
  if (Array.isArray(assistant?.content)) {
    const textPart = assistant.content[1];
    assert.equal((textPart as { providerOptions?: { anthropic?: { cacheControl?: { type?: string } } } }).providerOptions?.anthropic?.cacheControl?.type, "ephemeral");
    const reasoningPart = assistant.content[0];
    assert.equal((reasoningPart as { providerOptions?: unknown }).providerOptions, undefined);
  }
  assert.equal(marked[2]?.providerOptions, undefined);
  assert.equal(messages[1]?.providerOptions, undefined);
}

function testAnthropicStringContent(): void {
  const messages: ModelMessage[] = [
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "text", text: "answer" }] }
  ];
  const marked = applyCacheMarkers(messages, { protocol: "anthropic" });
  // 字符串内容（user 消息）转为单 text part 携带断言点
  const user = marked[0];
  assert.ok(Array.isArray(user?.content));
  if (Array.isArray(user?.content)) {
    assert.equal((user.content[0] as { providerOptions?: { anthropic?: { cacheControl?: { type?: string } } } }).providerOptions?.anthropic?.cacheControl?.type, "ephemeral");
  }
  // 最后一条消息不打标；单条消息无需标记
  assert.equal(marked[1]?.providerOptions, undefined);
  assert.equal(applyCacheMarkers([{ role: "user", content: "only" }], { protocol: "anthropic" }).length, 1);
}

function testNoPlanPassthrough(): void {
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
  assert.equal(applyCacheMarkers(messages, undefined), messages);
}

testProtocolRouting();
testMarkInstructions();
testOpenAICompatibleTail();
testAnthropicTail();
testAnthropicStringContent();
testNoPlanPassthrough();
console.log("cache marker tests passed");
