/** Discarded retry responses are owned by the retry helper; returned responses belong to its caller. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRetryFetch, type RetryAttemptMetrics } from "../src/ai/retry.js";
import { fetchModelCatalogSnapshot } from "../src/ai/modelCatalog.js";
import { providerDefinition } from "../src/ai/provider.js";
import { ProviderEmbeddingRuntime } from "../src/llm/embedding/ProviderEmbeddingRuntime.js";

const retryableStatuses = [408, 409, 425, 429, 500, 502, 503, 504];
const policy = { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 };
const url = "https://fixture.invalid/v1/models";

for (const status of retryableStatuses) {
  test(`discarded ${status} body is cancelled before the next request`, async () => {
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
    const failed = new Response(body, { status });
    const success = new Response("complete");
    const observed: number[] = [];
    const metrics: RetryAttemptMetrics[] = [];
    const fetcher = createRetryFetch(policy, async () => {
      observed.push(cancels);
      return observed.length === 1 ? failed : success;
    }, (metric) => { metrics.push(metric); });
    try {
      assert.equal(await fetcher(url), success);
      assert.deepEqual(observed, [0, 1]);
      assert.equal(cancels, 1);
      assert.equal(body.locked, false);
      const reader = body.getReader();
      try { assert.equal((await reader.read()).done, true); }
      finally { reader.releaseLock(); }
      assert.equal(await success.text(), "complete");
      assert.deepEqual(metrics.map(({ attempt, status, willRetry, retryDelayMs }) => ({ attempt, status, willRetry, retryDelayMs })), [
        { attempt: 1, status, willRetry: true, retryDelayMs: 0 },
        { attempt: 2, status: 200, willRetry: false, retryDelayMs: undefined }
      ]);
    } finally {
      if (!body.locked) await body.cancel();
    }
  });
}

for (const [label, statuses, maxAttempts] of [
  ["success", [200], 3], ["client error", [401], 3], ["non-retryable server error", [501], 3],
  ["no retries", [503], 1], ["exhausted retries", [429, 503, 504], 3]
] as const) {
  test(`${label}: the final response remains readable and uncancelled`, async () => {
    const cancels = statuses.map(() => 0);
    const responses = statuses.map((status, index) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`response ${index}`)); },
      cancel() { cancels[index] = (cancels[index] ?? 0) + 1; }
    }), { status }));
    let calls = 0;
    const fetcher = createRetryFetch({ ...policy, maxAttempts }, async () => responses[calls++]!);
    try {
      const result = await fetcher(url);
      assert.equal(result, responses.at(-1));
      assert.equal(calls, statuses.length);
      assert.deepEqual(cancels, statuses.map((_, index) => index === statuses.length - 1 ? 0 : 1));
      const reader = result.body!.getReader();
      try { assert.equal(new TextDecoder().decode((await reader.read()).value), `response ${statuses.length - 1}`); }
      finally { reader.releaseLock(); }
    } finally { await Promise.all(responses.map((response) => response.body?.cancel())); }
  });
}

test("null response bodies keep the same retry behavior", async () => {
  const first = new Response(null, { status: 503 });
  const last = new Response(null, { status: 204 });
  let calls = 0;
  const result = await createRetryFetch(policy, async () => ++calls === 1 ? first : last)(url);
  assert.equal(result, last);
  assert.equal(calls, 2);
});

for (const outcome of ["success", "transport failure", "abort"] as const) {
  test(`pending asynchronous body cleanup cannot delay ${outcome}`, async () => {
    const cleanup = deferred<void>();
    let cancels = 0;
    let cleanupFinished = false;
    let calls = 0;
    const controller = new AbortController();
    const failure = new Error("fixture transport failure");
    const reason = new Error("fixture cancellation");
    const body = new ReadableStream<Uint8Array>({ async cancel() {
      cancels++;
      await cleanup.promise;
      cleanupFinished = true;
    } });
    const failed = new Response(body, { status: 503 });
    const success = new Response("complete");
    const request = createRetryFetch({ ...policy, maxAttempts: 2 }, async () => {
      calls++;
      if (calls === 1) return failed;
      if (outcome === "transport failure") throw failure;
      return success;
    }, () => { if (outcome === "abort") controller.abort(reason); })(url, { signal: controller.signal });
    try {
      if (outcome === "success") assert.equal(await bounded(request), success);
      else await assert.rejects(bounded(request), (error: unknown) => error === (outcome === "abort" ? reason : failure));
      assert.equal(cancels, 1);
      assert.equal(calls, outcome === "abort" ? 1 : 2);
      assert.equal(cleanupFinished, false);
    } finally { cleanup.resolve(); await body.cancel(); }
  });
}

for (const rejection of ["immediate", "late"] as const) {
  test(`${rejection} cancellation rejection is observed without replacing the request result`, async () => {
    const cleanup = deferred<void>();
    const failure = new Error("fixture cleanup failure");
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    let cancels = 0;
    let calls = 0;
    const failed = new Response(new ReadableStream<Uint8Array>({ async cancel() {
      cancels++;
      if (rejection === "late") await cleanup.promise;
      throw failure;
    } }), { status: 503 });
    const success = new Response("complete");
    try {
      const result = await createRetryFetch(policy, async () => ++calls === 1 ? failed : success)(url);
      assert.equal(result, success);
      assert.equal(cancels, 1);
      assert.equal(calls, 2);
      cleanup.resolve();
      await turn();
      await turn();
      assert.deepEqual(unhandled, []);
    } finally {
      cleanup.resolve();
      await failed.body?.cancel().catch(() => undefined);
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
}

test("a locked injected response cannot turn best-effort cleanup into a request failure", async () => {
  const source = new ReadableStream<Uint8Array>();
  const reader = source.getReader();
  const first = new Response(null, { status: 503 });
  Object.defineProperty(first, "body", { value: source });
  const last = new Response("complete");
  let calls = 0;
  try {
    assert.equal(await createRetryFetch(policy, async () => ++calls === 1 ? first : last)(url), last);
    await turn();
    assert.equal(calls, 2);
    assert.equal(source.locked, true, "a reader owned by an injected fetcher is not forcibly released");
  } finally { await reader.cancel(); reader.releaseLock(); }
});

test("cleanup occurs before backoff and cancellation still stops the next request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let cancels = 0;
  const controller = new AbortController();
  const reason = new Error("stop in backoff");
  const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
  const metrics: RetryAttemptMetrics[] = [];
  const request = createRetryFetch({ ...policy, initialDelayMs: 40, maxDelayMs: 100 }, async () => {
    calls++;
    return new Response(body, { status: 429, headers: { "retry-after-ms": "70" } });
  }, (metric) => { metrics.push(metric); })(url, { signal: controller.signal });
  const rejected = assert.rejects(request, (error: unknown) => error === reason);
  try {
    await turn();
    assert.equal(calls, 1);
    assert.equal(cancels, 1);
    assert.equal(metrics[0]?.retryDelayMs, 70);
    t.mock.timers.tick(69);
    await turn();
    assert.equal(calls, 1);
  } finally {
    controller.abort(reason);
    t.mock.timers.tick(100);
    await rejected;
    await body.cancel();
  }
  assert.equal(calls, 1);
});

test("request input and retry budget are unchanged", async () => {
  const input = new Request(url, { method: "GET" });
  const init = { headers: { "x-fixture": "unchanged" } };
  const seen: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  let cancels = 0;
  const bodies: ReadableStream<Uint8Array>[] = [];
  const fetcher = createRetryFetch({ ...policy, maxAttempts: 2 }, async (receivedInput, receivedInit) => {
    seen.push([receivedInput, receivedInit]);
    const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
    bodies.push(body);
    return new Response(body, { status: 503 });
  });
  try {
    assert.equal((await fetcher(input, init)).status, 503);
    assert.equal(seen.length, 2);
    assert.ok(seen.every(([receivedInput, receivedInit]) => receivedInput === input && receivedInit === init));
    assert.equal(cancels, 1);
  } finally { await Promise.all(bodies.map((body) => body.cancel())); }
});

for (const caller of ["catalog", "embedding"] as const) {
  test(`${caller} retry releases the discarded transport body before the next request`, async () => {
    let cancels = 0;
    const failedBody = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
    const observed: number[] = [];
    const config = {
      type: "openai-compatible", baseUrl: "https://fixture.invalid/v1", requiresApiKey: false,
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
      embeddingModels: [{ id: "fixture", displayName: "Fixture", dimensions: 2 }]
    };
    const definition = providerDefinition(config.type);
    const fetcher: typeof fetch = async (input) => {
      assert.equal(String(input), caller === "catalog" ? url : "https://fixture.invalid/v1/embeddings");
      observed.push(cancels);
      if (observed.length === 1) return new Response(failedBody, { status: 503 });
      return Response.json(caller === "catalog" ? { data: [{ id: "fixture" }] }
        : { data: [{ index: 0, embedding: [3, 4] }] });
    };
    try {
      if (caller === "catalog") {
        const result = await fetchModelCatalogSnapshot({ alias: "fixture", config, definition }, undefined, {}, fetcher);
        assert.equal(result.models?.[0]?.id, "fixture");
        assert.equal(result.notModified, false);
      } else {
        const runtime = new ProviderEmbeddingRuntime("fixture", config, definition, "fixture", { fetcher, env: {} });
        const result = await runtime.embed({ texts: ["fixture input"], inputType: "query" });
        assert.equal(result.dimensions, 2);
        assert.equal(result.embeddings.length, 1);
      }
      assert.deepEqual(observed, [0, 1]);
      assert.equal(cancels, 1);
      assert.equal(failedBody.locked, false);
    } finally { await failedBody.cancel(); }
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Request waited for asynchronous body cleanup")), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}
