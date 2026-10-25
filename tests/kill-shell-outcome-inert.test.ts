/** Review-only candidate: no product module imports and no real process service. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ManagedProcessSnapshot } from "../src/runtime/ManagedProcessService.js";

const root = new URL("../", import.meta.url);
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(new URL(path, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const managed = source("src/tools/process/managedProcesses.ts");
const coordinator = source("src/agent/toolExecutionCoordinator.ts");
function one<T>(items: T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(current: ts.Node): void {
    if (predicate(current)) found.push(current);
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  return one(file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name), name);
}
const factory = declaration(managed, "createKillShellTool");
const resolver = one(descendants(factory, node => ts.isMethodDeclaration(node) && node.name.getText(managed) === "resolveExecution"), "KillShell resolver") as ts.MethodDeclaration;
assert.ok(resolver.body);
const classificationBlock = one(descendants(coordinator, node => ts.isBlock(node)
  && node.statements.some(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === "interpreted"))), "classification block") as ts.Block;
const classificationStart = classificationBlock.statements.findIndex(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === "interpreted"));
const classification = classificationBlock.statements.slice(classificationStart);
assert.equal(classification.length, 6, "Only the reviewed classification tail may execute");
assert.ok(ts.isReturnStatement(classification[5]!));

const createTools = one(descendants(coordinator, node => ts.isMethodDeclaration(node) && node.name.getText(coordinator) === "createAgentTools"), "createAgentTools");
const modelBlock = one(descendants(createTools, node => ts.isBlock(node)
  && node.statements.some(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === "isError"))), "model envelope block") as ts.Block;
const errorStatement = one(modelBlock.statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === "isError")), "model error assignment");
const modelReturn = one(modelBlock.statements.filter(ts.isReturnStatement), "model envelope return");

const methods = new Set(["none", "stop", "interpretResult", "now", "isArray", "filter", "join", "split", "has", "add"]);
const direct = new Set(["attachToolSummary", "failedToolResultMessage", "reportExecutionState", "readStringField", "String", "Boolean", "serializeToolResult"]);
function guard(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    assert.ok(ts.isIdentifier(callee) && direct.has(callee.text)
      || ts.isPropertyAccessExpression(callee) && methods.has(callee.name.text), "Unreviewed call: " + node.getText());
  }
  if (ts.isNewExpression(node)) assert.ok(ts.isIdentifier(node.expression) && node.expression.text === "Set", "Unreviewed constructor");
  ts.forEachChild(node, guard);
}
const helpers = ["attachToolSummary", "failedToolResultMessage", "readStringField"].map(name => declaration(coordinator, name));
for (const node of [resolver.body, ...classification, errorStatement, modelReturn, ...helpers]) guard(node);
const script = [
  ...helpers.map(node => node.getText(coordinator)),
  `function resolve(args) ${resolver.body.getText(managed)}`,
  `function classify(execution, result, scriptMode, latestExecutionState = "running") {
    const options = { script: scriptMode }; const startedAt = 0;
    ${classification.map(node => node.getText(coordinator)).join("\n")}
  }`,
  `function envelope(result, resultStatus, scriptMode) {
    const image = undefined, source = "builtin", recoverableError = false;
    const options = { script: scriptMode };
    ${errorStatement.getText(coordinator)}
    ${modelReturn.getText(coordinator)}
  }`,
  "({resolve, classify, envelope})"
].join("\n");
const compiled = stripTypeScriptTypes(script, { mode: "strip" });
interface Execution {
  execute(): Promise<ManagedProcessSnapshot>;
  interpretResult?: (result: ManagedProcessSnapshot, context: { script: boolean }) => { result: unknown; errorMessage?: string };
}
interface Outcome { result: ManagedProcessSnapshot; executionStatus: string; errorMessage?: string; evidence?: string }
interface Api {
  resolve(args: { processId: string; reason: string }): Execution;
  classify(execution: Execution, result: ManagedProcessSnapshot, script: boolean, state?: string): Outcome;
  envelope(result: unknown, status: string, script: boolean): { isError: boolean; details: unknown; content: Array<{ text: string }> };
}
for (const scriptMode of [false, true]) {
  for (const row of [
    { status: "failed", exitCode: undefined, message: "Process group remained alive after SIGKILL.", failed: true },
    { status: "failed", exitCode: 0, message: undefined, failed: true },
    { status: "failed", exitCode: undefined, message: "", failed: true },
    { status: "stopped", exitCode: 7, message: undefined, failed: false },
    { status: "not_needed", exitCode: 7, message: undefined, failed: false },
    { status: "stopped", exitCode: undefined, message: undefined, failed: false }
  ] as const) {
    test(`KillShell ${row.status}, code ${row.exitCode}, message ${JSON.stringify(row.message)}, script ${scriptMode}`, async () => {
      const snapshot: ManagedProcessSnapshot = Object.freeze({
        processId: "00000000-0000-4000-8000-000000000001", pid: 123,
        command: "fixture", cwd: "/inert", logPath: "/inert/log", startedAt: "2026-10-24T00:00:00Z",
        state: row.status === "failed" ? "running" : row.status === "stopped" ? "stopped" : "failed",
        exitCode: row.exitCode, cleanup: Object.freeze({ status: row.status, message: row.message })
      });
      const original = JSON.stringify(snapshot);
      const calls: unknown[][] = [];
      const states: unknown[][] = [];
      const api = runInNewContext(compiled, {
        service: { stop: async (...args: unknown[]) => { calls.push(args); return snapshot; } },
        ToolAccesses: { none: () => [] }, Date: { now: () => 10 },
        reportExecutionState: (...args: unknown[]) => states.push(args),
        serializeToolResult: (value: unknown) => JSON.stringify(value)
      }, { timeout: 2_000, contextCodeGeneration: { strings: false, wasm: false } }) as Api;
      const execution = api.resolve({ processId: snapshot.processId, reason: "inert proof" });
      const result = await execution.execute();
      assert.strictEqual(result, snapshot);
      assert.deepEqual(calls, [[snapshot.processId, "inert proof"]]);
      if (execution.interpretResult) assert.strictEqual(execution.interpretResult(snapshot, { script: scriptMode }).result, snapshot);
      const outcome = api.classify(execution, result, scriptMode);
      assert.equal(outcome.executionStatus, row.failed ? "failed" : "succeeded");
      assert.equal(Boolean(outcome.errorMessage), row.failed);
      if (row.failed && row.message) assert.equal(outcome.errorMessage, row.message);
      assert.deepEqual(states, [[outcome.executionStatus, outcome.errorMessage]]);
      const envelope = api.envelope(outcome.result, outcome.executionStatus, scriptMode);
      assert.equal(envelope.isError, row.failed);
      assert.strictEqual(envelope.details, outcome.result);
      assert.equal(JSON.stringify(snapshot), original);
      assert.equal(JSON.stringify(outcome.result.cleanup), JSON.stringify(snapshot.cleanup));
      assert.equal(outcome.result.exitCode, snapshot.exitCode);
      const unknown = api.classify(execution, result, scriptMode, "unknown");
      assert.equal(unknown.executionStatus, "unknown");
    });
  }
}
