/**
 * Natural-CI regression: public HTTP and CLI/Desktop export paths, isolated real
 * SQLite and Markdown files. Only model/provider I/O is controlled. Do not run
 * this file in source-only review environments.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { ActivitySessionAnalysis, ActivityStore as Store } from "../src/activity/store.js";

const dateKey = "2026-09-13";
const originalTitle = "Original session evidence";
const newerTitle = "Newer session evidence";
type Failure = "throw" | "short";
const suiteRoot = await mkdtemp(path.join(os.tmpdir(), "biny-report-fallback-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
process.env.BINY_AGENT_DIR = suiteRoot;
let providerHandler: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined;
globalThis.fetch = async () => {
  throw new Error("Network request during report fixture imports.");
};

try {
  // Product imports happen only after the state directory and network guard exist.
  const { ActivityStore } = await import("../src/activity/store.js");
  const { defaultActivitySettings } = await import("../src/activity/settings.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  const { createFileConfigStore } = await import("../src/config/store.js");
  const { handleActivityHttpRequest } = await import("../src/activity/httpServer.js");
  const { buildActivityReport } = await import("../src/activity/analyzer.js");
  const { narrateActivityReport } = await import("../src/activity/reportNarrative.js");
  const { activityReportCommand } = await import("../src/cli/commands/activity.js");
  const { ActivityRecorderService } = await import("../src/desktop/electron/main/ActivityRecorderService.js");
  const { DatabaseSync } = await import("node:sqlite");
  // A distinct post-import function identity keeps proxyFetch on its injected
  // fetch path even if the CI environment supplies proxy variables.
  globalThis.fetch = async (input, init) => {
    if (!providerHandler) throw new Error("Unexpected network request in report fallback fixture.");
    return await providerHandler(input, init);
  };

  async function fixture(run: (f: {
    root: string; agentDir: string; first: Store; second: Store;
    settings: typeof defaultActivitySettings;
    configStore: ReturnType<typeof createFileConfigStore>;
    notePath: string; row(): string;
  }) => Promise<void>) {
    const root = await mkdtemp(path.join(suiteRoot, "case-"));
    const agentDir = path.join(root, "agent");
    process.env.BINY_AGENT_DIR = agentDir;
    const settings = { ...defaultActivitySettings, enabled: false, outputDirectory: path.join(root, "snapshots") };
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "config.json"), JSON.stringify({
      ...defaultConfig,
      activity: settings,
      defaultModel: "report-fixture",
      toolModel: "report-fixture",
      providers: { local: { type: "openai-compatible", baseUrl: "https://report-fallback.invalid/v1",
        requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { "report-fixture": { provider: "local", model: "report-fixture", contextWindow: 128_000,
        capabilities: { tools: true, reasoning: false, streaming: true } } }
    }));
    const configStore = createFileConfigStore(root, { globalDir: agentDir });
    const first = new ActivityStore();
    const second = new ActivityStore();
    let observer: InstanceType<typeof DatabaseSync> | undefined;
    try {
      await first.open(settings.outputDirectory, agentDir);
      await second.open(settings.outputDirectory, agentDir);
      observer = new DatabaseSync(path.join(agentDir, "agent.sqlite"), { readOnly: true });
      assert.equal(first.listHttpSessions({ limit: 10 }).length, 0, "fixture must begin with an empty activity store");
      seed(first, 9, originalTitle);
      await run({ root, agentDir, first, second, settings, configStore,
        notePath: path.join(agentDir, "memory", dateKey + ".md"),
        row: () => {
          const saved = observer!.prepare("SELECT * FROM activity_summaries WHERE kind = 'daily' AND date_key = ?").get(dateKey);
          assert.equal(saved !== undefined, true, "expected a persisted daily row");
          return JSON.stringify(saved);
        } });
    } finally {
      providerHandler = undefined;
      console.log = originalLog;
      await first.close();
      await second.close();
      observer?.close();
      process.env.BINY_AGENT_DIR = suiteRoot;
      await rm(root, { recursive: true, force: true });
    }
  }

  function request(f: { agentDir: string; settings: typeof defaultActivitySettings }, model: AgentModel | undefined,
    format: "json" | "markdown", day = dateKey, method: "GET" | "POST" = "GET") {
    return handleActivityHttpRequest({
      method,
      pathname: "/api/activity-recorder/" + (method === "POST" ? "summary/daily/" : "report/") + day,
      searchParams: new URLSearchParams(method === "POST" ? "" : "force=true&format=" + format)
    }, { agentDir: f.agentDir, loadSettings: async () => f.settings, getModel: () => model });
  }

  for (const failure of ["throw", "short"] as const) {
    for (const format of ["json", "markdown"] as const) {
      for (const replacement of ["report", "summary"] as const) {
        await test("HTTP " + format + " rejects stale " + failure + " fallback after newer " + replacement,
          { timeout: 20_000 }, async () => {
            await fixture(async (f) => {
              const old = pausedModel(failure);
              const work = request(f, old.model, format);
              try {
                await awaitStarted(old.started, work);
                const oldState = f.row();
                assert.equal(f.first.getSummary("daily", dateKey)?.stats.reportStats?.analyzedCount, 1);
                seed(f.second, 10, newerTitle);
                const newer = await request(f, replacement === "report" ? immediateModel(newerText()) : undefined,
                  "json", dateKey, replacement === "report" ? "GET" : "POST");
                assert.equal(newer.status, 200);
                const current = f.row();
                assert.notEqual(current, oldState, "the independently committed row must actually change");
                if (replacement === "report") {
                  assert.equal(f.second.getSummary("daily", dateKey)?.stats.reportStats?.analyzedCount, 2);
                  assert.equal(f.second.getSummary("daily", dateKey)?.stats.report?.includes(newerTitle), true);
                } else {
                  assert.equal(f.second.getSummary("daily", dateKey)?.stats.report, undefined);
                }
                old.release();
                const response = await work;
                // Establish the database boundary even on Red: fallback did not overwrite the newer row.
                assert.equal(f.row(), current, "late fallback must leave the newer SQLite row unchanged");
                assert.equal(old.calls(), 1);
                assert.equal(response.status, 409, JSON.stringify({
                  response: response.body,
                  currentReport: f.second.getSummary("daily", dateKey)?.stats.report,
                  currentGeneratedAt: f.second.getSummary("daily", dateKey)?.stats.reportGeneratedAt
                }));
                assert.equal(JSON.stringify(response.body), JSON.stringify({ error: "Activity 请求已取消。" }));
              } finally { old.release(); await work; }
            });
          });
      }

      await test("HTTP " + format + " retains current-owner " + failure + " fallback",
        { timeout: 20_000 }, async () => {
          await fixture(async (f) => {
            const old = pausedModel(failure);
            const work = request(f, old.model, format);
            try {
              await awaitStarted(old.started, work);
              const current = f.row();
              const skeleton = f.first.getSummary("daily", dateKey)?.stats.report;
              const generatedAt = f.first.getSummary("daily", dateKey)?.stats.reportGeneratedAt;
              old.release();
              const response = await work;
              assert.equal(response.status, 200);
              assert.equal(f.row(), current, "normal fallback must not mutate the cache or its generation");
              const body = response.body as { markdown?: string; generatedAt?: number; model?: string } | string;
              assert.equal(typeof body === "string" ? body : body.markdown, skeleton);
              if (typeof body !== "string") {
                assert.equal(body.generatedAt, generatedAt);
                assert.equal(body.model, old.model.modelId);
              }
              assert.equal(old.calls(), 1);
            } finally { old.release(); await work; }
          });
        });
    }

    await test("a different report date does not cancel current-owner " + failure + " fallback",
      { timeout: 20_000 }, async () => {
        await fixture(async (f) => {
          const old = pausedModel(failure);
          const work = request(f, old.model, "json");
          try {
            await awaitStarted(old.started, work);
            const current = f.row();
            assert.equal((await request(f, undefined, "json", "2026-09-12")).status, 200);
            old.release();
            const response = await work;
            assert.equal(response.status, 200);
            assert.equal(f.row(), current);
          } finally { old.release(); await work; }
        });
      });

    for (const entry of ["CLI", "Desktop"] as const) {
      for (const superseded of [true, false]) {
        await test(entry + " " + failure + " fallback " + (superseded ? "preserves newer export" : "still exports current skeleton"),
          { timeout: 30_000 }, async () => {
            await fixture(async (f) => {
              const provider = pausedProvider(failure);
              providerHandler = provider.fetch;
              const printed: string[] = [];
              console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
              const service = entry === "Desktop"
                ? new ActivityRecorderService({ agentDir: f.agentDir, configStore: f.configStore, inputMonitorPath: undefined })
                : undefined;
              try {
                // buildReport owns its own connection and reads config without starting the recorder.
                await mkdir(path.dirname(f.notePath), { recursive: true });
                await writeFile(f.notePath, "# " + dateKey + " 每日摘要\n\n## 聊天摘要\n\nKeep this separate chat entry.\n");
                const work = (entry === "CLI"
                  ? activityReportCommand(f.root, dateKey, { force: true, json: true })
                  : service!.buildReport(dateKey)).then(
                    () => ({ ok: true, errorName: "" }),
                    (error: unknown) => ({ ok: false, errorName: error instanceof Error ? error.name : String(error) })
                  );
                try {
                  await awaitStarted(provider.started, work);
                  assert.equal(f.first.getSummary("daily", dateKey)?.stats.reportStats?.analyzedCount, 1);
                  if (superseded) {
                    seed(f.second, 10, newerTitle);
                    // This is the real CLI forced-report entry and real daily-note writer, not a helper composition.
                    await activityReportCommand(f.root, dateKey, { force: true, skeleton: true, json: true });
                  }
                  const current = f.row();
                  const fileBefore = await readFile(f.notePath, "utf8");
                  if (superseded) assert.equal(fileBefore.includes(newerTitle), true, "new report must already be exported");
                  provider.release();
                  const outcome = await work;
                  const fileAfter = await readFile(f.notePath, "utf8");
                  assert.equal(f.row(), current, "fallback must never replace the committed SQLite report");
                  assert.equal(fileAfter.includes("Keep this separate chat entry."), true);
                  assert.equal(provider.calls(), 1, "only the original report calls the provider");
                  assert.equal(provider.unexpected(), 0, "all unexpected provider destinations must fail closed");
                  if (superseded) {
                    assert.equal(fileAfter, fileBefore, "late fallback must not replace the newer Activity section");
                    assert.equal(outcome.ok, false);
                    assert.equal(outcome.errorName, "AbortError");
                    assert.equal(printed.length, 1, "only the newer CLI request produces output");
                  } else {
                    assert.equal(outcome.ok, true, outcome.errorName);
                    assert.equal(fileAfter.includes(originalTitle), true);
                    assert.equal(fileAfter.includes("## 活动记录"), true);
                    assert.equal(printed.length, entry === "CLI" ? 1 : 0);
                  }
                } finally { provider.release(); await work; }
              } finally { await service?.stop(); }
            });
          });
      }
    }

    await test("no-store " + failure + " fallback stays independent of a superseded persisted owner",
      { timeout: 20_000 }, async () => {
        await fixture(async (f) => {
          const original = await buildActivityReport({ store: f.first }, dateKey, { force: true });
          const old = pausedModel(failure);
          const work = narrateActivityReport({ ...original }, { model: old.model });
          try {
            await awaitStarted(old.started, work);
            seed(f.second, 10, newerTitle);
            await buildActivityReport({ store: f.second }, dateKey, { force: true });
            const current = f.row();
            old.release();
            const result = await work;
            assert.equal(result.markdown, original.markdown);
            assert.equal(result.narrativeModel, old.model.modelId);
            assert.equal(f.row(), current);
          } finally { old.release(); await work; }
        });
      });
  }

  await test("a real failed report transaction still returns current-owner fallback",
    { timeout: 20_000 }, async () => {
      await fixture(async (f) => {
        const original = await buildActivityReport({ store: f.first }, dateKey, { force: true });
        const before = f.row();
        const database = new DatabaseSync(path.join(f.agentDir, "agent.sqlite"));
        try {
          // An AFTER trigger exercises rollback after SQLite has applied the UPDATE.
          // No product storage method is mocked or replaced.
          database.exec("CREATE TRIGGER report_fixture_failure AFTER UPDATE ON activity_summaries BEGIN SELECT RAISE(ABORT, 'synthetic report write failure'); END;");
          const result = await narrateActivityReport(original, { store: f.first, model: immediateModel(newerText()) });
          assert.equal(result.markdown, original.markdown);
          assert.equal(result.narrativeModel, "fallback-fixture-model");
          assert.equal(f.row(), before, "actual SQLite rollback must leave ownership and timestamps intact");
          database.exec("DROP TRIGGER report_fixture_failure;");
          const retry = await narrateActivityReport(original, { store: f.first, model: immediateModel(newerText()) });
          assert.equal(retry.markdown, newerText().trim(), "rollback must not consume the original owner");
        } finally { database.close(); }
      });
    });
} finally {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(suiteRoot, { recursive: true, force: true });
}

async function awaitStarted(started: Promise<void>, work: Promise<unknown>): Promise<void> {
  await Promise.race([
    started,
    work.then(
      () => { throw new Error("Request settled before reaching the controlled model boundary."); },
      () => { throw new Error("Request rejected before reaching the controlled model boundary."); }
    )
  ]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pausedModel(failure: Failure) {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const model: AgentModel = {
    provider: "test", modelId: "fallback-fixture-model", runtime: "builtin-llama.cpp", dataResidency: "local",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      started.resolve();
      await release.promise;
      if (failure === "throw") throw new Error("synthetic report provider failure");
      yield { type: "text-delta", text: "# Incomplete report" };
      yield { type: "finish", reason: "stop" };
    })()
  };
  return { model, started: started.promise, release: release.resolve, calls: () => calls };
}

function immediateModel(output: string): AgentModel {
  return {
    provider: "test", modelId: "fallback-fixture-model", runtime: "builtin-llama.cpp", dataResidency: "local",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: output };
      yield { type: "finish", reason: "stop" };
    })()
  };
}

function newerText(): string {
  return "# Work journal\n\n## Project\n" + (originalTitle + " and " + newerTitle + ". ").repeat(5);
}

function pausedProvider(failure: Failure) {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  let unexpected = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url !== "https://report-fallback.invalid/v1/chat/completions" || method !== "POST") {
      unexpected += 1;
      throw new Error("Unexpected provider request: " + method + " " + url);
    }
    calls += 1;
    started.resolve();
    await release.promise;
    if (failure === "throw") return new Response(JSON.stringify({ error: { message: "synthetic provider failure", type: "fixture" } }),
      { status: 400, headers: { "Content-Type": "application/json" } });
    return new Response([
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "# Incomplete report" }, finish_reason: null }] }),
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]", ""
    ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return { fetch, started: started.promise, release: release.resolve, calls: () => calls, unexpected: () => unexpected };
}

function seed(store: Store, hour: number, title: string) {
  const startedAt = new Date(2026, 8, 13, hour);
  const endedAt = new Date(startedAt.getTime() + 600_000);
  const id = store.startSession(startedAt.toISOString());
  store.recordEvent({ sessionId: id, occurredAt: startedAt.toISOString(), eventType: "app_focus", application: "Editor" });
  store.endSession(id, endedAt.toISOString());
  store.recordAnalysis({
    sessionId: id, analyzedAt: endedAt.toISOString(), analyzerModel: "fixture-analysis", project: "Project",
    title, summary: title, description: title, topics: ["report"], prs: [], issues: [], people: [], versions: [],
    decisions: [], entities: [], highlights: [], worthMemory: false, worthKnowledge: false,
    isMeeting: false, storageTier: "standard", confidence: 0.9, sourceEventCount: 1,
    inputHash: "fixture-" + title
  } satisfies ActivitySessionAnalysis);
}
