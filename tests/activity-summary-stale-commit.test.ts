/** CI-only: real Activity HTTP handlers and isolated shared SQLite storage.
 * Product imports happen only after fixture isolation. Never run in a source-only review environment.
 */
type Store = import("../src/activity/store.js").ActivityStore;
type Model = import("../src/agent/core/types.js").AgentModel;
type Event = import("../src/agent/core/types.js").ModelStreamEvent;
type Request = import("../src/activity/httpServer.js").ActivityHttpRequest;
type Context = import("node:test").TestContext;
type Kind = "daily" | "weekly";
type Completion = "success" | "error" | "empty";

async function main(): Promise<void> {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const date = "2026-09-13";
  const key = (kind: Kind) => kind === "daily" ? date : "2026-W37";

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  async function fixture(t: Context) {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-summary-stale-"));
    const previousRoot = process.env.BINY_AGENT_DIR;
    const previousFetch = globalThis.fetch;
    const stores: Store[] = [];
    const pending = new Set<Promise<unknown>>();
    const modelSettlements: Promise<void>[] = [];
    const releases: Array<() => void> = [];
    let fetchCalls = 0;
    t.after(async () => {
      const errors: unknown[] = [];
      try {
        for (const release of releases) release();
        await Promise.allSettled([...pending, ...modelSettlements]);
        for (const store of stores) {
          try { await store.close(); } catch (error) { errors.push(error); }
        }
      } finally {
        globalThis.fetch = previousFetch;
        if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR;
        else process.env.BINY_AGENT_DIR = previousRoot;
        try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      }
      assert.equal(fetchCalls, 0, "injected models must never dispatch a network request");
      if (errors.length) throw new AggregateError(errors, "summary fixture cleanup failed");
    });
    process.env.BINY_AGENT_DIR = root;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("Unexpected network request in summary regression");
    };
    const { ActivityStore } = await import("../src/activity/store.js");
    const { defaultActivitySettings } = await import("../src/activity/settings.js");
    const { handleActivityHttpRequest } = await import("../src/activity/httpServer.js");
    const { refreshActivitySummaryWithNarrative } = await import("../src/activity/summary.js");
    const settings = { ...defaultActivitySettings, enabled: false, outputDirectory: path.join(root, "snapshots") };
    const store = new ActivityStore();
    stores.push(store);
    await store.open(settings.outputDirectory, root);
    const seed = (hour: number) => {
      const start = new Date(2026, 8, 13, hour);
      const session = store.startSession(start.toISOString());
      store.recordEvent({ sessionId: session, occurredAt: start.toISOString(), eventType: "app_focus", application: "Editor" });
      store.endSession(session, new Date(start.getTime() + 600_000).toISOString());
      store.recordAnalysis({
        sessionId: session, analyzedAt: start.toISOString(), analyzerModel: "fixture-analysis",
        analysisStatus: "analyzed", title: `Session at ${hour}`, summary: `Session at ${hour}`,
        topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
        worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
        confidence: 1, sourceEventCount: 1, inputHash: `fixture-${hour}`
      });
    };
    seed(9);
    const model = (completion: Completion, text: string) => {
      const started = deferred<void>();
      const gate = deferred<void>();
      const finished = deferred<void>();
      let calls = 0;
      const release = () => gate.resolve();
      releases.push(release);
      const value: Model = {
        provider: "test", modelId: "summary-stale-test", runtime: "builtin-llama.cpp", dataResidency: "local",
        stream: async () => (async function* (): AsyncGenerator<Event> {
          modelSettlements.push(finished.promise);
          calls += 1;
          started.resolve();
          try {
            await gate.promise;
            if (completion === "error") throw new Error("Synthetic narrative failure");
            if (completion === "success") yield { type: "text-delta", text };
            yield { type: "finish", reason: "stop" };
          } finally {
            finished.resolve();
          }
        })()
      };
      return { value, started: started.promise, release, calls: () => calls };
    };
    const track = <T>(result: Promise<T>) => {
      pending.add(result);
      void result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    };
    const request = (input: Request, selected?: Model, outputDirectory = settings.outputDirectory, agentDir = root) => {
      const result = handleActivityHttpRequest(input, {
        agentDir, loadSettings: async () => ({ ...settings, outputDirectory }), getModel: () => selected
      });
      return track(result);
    };
    const refresh = (kind: Kind, selected?: Model, signal?: AbortSignal, outputDirectory?: string) => request({
      method: "POST", pathname: `/api/activity-recorder/summary/${kind}/${date}`,
      searchParams: new URLSearchParams(selected ? "narrative=true" : ""), signal
    }, selected, outputDirectory);
    const direct = (kind: Kind, dateKey: string, selected?: Model) => track(refreshActivitySummaryWithNarrative(
      store, kind, dateKey, { model: selected, withNarrative: selected !== undefined }
    ));
    return { root, store, seed, model, request, refresh, direct };
  }

  for (const kind of ["daily", "weekly"] as const) {
    for (const completion of ["success", "error", "empty"] as const) {
      await test(`${kind}: delayed ${completion} cannot overwrite a newer committed summary`, { timeout: 15_000 }, async (t) => {
        const f = await fixture(t);
        const old = f.model(completion, "Older narrative");
        const older = f.refresh(kind, old.value);
        await old.started;
        f.seed(10);
        const fresh = f.model("success", "Current narrative with both sessions");
        fresh.release();
        assert.equal((await f.refresh(kind, fresh.value)).status, 200);
        const saved = f.store.getSummary(kind, key(kind));
        assert.ok(saved);
        assert.equal(saved.stats.sessionCount, 2);
        assert.equal(saved.summary, "Current narrative with both sessions");
        const savedHttp = f.store.getHttpSummary(kind, key(kind));
        old.release();
        const result = await older;
        // Check durable contents before response status so the natural Red proves the overwrite itself.
        assert.deepEqual(f.store.getSummary(kind, key(kind)), saved, "late completion must preserve all newer persisted fields");
        assert.deepEqual(f.store.getHttpSummary(kind, key(kind)), savedHttp, "public id and timestamps must also remain unchanged");
        assert.equal(result.status, 409);
        assert.deepEqual(result.body, { error: "Activity 请求已取消。" });
        assert.equal(old.calls(), 1);
        assert.equal(fresh.calls(), 1);
      });
    }

    await test(`${kind}: unchanged ownership retains the current narrative`, { timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      const current = f.model("success", "Current sole narrative");
      const work = f.refresh(kind, current.value);
      await current.started;
      current.release();
      assert.equal((await work).status, 200);
      const saved = f.store.getSummary(kind, key(kind));
      assert.ok(saved);
      assert.equal(saved.summary, "Current sole narrative");
      assert.equal(saved.stats.sessionCount, 1);
      assert.equal(saved.model, current.value.modelId);
    });

    await test(`${kind}: a newer canceled request without a commit does not steal ownership`, { timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      const old = f.model("success", "Original request may still finish");
      const older = f.refresh(kind, old.value);
      await old.started;
      const controller = new AbortController();
      const canceled = f.model("success", "Must not persist");
      const newer = f.refresh(kind, canceled.value, controller.signal);
      await canceled.started;
      controller.abort();
      canceled.release();
      assert.equal((await newer).status, 409);
      assert.equal(f.store.getSummary(kind, key(kind)), undefined);
      old.release();
      assert.equal((await older).status, 200);
      assert.equal(f.store.getSummary(kind, key(kind))?.summary, "Original request may still finish");
    });

    await test(`${kind}: a newer model-error fallback is a committed replacement`, { timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      const old = f.model("success", "Older narrative");
      const older = f.refresh(kind, old.value);
      await old.started;
      f.seed(10);
      const fallback = f.model("error", "unused");
      fallback.release();
      assert.equal((await f.refresh(kind, fallback.value)).status, 200);
      const saved = f.store.getSummary(kind, key(kind));
      assert.ok(saved);
      assert.equal(saved.stats.sessionCount, 2);
      assert.equal(saved.model, undefined);
      old.release();
      const result = await older;
      assert.deepEqual(f.store.getSummary(kind, key(kind)), saved);
      assert.equal(result.status, 409);
    });
    await test(`${kind}: an existing row is protected from a late overwrite after non-narrative refresh`, { timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      assert.equal((await f.refresh(kind)).status, 200);
      const initial = f.store.getHttpSummary(kind, key(kind));
      const old = f.model("success", "Older narrative");
      const older = f.refresh(kind, old.value);
      await old.started;
      f.seed(10);
      assert.equal((await f.refresh(kind)).status, 200);
      const saved = f.store.getSummary(kind, key(kind));
      const savedHttp = f.store.getHttpSummary(kind, key(kind));
      assert.equal(saved?.stats.sessionCount, 2);
      assert.equal(savedHttp?.id, initial?.id, "refresh preserves the public row identity");
      assert.equal(savedHttp?.createdAt, initial?.createdAt);
      old.release();
      const result = await older;
      assert.deepEqual(f.store.getSummary(kind, key(kind)), saved);
      assert.deepEqual(f.store.getHttpSummary(kind, key(kind)), savedHttp);
      assert.equal(result.status, 409);
    });

    await test(`${kind}: source changes alone still allow the captured summary to commit`, { timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      const old = f.model("success", "Captured-source narrative");
      const work = f.refresh(kind, old.value);
      await old.started;
      f.seed(10);
      old.release();
      assert.equal((await work).status, 200);
      assert.equal(f.store.getSummary(kind, key(kind))?.stats.sessionCount, 1,
        "this is a persisted-state guard, not automatic source-revision invalidation");
    });

    await test(`${kind}: another persisted date does not invalidate this slot`, { timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      const old = f.model("success", "Independent-date narrative");
      const work = f.refresh(kind, old.value);
      await old.started;
      assert.equal((await f.request({ method: "POST", pathname: `/api/activity-recorder/summary/${kind}/2026-09-06` })).status, 200);
      old.release();
      assert.equal((await work).status, 200);
      assert.equal(f.store.getSummary(kind, key(kind))?.summary, "Independent-date narrative");
    });

    await test(`${kind}: the first changed commit wins even when it belongs to the earlier request`, { timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      const first = f.model("success", "First committed narrative");
      const firstWork = f.refresh(kind, first.value);
      await first.started;
      const second = f.model("success", "Later-started narrative");
      const secondWork = f.refresh(kind, second.value);
      await second.started;
      first.release();
      assert.equal((await firstWork).status, 200);
      const saved = f.store.getSummary(kind, key(kind));
      second.release();
      const result = await secondWork;
      assert.deepEqual(f.store.getSummary(kind, key(kind)), saved);
      assert.equal(result.status, 409);
    });

    await test(`${kind}: a real write followed by an error rolls back without invalidating the waiting request`, { timeout: 15_000 }, async (t) => {
      const f = await fixture(t);
      assert.equal((await f.refresh(kind)).status, 200);
      const before = f.store.getSummary(kind, key(kind));
      const old = f.model("success", "Surviving narrative");
      const older = f.refresh(kind, old.value);
      await old.started;
      f.seed(10);
      const write = f.store.upsertSummary.bind(f.store);
      f.store.upsertSummary = (record) => { write(record); throw new Error("Synthetic failure after SQL write"); };
      try {
        await assert.rejects(f.direct(kind, date), /Synthetic failure after SQL write/u);
      } finally {
        f.store.upsertSummary = write;
      }
      assert.deepEqual(f.store.getSummary(kind, key(kind)), before, "the changed write must actually be rolled back");
      old.release();
      assert.equal((await older).status, 200);
      assert.equal(f.store.getSummary(kind, key(kind))?.summary, "Surviving narrative");
    });
  }

  await test("daily direct callers use the canonical trimmed date slot", { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const old = f.model("success", "Older padded-date narrative");
    const older = f.direct("daily", `  ${date}  `, old.value);
    const settled = older.then(value => ({ value }), (error: unknown) => ({ error }));
    await old.started;
    f.seed(10);
    assert.equal((await f.refresh("daily")).status, 200);
    const saved = f.store.getSummary("daily", date);
    old.release();
    const result = await settled;
    assert.deepEqual(f.store.getSummary("daily", date), saved);
    assert.equal("error" in result && result.error instanceof Error && result.error.name === "AbortError", true);
  });

  await test("weekly different end dates in the same ISO week share one persisted slot", { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const old = f.model("success", "Older Sunday-ending narrative");
    const older = f.refresh("weekly", old.value);
    await old.started;
    assert.equal((await f.request({ method: "POST", pathname: "/api/activity-recorder/summary/weekly/2026-09-12" })).status, 200);
    const saved = f.store.getSummary("weekly", "2026-W37");
    assert.equal(saved?.stats.endDate, "2026-09-12");
    old.release();
    const result = await older;
    assert.deepEqual(f.store.getSummary("weekly", "2026-W37"), saved);
    assert.equal(result.status, 409);
  });

  await test("a new report cache is protected while an older summary narrative waits", { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const old = f.model("success", "Older summary");
    const older = f.refresh("daily", old.value);
    await old.started;
    assert.equal((await f.request({ method: "GET", pathname: `/api/activity-recorder/report/${date}`,
      searchParams: new URLSearchParams("force=true&skeletonOnly=true") })).status, 200);
    const saved = f.store.getSummary("daily", date);
    assert.ok(saved?.stats.reportState?.generation);
    assert.ok(saved.stats.report);
    old.release();
    const result = await older;
    assert.deepEqual(f.store.getSummary("daily", date), saved, "old summary must not erase the later report cache");
    assert.equal(result.status, 409);
  });

  await test("identical dates in separate agent databases do not conflict", { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const old = f.model("success", "Independent-database narrative");
    const older = f.refresh("daily", old.value);
    await old.started;
    assert.equal((await f.request({ method: "POST", pathname: `/api/activity-recorder/summary/daily/${date}` },
      undefined, path.join(f.root, "other-snapshots"), path.join(f.root, "other-agent"))).status, 200);
    old.release();
    assert.equal((await older).status, 200);
    assert.equal(f.store.getSummary("daily", date)?.summary, "Independent-database narrative");
  });

  await test("shared agent database remains one summary slot with different screenshot roots", { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const old = f.model("success", "Older shared-storage narrative");
    const older = f.refresh("daily", old.value);
    await old.started;
    f.seed(10);
    assert.equal((await f.refresh("daily", undefined, undefined, path.join(f.root, "other-snapshots"))).status, 200);
    const saved = f.store.getSummary("daily", date);
    assert.equal(saved?.stats.sessionCount, 2);
    old.release();
    const result = await older;
    assert.deepEqual(f.store.getSummary("daily", date), saved);
    assert.equal(result.status, 409);
  });
}

await main();
export {};
