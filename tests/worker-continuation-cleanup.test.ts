/**
 * Source-isolated regression. Only dispatchTaskRun's executeAttempt arrow is
 * extracted and executed. The product module is read as text, never imported.
 * Every collaborator is an inert in-memory fake. No TaskClosure, WorkerSession,
 * task manager, Host, recorder, database, SDK, process or model is initialized.
 * VM compilation disables generated strings/Wasm and has a 1s timeout. Returned
 * callbacks run afterward; all awaited promises below are explicitly settled.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const file = ts.createSourceFile("CommandRuntime.ts",
  readFileSync(new URL("../src/runtime/CommandRuntime.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function unique<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T, match: (node: T) => boolean): T {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (guard(node) && match(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.equal(matches.length, 1, "expected exactly one reviewed source node");
  return matches[0]!;
}

const dispatch = unique(file, ts.isVariableDeclaration,
  node => ts.isIdentifier(node.name) && node.name.text === "dispatchTaskRun");
const property = unique(dispatch, ts.isPropertyAssignment, node => node.name.getText(file) === "executeAttempt");
assert.ok(ts.isArrowFunction(property.initializer));
const arrow = property.initializer;

// Fail closed if the extracted source gains an unreviewed call or constructor.
const permittedCalls = new Set([
  "workerContinuations.set", "workerContinuations.delete",
  "startSubagentTask", "subagentAccessMode", "finishTaskAttempt",
  "String", "workerContinuation?.close"
]);
function checkBoundary(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(permittedCalls.has(node.expression.getText(file)),
    "unexpected extracted call: " + node.expression.getText(file));
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(file), "Error");
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  ts.forEachChild(node, checkBoundary);
}
checkBoundary(arrow);
const script = stripTypeScriptTypes("(" + arrow.getText(file) + ")", { mode: "strip" });

interface Failure {
  status: string;
  input: { artifacts?: { output: string }; failure: { message: string; failureClass: string } };
}
interface Prepared { close(): Promise<void> }
class IncompleteFixtureError extends Error {
  readonly stopReason: string;
  readonly output: string;

  constructor(stopReason: string, output: string) {
    super("incomplete fixture");
    this.stopReason = stopReason;
    this.output = output;
  }
}

function fixture(closureRequired: boolean, submitFailure?: Error, hasContinuation = true, closeFailure?: Error) {
  const taskRunId = "task-fixture";
  const attempt = { attemptId: "attempt-fixture" };
  const key = closureRequired ? attempt.attemptId : taskRunId;
  const workerContinuations = new Map<string, Prepared>();
  const failures: Failure[] = [];
  const calls: string[] = [];
  let closeCalls = 0;
  let resolveCompletion!: (value: string) => void;
  let rejectCompletion!: (reason: Error) => void;
  const completion = new Promise<string>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // An unused completion in the synchronous-rejection case is intentionally
  // resolved immediately; no fixture leaves a pending external operation.
  if (submitFailure) resolveCompletion("not dispatched");
  const prepared: Prepared = {
    async close() {
      closeCalls += 1;
      calls.push("close");
      assert.equal(workerContinuations.has(key), false, "remove the retained handle before closing");
      if (closeFailure) throw closeFailure;
    }
  };
  const actualDelete = workerContinuations.delete.bind(workerContinuations);
  workerContinuations.delete = (id: string): boolean => {
    assert.equal(id, key);
    calls.push("delete");
    return actualDelete(id);
  };
  const forbidden = (): never => { throw new Error("A forbidden product entry point was invoked."); };
  const permissionManager = Object.freeze({ fixture: true });
  const controller = { signal: Object.freeze({ fixtureSignal: true }) };
  const sandbox = {
    Error, String, closureRequired, taskRunId, workerContinuations,
    workerContinuation: hasContinuation ? prepared : undefined,
    latest: { parentRunId: "parent-fixture" },
    controller, definition: { agent: "fixture-agent" }, permissionManager,
    taskRuns: Object.freeze({ fixtureTaskStore: true }),
    SubagentTaskIncompleteError: IncompleteFixtureError,
    subagentAccessMode: (received: unknown) => {
      assert.equal(received, permissionManager);
      return "read-only";
    },
    startSubagentTask: (prompt: string, options: Record<string, unknown>) => {
      calls.push("submit");
      assert.equal(prompt, "bounded fixture");
      assert.equal(workerContinuations.get(key), hasContinuation ? prepared : undefined);
      assert.equal(options.taskId, key);
      assert.equal(options.taskRunId, taskRunId);
      assert.equal(options.attemptId, attempt.attemptId);
      assert.equal(options.completedStatus, closureRequired ? "verifying" : "completed");
      assert.equal(options.signal, controller.signal);
      if (submitFailure) throw submitFailure;
      return { completion };
    },
    finishTaskAttempt: (store: unknown, taskId: string, attemptId: string, status: string, input: Failure["input"]) => {
      assert.equal(store, sandbox.taskRuns);
      assert.equal(taskId, taskRunId);
      assert.equal(attemptId, attempt.attemptId);
      failures.push({ status, input });
    },
    // These are not referenced by the reviewed arrow. Guards make an accidental
    // broader extraction fail rather than initialize any product service.
    runTaskClosure: forbidden, prepareSubagentTask: forbidden,
    WorkerSession: forbidden, SubagentTaskManager: forbidden,
    SessionRecorder: forbidden, RuntimeEventAuthority: forbidden,
    DurableTaskRunStore: forbidden, executeTaskCheck: forbidden
  };
  const executeAttempt = runInNewContext(script, sandbox, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as (prompt: string, attempt: { attemptId: string }) => Promise<string>;
  return {
    run: () => executeAttempt("bounded fixture", attempt),
    resolveCompletion, rejectCompletion, failures, calls, workerContinuations,
    assertReleased() {
      assert.equal(workerContinuations.size, 0, "settled admission must not retain its prepared worker");
      assert.equal(calls.filter(call => call === "delete").length, 1);
      assert.equal(closeCalls, hasContinuation ? 1 : 0, "one close within executeAttempt, not the entire resume chain");
    }
  };
}

for (const closureRequired of [false, true]) {
  const label = closureRequired ? "attempt-keyed" : "task-keyed";
  test(label + ": synchronous queue rejection releases the prepared continuation", async () => {
    const error = new Error("Subagent task queue is full.");
    error.name = "SubagentTaskQueueFullError";
    const f = fixture(closureRequired, error);
    await assert.rejects(f.run(), caught => caught === error);
    f.assertReleased();
    assert.deepEqual(f.failures.map(failure => [failure.status, failure.input.failure.failureClass]),
      [["failed", "dispatch_failed"]]);
    assert.deepEqual(f.calls, ["submit", "delete", "close"]);
  });

  test(label + ": successful completion retains the handle while pending and then releases it", async () => {
    const f = fixture(closureRequired);
    const result = f.run();
    assert.equal(f.workerContinuations.size, 1);
    assert.deepEqual(f.calls, ["submit"]);
    f.resolveCompletion("completed fixture");
    assert.equal(await result, "completed fixture");
    f.assertReleased();
    assert.deepEqual(f.failures, []);
  });

  for (const [name, error, status, failureClass] of [
    ["failure", new Error("execution rejected"), "failed", "execution_failed"],
    ["cancellation", Object.assign(new Error("cancelled fixture"), { name: "SubagentTaskAbortedError" }), "aborted", "cancelled"],
    ["incomplete", new IncompleteFixtureError("step_limit", "partial fixture"), "incomplete", "step_limit"]
  ] as const) {
    test(label + ": asynchronous " + name + " releases the handle and keeps its classification", async () => {
      const f = fixture(closureRequired);
      const result = f.run();
      assert.equal(f.workerContinuations.size, 1);
      f.rejectCompletion(error);
      await assert.rejects(result, caught => caught === error);
      f.assertReleased();
      assert.deepEqual(f.failures.map(failure => [failure.status, failure.input.failure.failureClass]), [[status, failureClass]]);
      assert.equal(f.failures[0]?.input.artifacts?.output, name === "incomplete" ? "partial fixture" : undefined);
    });
  }
}

test("fresh execution without a prepared continuation keeps its successful result", async () => {
  const f = fixture(false, undefined, false);
  const result = f.run();
  f.resolveCompletion("fresh result");
  assert.equal(await result, "fresh result");
  f.assertReleased();
  assert.deepEqual(f.failures, []);
});

test("a close rejection still removes the handle and preserves the recorded admission classification", async () => {
  const closeFailure = new Error("close fixture failed");
  const f = fixture(false, new Error("queue full fixture"), true, closeFailure);
  await assert.rejects(f.run(), caught => caught === closeFailure);
  f.assertReleased();
  assert.deepEqual(f.failures.map(failure => failure.input.failure.failureClass), ["dispatch_failed"]);
});

test("static contract: repeated WorkerSession.close calls reuse the resource-closing promise", () => {
  // The outer resume completion callback already closes prepared workers again.
  // Inspect its underlying idempotency contract without instantiating a session.
  const worker = ts.createSourceFile("WorkerSession.ts",
    readFileSync(new URL("../src/runtime/WorkerSession.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const workerClass = unique(worker, ts.isClassDeclaration, node => node.name?.text === "WorkerSession");
  const close = unique(workerClass, ts.isMethodDeclaration, node => node.name.getText(worker) === "close");
  const statements = close.body!.statements;
  const first = statements[0]!;
  assert.ok(ts.isIfStatement(first));
  assert.equal(first.expression.getText(worker), "this.closePromise");
  assert.ok(ts.isReturnStatement(first.thenStatement));
  assert.equal(first.thenStatement.expression?.getText(worker), "this.closePromise");
  const last = statements.at(-1)!;
  assert.ok(ts.isReturnStatement(last));
  assert.equal(last.expression?.getText(worker), "this.closePromise");
  const assignment = unique(close, ts.isBinaryExpression,
    node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(worker) === "this.closePromise");
  assert.ok(ts.isCallExpression(assignment.right));
});
