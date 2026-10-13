import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Source-only contract: these imports never load product modules, providers,
// Host, SQLite, services, subprocesses, or filesystem-writing product code.
// The exact changed declarations/method are whitelisted below. Store/model
// boundaries are inert memory fakes; this does not validate real SQLite locks.
const root = new URL("../", import.meta.url);
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declarations(file: ts.SourceFile, names: readonly string[]): string {
  return names.map((name) => {
    const nodes = file.statements.filter((node) => ts.isFunctionDeclaration(node)
      ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.some(
        (item) => ts.isIdentifier(item.name) && item.name.text === name));
    assert.equal(nodes.length, 1, file.fileName + ": " + name);
    const node = nodes[0]!;
    if (ts.isVariableStatement(node)) assert.equal(node.declarationList.declarations.length, 1);
    return node.getText(file).replace(/^export\s+/u, "");
  }).join("\n");
}
const analyzer = source("src/activity/analyzer.ts");
const narrative = source("src/activity/reportNarrative.ts");
const store = source("src/activity/store.ts");
const storeClass = store.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "ActivityStore");
assert.ok(storeClass);
const guard = storeClass.members.filter((node): node is ts.MethodDeclaration =>
  ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "writeDailyReportCache");
assert.equal(guard.length, 1);
const javascript = stripTypeScriptTypes([
  declarations(analyzer, ["reportCacheGenerations", "persistActivityReport"]),
  declarations(narrative, ["prompt", "narrateActivityReport", "validNarrative"]),
  "class GuardFixture { " + guard[0]!.getText(store) + " }",
  "({ persist: persistActivityReport, narrate: narrateActivityReport, guard: GuardFixture.prototype.writeDailyReportCache });"
].join("\n"), { mode: "strip" });

interface Report {
  date: string; startIso: string; endIso: string; markdown: string; narrativeModel?: string;
  sessionCount: number; analyzedNow: number; pendingModel: number; blocked: boolean;
  cached?: boolean; stats: { sessionCount: number; analyzedCount: number; totalActiveMinutes: number; clusterCount: number; topApps: unknown[] };
}
interface Summary {
  kind: "daily"; dateKey: string; summary: string; model?: string; isPartial: boolean;
  generatedAt: string; stats: Record<string, unknown> & { reportState?: { generation?: string } };
}
interface Cache {
  report: string; reportGeneratedAt: number; reportStats: Report["stats"];
  reportState: { generation: string; sessionCount: number; pendingModel: number; blocked: boolean; narrativeModel?: string };
}
interface Model { modelId: string; response: Promise<{ text: string }> }
interface Options { store?: StoreFixture; model?: Model; skeleton?: boolean; signal?: AbortSignal; checkpoint?: () => Promise<void> }
interface Contract {
  persist(store: StoreFixture, report: Report, now?: Date, source?: Report): boolean;
  narrate(report: Report, options: Options): Promise<Report>;
  guard(this: StoreFixture, date: string, cache: Cache, create: () => Summary, expected: string | undefined): boolean;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const now = new Date("2026-10-12T12:00:00.000Z");
function report(date = "2026-10-11"): Report {
  return {
    date, startIso: date + "T00:00:00.000Z", endIso: date + "T23:59:59.000Z",
    markdown: "# Work journal\n\n## Project\n" + "Original supported activity. ".repeat(5),
    sessionCount: 1, analyzedNow: 0, pendingModel: 0, blocked: false,
    stats: { sessionCount: 1, analyzedCount: 1, totalActiveMinutes: 10, clusterCount: 1, topApps: [] }
  };
}
function summary(date: string): Summary {
  return { kind: "daily", dateKey: date, summary: "Current summary", model: "summary-model",
    isPartial: false, generatedAt: now.toISOString(), stats: { sessionCount: 1, marker: "summary-source" } };
}
class StoreFixture {
  readonly log: string[] = [];
  inTransaction = false;
  throwOnWrite = false;
  beforeBegin?: () => void;
  constructor(readonly rows: Map<string, Summary>, readonly contract: Contract) {}
  requireDatabase() {
    return { exec: (sql: string) => {
      this.log.push(sql);
      if (sql === "BEGIN IMMEDIATE;") {
        this.beforeBegin?.();
        assert.equal(this.inTransaction, false);
        this.inTransaction = true;
      } else {
        assert.equal(this.inTransaction, true);
        this.inTransaction = false;
      }
    } };
  }
  getSummary(_kind: string, date: string) {
    assert.equal(this.inTransaction, true, "owner must be read after BEGIN");
    this.log.push("read:" + date);
    const row = this.rows.get(date);
    return row ? structuredClone(row) : undefined;
  }
  upsertSummary(value: Summary) {
    assert.equal(this.inTransaction, true, "write must occur before COMMIT");
    this.log.push("write:" + value.dateKey);
    if (this.throwOnWrite) throw new Error("synthetic database failure");
    this.rows.set(value.dateKey, structuredClone(value));
  }
  writeDailyReportCache(date: string, cache: Cache, create: () => Summary, expected: string | undefined) {
    return this.contract.guard.call(this, date, cache, create, expected);
  }
}
function fixture() {
  const rows = new Map<string, Summary>();
  const modelStarted = deferred<void>();
  let uuid = 0;
  let modelCalls = 0;
  const prompts: unknown[] = [];
  const contract = runInNewContext(javascript, {
    WeakMap, Date, DOMException,
    randomUUID: () => "unique-generation-" + String(++uuid),
    buildActivitySummary: (target: StoreFixture, _kind: string, date: string) => {
      assert.equal(target.inTransaction, true, "missing-row fallback runs under the same lock");
      target.log.push("factory:" + date);
      return summary(date);
    },
    nativeJsonMessages: (system: string, body: string) => ({ system, body }),
    generateNativeText: async (model: Model, messages: unknown) => {
      modelCalls += 1; prompts.push(messages); modelStarted.resolve();
      return await model.response;
    }
  }, { contextCodeGeneration: { strings: false, wasm: false }, timeout: 1_000 }) as Contract;
  return { rows, contract, target: new StoreFixture(rows, contract), modelStarted, prompts, modelCalls: () => modelCalls };
}

test("summary invalidation rejects delayed narration without recreating report fields", async () => {
  const f = fixture();
  const initial = report();
  assert.equal(f.contract.persist(f.target, initial, now), true);
  const pending = deferred<{ text: string }>();
  const work = f.contract.narrate(initial, { store: f.target, model: { modelId: "fake", response: pending.promise } });
  const rejected = assert.rejects(work, { name: "AbortError" });
  await f.modelStarted.promise;
  const refreshed = summary(initial.date);
  refreshed.summary = "New summary after analysis";
  refreshed.stats.sessionCount = 2;
  f.rows.set(initial.date, structuredClone(refreshed));
  pending.resolve({ text: initial.markdown + "\nDelayed narrative." });
  await rejected;
  assert.deepEqual(f.rows.get(initial.date), refreshed);
  assert.equal(f.rows.get(initial.date)?.stats.reportGeneratedAt, undefined);
  assert.equal(f.target.log.at(-1), "ROLLBACK;");
});

test("same-millisecond forced generations and consumed owners reject older writes", async () => {
  const f = fixture();
  const first = report(); const second = report();
  f.contract.persist(f.target, first, now);
  const firstId = f.rows.get(first.date)?.stats.reportState?.generation;
  f.contract.persist(f.target, second, now);
  const secondId = f.rows.get(second.date)?.stats.reportState?.generation;
  assert.notEqual(firstId, secondId);
  const final = { ...second, markdown: second.markdown + "\nNew narrative." };
  assert.equal(f.contract.persist(f.target, final, now, second), true);
  const saved = structuredClone(f.rows.get(second.date));
  assert.equal(f.contract.persist(f.target, { ...first, markdown: "old" }, now, first), false);
  assert.equal(f.contract.persist(f.target, { ...second, markdown: "duplicate" }, now, second), false);
  assert.deepEqual(f.rows.get(second.date), saved);
});

test("unowned object copies fail closed and missing rows are not rebuilt", () => {
  const f = fixture(); const initial = report();
  f.contract.persist(f.target, initial, now);
  const before = f.target.log.length;
  assert.equal(f.contract.persist(f.target, { ...initial }, now, { ...initial }), false);
  assert.equal(f.target.log.length, before, "missing WeakMap ownership must not call store");
  f.rows.delete(initial.date);
  assert.equal(f.contract.persist(f.target, { ...initial }, now, initial), false);
  assert.equal(f.rows.has(initial.date), false);
  assert.deepEqual(f.target.log.slice(-3), ["BEGIN IMMEDIATE;", "read:" + initial.date, "ROLLBACK;"]);
});

test("first write and narration preserve the latest summary; dates are isolated", () => {
  const f = fixture(); const initial = report();
  const newer = summary(initial.date); newer.summary = "Updated before lock"; newer.stats.marker = "new marker";
  f.target.beforeBegin = () => { f.rows.set(initial.date, structuredClone(newer)); f.target.beforeBegin = undefined; };
  f.contract.persist(f.target, initial, now);
  assert.equal(f.target.log.some((line) => line.startsWith("factory:")), false);
  assert.equal(f.rows.get(initial.date)?.summary, newer.summary);
  assert.equal(f.rows.get(initial.date)?.stats.marker, "new marker");
  const other = report("2026-10-10");
  f.contract.persist(f.target, other, now);
  const final = { ...initial, markdown: initial.markdown + "\nNarration." };
  assert.equal(f.contract.persist(f.target, final, now, initial), true);
  assert.equal(f.rows.get(initial.date)?.model, newer.model);
  assert.equal(f.rows.get(other.date)?.stats.report, other.markdown);
});

test("database error still rolls back and returns the existing narration fallback", async () => {
  const f = fixture(); const initial = report();
  f.contract.persist(f.target, initial, now);
  const saved = structuredClone(f.rows.get(initial.date));
  f.target.throwOnWrite = true;
  const fallback = await f.contract.narrate(initial, {
    store: f.target, model: { modelId: "fake", response: Promise.resolve({ text: initial.markdown + "\nNarration." }) }
  });
  assert.equal(fallback.markdown, initial.markdown);
  assert.equal(fallback.narrativeModel, "fake");
  assert.deepEqual(f.rows.get(initial.date), saved);
  assert.equal(f.target.log.at(-1), "ROLLBACK;");
  assert.equal(f.target.inTransaction, false);
});

test("model, invalid-output, cancellation, and no-store behavior stay unchanged", async () => {
  const f = fixture(); const initial = report();
  f.contract.persist(f.target, initial, now);
  const before = f.target.log.length;
  const invalid = await f.contract.narrate(initial, { store: f.target,
    model: { modelId: "fake", response: Promise.resolve({ text: "too short" }) } });
  assert.equal(invalid.markdown, initial.markdown);
  const failure = await f.contract.narrate(initial, { store: f.target,
    model: { modelId: "fake", response: Promise.reject(new Error("model unavailable")) } });
  assert.equal(failure.markdown, initial.markdown);
  assert.equal(f.target.log.length, before);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.contract.narrate(initial, { signal: controller.signal }), { name: "AbortError" });
  const output = initial.markdown + "\nIndependent narration.";
  assert.equal((await f.contract.narrate({ ...initial }, {
    model: { modelId: "fake", response: Promise.resolve({ text: output }) }
  })).markdown, output);
  assert.doesNotMatch(JSON.stringify(initial), /generation|unique-generation/u);
  assert.doesNotMatch(JSON.stringify(f.prompts), /unique-generation/u);
  assert.equal(f.modelCalls(), 3);
});
