import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { resolveToolModelCandidates, type ToolModelCandidate } from "../src/llm/toolModel.js";
import { generateToolModelText, toolModelFailureScope, ToolModelCandidatesExhaustedError } from "../src/llm/toolModelRequest.js";

function candidate(id: string, domain: string, operation: () => Promise<string>): ToolModelCandidate {
  const model: AgentModel = {
    provider: "test", providerAlias: `${id}-connection`, modelId: id,
    async stream() {
      const text = await operation();
      return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text }; })();
    }
  };
  return { model, failureDomain: domain };
}

function failure(statusCode: number, message = "request rejected", data?: unknown): Error {
  return Object.assign(new Error(message), { statusCode, data });
}

test("余额不足跳过共享连接，记录实际成功模型与有界尝试元数据", async () => {
  const calls: string[] = [];
  const models = [
    candidate("empty", "same-account", async () => { calls.push("empty"); throw failure(402, "Insufficient Balance"); }),
    candidate("same", "same-account", async () => { calls.push("same"); return "wrong"; }),
    candidate("funded", "other-account", async () => { calls.push("funded"); return "selected"; })
  ];
  const result = await generateToolModelText(models, [{ role: "user", content: "select" }]);
  assert.equal(result.text, "selected");
  assert.equal(result.model.modelId, "funded");
  assert.deepEqual(calls, ["empty", "funded"]);
  assert.deepEqual(result.attempts, [
    { provider: "test", providerAlias: "empty-connection", modelId: "empty", status: "failed" },
    { provider: "test", providerAlias: "funded-connection", modelId: "funded", status: "completed" }
  ]);
});

test("401 鉴权失败跳过相同凭据连接", async () => {
  const calls: string[] = [];
  const result = await generateToolModelText([
    candidate("unauthorized", "shared", async () => { calls.push("unauthorized"); throw failure(401); }),
    candidate("same", "shared", async () => { calls.push("same"); return "wrong"; }),
    candidate("valid", "valid", async () => { calls.push("valid"); return "ok"; })
  ], []);
  assert.equal(result.text, "ok");
  assert.deepEqual(calls, ["unauthorized", "valid"]);
});

test("额度错误码即使使用 429 也触发连接切换", async () => {
  const result = await generateToolModelText([
    candidate("quota", "quota", async () => { throw failure(429, "request rejected", { error: { code: "insufficient_quota" } }); }),
    candidate("valid", "valid", async () => "ok")
  ], []);
  assert.equal(result.text, "ok");
});

test("普通 403 只跳当前模型，仍可使用同连接的其他型号", async () => {
  const result = await generateToolModelText([
    candidate("forbidden", "shared", async () => { throw failure(403, "model access denied"); }),
    candidate("allowed", "shared", async () => "ok")
  ], []);
  assert.equal(result.model.modelId, "allowed");
});

test("403 的鉴权错误码归属连接，而不是当前型号", async () => {
  let sameCalls = 0;
  const result = await generateToolModelText([
    candidate("invalid-key", "shared", async () => { throw failure(403, "request rejected", { error: { type: "invalid_api_key" } }); }),
    candidate("same", "shared", async () => { sameCalls++; return "wrong"; }),
    candidate("other", "other", async () => "ok")
  ], []);
  assert.equal(result.model.modelId, "other");
  assert.equal(sameCalls, 0);
});

test("嵌套错误原因能分类，循环或过深的原因不导致无界遍历", () => {
  assert.equal(toolModelFailureScope(new Error("outer", { cause: failure(402) })), "connection");
  const cyclic = new Error("network error");
  cyclic.cause = cyclic;
  assert.equal(toolModelFailureScope(cyclic), undefined);
  let deep: Error = failure(402);
  for (let index = 0; index < 10; index++) deep = new Error("wrapper", { cause: deep });
  assert.equal(toolModelFailureScope(deep), undefined);
});

test("已有永久鉴权和余额错误码仍触发连接切换", async () => {
  for (const code of ["invalid_token", "credit_balance_too_low"]) {
    const result = await generateToolModelText([
      candidate("failed", "failed", async () => { throw Object.assign(new Error("request rejected"), { code }); }),
      candidate("valid", "valid", async () => "ok")
    ], []);
    assert.equal(result.text, "ok", code);
  }
});

test("Google 数字错误码保留明确的无效凭据和 UNAUTHENTICATED 语义", async () => {
  for (const data of [
    { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } },
    { error: { code: null, message: "request rejected", status: "UNAUTHENTICATED" } }
  ]) {
    const result = await generateToolModelText([
      candidate("invalid", "invalid", async () => { throw failure(400, "request rejected", data); }),
      candidate("valid", "valid", async () => "ok")
    ], []);
    assert.equal(result.text, "ok");
  }
});

test("Google RESOURCE_EXHAUSTED 分钟限流不表示账户余额永久失效", async () => {
  let fallbackCalls = 0;
  const message = "Quota exceeded for quota metric 'Generate requests' and limit 'GenerateRequestsPerMinutePerProjectPerModel'.";
  const error = failure(429, message, { error: { code: 429, message, status: "RESOURCE_EXHAUSTED" } });
  await assert.rejects(generateToolModelText([
    candidate("limited", "limited", async () => { throw error; }),
    candidate("other", "other", async () => { fallbackCalls++; return "wrong"; })
  ], []), (actual) => actual === error);
  assert.equal(fallbackCalls, 0);
  assert.equal(toolModelFailureScope(failure(429, "request rate limited", { error: { code: 429, message: "request rate limited", status: "RESOURCE_EXHAUSTED" } })), undefined);
});

test("普通 429、网络错误和 5xx 不扩大到其他连接", async () => {
  for (const error of [failure(429, "rate limited"), new TypeError("fetch failed"), failure(503, "unavailable")]) {
    let nextCalls = 0;
    await assert.rejects(generateToolModelText([
      candidate("transient", "first", async () => { throw error; }),
      candidate("other", "other", async () => { nextCalls++; return "wrong"; })
    ], []), (actual) => actual === error);
    assert.equal(nextCalls, 0);
  }
});

test("单个显式候选不会改用其他模型，耗尽错误保留原因", async () => {
  const reason = failure(402, "Insufficient Balance");
  await assert.rejects(generateToolModelText([candidate("pinned", "pinned", async () => { throw reason; })], []), (error) => {
    assert.equal(error instanceof ToolModelCandidatesExhaustedError, true);
    assert.equal((error as ToolModelCandidatesExhaustedError).cause, reason);
    assert.deepEqual((error as ToolModelCandidatesExhaustedError).attempts, [
      { provider: "test", providerAlias: "pinned-connection", modelId: "pinned", status: "failed" }
    ]);
    return true;
  });
});

test("所有永久失败至多尝试一次，聚合元数据不包含错误正文", async () => {
  let calls = 0;
  const secret = "credential-value-must-not-be-metadata";
  await assert.rejects(generateToolModelText([
    candidate("first", "first", async () => { calls++; throw failure(402, secret); }),
    candidate("second", "second", async () => { calls++; throw failure(401, secret); })
  ], []), (error) => {
    assert.equal(error instanceof ToolModelCandidatesExhaustedError, true);
    const exhausted = error as ToolModelCandidatesExhaustedError;
    assert.equal(exhausted.attempts.length, 2);
    assert.equal(JSON.stringify(exhausted.attempts).includes(secret), false);
    assert.equal(exhausted.message.includes(secret), false);
    return true;
  });
  assert.equal(calls, 2);
});

test("无候选返回明确且永久的失败", async () => {
  await assert.rejects(generateToolModelText([], []), (error) => {
    assert.equal(error instanceof ToolModelCandidatesExhaustedError, true);
    assert.match((error as Error).message, /No available tool model/u);
    assert.equal((error as ToolModelCandidatesExhaustedError).retryable, false);
    return true;
  });
});

test("取消立即停止候选链，不接收忽略取消的迟到失败", async () => {
  const controller = new AbortController();
  let release!: () => void;
  let nextCalls = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const result = generateToolModelText([
    candidate("pending", "first", async () => { await pending; throw failure(402); }),
    candidate("other", "other", async () => { nextCalls++; return "wrong"; })
  ], [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  release();
  await Promise.resolve();
  assert.equal(nextCalls, 0);
});

test("预先取消不开始任何模型请求", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(generateToolModelText([candidate("first", "first", async () => { calls++; return "wrong"; })], [], { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("候选切换共用总期限，不为第二个请求重置 deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectFirst!: (error: Error) => void;
  let startedSecond!: () => void;
  let releaseSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => { startedSecond = resolve; });
  const first = new Promise<string>((_resolve, reject) => { rejectFirst = reject; });
  const second = new Promise<string>((resolve) => { releaseSecond = () => resolve("late"); });
  const result = generateToolModelText([
    candidate("first", "first", async () => first),
    candidate("second", "second", async () => { startedSecond(); return second; })
  ], [], { timeoutMs: 100 });
  const rejected = assert.rejects(result, { name: "TimeoutError" });
  t.mock.timers.tick(40);
  rejectFirst(failure(402));
  await secondStarted;
  t.mock.timers.tick(60);
  await rejected;
  releaseSecond();
});

test("成功后释放总期限计时器与外部取消监听", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const model: AgentModel = {
    provider: "test", modelId: "success",
    async stream(_context, options) {
      observedSignal = options?.signal;
      return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "ok" }; })();
    }
  };
  await generateToolModelText([{ model, failureDomain: "success" }], [], { timeoutMs: 100, signal: controller.signal });
  t.mock.timers.tick(100);
  controller.abort();
  assert.equal(observedSignal?.aborted, false, "完成后请求链不再响应计时器或外部取消");
});

test("真实 provider 装配链能从余额失败切换并产出结果", async (t) => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url!);
    request.resume();
    if (request.url?.startsWith("/empty")) {
      response.writeHead(402, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Insufficient Balance", type: "insufficient_balance" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"funded","choices":[{"index":0,"delta":{"content":"selected"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","created":0,"model":"funded","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const config = configSchema.parse({
    ...defaultConfig,
    providers: {
      empty: { type: "openai", apiKey: "fake-empty", baseUrl: `${base}/empty` },
      funded: { type: "openai", apiKey: "fake-funded", baseUrl: `${base}/funded` }
    },
    models: { empty: { provider: "empty", model: "empty" }, funded: { provider: "funded", model: "funded" } },
    defaultModel: "empty"
  });
  const result = await generateToolModelText(resolveToolModelCandidates(config), [{ role: "user", content: "select" }], { maxRetries: 0, timeoutMs: 5_000 });
  assert.equal(result.text, "selected");
  assert.equal(result.model.providerAlias, "funded");
  assert.deepEqual(calls, ["/empty/chat/completions", "/funded/chat/completions"]);
});

test("SDK 重试包装保留的最终 401、402、429 额度错误仍能切换", async (t) => {
  const calls = new Map<string, number>();
  const server = createServer((request, response) => {
    request.resume();
    const route = request.url!;
    const count = (calls.get(route) ?? 0) + 1;
    calls.set(route, count);
    if (!route.startsWith("/funded")) {
      const status = Number(route.split("/")[1]);
      response.writeHead(count === 1 ? 503 : status, { "Content-Type": "application/json", "retry-after-ms": "1" });
      response.end(JSON.stringify({ error: { message: "request rejected", code: status === 429 && count > 1 ? "insufficient_quota" : "request_failed" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"funded","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","created":0,"model":"funded","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  for (const status of [401, 402, 429]) {
    await t.test(String(status), async () => {
      const config = configSchema.parse({
        ...defaultConfig,
        providers: {
          rejected: { type: "openai", apiKey: "fake-rejected", baseUrl: `${base}/${status}` },
          funded: { type: "openai", apiKey: "fake-funded", baseUrl: `${base}/funded` }
        },
        models: { rejected: { provider: "rejected", model: "rejected" }, funded: { provider: "funded", model: "funded" } },
        defaultModel: "rejected"
      });
      const result = await generateToolModelText(resolveToolModelCandidates(config), [{ role: "user", content: "select" }], { maxRetries: 1, timeoutMs: 5_000 });
      assert.equal(result.text, "ok");
      assert.equal(result.model.providerAlias, "funded");
      assert.equal(calls.get(`/${status}/chat/completions`), 2, "SDK 预算耗尽后才切到另一连接");
    });
  }
});
