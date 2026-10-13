import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Pure cache-contract coverage: source text is read, never imported. Synthetic
// fingerprints and byte lengths do not allocate or read a large session file.
const root = process.env.BINY_PARSE_CACHE_SOURCE_ROOT ?? process.cwd();
const file = process.env.BINY_PARSE_CACHE_BASELINE ?? path.join(root, "src/session/parseCache.ts");
const parsed = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const variableNames = ["maxCachedSessions", "maxCachedSourceBytes", "cache", "cachedSourceBytes"];
const functionNames = ["previousSessionParse", "sessionFileFingerprint", "lookupSessionEvents", "store", "cachedSessionEvents", "clearSessionParseCache", "sameSessionFingerprint"];
const selected: ts.Statement[] = [];
for (const name of [...variableNames, ...functionNames]) {
  const matches = parsed.statements.filter(node => ts.isFunctionDeclaration(node)
    ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name));
  assert.equal(matches.length, 1, `one declaration for ${name}`);
  const node = matches[0]!;
  if (ts.isVariableStatement(node)) assert.equal(node.declarationList.declarations.length, 1);
  selected.push(node);
}
const calls = new Set(["cache.get", "cache.delete", "cache.set", "Math.max", "cache.keys", "cache.keys().next",
  "sameSessionFingerprint", "lookupSessionEvents", "load", "store", "cache.clear"]);
for (const node of selected) {
  const visit = (child: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(child) && !ts.isAwaitExpression(child));
    if (ts.isNewExpression(child)) {
      assert.equal(child.expression.getText(parsed), "Map");
      assert.equal(child.arguments?.length ?? 0, 0);
    }
    if (ts.isCallExpression(child)) assert.ok(calls.has(child.expression.getText(parsed)), `unreviewed call: ${child.expression.getText(parsed)}`);
    ts.forEachChild(child, visit);
  };
  visit(node);
}
const source = selected.map(node => node.getText(parsed).replace(/^export /u, "")).join("\n") + `
({ previousSessionParse, sessionFileFingerprint, lookupSessionEvents, store, cachedSessionEvents, clearSessionParseCache,
  limits: { count: maxCachedSessions, bytes: maxCachedSourceBytes },
  state() { return { count: cache.size, bytes: cachedSourceBytes }; }
});`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
interface Fingerprint { size: number; mtimeMs: number; ctimeMs?: number; dev?: number; ino?: number }
interface Event { type: string; content: string }
interface Source { bytes: { length: number }; newlineCount: number }
interface Loaded { events: Event[]; complete: boolean; source?: Source }
interface Entry { events: Event[]; fingerprint: Fingerprint; source?: Source; weight: number }
interface Pure {
  previousSessionParse(file: string): Entry | undefined;
  sessionFileFingerprint(stat: Fingerprint): Fingerprint;
  lookupSessionEvents(file: string, fingerprint: Fingerprint): Event[] | undefined;
  store(file: string, fingerprint: Fingerprint, events: Event[], source?: Source): void;
  cachedSessionEvents(file: string, fingerprint: Fingerprint, load: () => Loaded): Event[];
  clearSessionParseCache(): void;
  limits: { count: number; bytes: number };
  state(): { count: number; bytes: number };
}
const api = runInNewContext(compiled.outputText, {}, {
  timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
}) as Pure;
assert.equal(api.limits.bytes, 64 * 1024 * 1024);
assert.equal(api.limits.count, 32);
const cap = api.limits.bytes;
const fingerprint = (size: number, mtimeMs = 1): Fingerprint => ({ size, mtimeMs, ctimeMs: mtimeMs, dev: 1, ino: 1 });
function lazy(label: string, complete = true, source?: Source) {
  let calls = 0;
  const events: Event[] = [{ type: "user_message", content: label }];
  Object.freeze(events[0]); Object.freeze(events);
  return { events, calls: () => calls, load: (): Loaded => { calls++; return { events, complete, source }; } };
}
function put(name: string, size = 1): Event[] {
  const loader = lazy(name);
  return api.cachedSessionEvents(name, fingerprint(size), loader.load);
}

test("oversized complete entry preserves healthy A/B and loader identity", () => {
  api.clearSessionParseCache();
  const a = put("A"); const b = put("B"); const c = lazy("C");
  assert.equal(api.cachedSessionEvents("C", fingerprint(cap + 1), c.load), c.events);
  assert.equal(c.calls(), 1);
  assert.equal(api.lookupSessionEvents("C", fingerprint(cap + 1)), undefined);
  assert.equal(api.lookupSessionEvents("A", fingerprint(1)), a);
  assert.equal(api.lookupSessionEvents("B", fingerprint(1)), b);
  assert.equal(api.state().bytes, 2);
});

test("oversized same-path replacement removes the old prefix before declining admission", () => {
  api.clearSessionParseCache();
  const prefix = { bytes: { length: 2 }, newlineCount: 1 };
  const old = lazy("old", true, prefix);
  api.store("same", fingerprint(2), old.events, prefix);
  const healthy = put("healthy");
  // Directly exercise the real private store to prove removal ordering, rather
  // than relying only on the public lookup's earlier fingerprint invalidation.
  api.store("same", fingerprint(cap + 1, 2), lazy("new").events);
  assert.equal(api.previousSessionParse("same"), undefined);
  assert.equal(api.lookupSessionEvents("same", fingerprint(2)), undefined);
  assert.equal(api.lookupSessionEvents("healthy", fingerprint(1)), healthy);
  assert.equal(api.state().bytes, 1);
});

test("an entry exactly equal to the byte cap remains cacheable", () => {
  api.clearSessionParseCache();
  put("old"); const loader = lazy("exact");
  const value = api.cachedSessionEvents("exact", fingerprint(cap), loader.load);
  assert.equal(api.cachedSessionEvents("exact", fingerprint(cap), loader.load), value);
  assert.equal(loader.calls(), 1);
  assert.equal(api.state().count, 1);
  assert.equal(api.state().bytes, cap);
  assert.equal(api.previousSessionParse("old"), undefined);
});

test("retained source bytes count toward admission without allocating those bytes", () => {
  api.clearSessionParseCache();
  // This is the generic cache contract. Current readers only retain actual
  // source buffers for files <=16MiB; it is not a 32MiB production threshold.
  const exact = lazy("source-exact", true, { bytes: { length: cap / 2 }, newlineCount: 1 });
  api.cachedSessionEvents("exact", fingerprint(cap / 2), exact.load);
  assert.equal(api.state().bytes, cap);
  assert.equal(api.lookupSessionEvents("exact", fingerprint(cap / 2)), exact.events);
  api.clearSessionParseCache(); const healthy = put("healthy");
  const oversized = lazy("source-large", true, { bytes: { length: cap / 2 + 1 }, newlineCount: 1 });
  assert.equal(api.cachedSessionEvents("large", fingerprint(cap / 2), oversized.load), oversized.events);
  assert.equal(api.previousSessionParse("large"), undefined);
  assert.equal(api.lookupSessionEvents("healthy", fingerprint(1)), healthy);
  assert.equal(api.state().bytes, 1);
});

test("ordinary count eviction preserves hit-updated LRU ordering", () => {
  api.clearSessionParseCache();
  const entries = Array.from({ length: 32 }, (_, index) => put(String(index)));
  assert.equal(api.lookupSessionEvents("0", fingerprint(1)), entries[0]);
  put("32");
  assert.equal(api.previousSessionParse("1"), undefined);
  assert.equal(api.lookupSessionEvents("0", fingerprint(1)), entries[0]);
  assert.equal(api.state().count, 32);
  assert.equal(api.state().bytes, 32);
});

test("ordinary byte eviction retains the newest fitting entries", () => {
  api.clearSessionParseCache();
  const half = cap / 2;
  put("A", half); const b = put("B", half); const c = put("C", 1);
  assert.equal(api.previousSessionParse("A"), undefined);
  assert.equal(api.lookupSessionEvents("B", fingerprint(half)), b);
  assert.equal(api.lookupSessionEvents("C", fingerprint(1)), c);
  assert.equal(api.state().bytes, half + 1);
});

test("fingerprint changes invalidate and clear stale parse/source weight", () => {
  for (const field of ["size", "mtimeMs", "ctimeMs", "dev", "ino"] as const) {
    api.clearSessionParseCache();
    const original = fingerprint(10);
    const first = lazy("first", true, { bytes: { length: 10 }, newlineCount: 1 });
    api.cachedSessionEvents("entry", original, first.load);
    const changed = { ...original, [field]: (original[field] ?? 0) + 1 };
    assert.equal(api.lookupSessionEvents("entry", changed), undefined);
    assert.equal(api.previousSessionParse("entry"), undefined);
    assert.equal(api.state().bytes, 0);
    const next = lazy("next");
    assert.equal(api.cachedSessionEvents("entry", changed, next.load), next.events);
    assert.equal(api.cachedSessionEvents("entry", changed, next.load), next.events);
    assert.equal(next.calls(), 1);
    const copied = api.sessionFileFingerprint(changed);
    for (const key of ["size", "mtimeMs", "ctimeMs", "dev", "ino"] as const) assert.equal(copied[key], changed[key]);
    assert.notEqual(copied, changed);
  }
});

test("incomplete loads are returned but never cached or charged", () => {
  api.clearSessionParseCache(); const healthy = put("healthy"); const incomplete = lazy("tail", false);
  for (let index = 0; index < 3; index++) assert.equal(api.cachedSessionEvents("tail", fingerprint(cap + 1), incomplete.load), incomplete.events);
  assert.equal(incomplete.calls(), 3);
  assert.equal(api.previousSessionParse("tail"), undefined);
  assert.equal(api.lookupSessionEvents("healthy", fingerprint(1)), healthy);
  assert.equal(api.state().bytes, 1);
});

test("repeated oversized complete loads return each current result without disturbing healthy cache", () => {
  api.clearSessionParseCache(); const healthy = put("healthy"); let loads = 0;
  for (let index = 0; index < 3; index++) {
    const current = lazy(`large-${index}`);
    assert.equal(api.cachedSessionEvents("large", fingerprint(cap + 1), () => { loads++; return current.load(); }), current.events);
    assert.equal(api.previousSessionParse("large"), undefined);
  }
  assert.equal(loads, 3);
  assert.equal(api.lookupSessionEvents("healthy", fingerprint(1)), healthy);
  assert.equal(api.state().bytes, 1);
  api.clearSessionParseCache();
  assert.equal(api.state().count, 0); assert.equal(api.state().bytes, 0);
});
