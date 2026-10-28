import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Only source extraction: no React, Electron, Host, storage or service imports.
// Use an external process watchdog in addition to the bounded synchronous VM entries.
const root = path.resolve(process.env.BINY_PROJECT_PREFERENCE_SOURCE_ROOT ?? process.cwd());
const read = (name: string) => ts.createSourceFile(name, readFileSync(path.join(root, name), "utf8"), ts.ScriptTarget.Latest, true, name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const app = read("src/desktop/renderer/src/App.tsx");
const helper = read("src/desktop/renderer/src/app/sessionTreePageLifetime.ts");
function one<T>(items: readonly T[], label: string): T { assert.equal(items.length, 1, label); return items[0]!; }
const component = one(app.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "DesktopApp"), "DesktopApp");
assert.ok(component.body);
const declarations = component.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
const callbacks = ["toggleProjectPinned", "settingsCommitted"].map(name => {
  const declaration = one(declarations.filter(node => node.name.getText(app) === name), name);
  assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
  assert.equal(declaration.initializer.expression.getText(app), "useCallback");
  const callback = declaration.initializer.arguments[0];
  assert.ok(callback && ts.isArrowFunction(callback));
  return { name, callback };
});
const factory = one(helper.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "createSessionTreePageLifetime"), "real catalog lifetime");
const refreshDelay = one(helper.statements.filter(ts.isVariableStatement).filter(statement =>
  statement.declarationList.declarations.some(declaration => declaration.name.getText(helper) === "CATALOG_REFRESH_DELAY_MS")), "real catalog refresh delay");
function target(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${target(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${target(node.expression)}()`;
  assert.fail(`Unexpected callable: ${node.getText()}`);
}
const calls = new Set(["sessionTreePages.captureCatalogProject", "window.biny.setProjectPinned", "window.biny.refreshProject", "window.biny.refreshProject().then", "window.biny.refreshProject().then().catch", "ownsProject", "mergeProjectSnapshot", "setWarning", "errorMessage", "setChatResponse", "adoptAppearance", "normalizeAppearancePreference"]);
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isNewExpression(node));
  if (ts.isCallExpression(node)) assert.ok(calls.has(target(node.expression)), `Unexpected call: ${target(node.expression)}`);
  ts.forEachChild(node, audit);
}
callbacks.forEach(({ callback }) => audit(callback));
// The actual helper is extracted intact, not reimplemented as a test-only owner.
// Its only runtime globals are collections and timers. Timers fail closed below.
const extracted = `${refreshDelay.getText(helper)}\n${factory.getText(helper).replace(/^export\s+/u, "")}\nglobalThis.makeLifetime = createSessionTreePageLifetime;\n${callbacks.map(({ name, callback }) => `globalThis.${name} = ${callback.getText(app)};`).join("\n")}`;
assert.equal(/\b(?:require|process|fetch|eval)\b|import\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal((emitted.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Kind = "pin" | "settings";
type Snapshot = { project: { id: string }; marker: string };
type Owner = { replaceAll(sessions?: unknown[], ids?: string[]): void; replaceProject(id: string, sessions: unknown[]): void; removeProject(id: string): void; observe(id: string, sessions: unknown[]): void };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(kind: Kind) {
  const gate = deferred<Snapshot>();
  const merges: Snapshot[] = [], warnings: string[] = [], appearances: unknown[] = [], responses: unknown[] = [], requests: unknown[][] = [];
  const sandbox: Record<string, unknown> = {
    setTimeout() { assert.fail("No catalog reconciliation timer belongs to these handlers"); }, clearTimeout() { assert.fail("No catalog reconciliation timer belongs to these handlers"); },
    mergeProjectSnapshot(value: Snapshot) { merges.push(value); }, setWarning(value: string) { warnings.push(value); },
    errorMessage: (error: Error) => error.message, normalizeAppearancePreference: (value: unknown) => value,
    adoptAppearance(value: unknown) { appearances.push(value); }, setChatResponse(value: unknown) { responses.push(value); },
    settings: { projectId: "p", chatParams: { response: { streaming: false } }, themePreference: "dark", fontPreference: { family: "system", size: 14 }, appearancePreference: { marker: "saved" } },
    window: { biny: {
      setProjectPinned(id: string, pinned: boolean) { requests.push([id, pinned]); return gate.promise; },
      refreshProject(id: string) { requests.push([id]); return gate.promise; }
    } }
  };
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const run = (code: string) => new Script(code).runInContext(context, { timeout: 1000 });
  run(emitted.outputText);
  run('globalThis.sessionTreePages = makeLifetime(); sessionTreePages.replaceAll([], ["p", "q"]);');
  const owner = sandbox.sessionTreePages as Owner;
  return { gate, merges, warnings, appearances, responses, requests, owner,
    start() { run(kind === "pin" ? 'globalThis.pending = toggleProjectPinned("p", true)' : 'settingsCommitted(settings)'); },
    async finish(failure = false) { if (failure) gate.reject(new Error("Preference unavailable")); else gate.resolve({ project: { id: "p" }, marker: "receipt" }); await setImmediate(); }
  };
}

for (const kind of ["pin", "settings"] as const) {
  for (const failure of [false, true]) {
    test(`${kind}: current ${failure ? "failure" : "success"} remains visible for a collapsed/empty project`, async () => {
      const f = fixture(kind); f.start(); await f.finish(failure);
      assert.deepEqual(f.requests, [kind === "pin" ? ["p", true] : ["p"]]);
      assert.equal(f.merges.length, failure ? 0 : 1); assert.deepEqual(f.warnings, failure ? ["Preference unavailable"] : []);
    });
    for (const retire of ["remove", "recreate", "bootstrap-omission", "unmount"] as const) {
      test(`${kind}: ${retire} retires late ${failure ? "failure" : "success"}`, async () => {
        const f = fixture(kind); f.start();
        if (retire === "unmount") f.owner.replaceAll();
        else if (retire === "bootstrap-omission") f.owner.replaceAll([], ["q"]);
        else { f.owner.removeProject("p"); if (retire === "recreate") f.owner.replaceProject("p", []); }
        await f.finish(failure);
        assert.equal(f.merges.length, 0); assert.equal(f.warnings.length, 0);
        if (kind === "settings") { assert.equal(f.responses.length, 1); assert.equal(f.appearances.length, 1); }
      });
    }
  }
  test(`${kind}: ordinary catalog changes and unrelated removal preserve the owner`, async () => {
    const f = fixture(kind); f.start();
    f.owner.replaceProject("p", []); f.owner.observe("p", []); f.owner.replaceAll([], ["p", "q"]); f.owner.removeProject("q");
    await f.finish(); assert.equal(f.merges.length, 1); assert.deepEqual(f.warnings, []);
  });
  test(`${kind}: a fresh operation on a recreated project retains publication rights`, async () => {
    const f = fixture(kind); f.owner.removeProject("p"); f.owner.replaceProject("p", []);
    f.start(); await f.finish(); assert.equal(f.merges.length, 1);
  });
  test(`${kind}: a pending or rejected removal does not retire an unchanged catalog owner`, async () => {
    const f = fixture(kind); f.start();
    // App retires catalog identity only on successful removal. The complete-App
    // test covers that rejection path; no pretend removal algorithm is used here.
    await f.finish(); assert.equal(f.merges.length, 1);
  });
}
test("saved global appearance and response apply before the project refresh settles", async () => {
  const f = fixture("settings"); f.start();
  assert.equal(f.responses.length, 1); assert.equal(f.appearances.length, 1); assert.equal(f.merges.length, 0);
  f.owner.removeProject("p"); await f.finish();
  assert.equal(f.responses.length, 1); assert.equal(f.appearances.length, 1); assert.equal(f.merges.length, 0);
});
