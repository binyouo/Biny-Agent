/** Actual UI handlers only: inert callbacks, explicit render snapshots, no React/Host/model/DB. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("SettingsMemory.tsx", readFileSync(path.resolve(process.cwd(),
  "src/desktop/renderer/src/components/settings/SettingsMemory.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && node.name?.text === "SettingsMemory");
assert.ok(component?.body);
const names = ["downloadEmbedding", "cancelEmbeddingDownload", "rebuildEmbedding", "cancelEmbeddingRebuild"] as const;
const declarations = component.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
function declaration(name: string): ts.VariableDeclaration {
  const matches = declarations.filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0]!;
}
const handlers = names.map(name => declaration(name));
const refs = declarations.filter(node => ts.isIdentifier(node.name) && node.name.text === "embeddingActionGenerationRef");
assert.ok(refs.length <= 1);
const ref = refs[0];
if (ref) assert.equal(ref.initializer?.getText(source), "useRef(0)");
else {
  // A baseline without ownership can use the same behavioral tests. This unused ref
  // adds no guard to its actual handlers; never allow a missing ref for new handlers.
  const rejectMissingRefUse = (node: ts.Node): void => {
    assert.ok(!ts.isIdentifier(node) || node.text !== "embeddingActionGenerationRef");
    ts.forEachChild(node, rejectMissingRefUse);
  };
  handlers.forEach(rejectMissingRefUse);
}
const helper = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && node.name?.text === "errorMessage");
assert.ok(helper);
const allowedCalls = new Set(["useRef", "onDownloadEmbeddingModel", "onCancelEmbeddingDownload",
  "onRebuildEmbeddingIndex", "onCancelEmbeddingRebuild", "setEmbeddingWorking", "setEmbeddingStatus",
  "setEmbeddingError", "onNotify", "errorMessage", "String"]);
const allowedProperties = new Set(["embeddingActionGenerationRef.current", "result.status", "result.cancelled", "error.message"]);
function audit(node: ts.Node): void {
  assert.ok(!ts.isNewExpression(node) && !ts.isTaggedTemplateExpression(node) && !ts.isElementAccessExpression(node)
    && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && node.kind !== ts.SyntaxKind.ImportKeyword,
  `forbidden syntax: ${node.getText(source)}`);
  if (ts.isCallExpression(node)) {
    assert.ok(ts.isIdentifier(node.expression) && allowedCalls.has(node.expression.text), `unexpected call: ${node.getText(source)}`);
  }
  if (ts.isPropertyAccessExpression(node)) assert.ok(allowedProperties.has(node.getText(source)), `unexpected property: ${node.getText(source)}`);
  ts.forEachChild(node, audit);
}
if (ref) audit(ref);
[...handlers, helper].forEach(audit);
const compiled = ts.transpileModule(`(() => {
  const ${ref ? ref.getText(source) : "embeddingActionGenerationRef = useRef(0)"};
  ${helper.getText(source)}
  return { render: (embeddingWorking, dirtyCount) => {
    ${handlers.map(node => `const ${node.getText(source)};`).join("\n")}
    return { ${names.join(", ")} };
  } };
})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Kind = "download" | "rebuild";
// Primitive statuses distinguish inert publications, not real protocol payload shapes.
type Cancellation = { cancelled: boolean; status: string };
type Handlers = {
  downloadEmbedding(model: string): Promise<void>;
  cancelEmbeddingDownload(model: string): Promise<void>;
  rebuildEmbedding(): Promise<void>;
  cancelEmbeddingRebuild(): Promise<void>;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const state: { working: Kind | undefined; status: string | undefined; error: string | undefined } = {
    working: undefined, status: undefined, error: undefined
  };
  const events: Array<[string, unknown]> = [];
  const actions: Array<{ kind: Kind; result: ReturnType<typeof deferred<string>> }> = [];
  const cancellations: Array<{ kind: Kind; result: ReturnType<typeof deferred<Cancellation>> }> = [];
  let maintenance: (typeof actions)[number] | undefined;
  // Models only the abort boundary; original operation settlement is independently controlled.
  let onCancel: (() => void) | undefined;
  function action(kind: Kind): Promise<string> {
    assert.equal(maintenance, undefined, "new operation must wait for the old maintenance slot to release");
    const entry = { kind, result: deferred<string>() };
    maintenance = entry; actions.push(entry);
    return entry.result.promise.finally(() => {
      assert.equal(maintenance, entry); maintenance = undefined;
    });
  }
  function cancel(kind: Kind): Promise<Cancellation> {
    onCancel?.();
    const entry = { kind, result: deferred<Cancellation>() };
    cancellations.push(entry);
    // DesktopAgentManager awaits owner.cancel*(), then an independent owner.status().
    // This promise represents that still-pending status/API response, not maintenance admission.
    return entry.result.promise;
  }
  const context = vm.createContext({ Error, String,
    useRef: (current: number) => ({ current }),
    onDownloadEmbeddingModel: () => action("download"), onRebuildEmbeddingIndex: () => action("rebuild"),
    onCancelEmbeddingDownload: () => cancel("download"), onCancelEmbeddingRebuild: () => cancel("rebuild"),
    setEmbeddingWorking: (value: Kind | undefined) => { state.working = value; events.push(["working", value]); },
    setEmbeddingStatus: (value: string) => { state.status = value; events.push(["status", value]); },
    setEmbeddingError: (value: string | undefined) => { state.error = value; events.push(["error", value]); },
    onNotify: (value: string) => { events.push(["notify", value]); }
  }, { codeGeneration: { strings: false, wasm: false } });
  const extracted = vm.runInContext(compiled.outputText, context, { timeout: 1_000 }) as {
    render(working: Kind | undefined, dirty: number): Handlers
  };
  let committed = extracted.render(state.working, 0);
  return { state, events, actions, cancellations,
    // State sinks never rewrite a handler's closure. A commit creates a new render snapshot.
    commit(dirty = 0) { committed = extracted.render(state.working, dirty); },
    start(kind: Kind) { return kind === "download" ? committed.downloadEmbedding("multilingual-e5-small") : committed.rebuildEmbedding(); },
    cancel(kind: Kind) { return kind === "download" ? committed.cancelEmbeddingDownload("multilingual-e5-small") : committed.cancelEmbeddingRebuild(); },
    abortOnCancel() { onCancel = () => { maintenance?.result.reject(new Error("inert abort")); }; },
    assertIdle() { assert.equal(maintenance, undefined); }
  };
}

for (const kind of ["download", "rebuild"] as const) {
  for (const lateFailure of [false, true]) {
    test(`${kind}: old cancel status ${lateFailure ? "failure" : "success"} cannot publish into admitted B`, async () => {
      const f = fixture(); const a = f.start(kind); f.commit();
      f.abortOnCancel(); const cancel = f.cancel(kind);
      // Source-linked ordering: service cancel aborts immediately; owner.execute finally releases
      // maintenance before A's error reaches UI. Desktop cancel separately awaits owner.status.
      // See MemoryEmbeddingService.cancel*, runtime/memory/owner.ts execute, and
      // DesktopAgentManager.cancelMemoryEmbedding{Download,Rebuild}. No backend code is executed.
      await a; f.assertIdle(); assert.equal(f.state.working, undefined);
      f.commit(); // The now-enabled action has a fresh undefined-working render closure.
      const b = f.start(kind); f.commit(); assert.equal(f.state.working, kind);
      assert.equal(f.actions.length, 2);
      const before = [...f.events];
      if (lateFailure) f.cancellations[0]!.result.reject(new Error("late status failure"));
      else f.cancellations[0]!.result.resolve({ cancelled: true, status: "B running" });
      await cancel;
      assert.equal(f.state.working, kind); assert.deepEqual(f.events, before);
      f.actions[1]!.result.resolve("B complete"); await b;
      assert.equal(f.state.status, "B complete"); assert.equal(f.state.working, undefined); f.assertIdle();
    });
  }
  for (const outcome of ["true", "false", "failure"] as const) {
    test(`${kind}: current cancel ${outcome} never releases action-owned busy`, async () => {
      const f = fixture(); const a = f.start(kind); f.commit();
      const cancel = f.cancel(kind);
      if (outcome === "failure") f.cancellations[0]!.result.reject(new Error("cancel failed"));
      else f.cancellations[0]!.result.resolve({ cancelled: outcome === "true", status: "still draining" });
      await cancel;
      assert.equal(f.state.working, kind);
      assert.equal(f.events.filter(([name, value]) => name === "working" && value === undefined).length, 0);
      if (outcome === "failure") assert.equal(f.state.error, "cancel failed");
      else assert.equal(f.state.status, "still draining");
      // True is only acknowledgement of abort; actual operation settles later.
      if (outcome === "true") f.actions[0]!.result.reject(new Error("inert abort"));
      else f.actions[0]!.result.resolve("A complete");
      await a; assert.equal(f.state.working, undefined); f.assertIdle();
      if (outcome !== "true") { assert.equal(f.state.status, "A complete"); assert.equal(f.state.error, undefined); }
    });
  }
  test(`${kind}: duplicate cancellations retire together after A settles and B starts`, async () => {
    const f = fixture(); const a = f.start(kind); f.commit(); f.abortOnCancel();
    const first = f.cancel(kind); const second = f.cancel(kind);
    await a; f.assertIdle(); f.commit(); const b = f.start(kind); f.commit();
    const before = [...f.events];
    f.cancellations[0]!.result.resolve({ cancelled: true, status: "old" }); await first;
    f.cancellations[1]!.result.reject(new Error("old failure")); await second;
    assert.equal(f.state.working, kind); assert.deepEqual(f.events, before);
    f.actions[1]!.result.resolve("B"); await b;
  });
  for (const failure of [false, true]) {
    test(`${kind}: ordinary ${failure ? "failure" : "success"} releases its own busy`, async () => {
      const f = fixture(); const a = f.start(kind); assert.equal(f.state.working, kind);
      if (failure) f.actions[0]!.result.reject(new Error("action failed")); else f.actions[0]!.result.resolve("ready");
      await a; assert.equal(f.state.working, undefined); f.assertIdle();
      assert.equal(f.state.error, failure ? "action failed" : undefined);
      assert.equal(f.state.status, failure ? undefined : "ready");
      assert.equal(f.events.filter(([name]) => name === "notify").length, failure ? 0 : 1);
    });
  }
  for (const superseded of [false, true]) {
    test(`${kind}: external operation cancellation at generation zero, superseded=${superseded}`, async () => {
      const f = fixture(); const cancel = f.cancel(kind);
      const a = superseded ? f.start(kind) : undefined;
      const before = [...f.events];
      f.cancellations[0]!.result.resolve({ cancelled: true, status: "external cancelled" }); await cancel;
      if (superseded) {
        assert.equal(f.state.working, kind); assert.deepEqual(f.events, before);
        f.actions[0]!.result.resolve("new complete"); await a;
      } else {
        assert.equal(f.state.status, "external cancelled"); assert.equal(f.state.working, undefined);
      }
    });
  }
}

test("busy and dirty guards admit no callbacks and preserve the active action", async () => {
  const f = fixture(); f.commit(1); await f.start("rebuild");
  assert.equal(f.actions.length, 0);
  f.commit(); const a = f.start("download"); f.commit();
  await f.start("download"); await f.start("rebuild");
  assert.equal(f.actions.length, 1); assert.equal(f.state.working, "download");
  f.actions[0]!.result.resolve("ready"); await a;
  assert.equal(f.state.status, "ready"); assert.equal(f.state.working, undefined); f.assertIdle();
});
