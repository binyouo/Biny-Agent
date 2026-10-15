/** Shared credential preparation belongs to all live callers, including callers without a signal. */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModel } from "../src/agent/core/types.js";
import { configSchema, defaultConfig, type ProviderConfig } from "../src/config/schema.js";
import { ProviderAuthenticationError, ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { CODEX_OAUTH_TOKEN_ENDPOINT } from "../src/llm/subscriptionAuth.js";

for (const cancelledCaller of [0, 1]) {
  for (const survivorHasSignal of [false, true]) {
    test(`shared refresh preserves caller ${1 - cancelledCaller} (signal: ${survivorHasSignal})`, { timeout: 10_000 }, async () => {
      const release = deferred<void>();
      const f = fixture({ refresh: async (signal) => { await release.promise; signal.throwIfAborted(); } });
      const controllers = [new AbortController(), new AbortController()];
      const reason = new Error("cancel one auxiliary request");
      const signals = controllers.map((controller, index) => index === cancelledCaller || survivorHasSignal ? controller.signal : undefined);
      const requests = signals.map((signal) => f.request(signal));
      const cancelled = assert.rejects(requests[cancelledCaller]!, (error: unknown) => error === reason);
      const survivor = requests[1 - cancelledCaller]!;
      // Observe failures immediately; the survivor is also awaited below for its full result.
      void survivor.catch(() => undefined);
      try {
        await boundary(f.refreshStarted.promise, Promise.all(requests));
        assert.equal(f.admissions, 2, "both public calls entered credential preparation");
        controllers[cancelledCaller]!.abort(reason);
        await cancelled;
        const refreshWasAborted = f.refreshSignals[0]?.aborted;
        assert.equal(controllers[1 - cancelledCaller]!.signal.aborted, false);
        release.resolve();
        assert.equal((await survivor).text, "ready");
        assert.equal(refreshWasAborted, false, "one caller cannot abort another caller's refresh");
        assert.equal(f.refreshSignals.length, 1);
        assert.equal(f.textRequests, 1);
        assert.equal(f.saves, 1);
        assert.equal((await f.request()).text, "ready");
        assert.equal(f.refreshSignals.length, 1, "success clears the flight and reuses the saved credential");
        assert.equal(f.reads, 2, "the next public request prepares again instead of retaining a settled flight");
      } finally {
        controllers.forEach((controller) => controller.abort(reason));
        release.resolve();
        await Promise.allSettled([...requests, cancelled]);
      }
    });
  }
}

test("all cancelled callers drain before a new request starts its own refresh", { timeout: 10_000 }, async () => {
  const releaseOld = deferred<void>();
  const releaseNew = deferred<void>();
  const secondRefresh = deferred<void>();
  let aborts = 0;
  const f = fixture({ refresh: async (signal, attempt) => {
    if (attempt === 1) {
      signal.addEventListener("abort", () => { aborts++; }, { once: true });
      await releaseOld.promise;
      signal.throwIfAborted();
    } else {
      secondRefresh.resolve();
      await releaseNew.promise;
    }
  } });
  const a = new AbortController();
  const b = new AbortController();
  const reasonA = new Error("cancel first");
  const reasonB = new Error("cancel second");
  const first = f.request(a.signal, true);
  const second = f.request(b.signal, true);
  let oldSettled = 0;
  const rejectedA = assert.rejects(first, (error: unknown) => error === reasonA).then(() => { oldSettled++; });
  const rejectedB = assert.rejects(second, (error: unknown) => error === reasonB).then(() => { oldSettled++; });
  let next: ReturnType<typeof f.request> | undefined;
  try {
    await boundary(f.refreshStarted.promise, first);
    a.abort(reasonA);
    assert.equal(f.refreshSignals[0]?.aborted, false);
    b.abort(reasonB);
    assert.equal(f.refreshSignals[0]?.aborted, true);
    assert.equal(aborts, 1);
    next = f.request();
    void next.catch(() => undefined);
    await turn();
    assert.equal(f.refreshSignals.length, 1, "new caller cannot join or overlap the aborted flight");
    assert.equal(oldSettled, 0, "strict callers retain physical refresh settlement");
    releaseOld.resolve();
    await Promise.all([rejectedA, rejectedB]);
    await Promise.race([
      secondRefresh.promise,
      next.then(() => { throw new Error("new request settled before its held refresh started"); })
    ]);
    assert.equal(f.refreshSignals.length, 2);
    const joined = f.request();
    void joined.catch(() => undefined);
    releaseNew.resolve();
    assert.equal((await next).text, "ready");
    assert.equal((await joined).text, "ready");
    assert.equal(f.refreshSignals.length, 2, "old cleanup must not clear the new shared flight");
    assert.equal(f.textRequests, 2);
    assert.equal(f.saves, 1);
  } finally {
    a.abort(reasonA); b.abort(reasonB); releaseOld.resolve(); releaseNew.resolve();
    await Promise.allSettled([first, second, rejectedA, rejectedB, ...(next ? [next] : [])]);
  }
});

for (const failure of ["none", "save", "save-abort-reason", "connection", "network"] as const) {
  test(`new caller preserves late ${failure} outcome while an aborted refresh drains`, { timeout: 10_000 }, async () => {
    const releaseRefresh = deferred<void>();
    const releaseSave = deferred<void>();
    const saveStarted = deferred<void>();
    const expected = failure === "connection"
      ? new ProviderAuthenticationError("subscription", "oauth_credentials_changed", "synthetic connection changed")
      : new Error(`synthetic ${failure} failure`);
    const f = fixture({
      refresh: async () => {
        await releaseRefresh.promise;
        if (failure === "network") throw expected;
      },
      save: async () => {
        saveStarted.resolve();
        await releaseSave.promise;
        if (failure === "save-abort-reason") throw f.refreshSignals[0]!.reason;
        if (failure === "save" || failure === "connection") throw expected;
      }
    });
    const controller = new AbortController();
    const ownReason = new Error("cancel original request");
    let settled = false;
    const old = f.request(controller.signal, true);
    const rejected = assert.rejects(old, (error: unknown) => error === ownReason).then(() => { settled = true; });
    let next: ReturnType<typeof f.request> | undefined;
    try {
      await boundary(f.refreshStarted.promise, old);
      controller.abort(ownReason);
      next = f.request();
      const nextOutcome = next.then((value) => ({ value }), (error: unknown) => ({ error }));
      await turn();
      assert.equal(f.refreshSignals.length, 1);
      assert.equal(settled, false);
      releaseRefresh.resolve();
      if (failure !== "network") {
        await boundary(saveStarted.promise, old);
        assert.equal(settled, false, "strict cancellation must not bypass confirmed token persistence");
        assert.equal(f.textRequests, 0);
        assert.equal(f.refreshSignals.length, 1);
      }
      releaseSave.resolve();
      const outcome = await nextOutcome;
      await rejected;
      assert.equal(f.refreshSignals.length, 1, "no automatic retry after a real failure or confirmed rotation");
      if (failure === "none") {
        assert.ok("value" in outcome);
        assert.equal(outcome.value.text, "ready");
        assert.equal(f.textRequests, 1);
        assert.equal(f.saves, 1);
        assert.equal(f.reads, 2);
      } else {
        assert.ok("error" in outcome);
        assert.equal(outcome.error, failure === "save-abort-reason" ? f.refreshSignals[0]!.reason : expected);
        assert.equal(f.textRequests, 0);
        assert.equal(f.reads, 1, "a draining safety failure must not silently start new preparation");
      }
    } finally {
      controller.abort(ownReason); releaseRefresh.resolve(); releaseSave.resolve();
      await Promise.allSettled([old, rejected, ...(next ? [next] : [])]);
    }
  });
}

test("direct preparation preserves confirmed save settlement after cancellation", { timeout: 10_000 }, async () => {
  const releaseSave = deferred<void>();
  const saveStarted = deferred<void>();
  const f = fixture({ save: async () => { saveStarted.resolve(); await releaseSave.promise; } });
  const controller = new AbortController();
  const reason = new Error("cancel direct preparation");
  let settled = false;
  const pending = f.model().prepareTextRequest!(controller.signal);
  const rejected = assert.rejects(pending, (error: unknown) => error === reason).then(() => { settled = true; });
  try {
    await boundary(saveStarted.promise, pending);
    controller.abort(reason);
    await turn();
    assert.equal(settled, false);
    assert.equal(f.saves, 1);
    releaseSave.resolve();
    await rejected;
    assert.equal(f.textRequests, 0);
    assert.equal((await f.request()).text, "ready");
    assert.equal(f.refreshSignals.length, 1);
  } finally { controller.abort(reason); releaseSave.resolve(); await Promise.allSettled([pending, rejected]); }
});

for (const phase of ["network", "save"] as const) {
  test(`direct preparation retains its original late ${phase} failure precedence`, { timeout: 10_000 }, async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const failure = new Error(`real synthetic ${phase} failure`);
    const fail = async (): Promise<void> => { started.resolve(); await release.promise; throw failure; };
    const f = fixture(phase === "network" ? { refresh: fail } : { save: fail });
    const controller = new AbortController();
    const pending = f.model().prepareTextRequest!(controller.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error === failure);
    try {
      await boundary(started.promise, pending);
      controller.abort(new Error("direct caller cancellation"));
      release.resolve();
      await rejected;
      assert.equal(f.textRequests, 0);
      assert.equal(f.refreshSignals.length, 1);
    } finally { controller.abort(); release.resolve(); await Promise.allSettled([pending, rejected]); }
  });
}

test("all callers cancelled during credential read prevent refresh and drain before new admission", { timeout: 10_000 }, async () => {
  const readStarted = deferred<AbortSignal>();
  const releaseRead = deferred<void>();
  const f = fixture({ read: async (signal, attempt) => {
    if (attempt !== 1) return;
    assert.ok(signal);
    readStarted.resolve(signal);
    await releaseRead.promise;
  } });
  const controller = new AbortController();
  const reason = new Error("cancel while reading credentials");
  const old = f.request(controller.signal, true);
  const rejected = assert.rejects(old, (error: unknown) => error === reason);
  let next: ReturnType<typeof f.request> | undefined;
  try {
    const readSignal = await boundary(readStarted.promise, old);
    controller.abort(reason);
    assert.equal(readSignal.aborted, true);
    next = f.request();
    void next.catch(() => undefined);
    await turn();
    assert.equal(f.reads, 1);
    assert.equal(f.refreshSignals.length, 0);
    releaseRead.resolve();
    await rejected;
    assert.equal((await next).text, "ready");
    assert.equal(f.reads, 2);
    assert.equal(f.refreshSignals.length, 1);
    assert.equal(f.textRequests, 1);
  } finally { controller.abort(reason); releaseRead.resolve(); await Promise.allSettled([old, rejected, ...(next ? [next] : [])]); }
});

test("pre-aborted preparation does not read credentials or refresh", async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);
  await assert.rejects(f.request(controller.signal), (error: unknown) => error === reason);
  await assert.rejects(f.model().prepareTextRequest!(controller.signal), (error: unknown) => error === reason);
  assert.equal(f.reads, 0);
  assert.equal(f.refreshSignals.length, 0);
  assert.equal(f.textRequests, 0);
});

function fixture(hooks: {
  read?: (signal: AbortSignal | undefined, attempt: number) => Promise<void>;
  refresh?: (signal: AbortSignal, attempt: number) => Promise<void>;
  save?: () => Promise<void>;
} = {}) {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "subscription",
    providers: { subscription: {
      type: "openai-codex", baseUrl: "https://credential-fixture.invalid/v1", requiresApiKey: false,
      apiKey: "synthetic-initial-access", authMode: "oauth-bearer",
      oauth: { provider: "openai-codex", refreshToken: "synthetic-initial-refresh", expiresAt: 1 }
    } },
    models: { subscription: { provider: "subscription", model: "fixture-model" } },
    thinking: { enabled: false, effort: "medium" }
  });
  let saved: ProviderConfig = config.providers.subscription!;
  const f = {
    admissions: 0, reads: 0, saves: 0, textRequests: 0,
    refreshSignals: [] as AbortSignal[], refreshStarted: deferred<void>(),
    model: (): AgentModel => {
      const model = providers.createModelSettings().model;
      const prepare = model.prepareTextRequest!;
      return { ...model, prepareTextRequest: (signal) => {
        const pending = prepare(signal);
        f.admissions++;
        return pending;
      } };
    },
    request: (signal?: AbortSignal, strict = false): ReturnType<typeof generateNativeText> => generateNativeText(f.model(), [{ role: "user", content: "synthetic fixture" }], {
      signal, timeoutMs: undefined, awaitModelSettlementOnAbort: strict
    })
  };
  const providers = new ProviderRegistry(config, [], undefined, undefined, async (input, init) => {
    if (String(input) === CODEX_OAUTH_TOKEN_ENDPOINT) {
      assert.equal(init?.method, "POST");
      assert.ok(init?.signal);
      f.refreshSignals.push(init.signal);
      f.refreshStarted.resolve();
      await hooks.refresh?.(init.signal, f.refreshSignals.length);
      return Response.json({ access_token: "synthetic-renewed-access", refresh_token: "synthetic-renewed-refresh", expires_in: 3600 });
    }
    assert.equal(String(input), "https://credential-fixture.invalid/v1/responses", "no unexpected external transport");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${saved.apiKey}`);
    assert.equal(saved.apiKey, "synthetic-renewed-access");
    f.textRequests++;
    return textResponse();
  }, {
    read: async (_alias, _previous, signal) => {
      f.reads++;
      await hooks.read?.(signal, f.reads);
      return saved;
    },
    write: async (_alias, _previous, renewed) => { f.saves++; await hooks.save?.(); saved = renewed; return saved; }
  });
  return f;
}

function textResponse(): Response {
  const message = { id: "fixture-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ready", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "fixture-response", created_at: 1, model: "fixture-model", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "ready" },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: "fixture-response", created_at: 1, model: "fixture-model", status: "completed", output: [message], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function boundary<T>(started: Promise<T>, pending: Promise<unknown>): Promise<T> {
  return await Promise.race([started, pending.then(() => {
    throw new Error("Request settled before the expected lifecycle boundary");
  })]);
}
