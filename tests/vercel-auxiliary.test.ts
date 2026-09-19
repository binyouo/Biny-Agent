import assert from "node:assert/strict";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentModel } from "../src/agent/core/types.js";
import { generateNativeText } from "../src/llm/nativeJson.js";

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }
};

let nativeCalls = 0;
const vercelModel = new MockLanguageModelV4({
  doStream: async () => ({
    stream: textStream("from vercel"),
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: []
  })
});

const model: AgentModel = {
  provider: "test",
  modelId: "vercel-auxiliary",
  vercelModel,
  vercelOptions: { maxOutputTokens: 64, providerOptions: { test: { mode: "auxiliary" } } },
  stream: async () => {
    nativeCalls++;
    throw new Error("unexpected native auxiliary route");
  }
};

const metrics: Array<{ provider: string; finishReason?: string }> = [];
const result = await generateNativeText(model, [{ role: "user", content: "hello" }], {
  onRequestMetrics: (value) => metrics.push({ provider: value.provider, finishReason: value.finishReason })
});

assert.equal(result.text, "from vercel");
assert.equal(result.usage?.totalTokens, 4);
assert.equal(nativeCalls, 0);
assert.deepEqual(metrics, [{ provider: "test", finishReason: "stop" }]);
assert.equal(vercelModel.doStreamCalls[0]?.maxOutputTokens, 64);
assert.deepEqual(vercelModel.doStreamCalls[0]?.providerOptions, { test: { mode: "auxiliary" } });

// 辅助请求必须走流式：只支持 SSE 的 OpenAI 兼容代理下，非流式请求会拿到
// 无法按 JSON 解析的响应体（Invalid JSON response）。
assert.equal(vercelModel.doStreamCalls.length > 0, true);
assert.equal((vercelModel.doStreamCalls[0] as { stream?: boolean } | undefined)?.stream === undefined, true);

// maxRetries 覆盖：可重试的瞬时 provider 故障在重试预算内恢复，默认值仍为 0 不重试。
let flakyAttempts = 0;
const flakyModel = new MockLanguageModelV4({
  doStream: async () => {
    flakyAttempts += 1;
    if (flakyAttempts === 1) {
      throw new APICallError({ message: "transient gateway error", url: "https://example.invalid", isRetryable: true });
    }
    return {
      stream: textStream("recovered"),
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: []
    };
  }
});
const flaky: AgentModel = {
  provider: "test",
  modelId: "flaky-auxiliary",
  vercelModel: flakyModel,
  stream: async () => {
    throw new Error("unexpected native auxiliary route");
  }
};
const recovered = await generateNativeText(flaky, [{ role: "user", content: "hello" }], { maxRetries: 2 });
assert.equal(recovered.text, "recovered");
assert.equal(flakyAttempts, 2, "第一次瞬时失败后应重试一次");

let strictAttempts = 0;
const strictModel = new MockLanguageModelV4({
  doStream: async () => {
    strictAttempts += 1;
    throw new APICallError({ message: "transient gateway error", url: "https://example.invalid", isRetryable: true });
  }
});
const strict: AgentModel = {
  provider: "test",
  modelId: "strict-auxiliary",
  vercelModel: strictModel,
  stream: async () => {
    throw new Error("unexpected native auxiliary route");
  }
};
await assert.rejects(
  generateNativeText(strict, [{ role: "user", content: "hello" }]),
  /transient gateway error/u
);
assert.equal(strictAttempts, 1, "未配置重试时应立即失败");

// 流中 error 事件不能因接管 console.error 而被吞掉，必须让消费端抛出。
const failingStreamModel = new MockLanguageModelV4({
  doStream: async () => ({
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: "partial" });
        controller.error(new Error("stream broke mid-response"));
      }
    }),
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: []
  })
});
const failingStream: AgentModel = {
  provider: "test",
  modelId: "failing-stream",
  vercelModel: failingStreamModel,
  stream: async () => {
    throw new Error("unexpected native auxiliary route");
  }
};
await assert.rejects(
  generateNativeText(failingStream, [{ role: "user", content: "hello" }]),
  /stream broke mid-response/u
);

console.log("vercel auxiliary tests passed");

function textStream(text: string): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "t" });
      controller.enqueue({ type: "text-delta", id: "t", delta: text });
      controller.enqueue({ type: "text-end", id: "t" });
      controller.enqueue({ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } });
      controller.close();
    }
  });
}
