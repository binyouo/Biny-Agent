import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Source-only fixtures: no product module, provider SDK, SQLite, recorder,
// process, service, or filesystem-writing product code is imported or run.
// The whitelist retains the actual analyzer, parser, prompt and commit guard.
// Only model, memory-store and SQL transaction boundaries are inert fakes.
const root = new URL("../", import.meta.url);
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(new URL(path, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declarations(file: ts.SourceFile, names: readonly string[]): string {
  return names.map(name => {
    const matches = file.statements.filter(node => ts.isFunctionDeclaration(node)
      ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.some(
        item => ts.isIdentifier(item.name) && item.name.text === name));
    assert.equal(matches.length, 1, `${file.fileName}: ${name}`);
    const node = matches[0]!;
    if (ts.isVariableStatement(node)) assert.equal(node.declarationList.declarations.length, 1);
    return node.getText(file).replace(/^export\s+/u, "");
  }).join("\n");
}
const analyzer = source("src/activity/analyzer.ts");
const storeSource = source("src/activity/store.ts");
const storeClass = storeSource.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "ActivityStore");
assert.ok(storeClass);
const guardNames = ["readAnalysisSnapshot", "captureAnalysisSnapshot", "commitAnalysisIfCurrent"];
const guardMethods = storeClass.members.filter((node): node is ts.MethodDeclaration =>
  ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && guardNames.includes(node.name.text));
const hasGuard = guardMethods.length === guardNames.length;
assert.ok(hasGuard || guardMethods.length === 0, "all guard methods must exist together");
const code = [
  declarations(analyzer, [
    "ACTIVITY_ANALYSIS_MIN_SESSION_DURATION_MS", "ACTIVITY_ANALYSIS_MIN_EVENTS", "ACTIVITY_ANALYSIS_MIN_SNAPSHOTS",
    "ACTIVITY_ANALYSIS_MAX_OCR_CHARS", "ACTIVITY_ANALYSIS_MAX_EVENTS_IN_PROMPT", "ACTIVITY_TRIVIAL_SUMMARY",
    "ACTIVITY_ANALYSIS_FAILED_SUMMARY", "KNOWN_PROJECT_LOOKBACK_MS", "KNOWN_PROJECT_LIMIT", "ACTIVITY_ANALYSIS_VERSION",
    "analysisReferenceSchema", "analysisCommitSchema", "analysisPersonSchema", "memoryCandidateSchema",
    "analysisEntityDetailsSchema", "analysisOutputSchema", "ANALYSIS_SYSTEM_PROMPT",
    "analyzeActivitySession", "projectActivityAnalysis", "activityAnalysisInputHash", "buildTrivialAnalysis",
    "parseActivityAnalysisOutput", "normalizeEntityGroup", "normalizeReferences", "normalizeCommits",
    "normalizePeopleValues", "normalizeStrings", "normalizeMemoryCandidates", "optionalString", "isMemoryCandidateType",
    "isRecord", "requestSessionAnalysis", "buildAnalysisPrompt", "formatEventSample", "formatBrowserVisitSample",
    "formatWindowTitleSample", "browserVisitTitle", "formatEventTime", "isoTimestamp", "dedupeOcrTexts",
    "textSimilarity", "truncateOcrText", "normalizeProject", "normalizeEntityDetails", "normalizePeople",
    "referenceEntityLabels", "commitEntityLabels", "uniqueStrings", "deriveTitle", "errorMessage"
  ]),
  `class GuardFixture { ${guardMethods.map(node => node.getText(storeSource)).join("\n")} }`,
  "({ analyze: analyzeActivitySession, inputHash: activityAnalysisInputHash, guard: GuardFixture.prototype });"
].join("\n");
const javascript = stripTypeScriptTypes(code, { mode: "strip" });

interface Session {
  id: string; startedAt: string; endedAt: string; durationMs: number;
  eventCount: number; snapshotCount: number; appNames: string[];
}
interface Event {
  occurredAt: string; summary: string; eventType: string;
  application?: string; ocrText?: string;
}
interface Analysis extends Record<string, unknown> {
  sessionId: string; analyzedAt: string; analyzerModel: string;
  summary: string; inputHash: string; analysisStatus?: string;
}
interface Row {
  session: Session; events: Event[]; ocrTexts: string[];
  raw: Record<string, unknown>; analysis?: Analysis;
}
interface Snapshot {
  session: Session; events: Event[]; ocrTexts: string[];
  revision: string; state: string; analysis?: Analysis;
}
interface Details { model?: string; error?: string; analyzedAt?: string; title?: string | null; description?: string | null }
type Change = { analysis: Analysis } | { status: "skipped" | "failed"; details: Details };
interface Store {
  getEndedSession(id: string): Session | undefined;
  listSessionEventSummaries(id: string): Event[];
  listSessionAnalysisOcrTexts(id: string): string[];
  getAnalysis(id: string): Analysis | undefined;
  listRecentProjects(): string[];
  clearRevision(): string;
  recordAnalysis(analysis: Analysis): void;
  recordAnalysisStatus(id: string, status: string, details?: Details): void;
  readAnalysisSnapshot?: (id: string) => Snapshot | undefined;
  commitAnalysisIfCurrent?: (snapshot: Snapshot, change: Change) => boolean;
}
interface Deps {
  store: Store; model?: { modelId: string }; now(): Date;
  writeMemories(): Promise<void>; onAnalyzed(): Promise<void>;
}
interface Outcome { status: string; reason?: string; analysis?: Analysis; cached?: boolean; error?: string }
interface Extracted {
  analyze(deps: Deps, id: string, force?: boolean): Promise<Outcome>;
  inputHash(apps: readonly string[], events: readonly Event[]): string;
  guard: object;
}
type Response = "success" | "null" | "error";
const now = "2026-10-11T10:01:00.000Z";
const resultText = JSON.stringify({
  worth: true, title: "Review the activity guard", summary: "Checked the session analysis guard.",
  project: "Biny-Agent", confidence: 0.9,
  memoryCandidates: [{ type: "project", content: "Biny-Agent keeps activity analysis local.", why: "Standing project choice." }]
});
function clone<T>(value: T): T { return structuredClone(value); }
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function initialRow(id: string): Row {
  return {
    session: { id, startedAt: "2026-10-11T10:00:00.000Z", endedAt: now, durationMs: 60_000,
      eventCount: 1, snapshotCount: 3, appNames: ["Editor"] },
    events: [{ occurredAt: now, summary: "Focused editor", eventType: "app_focus", application: "Editor" },
      { occurredAt: now, summary: "Screen OCR", eventType: "screenshot_ocr", ocrText: "OLD_OCR alpha project" }],
    ocrTexts: ["OLD_OCR alpha project"],
    raw: { analysis_status: "pending", analysis_title: null, analysis_description: null, analysis_model: null,
      analysis_error: null, analyzed_at: null, analysis_generated_at: null, input_hash: null }
  };
}
function fixture(response: Response = "success") {
  let rows = new Map<string, Row>([["session", initialRow("session")], ["unrelated", initialRow("unrelated")]]);
  let revision = "generation-1";
  let transaction: { write: boolean; rows: Map<string, Row>; revision: string } | undefined;
  let failCommit = false;
  let failWrite = false;
  let readsHook: (() => void) | undefined;
  let nowHook: (() => void) | undefined;
  const entered = gate();
  const release = gate();
  const trace: string[] = [];
  const prompts: string[] = [];
  const writes: string[] = [];
  let memories = 0;
  let projections = 0;
  const commitError = new Error("inert database commit failure");
  const writeError = new Error("inert database write failure");
  const currentRows = () => transaction?.rows ?? rows;
  const database = {
    exec(sql: string): void {
      const command = sql.trim().replace(/;$/u, "");
      trace.push(command);
      if (command === "BEGIN" || command === "BEGIN IMMEDIATE") {
        assert.equal(transaction, undefined, "no nested fixture transaction");
        transaction = { write: command === "BEGIN IMMEDIATE", rows: clone(rows), revision };
      } else if (command === "COMMIT") {
        assert.ok(transaction);
        if (transaction.write && failCommit) { failCommit = false; throw commitError; }
        if (transaction.write) rows = transaction.rows;
        transaction = undefined;
      } else if (command === "ROLLBACK") {
        assert.ok(transaction, "rollback requires an active transaction");
        transaction = undefined;
      } else assert.fail(`unexpected SQL command: ${command}`);
    },
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      assert.equal(normalized,
        "SELECT analysis_status, analysis_title, analysis_description, analysis_model, analysis_error, analyzed_at, analysis_generated_at, input_hash FROM activity_sessions WHERE id = ?",
        "only the guard's raw-state read crosses the fake SQL boundary");
      return { get(id: string) {
        trace.push(`read-state:${id}`);
        const row = currentRows().get(id);
        const result = row ? clone(row.raw) : undefined;
        const hook = readsHook;
        readsHook = undefined;
        hook?.();
        return result;
      } };
    }
  };
  const api = runInNewContext(javascript, {
    createHash, z, Error,
    console: { error() {} },
    nativeJsonMessages: (system: string, prompt: string) => ({ system, prompt }),
    generateNativeText: async (_model: unknown, messages: { prompt: string }) => {
      assert.equal(transaction, undefined, "never hold the database transaction while waiting for the model");
      prompts.push(messages.prompt);
      entered.resolve();
      await release.promise;
      if (response === "error") throw new Error("inert model failure");
      return { text: response === "null" ? "null" : resultText };
    }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Extracted;
  const store: Store = Object.assign(Object.create(api.guard) as Store, {
    requireDatabase: () => database,
    getEndedSession: (id: string) => {
      const row = currentRows().get(id);
      return row ? clone(row.session) : undefined;
    },
    listSessionEventSummaries: (id: string) => clone(currentRows().get(id)?.events ?? []),
    listSessionAnalysisOcrTexts: (id: string) => clone(currentRows().get(id)?.ocrTexts ?? []),
    getAnalysis: (id: string) => {
      const row = currentRows().get(id);
      return row?.raw.input_hash ? clone(row.analysis) : undefined;
    },
    listRecentProjects: () => [],
    clearRevision: () => transaction?.revision ?? revision,
    recordAnalysis: (analysis: Analysis) => {
      writes.push("analysis");
      const row = currentRows().get(analysis.sessionId);
      if (row) saveAnalysis(row, analysis);
      if (failWrite) { failWrite = false; throw writeError; }
    },
    recordAnalysisStatus: (id: string, status: string, details: Details = {}) => {
      writes.push(status);
      const row = currentRows().get(id);
      if (row) saveStatus(row, status, details);
      if (failWrite) { failWrite = false; throw writeError; }
    }
  });
  const deps: Deps = {
    store, model: { modelId: "inert-model" },
    now: () => { nowHook?.(); return new Date(now); },
    writeMemories: async () => { memories += 1; },
    onAnalyzed: async () => { projections += 1; }
  };
  const row = (id = "session") => { const value = rows.get(id); assert.ok(value); return value; };
  return {
    api, store, deps, trace, prompts, writes, entered, release, commitError, writeError,
    row, exists: (id = "session") => rows.has(id), remove: (id = "session") => { rows.delete(id); },
    run: (force = false) => api.analyze(deps, "session", force),
    effects: () => ({ memories, projections }),
    isInTransaction: () => transaction !== undefined,
    failCommit: () => { failCommit = true; }, failWrite: () => { failWrite = true; },
    clearGeneration: () => { revision = "generation-2"; },
    duringRead: (hook: () => void) => { readsHook = hook; },
    duringNow: (hook: () => void) => { nowHook = hook; }
  };
}
type Fixture = ReturnType<typeof fixture>;
function saveAnalysis(row: Row, analysis: Analysis): void {
  row.analysis = clone(analysis);
  row.raw = { analysis_status: analysis.analysisStatus ?? "analyzed", analysis_title: analysis.title ?? null,
    analysis_description: analysis.description ?? analysis.summary, analysis_model: analysis.analyzerModel,
    analysis_error: null, analyzed_at: Date.parse(analysis.analyzedAt), analysis_generated_at: analysis.analyzedAt,
    input_hash: analysis.inputHash };
}
function saveStatus(row: Row, status: string, details: Details = {}): void {
  row.analysis = undefined;
  row.raw = { analysis_status: status, analysis_title: details.title ?? null, analysis_description: details.description ?? null,
    analysis_model: details.model ?? null, analysis_error: details.error ?? null,
    analyzed_at: details.analyzedAt ? Date.parse(details.analyzedAt) : null, analysis_generated_at: null, input_hash: null };
}
function lateOcr(row: Row): void {
  row.events.push({ occurredAt: now, summary: "Screen OCR", eventType: "screenshot_ocr", ocrText: "LATE_OCR beta design" });
  row.ocrTexts.push("LATE_OCR beta design");
  saveStatus(row, "pending");
}
function newerAnalysis(f: Fixture): Analysis {
  return { sessionId: "session", analyzedAt: "2026-10-11T10:02:00.000Z", analyzerModel: "newer-model",
    analysisStatus: "analyzed", summary: "Newer committed result", inputHash: f.api.inputHash(f.row().session.appNames, f.row().events) };
}
async function whileModelWaits(f: Fixture, mutate: () => void): Promise<Outcome> {
  const pending = f.run();
  // Install rejection handling immediately even if a mutation assertion fails.
  const settled = pending.then(value => ({ value }), error => ({ error }));
  await f.entered.promise;
  try { mutate(); } finally { f.release.resolve(); await settled; }
  return pending;
}
function rejectedAsStale(f: Fixture, outcome: Outcome): void {
  assert.deepEqual(clone(outcome), { status: "skipped", reason: "session_changed" });
  assert.deepEqual(f.writes, [], "stale analysis must not replace or reset the current row");
  assert.deepEqual(f.effects(), { memories: 0, projections: 0 });
  assert.equal(f.isInTransaction(), false);
}
const options = { timeout: 2_000 };

for (const response of ["success", "null", "error"] as const) {
  test(`${response}: OCR arriving during the model wait preserves pending state and suppresses projections`, options, async () => {
    const f = fixture(response);
    const outcome = await whileModelWaits(f, () => { lateOcr(f.row()); });
    rejectedAsStale(f, outcome);
    assert.equal(f.row().raw.analysis_status, "pending");
    assert.equal(f.row().raw.input_hash, null);
    assert.match(f.prompts[0]!, /OLD_OCR/u);
    assert.doesNotMatch(f.prompts[0]!, /LATE_OCR/u);
    assert.equal(f.prompts.length, response === "null" ? 2 : 1);
  });

  test(`${response}: a newer committed analysis cannot be overwritten by an older request`, options, async () => {
    const f = fixture(response);
    const newer = newerAnalysis(f);
    const outcome = await whileModelWaits(f, () => { saveAnalysis(f.row(), newer); });
    rejectedAsStale(f, outcome);
    assert.deepEqual(f.row().analysis, newer);
  });

  test(`${response}: deleting the session while the model waits produces no downstream writes`, options, async () => {
    const f = fixture(response);
    const outcome = await whileModelWaits(f, () => { f.remove(); });
    rejectedAsStale(f, outcome);
    assert.equal(f.exists(), false);
  });

  test(`${response}: unchanged input retains the original outcome and write semantics`, options, async () => {
    const f = fixture(response);
    const outcome = await whileModelWaits(f, () => {});
    assert.equal(outcome.status, response === "success" ? "analyzed" : "error");
    assert.deepEqual(f.writes, [response === "success" ? "analysis" : "failed"]);
    assert.deepEqual(f.effects(), response === "success" ? { memories: 1, projections: 1 } : { memories: 0, projections: 0 });
    assert.equal(f.isInTransaction(), false);
    if (response === "null") assert.equal(outcome.error, "LLM did not return parseable JSON");
    if (response === "error") assert.equal(outcome.error, "inert model failure");
    if (response === "success") {
      const cached = await f.run();
      assert.equal(cached.status, "analyzed");
      assert.equal(cached.cached, true);
      assert.equal(f.prompts.length, 1);
      assert.deepEqual(f.effects(), { memories: 1, projections: 1 });
    }
  });

  test(`${response}: unrelated-session OCR changes do not invalidate this session`, options, async () => {
    const f = fixture(response);
    const outcome = await whileModelWaits(f, () => { lateOcr(f.row("unrelated")); });
    assert.equal(outcome.status, response === "success" ? "analyzed" : "error");
    assert.equal(f.writes.length, 1);
    assert.equal(f.row("unrelated").raw.analysis_status, "pending");
  });
}

for (const mode of ["order", "selection"] as const) {
  test(`same full OCR event content with different prompt ${mode} rejects the old analysis`, options, async () => {
    const f = fixture();
    lateOcr(f.row());
    if (mode === "selection") f.row().ocrTexts = ["OLD_OCR alpha project"];
    const hash = f.api.inputHash(f.row().session.appNames, f.row().events);
    const outcome = await whileModelWaits(f, () => {
      if (mode === "order") f.row().ocrTexts.reverse();
      else f.row().ocrTexts = ["LATE_OCR beta design"];
    });
    assert.equal(f.api.inputHash(f.row().session.appNames, f.row().events), hash, "event hash alone cannot detect this change");
    rejectedAsStale(f, outcome);
  });
}

test("a newer failed status with no input hash is still protected", options, async () => {
  const f = fixture();
  const outcome = await whileModelWaits(f, () => {
    saveStatus(f.row(), "failed", { model: "newer-model", error: "newer failure", analyzedAt: now });
  });
  rejectedAsStale(f, outcome);
  assert.equal(f.store.getAnalysis("session"), undefined);
  assert.equal(f.row().raw.analysis_error, "newer failure");
});

test("clear and recreation with identical data invalidates the old generation", options, async () => {
  const f = fixture();
  const outcome = await whileModelWaits(f, () => { f.clearGeneration(); });
  rejectedAsStale(f, outcome);
  assert.equal(f.row().raw.analysis_status, "pending");
});

test("a later analysis uses the new OCR after a stale result was discarded", options, async () => {
  const f = fixture();
  rejectedAsStale(f, await whileModelWaits(f, () => { lateOcr(f.row()); }));
  const outcome = await f.run();
  assert.equal(outcome.status, "analyzed");
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1]!, /LATE_OCR/u);
  assert.deepEqual(f.writes, ["analysis"]);
  assert.deepEqual(f.effects(), { memories: 1, projections: 1 });
});

for (const mode of ["trivial", "no-model"] as const) {
  test(`${mode} writes also reject a changed snapshot`, options, async () => {
    const f = fixture();
    if (mode === "trivial") Object.assign(f.row().session, { durationMs: 1_000, snapshotCount: 1 });
    else f.deps.model = undefined;
    f.duringNow(() => { lateOcr(f.row()); });
    rejectedAsStale(f, await f.run());
    assert.equal(f.prompts.length, 0);
  });
}

for (const response of ["success", "null", "error"] as const) {
  test(`${response}: commit failure rolls back and never triggers a fallback failed write`, { ...options, skip: !hasGuard }, async () => {
    const f = fixture(response);
    const before = clone(f.row());
    f.failCommit();
    await assert.rejects(whileModelWaits(f, () => {}), error => error === f.commitError);
    assert.deepEqual(f.row(), before);
    assert.deepEqual(f.writes, [response === "success" ? "analysis" : "failed"]);
    assert.deepEqual(f.effects(), { memories: 0, projections: 0 });
    assert.deepEqual(f.trace.slice(-2), ["COMMIT", "ROLLBACK"]);
    assert.equal(f.isInTransaction(), false);
  });
}

test("a write error after a staged mutation rolls back and allows a later retry", { ...options, skip: !hasGuard }, async () => {
  const f = fixture();
  const before = clone(f.row());
  f.failWrite();
  await assert.rejects(whileModelWaits(f, () => {}), error => error === f.writeError);
  assert.deepEqual(f.row(), before);
  assert.equal(f.trace.at(-1), "ROLLBACK");
  assert.deepEqual(f.effects(), { memories: 0, projections: 0 });
  assert.equal((await f.run()).status, "analyzed");
  assert.deepEqual(f.effects(), { memories: 1, projections: 1 });
});

test("snapshot reads use one consistent read transaction and release it before returning", { ...options, skip: !hasGuard }, () => {
  const f = fixture();
  const before = clone(f.row());
  f.duringRead(() => { lateOcr(f.row()); });
  const snapshot = f.store.readAnalysisSnapshot!("session");
  assert.ok(snapshot);
  assert.deepEqual(clone(snapshot.events), before.events);
  assert.deepEqual(clone(snapshot.ocrTexts), before.ocrTexts);
  assert.equal(f.isInTransaction(), false);
  assert.deepEqual(f.trace, ["BEGIN", "read-state:session", "COMMIT"]);
  assert.equal(f.store.commitAnalysisIfCurrent!(snapshot, { status: "failed", details: { error: "old failure" } }), false);
  assert.equal(f.row().raw.analysis_status, "pending");
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.trace.slice(-3), ["BEGIN IMMEDIATE", "read-state:session", "ROLLBACK"]);
});

test("a snapshot cannot authorize an analysis for another session", { ...options, skip: !hasGuard }, () => {
  const f = fixture();
  const snapshot = f.store.readAnalysisSnapshot!("session");
  assert.ok(snapshot);
  const trace = [...f.trace];
  assert.throws(() => f.store.commitAnalysisIfCurrent!(snapshot, {
    analysis: { ...newerAnalysis(f), sessionId: "unrelated" }
  }), /does not match/u);
  assert.deepEqual(f.trace, trace, "reject the target mismatch before starting a transaction");
  assert.deepEqual(f.writes, []);
});

// Extract just the CLI command and the exact analyze route, never the HTTP
// handler/server or the dependency-importing CLI module.
const cliSource = source("src/cli/commands/activity.ts");
const httpSource = source("src/activity/httpServer.ts");
const analyzeRoutes: ts.IfStatement[] = [];
function findAnalyzeRoute(node: ts.Node): void {
  if (ts.isIfStatement(node) && node.expression.getText(httpSource).includes('pathname.endsWith("/analyze")')) {
    analyzeRoutes.push(node);
  } else ts.forEachChild(node, findAnalyzeRoute);
}
findAnalyzeRoute(httpSource);
assert.equal(analyzeRoutes.length, 1, "extract the single POST analyze branch");
const callerCode = stripTypeScriptTypes([
  declarations(cliSource, ["activityAnalyzeCommand"]),
  declarations(httpSource, ["decodePathPart", "notFound"]),
  `async function route() { let backgroundProjection; ${analyzeRoutes[0]!.getText(httpSource)} }`,
  "({ command: activityAnalyzeCommand, route });"
].join("\n"), { mode: "strip" });
interface CallerApi {
  command(root: string, sessionId: string, options?: { json?: boolean }): Promise<void>;
  route(): Promise<{ status: number; body: unknown }>;
}
function callers(outcome: Outcome) {
  const logs: string[] = [];
  const closed: string[] = [];
  const saved = { id: "session", analysisStatus: "pending" };
  const store = {
    getSessionDetail: () => ({}), getHttpSessionDetail: () => ({ session: saved }),
    close: async () => { closed.push("store"); }
  };
  const operation = { checkpoint: async () => {} };
  const api = runInNewContext(callerCode, {
    Error, store, operation, signal: { aborted: false }, hostSignal: undefined, deps: {},
    pathname: "/api/activity-recorder/sessions/session/analyze", method: "POST",
    console: { log: (message: string) => { logs.push(message); }, error() {} },
    createFileConfigStore: () => ({ load: async () => ({ activity: {} }) }),
    openActivityStore: async () => store, createActivityOperation: () => operation,
    createCliActivityMemoryPipeline: async () => ({ close: async () => { closed.push("memory"); } }),
    resolveToolModel: () => ({ modelId: "inert-model" }), analyzeActivitySession: async () => outcome
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as CallerApi;
  return { ...api, logs, closed, saved };
}

test("CLI explains session_changed and preserves its JSON outcome", options, async () => {
  const outcome = { status: "skipped", reason: "session_changed" };
  const text = callers(outcome);
  await text.command("/inert", "session");
  assert.deepEqual(text.logs, ["会话数据或分析结果已改变，本次分析未保存，请重新发起分析。"]);
  assert.deepEqual(text.closed, ["store", "memory"]);
  const json = callers(outcome);
  await json.command("/inert", "session", { json: true });
  assert.deepEqual(JSON.parse(json.logs[0]!), outcome);
  assert.deepEqual(json.closed, ["store", "memory"]);
});

test("REST reports stale analysis as a conflict", options, async () => {
  const result = await callers({ status: "skipped", reason: "session_changed" }).route();
  assert.deepEqual(clone(result), { status: 409,
    body: { error: "会话数据或分析结果已改变，本次分析未保存，请重新发起分析。" } });
});

for (const outcome of [{ status: "analyzed" }, { status: "trivial" },
  { status: "error", error: "inert model failure" }, { status: "skipped", reason: "no_model" }]) {
  test(`REST retains the existing saved-session response for ${outcome.status}`, options, async () => {
    const f = callers(outcome);
    assert.deepEqual(clone(await f.route()), { status: 200, body: f.saved });
  });
}
