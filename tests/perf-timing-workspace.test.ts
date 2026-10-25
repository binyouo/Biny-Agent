/** Real diagnostic sink controls plus source-only checks of production root plumbing.
 * Source checks do not execute AgentSession, Host, memory retrieval or providers.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { workspaceAgentDir } from "../src/config/paths.js";
import { perfNow, perfTimingEnabled, recordPerfPhase } from "../src/observability/perfTiming.js";

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "biny-perf-root-"));
  const previous = { agent: process.env.BINY_AGENT_DIR, timing: process.env.BINY_PERF_TIMING };
  try {
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    process.env.BINY_PERF_TIMING = "1";
    run(root);
  } finally {
    if (previous.agent === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous.agent;
    if (previous.timing === undefined) delete process.env.BINY_PERF_TIMING;
    else process.env.BINY_PERF_TIMING = previous.timing;
    rmSync(root, { recursive: true, force: true });
  }
}

function rows(workspace: string): Record<string, unknown>[] {
  return readFileSync(path.join(workspaceAgentDir(workspace), "perf.jsonl"), "utf8").trimEnd().split("\n").map(line => {
    const value: unknown = JSON.parse(line);
    assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
  });
}

test("sink: interleaved explicit workspaces retain their own phases and run IDs", () => withFixture(root => {
  const a = path.join(root, "a"), b = path.join(root, "b");
  mkdirSync(a); mkdirSync(b);
  const started = perfNow();
  recordPerfPhase("a.first", started, { runId: "run-a", count: 0, ready: false }, a);
  recordPerfPhase("b.first", started, { runId: "run-b" }, b);
  recordPerfPhase("a.second", started, { runId: "run-a" }, a);
  assert.notEqual(workspaceAgentDir(a), workspaceAgentDir(b));
  const aRows = rows(a), bRows = rows(b);
  assert.deepEqual(aRows.map(row => [row.phase, row.runId]), [["a.first", "run-a"], ["a.second", "run-a"]]);
  assert.deepEqual(bRows.map(row => [row.phase, row.runId]), [["b.first", "run-b"]]);
  assert.equal(aRows[0]?.count, 0);
  assert.equal(aRows[0]?.ready, false);
  for (const row of [...aRows, ...bRows]) {
    assert.equal(typeof row.t, "string");
    assert.ok(Number.isFinite(Date.parse(String(row.t))));
    assert.equal(typeof row.ms, "number");
    assert.ok(Number.isFinite(row.ms));
  }
}));

test("sink: missing workspace never borrows the preceding explicit destination", () => withFixture(root => {
  const a = path.join(root, "a");
  mkdirSync(a);
  recordPerfPhase("unowned.before", perfNow());
  assert.equal(existsSync(path.join(root, "state")), false);
  recordPerfPhase("owned", perfNow(), undefined, a);
  const file = path.join(workspaceAgentDir(a), "perf.jsonl");
  const before = readFileSync(file, "utf8");
  recordPerfPhase("unowned.after", perfNow());
  recordPerfPhase("empty-root", perfNow(), undefined, "");
  assert.equal(readFileSync(file, "utf8"), before);
}));

test("sink: disabled diagnostics do not create state", () => withFixture(root => {
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  for (const value of [undefined, "", "0"]) {
    if (value === undefined) delete process.env.BINY_PERF_TIMING;
    else process.env.BINY_PERF_TIMING = value;
    assert.equal(perfTimingEnabled(), false);
    recordPerfPhase("disabled", perfNow(), undefined, workspace);
    assert.equal(existsSync(path.join(root, "state")), false);
  }
}));

test("sink: directory creation failure is diagnostic-only and later roots still work", () => withFixture(root => {
  const blocked = path.join(root, "blocked"), healthy = path.join(root, "healthy");
  mkdirSync(blocked); mkdirSync(healthy);
  const destination = workspaceAgentDir(blocked);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, "obstruction");
  assert.doesNotThrow(() => recordPerfPhase("blocked", perfNow(), undefined, blocked));
  assert.equal(readFileSync(destination, "utf8"), "obstruction");
  recordPerfPhase("healthy", perfNow(), undefined, healthy);
  assert.deepEqual(rows(healthy).map(row => row.phase), ["healthy"]);
}));

test("sink: append failure is diagnostic-only and does not replace the obstruction", () => withFixture(root => {
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const file = path.join(workspaceAgentDir(workspace), "perf.jsonl");
  mkdirSync(file, { recursive: true });
  const marker = path.join(file, "owned-marker");
  writeFileSync(marker, "unchanged");
  assert.doesNotThrow(() => recordPerfPhase("blocked", perfNow(), undefined, workspace));
  assert.equal(readFileSync(marker, "utf8"), "unchanged");
}));

// This override changes AST input only. Runtime imports above always use this test's
// candidate helper; it must never load baseline session/store as a runtime dependency.
const sourceRoot = process.env.BINY_PERF_TIMING_SOURCE_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
function source(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, readFileSync(path.join(sourceRoot, relative), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function collect<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}
const callSites = [
  ["src/agent/AgentSession.ts", "this.options.workspaceRoot", ["turn.capabilities", "turn.preparePrompt", "turn.personalization", "turn.baseSystemPrompt", "turn.prepareTurn", "turn.persistCheckpoint", "turn.prepareTotal", "turn.loopPre"]],
  ["src/agent/context/ContextMemory.ts", "this.perfTimingRoot", ["context.workspace", "context.memoryRecall", "context.compact"]],
  ["src/agent/context/SemanticMemoryRetriever.ts", "this.options.workspaceRoot", ["memory.listEntries", "memory.semantic", "memory.rewrite"]],
  ["src/runtime/InteractiveAgentRuntime.ts", "this.commandRuntime.workspaceRoot", ["runtime.executeRun.pre"]],
  ["src/runtime/CommandRuntime.ts", "workspaceRoot", ["host.loadPlugins", "host.modelManagerCreate"]],
  ["src/desktop/electron/main/DesktopAgentManager.ts", "project.path", ["desktop.runtimeForPrompt", "desktop.loadAttachments", "desktop.sendPrompt", "desktop.sendPrompt"]]
] as const;
for (const [file, expectedRoot, phases] of callSites) {
  test(`source: every timing call in ${file} passes its instance root`, () => {
    const ast = source(file);
    const calls = collect(ast, ts.isCallExpression).filter(node => ts.isIdentifier(node.expression) && node.expression.text === "recordPerfPhase");
    assert.deepEqual(calls.map(call => {
      const phase = call.arguments[0];
      assert.ok(phase && ts.isStringLiteral(phase));
      return phase.text;
    }), [...phases]);
    for (const call of calls) {
      assert.equal(call.arguments.length, 4, call.getText(ast));
      assert.equal(call.arguments[3]?.getText(ast), expectedRoot);
    }
  });
}

test("source: session assembler binds retrieval and both context instances to its root", () => {
  const ast = source("src/agent/AgentSession.ts");
  const constructions = collect(ast, ts.isNewExpression);
  const retrievers = constructions.filter(node => node.expression.getText(ast) === "SemanticMemoryRetriever");
  assert.equal(retrievers.length, 1);
  const options = retrievers[0]?.arguments?.[0];
  assert.ok(options && ts.isObjectLiteralExpression(options));
  const roots = options.properties.filter(ts.isPropertyAssignment).filter(node => node.name.getText(ast) === "workspaceRoot");
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.initializer.getText(ast), "options.workspaceRoot");
  const contexts = constructions.filter(node => node.expression.getText(ast) === "ContextMemory");
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.arguments?.length, 13);
  assert.equal(contexts[0]?.arguments?.[12]?.getText(ast), "options.workspaceRoot");
  const factories = collect(ast, ts.isVariableDeclaration).filter(node => node.name.getText(ast) === "makeContextMemory");
  assert.equal(factories.length, 1);
  assert.ok(factories[0]?.initializer && ts.isArrowFunction(factories[0].initializer));
  assert.equal(factories[0].initializer.body, contexts[0]);
  const calls = collect(ast, ts.isCallExpression).filter(node => node.expression.getText(ast) === "makeContextMemory");
  assert.equal(calls.length, 2, "ordinary and staging contexts share the bound factory");
  assert.equal(calls[0]?.arguments[0]?.getText(ast), "workspace");
  const staging = calls[1]?.arguments[0];
  assert.ok(staging && ts.isNewExpression(staging));
  assert.equal(staging.expression.getText(ast), "WorkspaceContext");
  assert.equal(staging.arguments?.[0]?.getText(ast), "options.workspaceRoot");
});

test("source: no process-global workspace fallback remains", () => {
  for (const file of ["src/observability/perfTiming.ts", "src/agent/AgentSession.ts"]) {
    const ast = source(file);
    const oldNames = collect(ast, ts.isIdentifier).filter(node => node.text === "defaultWorkspaceRoot" || node.text === "setPerfTimingRoot");
    assert.equal(oldNames.length, 0, file);
  }
});

test("source: timing runtime imports only Node built-ins and the small config-path module", () => {
  for (const [file, expected] of [
    ["src/observability/perfTiming.ts", ["node:fs", "node:path", "../config/paths.js"]],
    ["src/config/paths.ts", ["node:crypto", "node:fs", "node:os", "node:path"]]
  ] as const) {
    const ast = source(file);
    const imports = ast.statements.filter(ts.isImportDeclaration).map(node => {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier));
      return node.moduleSpecifier.text;
    });
    assert.deepEqual(imports, [...expected], file);
    assert.equal(collect(ast, ts.isCallExpression).filter(node => node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require")).length, 0, file);
  }
});
