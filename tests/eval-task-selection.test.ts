import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual CLI function and report writes. Only configuration loading and
// the expensive model-suite boundary are inert; no model/runtime is imported.
const commandSource = ts.createSourceFile("evals.ts", readFileSync(new URL("../src/cli/commands/evals.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declarations = ["evalRunCommand", "sanitizeLabel"].map(name => {
  const found = commandSource.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, name);
  return found[0]!.getText(commandSource);
});
let importCount = 0;
const compiled = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  transformers: { before: [context => root => {
    const visit: ts.Visitor = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.equal(node.arguments.length, 1);
        assert.ok(ts.isStringLiteral(node.arguments[0]!));
        assert.equal((node.arguments[0] as ts.StringLiteral).text, "../../config/store.js");
        importCount += 1;
        return ts.factory.createCallExpression(ts.factory.createIdentifier("fixtureImport"), undefined, []);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  }] }
}).outputText;
assert.equal(importCount, 1, "exactly the existing config-store import is replaced");
const suiteSource = ts.createSourceFile("suite.ts", readFileSync(new URL("../src/evals/suite.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const catalog = suiteSource.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).filter(node => ts.isIdentifier(node.name) && node.name.text === "builtinEvalTasks");
assert.equal(catalog.length, 1);
assert.ok(catalog[0]!.initializer && ts.isArrayLiteralExpression(catalog[0]!.initializer));
interface Task { id: string }
const tasks = JSON.parse(JSON.stringify(runInNewContext(`(${catalog[0]!.initializer.getText(suiteSource)})`, {}, { timeout: 1_000 }))) as Task[];
const ids = tasks.map(task => task.id);
assert.ok(ids.length >= 2);

interface Options { tasks?: string[]; out?: string; label?: string }
interface CommandApi { evalRunCommand(root: string, options: Options): Promise<void> }

async function fixture(selection: string[] | undefined, existing = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-eval-task-selection-"));
  const destination = path.join(root, "reports", "result.json");
  const sentinel = "existing evaluation report must survive invalid selection\n";
  if (existing) { await fs.mkdir(path.dirname(destination)); await fs.writeFile(destination, sentinel); }
  let configLoads = 0;
  let runnerCalls = 0;
  let selected: string[] = [];
  const logs: string[] = [];
  const exports: Partial<CommandApi> = {};
  const agentRunner = () => { throw new Error("Real model runner must not execute"); };
  runInNewContext(compiled, {
    exports, fs, path, builtinEvalTasks: tasks, runTaskWithAgent: agentRunner,
    agentDir: () => { throw new Error("The fixture always supplies an explicit output"); },
    console: { log: (...values: unknown[]) => { logs.push(values.join(" ")); } },
    fixtureImport: async () => ({ createFileConfigStore: () => ({ load: async () => { configLoads += 1; return { defaultModel: "synthetic" }; } }) }),
    runEvalSuite: async (options: { tasks: Task[]; label: string; run: unknown }) => {
      runnerCalls += 1;
      assert.equal(options.run, agentRunner);
      selected = Array.from(options.tasks, task => task.id);
      return { label: options.label, results: selected.map(taskId => ({ taskId, passed: true })), summary: { tasks: selected.length, passed: selected.length, passRate: 1, totalSteps: 0 } };
    }
  }, { timeout: 1_000 });
  let error: string | undefined;
  try {
    try { await exports.evalRunCommand!(root, { tasks: selection, out: destination, label: "selection-test" }); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    let output: string | undefined;
    try { output = await fs.readFile(destination, "utf8"); } catch (caught) { if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught; }
    const entries = await fs.readdir(root);
    return { error, output, sentinel, configLoads, runnerCalls, selected, logs, entries };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const [name, selection] of [
  ["unknown after valid", [ids[0]!, "missing-task"]],
  ["unknown before valid", ["missing-task", ids[0]!]],
  ["multiple unknown IDs", [ids[0]!, "missing-task", "other-missing"]],
  ["case-sensitive typo", [ids[0]!, ids[1]!.toUpperCase()]],
  ["whitespace typo", [ids[0]!, ` ${ids[1]!} `]]
] as const) {
  test(`eval selection rejects ${name} before model/config work or existing-report replacement`, async () => {
    const result = await fixture([...selection]);
    assert.match(result.error ?? "", /Unknown eval task IDs/u);
    assert.equal(result.configLoads, 0);
    assert.equal(result.runnerCalls, 0);
    assert.equal(result.output, result.sentinel);
    assert.deepEqual(result.logs, []);
  });
}
test("invalid mixed selection does not create output directories", async () => {
  const result = await fixture([ids[0]!, "missing-task"], false);
  assert.match(result.error ?? "", /Unknown eval task IDs/u);
  assert.equal(result.output, undefined);
  assert.deepEqual(result.entries, []);
  assert.equal(result.runnerCalls, 0);
});
test("all-invalid selection retains its existing diagnostic and report", async () => {
  const result = await fixture(["missing-task"]);
  assert.ok(result.error?.includes(`No matching eval tasks. Available: ${ids.join(", ")}`));
  assert.equal(result.output, result.sentinel);
  assert.equal(result.configLoads, 0);
  assert.equal(result.runnerCalls, 0);
});
for (const [name, selection, expected] of [
  ["omitted selection", undefined, ids],
  ["empty selection", [], ids],
  ["single exact ID", [ids[0]!], [ids[0]!]],
  ["reverse requested order", [ids[1]!, ids[0]!], [ids[0]!, ids[1]!]],
  ["duplicate valid IDs", [ids[0]!, ids[0]!], [ids[0]!]]
] as const) {
  test(`eval selection preserves ${name}`, async () => {
    const result = await fixture(selection === undefined ? undefined : [...selection]);
    assert.equal(result.error, undefined);
    assert.equal(result.configLoads, 1);
    assert.equal(result.runnerCalls, 1);
    assert.deepEqual(result.selected, expected);
    assert.deepEqual((JSON.parse(result.output!) as { results: Array<{ taskId: string }> }).results.map(item => item.taskId), expected);
  });
}
