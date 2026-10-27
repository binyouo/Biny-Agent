/** Execute only the real preview polling effect and toggle closure with inert boundaries. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = path.join(process.env.BINY_PREVIEW_LIFECYCLE_SOURCE_ROOT ?? process.cwd(),
  "src/desktop/renderer/src/components/workspace/WorkspaceBrowserPanel.tsx");
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: ts.ArrowFunction[] = [];
const toggles: ts.ArrowFunction[] = [];
const generationRefs: ts.VariableDeclaration[] = [];
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "previewOperationGeneration") generationRefs.push(node);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
    && node.arguments[0] && ts.isArrowFunction(node.arguments[0])
    && node.arguments[0].getText(source).includes("const refreshStatus =")) effects.push(node.arguments[0]);
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "toggleServer"
    && node.initializer && ts.isArrowFunction(node.initializer)) toggles.push(node.initializer);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(effects.length, 1); assert.equal(toggles.length, 1);
// The unfixed baseline may omit the ref, so it can reach behavioral red assertions.
// If present, validate the actual production declaration rather than trusting the VM seed.
assert.ok(generationRefs.length <= 1);
if (generationRefs[0]) {
  const initializer = generationRefs[0].initializer;
  assert.ok(initializer && ts.isCallExpression(initializer));
  assert.equal(initializer.expression.getText(source), "useRef");
  assert.equal(initializer.arguments.length, 1);
  assert.equal(initializer.arguments[0]!.getText(source), "0");
}
const allowedCalls = new Set([
  "isCurrent", "window.biny.projectPreviewStatus", "window.biny.browserSnapshot", "window.biny.browserAction",
  "window.biny.onTerminalEvent", "window.biny.stopProjectPreview", "window.biny.startProjectPreview",
  "window.biny.projectPreviewAvailability", "window.setInterval", "window.clearInterval", "refreshStatus", "unsubscribe",
  "setServerId", "setStaticUrl", "setServerStarting", "setPreviewFailure", "setServerNotice", "setError", "adopt", "String",
  "openedPreviewUrls.current.clear", "openedPreviewUrls.current.has", "openedPreviewUrls.current.add",
  "pendingPreviewUrls.get", "pendingPreviewUrls.set", "pendingPreviewUrls.delete", "current.tabs.some",
  "exitedServers.current.add", "exitedServers.current.delete", "exitedServers.current.values", "exitedServers.current.values().next",
  "exitedServers.current.has", "previewAvailability.entries.includes", "setHtmlPickerOpen", "setServerBusy",
  "setPreviewAvailability", "setSelectedHtmlFile", "availability.entries.includes"
]);
function check(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Map");
  ts.forEachChild(node, check);
}
check(effects[0]!); check(toggles[0]!);
const emitted = ts.transpileModule(`globalThis.extracted = { effect: ${effects[0]!.getText(source)}, toggle: ${toggles[0]!.getText(source)} };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(|\beval\s*\(/u.test(emitted.outputText), false);

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
interface Snapshot { projectId: string; revision: number; tabs: Array<{ url: string }> }
type Status = { kind: "static"; url: string } | { kind: "stopped" };
const url = "http://localhost:4000/synthetic";
const snap = (existing = false): Snapshot => ({ projectId: "synthetic", revision: 1, tabs: existing ? [{ url }] : [] });
const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };
function fixture() {
  const statusReads: Deferred<Status>[] = [], snapshotReads: Deferred<Snapshot>[] = [], actions: Deferred<Snapshot>[] = [];
  const stops: Deferred<void>[] = [], starts: Deferred<Status>[] = [];
  const actionInputs: unknown[][] = [], adopted: Snapshot[] = [], errors: string[] = [];
  const timers = new Map<number, () => void>(); let timerId = 0; let subscriptions = 0;
  const openedPreviewUrls = { current: new Set<string>() };
  const previewOperationGeneration = { current: 0 }; const serverPending = { current: false };
  const noop = (): void => {};
  const context = vm.createContext({
    active: true, projectId: "synthetic", serverId: undefined, staticUrl: undefined,
    selectedHtmlFile: undefined, previewAvailability: undefined,
    openedPreviewUrls, previewOperationGeneration, serverPending, exitedServers: { current: new Set<string>() }, alive: { current: true },
    setServerId: noop, setStaticUrl: noop, setServerStarting: noop, setPreviewFailure: noop, setServerNotice: noop,
    setHtmlPickerOpen: noop, setServerBusy: noop, setPreviewAvailability: noop, setSelectedHtmlFile: noop,
    setError: (error: string | undefined): void => { if (error !== undefined) errors.push(error); },
    adopt: (next: Snapshot): void => { adopted.push(next); },
    window: { biny: {
      projectPreviewStatus: (): Promise<Status> => { const read = deferred<Status>(); statusReads.push(read); return read.promise; },
      browserSnapshot: (): Promise<Snapshot> => { const read = deferred<Snapshot>(); snapshotReads.push(read); return read.promise; },
      browserAction: (...input: unknown[]): Promise<Snapshot> => { actionInputs.push(input); const action = deferred<Snapshot>(); actions.push(action); return action.promise; },
      onTerminalEvent: (): (() => void) => { subscriptions++; return () => { subscriptions--; }; },
      stopProjectPreview: (): Promise<void> => { const stop = deferred<void>(); stops.push(stop); return stop.promise; },
      startProjectPreview: (): Promise<Status> => { const start = deferred<Status>(); starts.push(start); return start.promise; },
      projectPreviewAvailability: async (): Promise<{ available: false; reason: string }> => ({ available: false, reason: "synthetic" })
    }, setInterval: (callback: () => void): number => { timers.set(++timerId, callback); return timerId; }, clearInterval: (id: number): void => { timers.delete(id); } }
  }, { codeGeneration: { strings: false, wasm: false } });
  // This timeout bounds source installation only. Invocations and deferred callbacks
  // require the external test-process watchdog; they are not covered by this VM limit.
  vm.runInContext(emitted.outputText, context, { timeout: 1000 });
  const extracted = context.extracted as { effect(): () => void; toggle(entry?: string): Promise<void> };
  const cleanups: Array<() => void> = [];
  const mount = (): (() => void) => { const cleanup = extracted.effect(); let done = false; const once = (): void => { if (!done) { done = true; cleanup(); } }; cleanups.push(once); return once; };
  const tick = (): void => { for (const callback of [...timers.values()]) callback(); };
  const ready = async (index = statusReads.length - 1): Promise<void> => { statusReads[index]!.resolve({ kind: "static", url }); await flush(); };
  const dispose = (): void => { cleanups.forEach(cleanup => cleanup()); assert.equal(timers.size, 0); assert.equal(subscriptions, 0); };
  return { context, extracted, mount, tick, ready, dispose, statusReads, snapshotReads, actions, stops, starts,
    actionInputs, adopted, errors, openedPreviewUrls, previewOperationGeneration, serverPending };
}

test("normal new dispatch claims URL synchronously and adopts its result", async () => {
  const f = fixture(); f.mount(); await f.ready();
  assert.equal(f.openedPreviewUrls.current.size, 0);
  f.snapshotReads[0]!.resolve(snap()); await flush();
  assert.equal(f.actions.length, 1); assert.ok(f.openedPreviewUrls.current.has(url));
  f.actions[0]!.resolve(snap(true)); await flush(); assert.equal(f.adopted.length, 1); f.dispose();
});
test("existing tab is remembered without a new dispatch", async () => {
  const f = fixture(); f.mount(); await f.ready(); f.snapshotReads[0]!.resolve(snap(true)); await flush();
  assert.equal(f.actions.length, 0); assert.ok(f.openedPreviewUrls.current.has(url)); f.dispose();
});
test("same-generation same-URL overlapping polls have only one pending snapshot", async () => {
  const f = fixture(); f.mount(); await f.ready(); f.tick(); await f.ready();
  assert.equal(f.snapshotReads.length, 1); f.snapshotReads[0]!.resolve(snap()); await flush();
  assert.equal(f.actions.length, 1); f.actions[0]!.resolve(snap(true)); await flush(); f.dispose();
});
for (const phase of ["status", "snapshot"] as const) {
  test(`hide or unmount while ${phase} is pending cannot dispatch or claim URL`, async () => {
    const f = fixture(); const cleanup = f.mount(); if (phase === "snapshot") await f.ready();
    cleanup();
    if (phase === "status") await f.ready(); else { f.snapshotReads[0]!.resolve(snap()); await flush(); }
    assert.equal(f.actions.length, 0); assert.equal(f.openedPreviewUrls.current.size, 0); f.dispose();
  });
}
test("hidden pending read does not suppress reopening the same URL", async () => {
  const f = fixture(); const cleanup = f.mount(); await f.ready(); cleanup(); f.mount(); await f.ready();
  f.snapshotReads[0]!.resolve(snap()); await flush(); assert.equal(f.actions.length, 0);
  f.snapshotReads[1]!.resolve(snap()); await flush(); assert.equal(f.actions.length, 1);
  f.actions[0]!.resolve(snap(true)); await flush(); f.dispose();
});
for (const finishStop of [false, true]) {
  test(`stop ${finishStop ? "already completed" : "still pending"} invalidates an older snapshot`, async () => {
    const f = fixture(); f.mount(); await f.ready(); f.context.staticUrl = url;
    const stopping = f.extracted.toggle();
    if (finishStop) { f.stops[0]!.resolve(); await stopping; }
    f.snapshotReads[0]!.resolve(snap()); await flush();
    assert.equal(f.actions.length, 0); assert.equal(f.openedPreviewUrls.current.size, 0);
    if (!finishStop) { f.stops[0]!.resolve(); await stopping; }
    assert.equal(f.previewOperationGeneration.current, 1, "accepted stop advances the production operation generation"); f.dispose();
  });
}
test("generation is captured before the initial status read", async () => {
  const f = fixture(); f.mount(); f.context.staticUrl = url; const stopping = f.extracted.toggle();
  f.stops[0]!.resolve(); await stopping; await f.ready();
  assert.equal(f.snapshotReads.length, 0); assert.equal(f.actions.length, 0); f.dispose();
});
test("old finally cannot clear a newer generation reservation", async () => {
  const f = fixture(); f.mount(); await f.ready(); f.context.staticUrl = url;
  const stopping = f.extracted.toggle(); f.stops[0]!.resolve(); await stopping;
  f.tick(); await f.ready(); assert.equal(f.snapshotReads.length, 2);
  f.snapshotReads[0]!.resolve(snap()); await flush();
  f.tick(); await f.ready(); assert.equal(f.snapshotReads.length, 2, "new generation still owns its snapshot reservation");
  f.snapshotReads[1]!.resolve(snap()); await flush(); assert.equal(f.actions.length, 1);
  f.actions[0]!.resolve(snap(true)); await flush(); f.dispose();
});
test("dispatched action survives as an attempted-open claim across hide/reopen, but cannot adopt late", async () => {
  const f = fixture(); const cleanup = f.mount(); await f.ready(); f.snapshotReads[0]!.resolve(snap()); await flush();
  cleanup(); f.mount(); await f.ready(); assert.equal(f.snapshotReads.length, 1); assert.equal(f.actions.length, 1);
  f.actions[0]!.resolve(snap(true)); await flush(); assert.equal(f.adopted.length, 0);
  assert.ok(f.openedPreviewUrls.current.has(url)); f.dispose();
});
test("new action result after stop completion cannot adopt or restore a cleared claim", async () => {
  const f = fixture(); f.mount(); await f.ready(); f.snapshotReads[0]!.resolve(snap()); await flush();
  f.context.staticUrl = url; const stopping = f.extracted.toggle(); f.stops[0]!.resolve(); await stopping;
  f.actions[0]!.resolve(snap(true)); await flush(); assert.equal(f.adopted.length, 0);
  assert.equal(f.openedPreviewUrls.current.size, 0); f.dispose();
});
test("claimed URL is not reopened by subsequent polling (close-handler invariant)", async () => {
  const f = fixture(); f.mount(); await f.ready(); f.snapshotReads[0]!.resolve(snap()); await flush();
  f.actions[0]!.resolve(snap(true)); await flush();
  // The actual close handler does not alter openedPreviewUrls; future snapshots would be empty.
  f.tick(); await f.ready(); assert.equal(f.snapshotReads.length, 1); assert.equal(f.actions.length, 1); f.dispose();
});
test("dispatch failure keeps the existing no-automatic-retry semantics", async () => {
  const f = fixture(); f.mount(); await f.ready(); f.snapshotReads[0]!.resolve(snap()); await flush();
  f.actions[0]!.reject(new Error("synthetic new failure")); await flush();
  assert.ok(f.openedPreviewUrls.current.has(url)); f.tick(); await f.ready();
  assert.equal(f.snapshotReads.length, 1); assert.equal(f.actions.length, 1); assert.equal(f.errors.length, 1); f.dispose();
});
test("snapshot failure releases only its local reservation for the next poll", async () => {
  const f = fixture(); f.mount(); await f.ready(); f.snapshotReads[0]!.reject(new Error("synthetic snapshot failure")); await flush();
  assert.equal(f.openedPreviewUrls.current.size, 0); f.tick(); await f.ready(); assert.equal(f.snapshotReads.length, 2);
  f.snapshotReads[1]!.resolve(snap(true)); await flush(); f.dispose();
});
test("toggle early returns and HTML picker do not invalidate polls", async () => {
  const f = fixture(); f.serverPending.current = true; await f.extracted.toggle(); f.serverPending.current = false;
  f.context.previewAvailability = { available: false, reason: "synthetic" }; await f.extracted.toggle();
  f.context.previewAvailability = { available: true, kind: "static", entries: ["a.html", "b.html"] }; await f.extracted.toggle();
  assert.equal(f.previewOperationGeneration.current, 0); assert.equal(f.starts.length + f.stops.length, 0); f.dispose();
});
test("structural regression: accepted explicit HTML start advances generation and dispatches new", async () => {
  const f = fixture(); const starting = f.extracted.toggle("a.html");
  assert.equal(f.previewOperationGeneration.current, 1); assert.equal(f.starts.length, 1);
  f.starts[0]!.resolve({ kind: "static", url }); await flush(); assert.equal(f.actions.length, 1);
  f.actions[0]!.resolve(snap(true)); await starting; assert.equal(f.serverPending.current, false); f.dispose();
});
