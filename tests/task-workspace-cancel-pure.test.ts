/** Source-extracted cancellation boundary only; no Runtime/Host/store/worker construction. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_TASK_CANCEL_SOURCE_ROOT ?? process.cwd();
const printer = ts.createPrinter({ removeComments: true });
function parse(text: string): ts.SourceFile { return ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const nodes = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1, name); assert.ok(nodes[0]?.body); return nodes[0];
}
function variable(block: ts.Block, name: string): ts.VariableDeclaration {
  const nodes = block.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(nodes.length, 1, name); assert.ok(nodes[0]?.initializer); return nodes[0];
}
function canonical(node: ts.Node, file: ts.SourceFile): string { return printer.printNode(ts.EmitHint.Unspecified, node, file); }
const prefixShape = parse(`async function executeTaskClosure(input) {
  const initial = input.taskRuns.get(input.taskRunId);
  if (!initial) throw new Error(\`TaskRun \${input.taskRunId} does not exist.\`);
  if (initial.status === "cancelled") return { status: "cancelled", reason: "Task was cancelled." };
  if (input.signal?.aborted && initial.status !== "completed") return cancelCurrentTask(input);
  const definition = readTaskDefinition(initial.task);
}`);
function checkedCancellationPrefix(file: ts.SourceFile): string {
  const node = declaration(file, "executeTaskClosure");
  const expected = declaration(prefixShape, "executeTaskClosure").body!.statements;
  assert.ok(node.body!.statements.length >= expected.length, "Cancellation prefix is incomplete");
  for (let index = 0; index < expected.length; index++) {
    assert.equal(canonical(node.body!.statements[index]!, file), canonical(expected[index]!, prefixShape), "Unreviewed cancellation prefix/next statement");
  }
  // Execute ORIGINAL first three statements only. The checked signal-only branch
  // and all later closure work are deliberately excluded, not replaced by success.
  const header = file.text.slice(node.getStart(file), node.body!.getStart(file));
  return header + "{\n" + node.body!.statements.slice(0, 3).map(statement => statement.getText(file)).join("\n")
    + '\nthrow new Error("UNREVIEWED_CLOSURE_TAIL");\n}';
}
const workspaceTryShape = parse(`async function checked() {
  try { root = await taskWorkspace(taskRunId, current.attempts.length === 0); }
  catch (error) {
    if (taskRuns.get(taskRunId)?.status === "queued" && current.attempts.length === 0) {
      const attempt = taskRuns.createAttempt(taskRunId, { parentRunId: latest.parentRunId, retrySafety: "safe" });
      finishTaskAttempt(taskRuns, taskRunId, attempt.attemptId, "failed", {
        failure: { failureClass: "workspace_preparation_failed", message: error instanceof Error ? error.message : String(error) }
      });
    }
    throw error;
  }
}`);
function completionIife(file: ts.SourceFile): string {
  const owner = declaration(file, "initializeCommandRuntime");
  const dispatch = variable(owner.body!, "dispatchTaskRun").initializer!;
  assert.ok(ts.isArrowFunction(dispatch) && ts.isBlock(dispatch.body));
  let expression = variable(dispatch.body, "completion").initializer!;
  for (const method of ["finally", "then"]) {
    assert.ok(ts.isCallExpression(expression) && expression.arguments.length === 1 && ts.isArrowFunction(expression.arguments[0]!));
    assert.ok(ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === method);
    expression = expression.expression.expression;
  }
  assert.ok(ts.isCallExpression(expression) && expression.arguments.length === 0 && ts.isParenthesizedExpression(expression.expression));
  const arrow = expression.expression.expression;
  assert.ok(ts.isArrowFunction(arrow) && arrow.parameters.length === 0 && arrow.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) && ts.isBlock(arrow.body));
  const statements = arrow.body.statements;
  assert.ok(statements.length === 4 || statements.length === 5, "Unexpected completion boundary size");
  assert.equal(statements[0]!.getText(file), "controller.signal.throwIfAborted();");
  assert.equal(statements[1]!.getText(file), "let root: string;");
  assert.equal(canonical(statements[2]!, file), canonical(declaration(workspaceTryShape, "checked").body!.statements[0]!, workspaceTryShape), "Workspace catch must remain intact");
  if (statements.length === 5) assert.equal(statements[3]!.getText(file), "controller.signal.throwIfAborted();");
  const returned = statements[statements.length - 1]!;
  assert.ok(ts.isReturnStatement(returned) && returned.expression && ts.isAwaitExpression(returned.expression));
  const call = returned.expression.expression;
  assert.ok(ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "runTaskClosure" && call.arguments.length === 1);
  const options = call.arguments[0]!; assert.ok(ts.isObjectLiteralExpression(options));
  assert.deepEqual(options.properties.map(property => property.name?.getText(file)), ["taskRuns", "taskRunId", "workspaceRoot", "ignore", "executor", "retrySafety", "resumeWorker", "signal", "executeAttempt"]);
  checkSelected(arrow.body, new Set(["controller.signal.throwIfAborted", "taskWorkspace", "taskRuns.get", "taskRuns.createAttempt", "finishTaskAttempt", "String", "runTaskClosure", "executeTaskCheck", "workerContinuations.set", "startSubagentTask", "subagentAccessMode", "workerContinuations.delete", "workerContinuation?.close"]));
  return expression.getText(file);
}
function checkSelected(node: ts.Node, calls: ReadonlySet<string>): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isExportDeclaration(node), "No imports in payload");
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText()), "Unreviewed call: " + node.expression.getText());
  if (ts.isNewExpression(node)) assert.ok(ts.isIdentifier(node.expression) && node.expression.text === "Error", "Only inert Error construction allowed");
  ts.forEachChild(node, child => checkSelected(child, calls));
}
const commandSource = parse(readFileSync(path.join(root, "src/runtime/CommandRuntime.ts"), "utf8"));
const closureSource = parse(readFileSync(path.join(root, "src/runtime/TaskClosure.ts"), "utf8"));
const iife = completionIife(commandSource);
const closure = declaration(closureSource, "runTaskClosure");
checkSelected(closure, new Set(["executeTaskClosure", "cancelCurrentTask"]));
const closureCode = closure.getText(closureSource).replace(/^export\s+/u, "") + "\n" + checkedCancellationPrefix(closureSource);
interface Task { status: string; attempts: Array<{ attemptId: string }>; parentRunId: string }
interface ClosureInput {
  taskRuns: unknown; taskRunId: string; workspaceRoot: string; ignore: string[];
  executor: { executeTaskCheck(input: unknown): Promise<unknown> };
  retrySafety: string; resumeWorker: boolean; signal: AbortSignal;
  executeAttempt(prompt: string, attempt: unknown): Promise<unknown>;
}
interface Result { status: string; reason?: string }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(options: { attempts?: number; preaborted?: Error; delegate?: (input: ClosureInput) => Promise<Result> } = {}) {
  const controller = new AbortController(); if (options.preaborted) controller.abort(options.preaborted);
  const gate = deferred<string>();
  const task: Task = { status: "queued", attempts: options.attempts ? [{ attemptId: "prior-attempt" }] : [], parentRunId: "parent" };
  const current = { ...task, attempts: [...task.attempts] }; const latest = { ...current };
  const events: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, args: unknown[]) => { events.push({ name, args }); };
  const forbidden = (name: string) => (...args: unknown[]): never => { record(name, args); throw new Error("FORBIDDEN_CAPABILITY:" + name); };
  const taskRuns = {
    get: (id: string) => { assert.equal(id, "task"); return task; },
    createAttempt: (...args: unknown[]) => { record("createAttempt", args); return { attemptId: "failure-attempt" }; }
  };
  const ignore = ["inert-ignore"];
  const globals = {
    Error, String, controller, current, latest, taskRuns, taskRunId: "task",
    taskWorkspace: (...args: unknown[]) => { record("workspace", args); return gate.promise; },
    finishTaskAttempt: (...args: unknown[]) => { record("finishTaskAttempt", args); },
    config: { workspace: { ignore } }, taskOptions: { retrySafety: "safe" }, workerContinuation: undefined,
    closureRequired: true, definition: {}, permissionManager: undefined,
    executeTaskCheck: forbidden("executeTaskCheck"), startSubagentTask: forbidden("startSubagentTask"),
    subagentAccessMode: forbidden("subagentAccessMode"), workerContinuations: { set: forbidden("worker.set"), delete: forbidden("worker.delete") },
    cancelCurrentTask: forbidden("cancelCurrentTask"),
    delegate: options.delegate
  };
  // Normal delegation control uses a recording port, never the excluded closure tail.
  const code = (options.delegate ? "const runTaskClosure = delegate;\n" : closureCode + "\n") + "(" + iife + ")";
  const output = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  const completion = runInNewContext(output.outputText, globals, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Promise<Result>;
  return { completion, controller, gate, task, taskRuns, ignore, events };
}
function noExecution(events: Array<{ name: string }>): void {
  assert.deepEqual(events.filter(event => event.name !== "workspace").map(event => event.name), []);
}

test("cancellation during workspace wait reaches the actual cancelled closure result", async () => {
  const f = harness(); const reason = new Error("inert cancellation");
  const settled = f.completion.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  assert.deepEqual(f.events, [{ name: "workspace", args: ["task", true] }]);
  f.task.status = "cancelled"; f.controller.abort(reason); f.gate.resolve("/inert-workspace");
  const result = await settled;
  if (!result.ok) assert.strictEqual(result.error, reason, "Baseline rejection must be the exact cancellation reason");
  noExecution(f.events);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable assertion narrowing");
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), { status: "cancelled", reason: "Task was cancelled." });
  noExecution(f.events);
});

test("already-aborted completion rejects before workspace or closure work", async () => {
  const reason = new Error("already cancelled"); const f = harness({ preaborted: reason });
  await assert.rejects(f.completion, error => error === reason); assert.deepEqual(f.events, []);
});

test("existing-attempt workspace failure preserves exact error without closure or worker", async () => {
  const f = harness({ attempts: 1 }); const failure = new Error("workspace unavailable");
  const rejected = assert.rejects(f.completion, error => error === failure); f.gate.reject(failure); await rejected;
  assert.deepEqual(f.events, [{ name: "workspace", args: ["task", false] }]); noExecution(f.events);
});

test("fresh queued workspace failure records one failed attempt and preserves error", async () => {
  const f = harness(); const failure = new Error("workspace preparation failed");
  const rejected = assert.rejects(f.completion, error => error === failure); f.gate.reject(failure); await rejected;
  assert.deepEqual(f.events.map(event => event.name), ["workspace", "createAttempt", "finishTaskAttempt"]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.events[1]!.args)), ["task", { parentRunId: "parent", retrySafety: "safe" }]);
  const args = f.events[2]!.args; assert.strictEqual(args[0], f.taskRuns);
  assert.deepEqual(JSON.parse(JSON.stringify(args.slice(1))), ["task", "failure-attempt", "failed", { failure: { failureClass: "workspace_preparation_failed", message: failure.message } }]);
});

test("cancellation does not turn a genuine workspace rejection into fulfilled cancellation", async () => {
  const f = harness(); const reason = new Error("cancelled"); const failure = new Error("real preparation failure");
  const rejected = assert.rejects(f.completion, error => error === failure);
  f.task.status = "cancelled"; f.controller.abort(reason); f.gate.reject(failure); await rejected;
  noExecution(f.events);
});

test("normal completion delegates exact options and result without executing worker callbacks", async () => {
  const delegated: ClosureInput[] = []; const expected = { status: "incomplete", reason: "inert port result" };
  const f = harness({ delegate: async input => { assert.equal(delegated.length, 0); delegated.push(input); return expected; } });
  f.gate.resolve("/inert-workspace"); assert.strictEqual(await f.completion, expected); const received = delegated[0]; assert.ok(received);
  assert.strictEqual(received.taskRuns, f.taskRuns); assert.equal(received.taskRunId, "task"); assert.equal(received.workspaceRoot, "/inert-workspace");
  assert.strictEqual(received.ignore, f.ignore); assert.strictEqual(received.signal, f.controller.signal);
  assert.equal(received.retrySafety, "safe"); assert.equal(received.resumeWorker, false);
  assert.equal(typeof received.executor.executeTaskCheck, "function"); assert.equal(typeof received.executeAttempt, "function"); noExecution(f.events);
});

test("prefix guard rejects inserted work and changed cancellation or next-statement boundaries", () => {
  const original = prefixShape.text;
  assert.doesNotThrow(() => checkedCancellationPrefix(parse(original)));
  for (const modified of [
    original.replace('const initial =', 'surprise(); const initial ='),
    original.replace('if (!initial)', 'surprise(); if (!initial)'),
    original.replace('initial.status === "cancelled"', 'initial.status === "completed"'),
    original.replace('return { status: "cancelled", reason: "Task was cancelled." }', 'return normalize(initial)'),
    original.replace('if (input.signal?.aborted', 'surprise(); if (input.signal?.aborted'),
    original.replace('initial.status !== "completed"', 'initial.status !== "cancelled"'),
    original.replace('const definition = readTaskDefinition(initial.task);', 'const definition = loadResources();')
  ]) assert.throws(() => checkedCancellationPrefix(parse(modified)), /Unreviewed cancellation prefix/u);
});
