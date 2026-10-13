/** Source-only regression: the extracted synchronous callback sees inert records, never native rejected Promises. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_CLI_CANCEL_SOURCE_ROOT ?? process.cwd();
const source = readFileSync(process.env.BINY_CLI_CANCEL_BASELINE_RUN ?? path.join(root, "src/cli/commands/run.ts"), "utf8");
const parsed = ts.createSourceFile("run.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const attached = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "runAttachedCommand");
assert.ok(attached?.body);
function descendants(node: ts.Node, predicate: (item: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (item: ts.Node): void => { if (predicate(item)) found.push(item); ts.forEachChild(item, visit); };
  visit(node); return found;
}
const aborts = descendants(attached, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "onAbort");
assert.equal(aborts.length, 1);
const abort = aborts[0]!;
assert.ok(ts.isVariableDeclaration(abort) && abort.initializer && ts.isArrowFunction(abort.initializer));
assert.equal(abort.initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);
const callbackCode = ts.transpileModule(`(${abort.initializer.getText(parsed)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

class RecordingPromise {
  readonly rejectionHandlers: Array<(error: unknown) => unknown> = [];
  readonly children: RecordingPromise[] = [];
  state: "pending" | "fulfilled" | "rejected" = "pending";
  error?: unknown;
  handlerResults: unknown[] = [];
  catch(handler: (error: unknown) => unknown): RecordingPromise {
    this.rejectionHandlers.push(handler);
    const child = new RecordingPromise(); this.children.push(child);
    if (this.state === "rejected") this.handlerResults.push(handler(this.error));
    return child;
  }
  reject(error: unknown): void {
    assert.equal(this.state, "pending"); this.state = "rejected"; this.error = error;
    for (const handler of this.rejectionHandlers) this.handlerResults.push(handler(error));
  }
  resolve(): void { assert.equal(this.state, "pending"); this.state = "fulfilled"; }
}
function fixture(initial: "pending" | "fulfilled" | "rejected") {
  const rpc = new RecordingPromise();
  const failure = new Error("Runtime Host connection closed.");
  if (initial === "rejected") rpc.reject(failure);
  if (initial === "fulfilled") rpc.resolve();
  const calls: unknown[][] = [];
  const runtime = {
    focusedRunId: "different-run-after-focus-change",
    cancelRunRequest: (...args: unknown[]) => { calls.push(args); return rpc; },
    cancelCurrentRun: () => assert.fail("must not cancel whichever run is focused now"),
    close: () => assert.fail("the callback must not close ahead of completion"),
    reportError: () => assert.fail("no new logging contract")
  };
  const callback = runInNewContext(callbackCode, {
    runtime, submitted: { runId: "submitted-run" }, sessionId: "submitted-session", Promise: undefined
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as () => void;
  return { rpc, failure, calls, callback };
}

for (const initial of ["pending", "fulfilled", "rejected"] as const) {
  test(`SIGINT synchronously observes the ${initial} cancellation RPC without changing its target`, () => {
    const f = fixture(initial);
    assert.equal(f.callback(), undefined);
    assert.deepEqual(f.calls, [["submitted-run", "interrupted", "submitted-session"]]);
    assert.equal(f.rpc.rejectionHandlers.length, 1, "attach a rejection observer before returning from the abort callback");
    assert.equal(f.rpc.children.length, 1);
    if (initial === "pending") f.rpc.reject(f.failure);
    assert.deepEqual(f.rpc.handlerResults, initial === "fulfilled" ? [] : [undefined], "observation does not throw, log or retry");
    assert.equal(f.calls.length, 1, "a failed RPC is never replayed");
  });
}

test("the callback keeps completion and finally cleanup ownership outside the cancel RPC", () => {
  assert.ok(attached.body);
  const waits = descendants(attached, node => ts.isAwaitExpression(node) && node.expression.getText(parsed) === "submitted.completion");
  assert.equal(waits.length, 1);
  const removals = descendants(attached, node => ts.isCallExpression(node) && node.expression.getText(parsed) === "signal.removeEventListener");
  assert.equal(removals.length, 1);
  const removal = removals[0]!;
  assert.ok(ts.isCallExpression(removal));
  assert.equal(removal.arguments.length, 2);
  assert.equal(removal.arguments[0]?.getText(parsed), '"abort"');
  assert.equal(removal.arguments[1]?.getText(parsed), "onAbort");
  const outer = attached.body.statements.find((node): node is ts.TryStatement => ts.isTryStatement(node));
  assert.ok(outer?.finallyBlock);
  assert.equal(outer.finallyBlock.statements.length, 1);
  assert.equal(outer.finallyBlock.statements[0]?.getText(parsed), "await runtime.close();");
});
