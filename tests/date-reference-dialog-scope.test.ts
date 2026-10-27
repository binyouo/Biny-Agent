import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Source extraction only: no component import, real IPC, calendar, model, or store.
const source = ts.createSourceFile("dialog.tsx", readFileSync("src/desktop/renderer/src/components/overlays/DateReferenceDetailDialog.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "DateReferenceDetailDialog");
assert.ok(component && ts.isFunctionDeclaration(component) && component.body);
const statements = component.body.statements;
const end = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === "sessions"));
assert.ok(end > 0);
const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "message");
assert.ok(helper);
const extracted = `${helper.getText(source)}\nfunction render(projectId: string, uri: string) {\n${statements.slice(0, end).map(node => node.getText(source)).join("\n")}\nreturn { load, readCalendar, indexOriginal }; }`;
// Review the exact source executed below, not a neighboring source fragment.
const extractedAst = ts.createSourceFile("extracted.ts", extracted, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const allowedCalls = new Set([
  "String", "Boolean", "useState", "useRef", "useCallback", "useLayoutEffect", "useEffect", "load", "isCurrent", "message",
  "setDetail", "setError", "setCalendar", "setCalendarError", "setCalendarBusy", "setIndexBusy", "setIndexError", "setIndexStatus",
  "window.biny.referenceDateDetail", "window.biny.referenceDateCalendar", "window.biny.referenceIndexOriginal", "window.biny.referenceCancelIndex", "crypto.randomUUID"
]);
function checkCalls(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(extractedAst)), `Unexpected executed call: ${node.expression.getText(extractedAst)}`);
  if (ts.isNewExpression(node)) assert.fail(`Unexpected executed constructor: ${node.expression.getText(extractedAst)}`);
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) assert.fail("Imports are not allowed in extracted code");
  ts.forEachChild(node, checkCalls);
}
checkCalls(extractedAst);
const executable = stripTypeScriptTypes(extracted, { mode: "strip" });
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const values: unknown[] = [];
  const writes: number[] = [];
  const refs: { current: unknown }[] = [];
  let stateSlot = 0, refSlot = 0, callbackSlot = 0, sequence = 0;
  const callbacks: { callback: unknown; deps: unknown[] }[] = [];
  let effectDeps: unknown[] | undefined;
  let nextEffect: { setup: () => () => void; deps: unknown[] } | undefined;
  const sameDeps = (left: unknown[] | undefined, right: unknown[]): boolean => Boolean(left && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
  const effect = (setup: () => () => void, deps: unknown[]): void => { if (!sameDeps(effectDeps, deps)) nextEffect = { setup, deps }; };
  let cleanup: (() => void) | undefined;
  const details: string[][] = [];
  const calendars: ReturnType<typeof deferred>[] = [];
  const indexes: ReturnType<typeof deferred>[] = [];
  const canceled: string[] = [];
  const context = vm.createContext({
    useState: () => {
      const slot = stateSlot++;
      return [values[slot], (value: unknown) => { values[slot] = value; writes.push(slot); }];
    },
    useRef: (initial: unknown) => refs[refSlot++] ?? (refs[refSlot - 1] = { current: initial }),
    useCallback: (callback: unknown, deps: unknown[]) => {
      const slot = callbackSlot++;
      if (!sameDeps(callbacks[slot]?.deps, deps)) callbacks[slot] = { callback, deps };
      return callbacks[slot]!.callback;
    },
    useLayoutEffect: effect,
    useEffect: effect,
    crypto: { randomUUID: () => `fake-index-${++sequence}` },
    window: { biny: {
      referenceDateDetail: async (project: string, uri: string) => { details.push([project, uri]); return { marker: `${project}/${uri}` }; },
      referenceDateCalendar: () => { const pending = deferred(); calendars.push(pending); return pending.promise; },
      referenceIndexOriginal: () => { const pending = deferred(); indexes.push(pending); return pending.promise; },
      referenceCancelIndex: async (id: string) => { canceled.push(id); return true; }
    } }
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(executable, context, { timeout: 1_000 });
  type Controls = { load(): Promise<void>; readCalendar(): Promise<void>; indexOriginal(id: string): Promise<void> };
  return { values, writes, details, calendars, indexes, canceled,
    render(project: string, uri: string): Controls {
      stateSlot = 0; refSlot = 0; callbackSlot = 0; nextEffect = undefined;
      context.project = project; context.uri = uri;
      const controls = vm.runInContext("render(project, uri)", context, { timeout: 1_000 }) as Controls;
      const pendingEffect = nextEffect as { setup: () => () => void; deps: unknown[] } | undefined;
      if (pendingEffect) { cleanup?.(); effectDeps = pendingEffect.deps; cleanup = pendingEffect.setup(); }
      return controls;
    },
    close() { cleanup?.(); cleanup = undefined; }
  };
}

for (const change of ["project", "uri"] as const) {
  for (const operation of ["calendar", "index"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      test(`retired ${change} ${operation} ${outcome} cannot mutate or reload the current scope`, async () => {
        const h = harness();
        const old = h.render("A", "date-1");
        await flush();
        const oldWork = operation === "calendar" ? old.readCalendar() : old.indexOriginal("old-session");
        const current = h.render(change === "project" ? "B" : "A", change === "uri" ? "date-2" : "date-1");
        await flush();
        const newWork = operation === "calendar" ? current.readCalendar() : current.indexOriginal("new-session");
        const writes = h.writes.length;
        const pending = operation === "calendar" ? h.calendars : h.indexes;
        if (outcome === "resolve") pending[0]!.resolve(operation === "calendar" ? { events: ["old"] } : { indexedMessages: 3 });
        else pending[0]!.reject(new Error(`old ${operation} failure`));
        await oldWork; await flush();
        // Business outcome first: baseline fails on stale writes, not merely missing busy reset.
        assert.equal(h.writes.length, writes, "retired success/catch/finally do not write state");
        assert.equal(h.details.length, 2, "retired index does not start another old detail read");
        assert.equal(h.values[operation === "calendar" ? 4 : 5], operation === "calendar" ? true : "new-session");
        h.close();
        if (operation === "index") assert.deepEqual(h.canceled, ["fake-index-1", "fake-index-2"], "old finally cannot clear the current cancellation identity");
        const afterClose = h.writes.length;
        pending[1]!.resolve(operation === "calendar" ? { events: [] } : { indexedMessages: 5 });
        await newWork; await flush();
        assert.equal(h.writes.length, afterClose);
        assert.equal(h.details.length, 2, "unmounted index does not reload");
      });
    }
  }
}

test("retired load closure cannot adopt the new current owner", async () => {
  const h = harness();
  const old = h.render("A", "date-1"); await flush();
  h.render("B", "date-2"); await flush();
  const writes = h.writes.length;
  await old.load(); await flush();
  assert.equal(h.details.length, 2, "old load must not start another A read");
  assert.equal(h.writes.length, writes);
  h.close();
});

test("same-scope rerender keeps pending operations; changing scope resets busy and status", async () => {
  const h = harness();
  const controls = h.render("A", "date-1"); await flush();
  const calendar = controls.readCalendar();
  const index = controls.indexOriginal("session");
  h.render("A", "date-1"); await flush();
  assert.equal(h.details.length, 1, "unchanged effect dependencies do not reload");
  assert.deepEqual(h.canceled, []);
  h.calendars[0]!.resolve({ events: ["current"] });
  h.indexes[0]!.resolve({ indexedMessages: 2 });
  await Promise.all([calendar, index]); await flush();
  assert.equal(h.values[7], "已索引 2 条原始消息");
  const moreCalendar = controls.readCalendar();
  const moreIndex = controls.indexOriginal("session");
  h.render("B", "date-2"); await flush();
  assert.equal(h.values[4], false);
  assert.equal(h.values[5], undefined);
  assert.equal(h.values[7], undefined);
  h.calendars[1]!.resolve({ events: [] }); h.indexes[1]!.resolve({ indexedMessages: 3 });
  await Promise.all([moreCalendar, moreIndex]); await flush();
  h.close();
});

test("current scope explicit calendar/index retain normal completion and refresh", async () => {
  const h = harness();
  const controls = h.render("A", "date-1"); await flush();
  const calendar = controls.readCalendar();
  const index = controls.indexOriginal("session");
  const events = { events: ["current"] };
  h.calendars[0]!.resolve(events); h.indexes[0]!.resolve({ indexedMessages: 2 });
  await Promise.all([calendar, index]); await flush();
  assert.equal(h.values[2], events);
  assert.equal(h.values[4], false);
  assert.equal(h.values[5], undefined);
  assert.equal(h.values[7], "已索引 2 条原始消息");
  assert.deepEqual(h.details, [["A", "date-1"], ["A", "date-1"]]);
  h.close();
  assert.deepEqual(h.canceled, [], "completed current index has no pending cancellation");
});
