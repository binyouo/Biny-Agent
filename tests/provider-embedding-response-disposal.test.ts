import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fetchModelCatalogSnapshot, ModelCatalogRequestError } from "../src/ai/modelCatalog.js";
import { createRetryFetch } from "../src/ai/retry.js";
import type { ProviderDefinition, ProviderEmbeddingDefinition } from "../src/ai/types.js";
import type { ProviderConfig } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ConfiguredProviderRuntime } from "../src/llm/ProviderRuntime.js";
import { ProviderEmbeddingRuntime } from "../src/llm/embedding/ProviderEmbeddingRuntime.js";

type Wire = ProviderEmbeddingDefinition["wire"];
const wires: Wire[] = ["openai-compatible", "google-generative-ai"];
const request = { texts: ["one"], inputType: "query" as const };
const endpoint = "https://embedding.invalid/v1";
const config: ProviderConfig = { type: "disposal-test", baseUrl: endpoint, requiresApiKey: false };

function definition(wire: Wire): ProviderDefinition {
  return {
    type: config.type,
    protocol: "openai-compatible",
    requiresApiKey: false,
    authModes: ["api-key"],
    embedding: { wire, models: [{ id: "embed", displayName: "Test", dimensions: 2, recommendedThreshold: 0.3 }] }
  };
}

function runtime(wire: Wire, fetcher: typeof fetch, maxAttempts = 1): ProviderEmbeddingRuntime {
  return new ProviderEmbeddingRuntime("fixture", {
    ...config, retry: { maxAttempts, initialDelayMs: 0, maxDelayMs: 0 }
  }, definition(wire), "embed", { fetcher, env: {} });
}

function trackedResponse(status: number, cancel?: () => void | Promise<void>) {
  let cancellations = 0;
  let pulls = 0;
  const reasons: unknown[] = [];
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("unread provider payload")); },
    pull() { pulls += 1; },
    cancel(reason) { cancellations += 1; reasons.push(reason); return cancel?.(); }
  }, { highWaterMark: 0 }), { status });
  return { response, cancellations: () => cancellations, pulls: () => pulls, reasons };
}

function httpError(status: number) {
  return { name: "Error", message: `Embedding request failed for provider fixture (${String(status)}).` };
}

function successfulResponse(wire: Wire, onCancel: () => void) {
  const payload = wire === "openai-compatible"
    ? { data: [{ index: 0, embedding: [3, 4] }] }
    : { embedding: { values: [3, 4] } };
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); },
    cancel: onCancel
  }));
}

for (const wire of wires) {
  for (const [status, maxAttempts] of [[401, 4], [503, 1], [503, 3]] as const) {
    test(`${wire}: discards final ${status} body with a ${maxAttempts}-attempt budget`, async () => {
      const tracked = trackedResponse(status);
      let calls = 0;
      const model = runtime(wire, async () => {
        calls += 1;
        return status === 503 && calls < maxAttempts ? new Response(null, { status }) : tracked.response;
      }, maxAttempts);
      try {
        await assert.rejects(model.embed(request), httpError(status));
        assert.equal(calls, status === 401 ? 1 : maxAttempts);
        assert.equal(tracked.cancellations(), 1);
        assert.equal(tracked.response.bodyUsed, true);
        assert.equal(tracked.pulls(), 0, "discarded payload must not be drained or parsed");
        assert.deepEqual(tracked.reasons, [undefined]);
      } finally {
        await tracked.response.body?.cancel().catch(() => undefined);
      }
    });
  }

  for (const outcome of ["reject", "throw", "never"] as const) {
    test(`${wire}: ${outcome} cleanup cannot replace or delay the HTTP error`, async () => {
      const cleanupError = new Error("cleanup failed");
      const tracked = trackedResponse(403, () => {
        if (outcome === "throw") throw cleanupError;
        return outcome === "reject" ? Promise.reject(cleanupError) : new Promise<void>(() => undefined);
      });
      const result = runtime(wire, async () => tracked.response).embed(request);
      let settled = false;
      const checked = assert.rejects(result, httpError(403)).then(() => { settled = true; });
      await nextTurn();
      assert.equal(settled, true, "HTTP failure must settle without awaiting cleanup");
      await checked;
      assert.equal(tracked.cancellations(), 1);
      // Node's test runner also fails if a rejected cleanup escapes as an unhandled rejection.
      await nextTurn();
    });
  }

  test(`${wire}: a locked body keeps the original error without taking over its reader`, async () => {
    const tracked = trackedResponse(403);
    const reader = tracked.response.body!.getReader();
    try {
      await assert.rejects(runtime(wire, async () => tracked.response).embed(request), httpError(403));
      await nextTurn();
      assert.equal(tracked.cancellations(), 0);
      assert.equal(tracked.response.body!.locked, true);
      assert.equal((await reader.read()).done, false);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  });

  test(`${wire}: cancels a partially consumed body after its reader releases the lock`, async () => {
    const tracked = trackedResponse(403);
    const reader = tracked.response.body!.getReader();
    await reader.read();
    reader.releaseLock();
    try {
      assert.equal(tracked.response.bodyUsed, true);
      await assert.rejects(runtime(wire, async () => tracked.response).embed(request), httpError(403));
      assert.equal(tracked.cancellations(), 1, "bodyUsed does not imply that the remaining body was released");
    } finally {
      await tracked.response.body?.cancel();
    }
  });

  test(`${wire}: null and fully consumed bodies retain status errors`, async () => {
    const consumed = new Response("already consumed", { status: 403 });
    await consumed.text();
    for (const response of [new Response(null, { status: 403 }), consumed]) {
      await assert.rejects(runtime(wire, async () => response).embed(request), httpError(403));
    }
    await nextTurn();
  });

  test(`${wire}: success still consumes vectors without cancelling them`, async () => {
    let cancellations = 0;
    const response = successfulResponse(wire, () => { cancellations += 1; });
    const result = await runtime(wire, async () => response).embed(request);
    assert.equal(response.bodyUsed, true);
    assert.equal(cancellations, 0);
    assert.deepEqual(result.embeddings, [new Float32Array([0.6, 0.8])]);
  });

  test(`${wire}: pre-abort and transport failures preserve reason identity and retry budget`, async () => {
    let calls = 0;
    const reason = new Error("caller stopped");
    const controller = new AbortController();
    controller.abort(reason);
    const model = runtime(wire, async () => { calls += 1; throw reason; }, 3);
    await assert.rejects(model.embed({ ...request, signal: controller.signal }), (error) => error === reason);
    assert.equal(calls, 0);
    await assert.rejects(model.embed(request), (error) => error === reason);
    assert.equal(calls, 3);
  });

  test(`${wire}: configured provider factory reaches the same cleanup boundary`, async () => {
    const registry = new AiRegistry();
    registry.registerProvider(definition(wire));
    const tracked = trackedResponse(400);
    const provider = new ConfiguredProviderRuntime("fixture", config, registry, [], undefined, async () => tracked.response);
    try {
      await assert.rejects(provider.createEmbeddingRuntime("embed").embed(request), httpError(400));
      assert.equal(tracked.cancellations(), 1);
    } finally {
      await tracked.response.body?.cancel();
    }
  });
}

test("Google stops later texts after a final error without cancelling earlier successful bodies", async () => {
  const tracked = trackedResponse(429);
  let calls = 0;
  let successfulCancellations = 0;
  const model = runtime("google-generative-ai", async () => {
    calls += 1;
    return calls === 1 ? successfulResponse("google-generative-ai", () => { successfulCancellations += 1; }) : tracked.response;
  });
  try {
    await assert.rejects(model.embed({ ...request, texts: ["one", "two", "three"] }), httpError(429));
    assert.equal(calls, 2);
    assert.equal(successfulCancellations, 0);
    assert.equal(tracked.cancellations(), 1);
  } finally {
    await tracked.response.body?.cancel();
  }
});

test("retry transport returns its final response untouched for its caller to own", async () => {
  const tracked = trackedResponse(503);
  try {
    const response = await createRetryFetch({ maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }, async () => tracked.response)(endpoint);
    assert.equal(response, tracked.response);
    assert.equal(response.bodyUsed, false);
    assert.equal(tracked.cancellations(), 0);
  } finally {
    await tracked.response.body?.cancel();
  }
});

test("catalog errors retain their consumed provider payload and HTTP status", async () => {
  const payload = "catalog provider error detail";
  const response = new Response(payload, { status: 401 });
  await assert.rejects(fetchModelCatalogSnapshot({ alias: "fixture", config, definition: definition("openai-compatible") },
    undefined, {}, async () => response), (error) => {
    assert.ok(error instanceof ModelCatalogRequestError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.responseBody, payload);
    assert.equal(error.message, "Model catalog request failed (401).");
    return true;
  });
  assert.equal(response.bodyUsed, true);
});
