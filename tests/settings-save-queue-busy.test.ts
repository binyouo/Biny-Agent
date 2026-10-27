/** Pure source-extracted save queue; never imports React, renderer, IPC, stores or credentials.
 * Run compiled test from the reviewed source-tree cwd with an external watchdog:
 * timeout 30s node /path/to/compiled/settings-save-queue-busy.test.js
 * VM timeout bounds synchronous extraction calls; external watchdog bounds async continuations.
 * setDraft is deliberately inert: this suite tests queue status, not draft/model rebasing.
 * recovery_required remains a dedicated state. No close-window or data-loss claim is tested.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const path = resolve(process.cwd(), "src/desktop/renderer/src/components/settings/SettingsDraftProvider.tsx");
const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "SettingsDraftProvider");
assert.ok(component?.body);
const statements = component.body.statements;
function declaration(name: string): string {
  const matches = statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
  assert.equal(matches.length, 1, `unique actual declaration: ${name}`);
  return matches[0]!.getText(source);
}
const effects = statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === "useEffect"
  && node.getText(source).includes('setSaveState(invalid ? "invalid"'));
assert.equal(effects.length, 1);
const extracted = [declaration("modelsSaveTailRef"), declaration("pendingModelSavesRef"), declaration("saveModels"), effects[0]!.getText(source)].join("\n");
const calls = new Set(["useRef", "Promise.resolve", "useCallback", "useEffect", "onNotify", "setSaveError", "setSaveState",
  "modelsSaveTailRef.current.then", "update", "Object.keys", "Object.keys(models).every", "window.biny.saveSettings",
  "setSnapshot", "setDraft", "rebaseUneditedFields", "draftFromSnapshot", "current.models.oauthCredentialHandles.filter",
  "models.oauthCredentialHandles?.includes", "structuredClone", "onCommitted", "operation.then", "String"]);
const ast = ts.createSourceFile("queue-extracted.ts", extracted, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function validate(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isExportDeclaration(node));
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(ast)), `unexpected call: ${node.expression.getText(ast)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(ast), "Error");
  ts.forEachChild(node, validate);
}
validate(ast);
const js = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const canSaveDeclaration = statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === "canSave")) as ts.VariableStatement;
assert.ok(canSaveDeclaration);
const canSaveExpression = canSaveDeclaration.declarationList.declarations[0]!.initializer!.getText(source);
assert.ok(!/\(/u.test(canSaveExpression), "canSave is an inert boolean expression");

type Snapshot = { projectId: string; preferenceRevision: number; configRevision: string; pendingRecovery?: object };
type Result = { status: "committed" | "rolled_back" | "recovery_required"; snapshot?: Snapshot; message?: string };
type Outcome = "committed" | "rolled_back" | "reject";
const snapshot = (revision = "config:1"): Snapshot => ({ projectId: "synthetic-project", preferenceRevision: 1, configRevision: revision });
const patch = () => ({ upserts: [], removeAliases: [], customProviders: [{ alias: "synthetic-provider", icon: "synthetic-icon" }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(dirtyCount = 0) {
  const writes: Array<{ input: { expectedConfigRevision: string }; gate: ReturnType<typeof deferred<Result>> }> = [];
  const operations: Array<Promise<{ result?: Result; error?: unknown }>> = [];
  let closing = false;
  let normalize = () => {};
  const state: { value: string; error?: string; notifications: string[] } = { value: "clean", notifications: [] };
  const base = { current: snapshot() };
  const generation = { current: 1 };
  const forbidden = () => { throw new Error("draft/model helpers must not execute"); };
  const context: ReturnType<typeof createContext> = createContext({
    snapshotRef: base, loadGenerationRef: generation, dirtyCount, invalid: false, saveState: "clean",
    active: true, draft: {}, runtimeBlocked: false,
    useRef: (current: unknown) => ({ current }), useCallback: <T>(callback: T) => callback,
    useEffect: (callback: () => void) => { normalize = callback; },
    setSaveState: (value: string) => { state.value = value; context.saveState = value; },
    setSaveError: (value?: string) => { state.error = value; },
    setSnapshot: () => {}, setDraft: () => {}, onCommitted: () => {},
    onNotify: (value: string) => { state.notifications.push(value); },
    draftFromSnapshot: forbidden, rebaseUneditedFields: forbidden, structuredClone: forbidden,
    window: { biny: { saveSettings: (_project: string, input: { expectedConfigRevision: string }) => {
      const gate = deferred<Result>(); writes.push({ input, gate });
      if (closing) gate.resolve({ status: "committed", snapshot: base.current });
      return gate.promise;
    } } }
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(js).runInContext(context, { timeout: 500 });
  const evaluate = <T>(text: string): T => new Script(text).runInContext(context, { timeout: 500 }) as T;
  const enqueue = (update: unknown = patch()) => {
    context.fixtureUpdate = update;
    const operation: Promise<{ result?: Result; error?: unknown }> = evaluate<Promise<Result>>("saveModels(fixtureUpdate)").then(result => ({ result }), error => ({ error }));
    operations.push(operation); return operation;
  };
  const settle = (index: number, outcome: Outcome, revision = "config:2") => {
    const gate = writes[index]!.gate;
    if (outcome === "reject") gate.reject(new Error(`synthetic failure ${index}`));
    else gate.resolve({ status: outcome, snapshot: snapshot(revision), message: `synthetic result ${index}` });
  };
  return { state, writes, base, generation, enqueue, settle,
    pending: () => evaluate<number>("pendingModelSavesRef.current"),
    canSave: () => evaluate<boolean>(canSaveExpression),
    normalize: (dirty = dirtyCount, invalid = false) => { context.dirtyCount = dirty; context.invalid = invalid; normalize(); },
    async entered(count: number) {
      await flush();
      assert.equal(writes.length, count, "queued fake backend must be reached");
    },
    async close() {
      closing = true;
      for (const { gate } of writes) gate.resolve({ status: "committed", snapshot: base.current });
      await Promise.all(operations);
    }
  };
}

for (const first of ["rolled_back", "reject"] as const) for (const last of ["committed", "rolled_back", "reject"] as const) for (const dirty of [0, 2]) {
  test(`first ${first}, last ${last}, dirty=${dirty}: busy until final settlement`, { timeout: 2000 }, async () => {
    const h = fixture(dirty);
    try {
      const a = h.enqueue(); const b = h.enqueue();
      await h.entered(1); h.settle(0, first); await a; await h.entered(2);
      assert.equal(h.pending(), 1);
      assert.equal(h.state.value, "saving", "failed first save must not clear busy while second is pending");
      assert.ok(h.state.error, "first failure remains visible");
      h.normalize(); assert.equal(h.state.value, "saving"); assert.equal(h.canSave(), false);
      h.settle(1, last, "config:3"); await b;
      assert.equal(h.pending(), 0); h.normalize();
      assert.equal(h.state.value, dirty ? "dirty" : "clean");
      assert.equal(h.canSave(), dirty > 0);
      if (last !== "committed") assert.match(h.state.error!, /synthetic/u);
      h.normalize(dirty, true); assert.equal(h.state.value, "invalid");
    } finally { await h.close(); }
  });
}
for (const outcome of ["rolled_back", "reject"] as const) test(`single ${outcome} does not stick saving`, async () => {
  const h = fixture();
  try { const operation = h.enqueue(); await h.entered(1); h.settle(0, outcome); await operation; h.normalize(); assert.equal(h.pending(), 0); assert.equal(h.state.value, "clean"); }
  finally { await h.close(); }
});
test("throwing builder keeps the subsequent queued operation busy and usable", async () => {
  const h = fixture();
  try {
    const a = h.enqueue(() => { throw new Error("synthetic builder failure"); }); const b = h.enqueue();
    assert.ok((await a).error); await h.entered(1);
    assert.equal(h.state.value, "saving"); assert.equal(h.pending(), 1);
    h.settle(0, "committed"); await b; h.normalize(); assert.equal(h.pending(), 0); assert.equal(h.state.value, "clean");
  } finally { await h.close(); }
});
test("successful queue control computes each builder from the latest snapshot", async () => {
  const h = fixture(); const revisions: string[] = [];
  const build = (base: Snapshot) => { revisions.push(base.configRevision); return patch(); };
  try {
    const a = h.enqueue(build); const b = h.enqueue(build);
    await h.entered(1); h.settle(0, "committed", "config:2"); await a; await h.entered(2);
    assert.equal(h.state.value, "saving"); assert.deepEqual(revisions, ["config:1", "config:2"]);
    assert.equal(h.writes[1]!.input.expectedConfigRevision, "config:2");
    h.settle(1, "committed", "config:3"); await b; assert.equal(h.pending(), 0); assert.equal(h.base.current.configRevision, "config:3");
  } finally { await h.close(); }
});
for (const outcome of ["committed", "rolled_back", "reject"] as const) test(`old generation ${outcome} cannot overwrite new snapshot or status`, async () => {
  const h = fixture();
  try {
    const a = h.enqueue(); await h.entered(1); h.generation.current += 1; h.base.current = snapshot("new-project:1");
    h.state.value = "new-page-marker";
    h.settle(0, outcome); await a;
    assert.equal(h.state.value, "new-page-marker"); assert.equal(h.base.current.configRevision, "new-project:1"); assert.equal(h.pending(), 0);
  } finally { await h.close(); }
});
// Single-operation control only; queued recovery semantics are deliberately outside this fix.
test("single recovery_required remains a dedicated status", async () => {
  const h = fixture();
  try {
    const a = h.enqueue(); await h.entered(1);
    h.writes[0]!.gate.resolve({ status: "recovery_required", message: "synthetic recovery" }); await a; h.normalize();
    assert.equal(h.state.value, "recovery_required"); assert.equal(h.canSave(), false); assert.equal(h.pending(), 0);
  } finally { await h.close(); }
});
