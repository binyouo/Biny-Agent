import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read product text only. The VM receives selected source and inert ports, not
// Host, TaskCommunication, registry, Worker, socket or persistence implementations.
const root = process.env.BINY_TASK_CONTINUE_SOURCE_ROOT ?? process.cwd();
function parse(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, readFileSync(path.join(root, relative), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const server = parse("src/runtime/host/server.ts");
const admission = parse("src/runtime/host/admission.ts");
const classes = server.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostServer");
assert.equal(classes.length, 1);
function method(name: string): ts.MethodDeclaration {
  const matches = classes[0]!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.body);
  return matches[0]!;
}
const predicates = admission.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "isRuntimeHostAdmissionOperation");
assert.equal(predicates.length, 1);
const predicate = predicates[0]!;
const statements = method("execute").body!.statements;
assert.equal(statements[0]!.getText(server), 'if (this.closePromise) throw new Error("Runtime Host is shutting down.");');
assert.equal(statements[1]!.getText(server), "const payload = asRecord(frame.payload);");
assert.equal(statements[2]!.getText(server), 'const admissionOperation = frame.operation === "command"\n      ? runtimeCommandOperation(requiredString(payload.input, "input")) ?? frame.operation\n      : frame.operation;');
assert.equal(statements[3]!.getText(server), "this.assertRequestAdmission(connection, admissionOperation);");
const branches = statements.filter((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(server) === 'frame.operation === "task.continue"');
assert.equal(branches.length, 1);
const branch = branches[0]!;
assert.equal(branch.elseStatement, undefined);
assert.ok(ts.isBlock(branch.thenStatement));
const branchStatements = branch.thenStatement.statements.map((node) => node.getText(server));
const expectedBranch = [
  'const sessionId = requiredString(payload.sessionId, "sessionId");',
  'const taskRunId = requiredString(payload.taskRunId, "taskRunId");',
  "const scoped = new TaskCommunication(this.commands.taskRuns, sessionId);",
  "try { scoped.read(taskRunId); } finally { scoped.close(); }",
  "const resident = await this.registry.ensure(sessionId);",
  'return await resident.commands.continueTaskRun(taskRunId, requiredString(payload.message, "message"), optionalString(payload.messageId));'
];
// Accept only the exact baseline or proposed additional fence, never silently
// omit an unexpected side effect while extracting a newly changed branch.
if (branchStatements.length === 7) expectedBranch.splice(5, 0, "this.assertRequestAdmission(connection, admissionOperation);");
assert.deepEqual(branchStatements, expectedBranch);
const helper = method("assertRequestAdmission");
const allowedCalls = new Set([
  "asRecord", "runtimeCommandOperation", "requiredString", "optionalString",
  "this.assertRequestAdmission", "isRuntimeHostAdmissionOperation",
  "this.assertEventSequenceAvailable", "this.admission.assertAdmission",
  "scoped.read", "scoped.close", "this.registry.ensure", "resident.commands.continueTaskRun"
]);
function inspect(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(node.getSourceFile())), `Unexpected extracted call: ${node.getText()}`);
  if (ts.isNewExpression(node)) assert.ok(["Error", "TaskCommunication"].includes(node.expression.getText(node.getSourceFile())));
  assert.equal(ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node), false);
  ts.forEachChild(node, inspect);
}
for (const node of [...statements.slice(0, 4), branch, helper, predicate]) inspect(node);
const extracted = `${predicate.getText(admission).replace(/^export /u, "")}\nclass Harness {
${helper.getText(server)}
async execute(connection, frame) {
${statements.slice(0, 4).map((node) => node.getText(server)).join("\n")}
${branch.getText(server)}
throw new Error("Unextracted operation");
}
}\n({ prototype: Harness.prototype, classify: isRuntimeHostAdmissionOperation });`;
const compiled = ts.transpileModule(extracted, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true
});
assert.deepEqual(compiled.diagnostics ?? [], []);

type Connection = { exitingForPause: boolean };
type Frame = { operation: string; payload: Record<string, unknown> };
interface Harness {
  execute(connection: Connection, frame: Frame): Promise<unknown>;
}
type Boundary = "pause" | "drain" | "sequence";
function fixture(deferred = false) {
  const events: string[] = [];
  const calls: unknown[][] = [];
  const connection: Connection = { exitingForPause: false };
  const failures = { scope: undefined as Error | undefined, ensure: undefined as Error | undefined };
  const state = { draining: false, exhausted: false };
  const result = { taskRunId: "continuation-result" };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  class ScopePort {
    constructor(store: unknown, sessionId: string) {
      assert.equal(store, taskRuns);
      assert.equal(sessionId, "session-a");
      events.push("scope.open");
    }
    read(taskRunId: string): void {
      assert.equal(taskRunId, "completed-task");
      events.push("scope.read");
      if (failures.scope) throw failures.scope;
    }
    close(): void { events.push("scope.close"); }
  }
  const taskRuns = {};
  const context = runInNewContext(compiled.outputText, {
    TaskCommunication: ScopePort,
    asRecord: (value: unknown) => value,
    requiredString: (value: unknown) => {
      if (typeof value !== "string") throw new Error("Expected string");
      return value;
    },
    optionalString: (value: unknown) => typeof value === "string" ? value : undefined,
    runtimeCommandOperation: () => { throw new Error("Unexpected command route"); }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as { prototype: Harness; classify: (operation: string) => boolean };
  const harness = Object.assign(Object.create(context.prototype) as Harness, {
    closePromise: undefined,
    commands: { taskRuns },
    admission: { assertAdmission: () => { if (state.draining) throw new Error("host draining"); } },
    assertEventSequenceAvailable: () => { if (state.exhausted) throw new Error("sequence exhausted"); },
    registry: { ensure: async (sessionId: string) => {
      assert.equal(sessionId, "session-a");
      events.push("ensure");
      entered();
      if (deferred) await gate;
      if (failures.ensure) throw failures.ensure;
      return { commands: { continueTaskRun: async (...args: unknown[]) => {
        events.push("continue"); calls.push(args); return result;
      } } };
    } }
  });
  const frame: Frame = { operation: "task.continue", payload: { sessionId: "session-a", taskRunId: "completed-task", message: "more work", messageId: "request-a" } };
  return {
    events, calls, connection, failures, result, frame, release, entering,
    classify: context.classify,
    invoke: () => harness.execute(connection, frame),
    block: (boundary: Boundary) => {
      if (boundary === "pause") connection.exitingForPause = true;
      if (boundary === "drain") state.draining = true;
      if (boundary === "sequence") state.exhausted = true;
    }
  };
}
const boundaryErrors: Record<Boundary, RegExp> = { pause: /exiting/, drain: /draining/, sequence: /sequence exhausted/ };
type Outcome = { rejected: true; error: unknown } | { rejected: false; value: unknown };
function observe(pending: Promise<unknown>): Promise<Outcome> {
  return pending.then<Outcome, Outcome>((value) => ({ rejected: false, value }), (error: unknown) => ({ rejected: true, error }));
}
function assertBoundaryRejected(outcome: Outcome, boundary: Boundary): void {
  assert.equal(outcome.rejected, true);
  if (!outcome.rejected) throw new Error("Expected a rejected admission outcome");
  assert.match(String(outcome.error), boundaryErrors[boundary]);
}

test("actual admission predicate includes task continuation and excludes read/control operations", () => {
  const f = fixture();
  assert.equal(f.classify("task.continue"), true);
  for (const operation of ["task.inspect", "task.wait", "task.message", "task.cancel", "client.pause-owned-runs", "snapshot"]) assert.equal(f.classify(operation), false, operation);
});
for (const boundary of ["pause", "drain", "sequence"] as const) {
  test(`initial ${boundary} rejects before scope lookup or continuation`, async () => {
    const f = fixture();
    f.block(boundary);
    const outcome = await observe(f.invoke());
    assertBoundaryRejected(outcome, boundary);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.calls, []);
  });
  test(`${boundary} during ensure rejects before continuation`, async () => {
    const f = fixture(true);
    const observed = observe(f.invoke());
    try {
      assert.equal(f.events.at(-1), "ensure", "ensure must be entered synchronously before waiting on its gate");
      await f.entering;
      f.block(boundary);
      f.release();
      assertBoundaryRejected(await observed, boundary);
      assert.deepEqual(f.events, ["scope.open", "scope.read", "scope.close", "ensure"]);
      assert.deepEqual(f.calls, []);
    } finally {
      f.release();
      await observed;
    }
  });
}
test("healthy continuation forwards exact arguments and result once", async () => {
  const f = fixture();
  assert.equal(await f.invoke(), f.result);
  assert.deepEqual(f.calls, [["completed-task", "more work", "request-a"]]);
  assert.deepEqual(f.events, ["scope.open", "scope.read", "scope.close", "ensure", "continue"]);
});
test("another client's pause does not revoke this connection", async () => {
  const f = fixture(true);
  const other: Connection = { exitingForPause: false };
  const observed = observe(f.invoke());
  try {
    assert.equal(f.events.at(-1), "ensure", "ensure must be entered synchronously before waiting on its gate");
    await f.entering;
    other.exitingForPause = true;
    f.release();
    const outcome = await observed;
    assert.equal(outcome.rejected, false);
    assert.equal(outcome.value, f.result);
    assert.equal(other.exitingForPause, true);
    assert.equal(f.connection.exitingForPause, false);
    assert.equal(f.calls.length, 1);
  } finally {
    f.release();
    await observed;
  }
});
test("scope rejection closes the scope and never ensures or continues", async () => {
  const f = fixture();
  const error = new Error("scope mismatch");
  f.failures.scope = error;
  await assert.rejects(f.invoke(), (actual: unknown) => actual === error);
  assert.deepEqual(f.events, ["scope.open", "scope.read", "scope.close"]);
  assert.deepEqual(f.calls, []);
});
test("ensure rejection preserves error identity without continuation", async () => {
  const f = fixture();
  const error = new Error("registry unavailable");
  f.failures.ensure = error;
  await assert.rejects(f.invoke(), (actual: unknown) => actual === error);
  assert.deepEqual(f.events, ["scope.open", "scope.read", "scope.close", "ensure"]);
  assert.deepEqual(f.calls, []);
});
