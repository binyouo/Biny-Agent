import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Parse only: no App/React, Electron, Task, Host, database or transport imports.
// Run this focused file under an external process watchdog as well as test timeouts.
const source = ts.createSourceFile("App.tsx", readFileSync(path.join(process.cwd(),
  "src/desktop/renderer/src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const apps = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "DesktopApp");
assert.equal(apps.length, 1, "Select DesktopApp, not the App routing wrapper");
const body = apps[0]!.body!;
function variable(name: string, optional = false): ts.VariableDeclaration | undefined {
  const matches = body.statements.flatMap(statement => ts.isVariableStatement(statement)
    ? [...statement.declarationList.declarations] : []).filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  if (optional && matches.length === 0) return undefined;
  assert.equal(matches.length, 1, `Expected one DesktopApp declaration: ${name}`);
  return matches[0]!;
}
const requestRef = variable("runtimeProjectionRequest", true); // Baseline must fail behavior, not extraction.
const refresh = variable("refreshRuntimeProjection")!;
const selected = [...(requestRef ? [requestRef] : []), refresh];
const calls = new Set(["useRef", "useCallback", "window.biny.runtimeProjection", "setWorkspace"]);
function audit(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  assert.equal(ts.isNewExpression(node) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node), false);
  ts.forEachChild(node, audit);
}
selected.forEach(audit);
const extracted = selected.map(node => `const ${node.getText(source)};`).join("\n")
  + "\nglobalThis.read = refreshRuntimeProjection;";
assert.equal(/\b(?:require|process|fetch|eval|Function|setTimeout|setInterval)\b|import\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);
const compiled = new Script(emitted.outputText);

type Projection = { tasks: { tasks: Array<{ taskRunId: string; status: string }> }; graphs: Array<{ graphId: string; status: string }> };
type Workspace = { project: { id: string }; runtimeProjection: Projection; marker: object };
function projection(status: string): Projection {
  return { tasks: { tasks: [{ taskRunId: "task", status }] }, graphs: [{ graphId: "graph", status }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const projectRef = { current: "a" as string | undefined };
  const loadRequestRef = { current: 1 };
  let current: Workspace | undefined = { project: { id: "a" }, runtimeProjection: projection("completed"), marker: {} };
  const queued: Array<(value: Workspace | undefined) => Workspace | undefined> = [];
  const reads: Array<{ projectId: string; gate: ReturnType<typeof deferred<Projection>> }> = [];
  const context = createContext({
    projectRef, loadRequestRef,
    useRef: (value: unknown) => ({ current: value }), useCallback: (callback: unknown) => callback,
    window: { biny: { runtimeProjection(projectId: string) {
      const gate = deferred<Projection>(); reads.push({ projectId, gate }); return gate.promise;
    } } },
    setWorkspace: (update: (value: Workspace | undefined) => Workspace | undefined) => { queued.push(update); }
  }, { codeGeneration: { strings: false, wasm: false } });
  compiled.runInContext(context, { timeout: 1000 });
  const read = (): Promise<void> => new Script("read()").runInContext(context, { timeout: 1000 }) as Promise<void>;
  const flush = (): void => {
    // Execute the real React updater after the async callback settled, never inline in setWorkspace.
    for (const update of queued.splice(0)) current = update(current);
  };
  return { read, reads, flush, current: () => current, queued: () => queued.length,
    navigate(projectId?: string) {
      loadRequestRef.current += 1; projectRef.current = projectId;
      current = projectId ? { project: { id: projectId }, runtimeProjection: projection("completed"), marker: {} } : undefined;
    }
  };
}
const options = { timeout: 1000 };

test("normal refresh preserves unrelated workspace fields; no project performs no IPC", options, async () => {
  const f = fixture(); const marker = f.current()!.marker; const fresh = projection("running");
  const pending = f.read(); assert.equal(f.reads[0]!.projectId, "a");
  f.reads[0]!.gate.resolve(fresh); await pending;
  assert.equal(f.queued(), 1); f.flush();
  assert.equal(f.current()!.runtimeProjection, fresh); assert.equal(f.current()!.marker, marker);
  f.navigate(); await f.read(); f.flush(); assert.equal(f.reads.length, 1); assert.equal(f.current(), undefined);
});

test("older running task and graph cannot replace newer completed projection", options, async () => {
  const f = fixture(); const old = f.read(); const latest = f.read(); const terminal = projection("completed");
  f.reads[1]!.gate.resolve(terminal); await latest; f.flush();
  const visible = f.current();
  f.reads[0]!.gate.resolve(projection("running")); await old; f.flush();
  assert.equal(f.current(), visible); assert.equal(f.current()!.runtimeProjection, terminal);
});

test("latest-issued failure propagates original error and does not revive an older success", options, async () => {
  const f = fixture(); const visible = f.current(); const old = f.read(); const latest = f.read();
  const failure = new Error("synthetic read failure");
  const rejected = assert.rejects(latest, error => error === failure);
  f.reads[1]!.gate.reject(failure); await rejected;
  f.reads[0]!.gate.resolve(projection("running")); await old; f.flush();
  assert.equal(f.current(), visible);
});

for (const route of [["b"], ["b", "a"], ["a"]]) {
  test(`pending read retires on navigation ${route.join(" -> ")}`, options, async () => {
    const f = fixture(); const pending = f.read(); route.forEach(id => f.navigate(id)); const visible = f.current();
    f.reads[0]!.gate.resolve(projection("running")); await pending; f.flush();
    assert.equal(f.current(), visible);
    // The new navigation is still allowed to refresh normally.
    const fresh = projection("queued"); const next = f.read();
    f.reads[1]!.gate.resolve(fresh); await next; f.flush(); assert.equal(f.current()!.runtimeProjection, fresh);
  });
}

test("queued response is rechecked when a newer request starts before React commits", options, async () => {
  const f = fixture(); const visible = f.current(); const old = f.read();
  f.reads[0]!.gate.resolve(projection("running")); await old; assert.equal(f.queued(), 1);
  const latest = f.read(); f.flush(); assert.equal(f.current(), visible);
  const fresh = projection("completed"); f.reads[1]!.gate.resolve(fresh); await latest; f.flush();
  assert.equal(f.current()!.runtimeProjection, fresh);
});

for (const route of [["b"], ["b", "a"], ["a"]]) {
  test(`queued updater retires after navigation ${route.join(" -> ")}`, options, async () => {
    const f = fixture(); const pending = f.read();
    f.reads[0]!.gate.resolve(projection("running")); await pending; assert.equal(f.queued(), 1);
    route.forEach(id => f.navigate(id)); const visible = f.current(); f.flush(); assert.equal(f.current(), visible);
  });
}

test("a lone failure remains observable and leaves the visible snapshot untouched", options, async () => {
  const f = fixture(); const visible = f.current(); const pending = f.read(); const failure = new Error("offline");
  const rejected = assert.rejects(pending, error => error === failure);
  f.reads[0]!.gate.reject(failure); await rejected; f.flush(); assert.equal(f.current(), visible);
});

test("static wiring evidence: runtime refresh is separate from plan events and navigation advances its epoch", () => {
  assert.match(body.getText(source), /onRuntimeRefresh=\{refreshRuntimeProjection\}/u);
  assert.match(variable("mutateRuntime")!.getText(source), /else await refreshRuntimeProjection\(\)/u);
  assert.match(variable("invalidateProjectRefresh")!.getText(source), /onRuntimeProjectionChanged: refreshPlans/u);
  assert.match(variable("selectProject")!.getText(source), /loadRequestRef\.current \+= 1/u);
  for (const name of ["selectProject", "openNavigationTarget", "openSession", "adoptWorkspace"]) {
    const text = variable(name)!.getText(source);
    assert.match(text, /loadRequestRef\.current \+ 1/u); assert.match(text, /loadRequestRef\.current = request/u);
  }
});
