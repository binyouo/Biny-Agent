/** AST-extracted UI handlers only; no component import, React, bridge, memory store or deletion. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("SettingsMemory.tsx", readFileSync(join(process.cwd(),
  "src/desktop/renderer/src/components/settings/SettingsMemory.tsx"
), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "SettingsMemory");
assert.ok(component?.body);
function declaration(name: string): string {
  const matches = component!.body!.statements.filter(ts.isVariableStatement)
    .flatMap(node => [...node.declarationList.declarations])
    .filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, name);
  return `const ${matches[0]!.getText(source)};`;
}
const errorMessage = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "errorMessage");
assert.ok(errorMessage);
const extracted = `${errorMessage.getText(source)}\n${["searchRequestRef", "pendingSearchRef", "search", "clearAll"].map(declaration).join("\n")}`;
const allowedCalls = new Set([
  "String", "useRef", "query.trim", "window.confirm", "onSearch", "onNotify", "errorMessage",
  "setSearchResults", "setSearching", "onClearMemory", "setStats", "reload", "setSaving"
]);
const extractedAst = ts.createSourceFile("handlers.ts", extracted, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function inspectCalls(node: ts.Node): void {
  assert.equal(ts.isNewExpression(node), false, "Extracted handlers must not construct capabilities");
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(extractedAst);
    assert.ok(allowedCalls.has(callee), `Unexpected extracted call: ${callee}`);
  }
  ts.forEachChild(node, inspectCalls);
}
inspectCalls(extractedAst);
const emitted = ts.transpileModule(`
${extracted}
globalThis.handlers = { search, clearAll, searchRequestRef, pendingSearchRef };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b/.test(emitted.outputText), false);
const script = new Script(emitted.outputText);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Flush cross-realm Promise continuations; this fixture never mounts React.
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
interface Match { id: string; excerpt: string }
interface Handlers {
  search(): Promise<void>;
  clearAll(): Promise<void>;
  searchRequestRef: { current: number };
  pendingSearchRef: { current: string | undefined };
}
function fixture(options: { confirm?: boolean; holdReload?: boolean } = {}) {
  const searches: Array<{ query: string; gate: ReturnType<typeof deferred<Match[]>> }> = [];
  const clear = deferred<{ total: number }>();
  const reload = deferred<void>();
  const state = { results: [] as Match[], searching: false, saving: false, notifications: [] as string[], clearCalls: 0, reloadCalls: 0 };
  const context = createContext({
    Error,
    hidden: false, workspaceAvailable: true, query: "same-query", stats: { total: 1 },
    saving: false, totalEntries: 1, archivedTotal: 0,
    useRef: <T>(value: T) => ({ current: value }),
    window: { confirm: () => options.confirm !== false },
    onSearch: (query: string) => { const gate = deferred<Match[]>(); searches.push({ query, gate }); return gate.promise; },
    onClearMemory: () => { state.clearCalls++; return clear.promise; },
    reload: () => { state.reloadCalls++; return options.holdReload ? reload.promise : Promise.resolve(); },
    setStats: (value: unknown) => { context.stats = value; },
    setSearchResults: (value: Match[]) => { state.results = Array.from(value); },
    setSearching: (value: boolean) => { state.searching = value; },
    setSaving: (value: boolean) => { context.saving = value; state.saving = value; },
    onNotify: (message: string) => { state.notifications.push(message); }
  }, { codeGeneration: { strings: false, wasm: false } });
  // This limits synchronous loading only; the runner still needs an external watchdog.
  script.runInContext(context, { timeout: 1_000 });
  const handlers = context.handlers as Handlers;
  return { state, searches, clear, reload, handlers };
}
const oldMatch: Match = { id: "old", excerpt: "deleted memory" };
const freshMatch: Match = { id: "fresh", excerpt: "current memory" };

for (const timing of ["before", "during"] as const) {
  for (const outcome of ["success", "rejection"] as const) {
    test(`successful clear retires ${timing}-clear search ${outcome} without a stuck spinner`, async () => {
      const h = fixture();
      const old = timing === "before" ? h.handlers.search() : undefined;
      const clearing = h.handlers.clearAll();
      const pending = old ?? h.handlers.search();
      assert.equal(h.state.searching, true);
      h.clear.resolve({ total: 0 }); await clearing;
      if (outcome === "success") h.searches[0]!.gate.resolve([oldMatch]);
      else h.searches[0]!.gate.reject(new Error("obsolete search failed"));
      await pending;
      assert.deepEqual(h.state.results, []);
      assert.deepEqual(h.state.notifications, []);
      assert.equal(h.state.searching, false);
      assert.equal(h.handlers.pendingSearchRef.current, undefined);
      assert.equal(h.state.saving, false);
      assert.equal(h.state.reloadCalls, 1);
    });

    for (const freshState of ["pending", "settled"] as const) {
      test(`${timing}-clear ${outcome}/finally cannot affect a fresh ${freshState} search`, async () => {
        const h = fixture();
        const old = timing === "before" ? h.handlers.search() : undefined;
        const clearing = h.handlers.clearAll();
        const pending = old ?? h.handlers.search();
        h.clear.resolve({ total: 0 }); await clearing;
        // Same query must be accepted again: the retired pending dedupe key is gone.
        const fresh = h.handlers.search();
        assert.equal(h.searches.length, 2);
        if (freshState === "settled") { h.searches[1]!.gate.resolve([freshMatch]); await fresh; }
        if (outcome === "success") h.searches[0]!.gate.resolve([oldMatch]);
        else h.searches[0]!.gate.reject(new Error("obsolete search failed"));
        await pending;
        assert.deepEqual(h.state.notifications, []);
        if (freshState === "pending") {
          assert.equal(h.state.searching, true);
          assert.equal(h.handlers.pendingSearchRef.current, "same-query");
          assert.deepEqual(h.state.results, []);
          h.searches[1]!.gate.resolve([freshMatch]); await fresh;
        }
        assert.deepEqual(h.state.results, [freshMatch]);
        assert.equal(h.state.searching, false);
        assert.equal(h.handlers.pendingSearchRef.current, undefined);
      });
    }
  }
}

test("clear failure preserves the pending search owner and its result", async () => {
  const h = fixture();
  const searching = h.handlers.search();
  const owner = h.handlers.searchRequestRef.current;
  const clearing = h.handlers.clearAll();
  h.clear.reject(new Error("clear failed")); await clearing;
  assert.equal(h.handlers.searchRequestRef.current, owner);
  assert.equal(h.handlers.pendingSearchRef.current, "same-query");
  assert.equal(h.state.searching, true);
  h.searches[0]!.gate.resolve([oldMatch]); await searching;
  assert.deepEqual(h.state.results, [oldMatch]);
  assert.deepEqual(h.state.notifications, ["clear failed"]);
  assert.equal(h.state.reloadCalls, 0);
  assert.equal(h.state.saving, false);
  assert.equal(h.state.searching, false);
});

test("declining confirmation does not clear or retire a search", async () => {
  const h = fixture({ confirm: false });
  const searching = h.handlers.search();
  const owner = h.handlers.searchRequestRef.current;
  await h.handlers.clearAll();
  assert.equal(h.state.clearCalls, 0);
  assert.equal(h.handlers.searchRequestRef.current, owner);
  h.searches[0]!.gate.resolve([oldMatch]); await searching;
  assert.deepEqual(h.state.results, [oldMatch]);
});

test("successful clear clears settled results and retires searches before reload finishes", async () => {
  const h = fixture({ holdReload: true });
  const initial = h.handlers.search();
  h.searches[0]!.gate.resolve([oldMatch]); await initial;
  const clearing = h.handlers.clearAll();
  const old = h.handlers.search();
  h.clear.resolve({ total: 0 });
  await flush(); // clearAll has entered the inert, still-pending reload.
  assert.equal(h.state.reloadCalls, 1);
  assert.deepEqual(h.state.results, []);
  assert.equal(h.state.searching, false);
  const fresh = h.handlers.search();
  assert.equal(h.searches.length, 3);
  h.searches[1]!.gate.resolve([oldMatch]); await old;
  assert.equal(h.state.searching, true);
  h.searches[2]!.gate.resolve([freshMatch]); await fresh;
  h.reload.resolve(); await clearing;
  assert.deepEqual(h.state.results, [freshMatch]);
  assert.equal(h.state.searching, false);
  assert.equal(h.state.saving, false);
});
