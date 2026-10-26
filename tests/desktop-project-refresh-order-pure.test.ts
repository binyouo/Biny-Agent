import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Source-only extraction: never import React, Electron, IPC, Host, or product services.
// Run under an external process watchdog; VM timeouts bound synchronous entry points.
const root = path.resolve(process.env.BINY_PROJECT_REFRESH_SOURCE_ROOT ?? process.cwd());
const filename = path.join(root, "src/desktop/renderer/src/app/useDesktopEventBridge.ts");
const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T { assert.equal(items.length, 1, label); return items[0]!; }
const hook = one(source.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "useDesktopEventBridge"), "hook");
assert.ok(hook.body);
const effects = hook.body.statements.filter(ts.isExpressionStatement).map(n => n.expression)
  .filter((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText(source) === "useEffect");
assert.equal(effects.length, 2);
const callbacks = effects.map(n => { const callback = n.arguments[0]; assert.ok(callback && ts.isArrowFunction(callback)); return callback; });
const invalidation = one(hook.body.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations])
  .filter(n => n.name.getText(source) === "invalidateProjectRefresh"), "invalidation");
assert.ok(invalidation.initializer && ts.isCallExpression(invalidation.initializer));
const invalidate = invalidation.initializer.arguments[0];
assert.ok(invalidate && ts.isArrowFunction(invalidate));
const allowedCalls = new Set([
  "projectRefreshEpochs.current.set", "projectRefreshEpochs.current.get", "createSessionEventBuffer", "JSON.stringify",
  "refreshTimers.get", "clearTimeout", "setTimeout", "refreshTimers.delete", "refreshTimers.set", "refreshTimers.values", "refreshTimers.clear",
  "projectRefreshOrder.get", "projectRefreshOrder.set", "window.biny.refreshProject", "window.biny.openSession",
  "scheduleRefresh", "mergeProjectSnapshot", "isCurrent", "setPendingRefresh", "onError",
  "setSidebarSessions", "applyUpdatesToSidebarSessions", "batch.filter", "projectBatch.some", "isTerminalRunEvent",
  "onRuntimeProjectionChanged", "setWorkspace", "applyUpdatesToWorkspace",
  "currentEvents.push", "pendingEvents.hold", "pendingEvents.take",
  "currentEvents.unshift", "currentEvents.filter", "setRecipeNotices", "current.map", "recipeNotices.filter", "seen.has",
  "setSkillExtraction", "currentEvents.some", "liveTimelineEvents", "setDocument", "appendLiveTimelineEvents", "hasContextStatus",
  "contextEvents.at", "setContextBudget", "onGenerationStarted", "onGenerationError", "event.error.trim", "event.reason.trim",
  "onCompactionStarted", "onCompactionFailed", "completedSessions.set", "completedSessions.values", "createDesktopEventBatcher",
  "window.biny.onAgentEvent", "unsubscribe", "batcher.dispose", "pendingRefresh.isCurrent", "setWriterConflict"
]);
// Normalize only argument lists, never method names or chain structure. These are
// the exact reviewed chains; arbitrary methods on an allowed call's result fail.
const allowedChains = new Set([
  "window.biny.refreshProject().then", "window.biny.refreshProject().then().catch",
  "onRuntimeProjectionChanged?.().catch", "pendingEvents.take().map",
  "pendingEvents.take().map().filter", "recipeNotices.filter().map"
]);
function callTarget(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    return `${callTarget(expression.expression)}${expression.questionDotToken ? "?." : "."}${expression.name.text}`;
  }
  if (ts.isCallExpression(expression)) {
    return `${callTarget(expression.expression)}${expression.questionDotToken ? "?.()" : "()"}`;
  }
  assert.fail(`unreviewed callee shape: ${expression.getText(source)}`);
}
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    const chain = ts.isPropertyAccessExpression(expression) && ts.isCallExpression(expression.expression);
    assert.ok(chain ? allowedChains.has(callTarget(expression)) : allowedCalls.has(callTarget(expression)), `unreviewed call: ${callTarget(expression)}`);
  }
  if (ts.isNewExpression(node)) assert.ok(["Map", "Set"].includes(node.expression.getText(source)));
  ts.forEachChild(node, audit);
}
for (const node of [...callbacks, invalidate]) audit(node);
const extracted = `globalThis.install = ${callbacks[0]!.getText(source)};\nglobalThis.commit = ${callbacks[1]!.getText(source)};\nglobalThis.invalidate = ${invalidate.getText(source)};`;
assert.equal(/\b(?:require|process|fetch|eval)\b|import\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal((emitted.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);

type Snapshot = { project: { id: string }; sessions: { id: string }[]; label: string };
type Document = { session: { id: string }; events: unknown[]; liveEvents: unknown[]; label?: string; writerConflict?: string };
type Envelope = { projectId: string; event: { type: string; sessionId: string; runId: string; timestamp: string } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const snapshot = (projectId: string, label: string): Snapshot => ({ project: { id: projectId }, sessions: [{ id: label }], label });
async function settle(): Promise<void> { await setImmediate(); }
function fixture() {
  let now = 0, timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const projectReads: { projectId: string; gate: ReturnType<typeof deferred<Snapshot>> }[] = [];
  const documentReads: { projectId: string; sessionId: string; gate: ReturnType<typeof deferred<Document>> }[] = [];
  const merges: Snapshot[] = [], errors: unknown[] = [], conflicts: unknown[] = [];
  let listener: ((event: Envelope) => void) | undefined;
  let disposed = false, unsubscribed = false;
  const activeProjectIdRef = { current: "p" }, selectedSessionIdRef = { current: "a" };
  const documentRef = { current: { session: { id: "a" }, events: [], liveEvents: [] } as Document };
  const noop = () => {};
  const sandbox: Record<string, unknown> = {
    activeProjectIdRef, selectedSessionIdRef, documentRef, projectRefreshEpochs: { current: new Map<string, number>() }, pendingRefresh: undefined,
    setTimeout(callback: () => void, delay: number) { assert.equal(delay, 260); const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    mergeProjectSnapshot(value: Snapshot) { merges.push(value); }, onError(error: unknown) { errors.push(error); },
    setPendingRefresh(value: unknown) { sandbox.pendingRefresh = value; },
    setDocument(value: Document) { documentRef.current = value; }, setWriterConflict(value: unknown) { conflicts.push(value); },
    setSidebarSessions: noop, setWorkspace: noop, setContextBudget: noop, setRecipeNotices: noop, setSkillExtraction: noop,
    onGenerationStarted: noop, onGenerationError: noop, onCompactionStarted: undefined, onCompactionFailed: undefined, onRuntimeProjectionChanged: undefined,
    isTerminalRunEvent: (event: Envelope["event"]) => event.type === "run.completed",
    liveTimelineEvents: () => [], hasContextStatus: () => false,
    createSessionEventBuffer: () => ({ hold: noop, take: () => [] }),
    // The actual event bridge routes these batches; real batcher timing is out of scope.
    createDesktopEventBatcher: (flush: (batch: Envelope[]) => void) => ({ push: (event: Envelope) => { if (!disposed) flush([event]); }, dispose: () => { disposed = true; } }),
    window: { biny: {
      onAgentEvent(callback: (event: Envelope) => void) { listener = callback; return () => { listener = undefined; unsubscribed = true; }; },
      refreshProject(projectId: string) { const gate = deferred<Snapshot>(); projectReads.push({ projectId, gate }); return gate.promise; },
      openSession(projectId: string, sessionId: string) { const gate = deferred<Document>(); documentReads.push({ projectId, sessionId, gate }); return gate.promise; }
    } }
  };
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const run = (code: string) => new Script(code).runInContext(context, { timeout: 1000 });
  run(emitted.outputText);
  run("globalThis.cleanup = install()");
  const tick = async (milliseconds = 260) => {
    now += milliseconds;
    const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      if (!timers.delete(id)) continue;
      sandbox.invoke = timer.callback; run("invoke()");
    }
    await settle();
  };
  const send = (projectId = "p", sessionId = "a") => {
    sandbox.invoke = () => listener?.({ projectId, event: { type: "run.completed", sessionId, runId: "inert", timestamp: "2026-10-01T00:00:00Z" } });
    run("invoke()");
  };
  return { projectReads, documentReads, merges, errors, conflicts, documentRef, activeProjectIdRef, selectedSessionIdRef, timers, send, tick,
    start: async (projectId = "p", sessionId = "a") => { send(projectId, sessionId); await tick(); },
    invalidate: (projectId = "p") => { sandbox.projectId = projectId; run("invalidate(projectId)"); },
    commit: () => run("commit()"), cleanup: () => run("cleanup()"), isUnsubscribed: () => unsubscribed };
}

test("same-project refreshes cannot publish in reverse request order", async () => {
  const f = fixture(); await f.start(); await f.start();
  f.projectReads[1]!.gate.resolve(snapshot("p", "new")); await settle();
  f.projectReads[0]!.gate.resolve(snapshot("p", "old")); await settle();
  assert.deepEqual(f.merges.map(x => x.label), ["new"]);
});
test("background session refresh protects its project catalog without swallowing selected session document read", async () => {
  const f = fixture(); await f.start("p", "a"); await f.start("p", "b");
  f.projectReads[1]!.gate.resolve(snapshot("p", "new")); await settle();
  assert.equal(f.documentReads.length, 0);
  f.projectReads[0]!.gate.resolve(snapshot("p", "old")); await settle();
  assert.deepEqual(f.merges.map(x => x.label), ["new"]);
  assert.deepEqual(f.documentReads.map(x => x.sessionId), ["a"]);
  const doc = { ...f.documentRef.current, label: "persisted a" };
  f.documentReads[0]!.gate.resolve(doc); await settle(); f.commit();
  assert.equal(f.documentRef.current, doc);
});
test("different projects retain independent publication order", async () => {
  const f = fixture(); await f.start("p"); await f.start("q");
  f.projectReads[1]!.gate.resolve(snapshot("q", "q-new")); await settle();
  f.projectReads[0]!.gate.resolve(snapshot("p", "p-old")); await settle();
  assert.deepEqual(f.merges.map(x => x.label), ["q-new", "p-old"]);
});
test("newer failed request still permits an older successful snapshot", async () => {
  const f = fixture(); await f.start(); await f.start();
  f.projectReads[1]!.gate.reject(new Error("inert read failure")); await settle();
  f.projectReads[0]!.gate.resolve(snapshot("p", "usable")); await settle();
  assert.deepEqual(f.merges.map(x => x.label), ["usable"]); assert.equal(f.errors.length, 1);
});
test("metadata-invalidated response reschedules without publishing or advancing applied order", async () => {
  const f = fixture(); await f.start(); await f.start(); f.invalidate();
  f.projectReads[1]!.gate.resolve(snapshot("p", "stale-newer")); await settle();
  assert.equal(f.merges.length, 0); assert.equal(f.documentReads.length, 0);
  f.projectReads[0]!.gate.resolve(snapshot("p", "stale-older")); await settle();
  assert.equal(f.timers.size, 1, "same-scope rereads remain debounced");
  await f.tick(); assert.equal(f.projectReads.length, 3);
  f.projectReads[2]!.gate.resolve(snapshot("p", "current")); await settle();
  assert.deepEqual(f.merges.map(x => x.label), ["current"]);
  await f.tick(1040); assert.equal(f.projectReads.length, 3);
});
test("document generation and identity guards remain effective", async () => {
  const f = fixture(); await f.start(); await f.start();
  f.projectReads[0]!.gate.resolve(snapshot("p", "first")); await settle();
  f.projectReads[1]!.gate.resolve(snapshot("p", "second")); await settle();
  const doc = { ...f.documentRef.current, label: "new doc" };
  f.documentReads[1]!.gate.resolve(doc); await settle();
  f.documentReads[0]!.gate.resolve({ ...doc, label: "old doc" }); await settle(); f.commit();
  assert.equal(f.documentRef.current, doc);
  await f.start(); f.projectReads[2]!.gate.resolve(snapshot("p", "third")); await settle();
  const replacement = { ...doc, label: "user changed version" }; f.documentRef.current = replacement;
  f.documentReads[2]!.gate.resolve({ ...doc, label: "stale version" }); await settle(); f.commit();
  assert.equal(f.documentRef.current, replacement);
});
test("burst debounces and cleanup cancels timers and in-flight publication", async () => {
  const f = fixture(); f.send(); f.send(); f.send(); assert.equal(f.timers.size, 1); await f.tick();
  assert.equal(f.projectReads.length, 1); f.send(); f.cleanup();
  assert.equal(f.timers.size, 0); assert.equal(f.isUnsubscribed(), true);
  f.projectReads[0]!.gate.resolve(snapshot("p", "disposed")); await settle(); await f.tick();
  assert.equal(f.merges.length, 0); assert.equal(f.documentReads.length, 0); assert.equal(f.errors.length, 0);
});
