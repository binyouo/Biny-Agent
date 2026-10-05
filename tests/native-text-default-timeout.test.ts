/** Configured provider timeouts also bound auxiliary requests and credential preparation. */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModel } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";

test("auxiliary requests inherit the configured provider timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferred<AbortSignal | undefined>();
  const response = deferred<Response>();
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "fixture",
    providers: { fixture: { type: "openai-compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", timeoutMs: 1_000 } },
    models: { fixture: { provider: "fixture", model: "fixture" } }
  });
  const model = new ProviderRegistry(config, [], undefined, undefined, async (_input, init) => {
    started.resolve(init?.signal ?? undefined);
    return response.promise;
  }).createModelSettings().model;
  const request = generateNativeText(model, [{ role: "user", content: "fixture" }]);
  const outcome = request.catch((error: unknown) => error);
  try {
    const signal = await started.promise;
    t.mock.timers.tick(999);
    assert.equal(signal?.aborted ?? false, false);
    t.mock.timers.tick(1);
    assert.equal(signal?.aborted, true, "a configured timeout must reach the auxiliary provider request");
    const error = await outcome;
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, "TimeoutError");
  } finally {
    response.resolve(new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    await outcome;
  }
});

for (const override of ["inherited", "explicit", "disabled"] as const) {
  test(`auxiliary credential preparation uses the ${override} timeout`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const prepared = deferred<AgentModel>();
    let preparationSignal: AbortSignal | undefined;
    let calls = 0;
    const model: AgentModel = {
      provider: "fixture", modelId: "prepare-timeout", vercelOptions: { timeoutMs: 1_000 },
      prepareTextRequest: async (signal) => {
        preparationSignal = signal;
        return prepared.promise;
      },
      stream: async () => {
        calls++;
        return (async function* () { yield { type: "text-delta" as const, text: "complete" }; })();
      }
    };
    const options = override === "inherited" ? {} : { timeoutMs: override === "explicit" ? 2_000 : undefined };
    const outcome = generateNativeText(model, [], options).catch((error: unknown) => error);
    try {
      t.mock.timers.tick(1_000);
      assert.equal(preparationSignal?.aborted ?? false, override === "inherited");
      if (override === "explicit") {
        t.mock.timers.tick(1_000);
        assert.equal(preparationSignal?.aborted, true);
      }
      prepared.resolve(model);
      const result = await outcome;
      if (override === "disabled") {
        assert.deepEqual(result, { text: "complete", usage: undefined, finishReason: undefined });
        assert.equal(calls, 1);
      } else {
        assert.ok(result instanceof DOMException);
        assert.equal(result.name, "TimeoutError");
        assert.equal(calls, 0, "expired preparation must not start a late model request");
      }
    } finally { prepared.resolve(model); await outcome; }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
