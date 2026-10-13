/** Only the actual TerminalScreen connection selector runs; all IPC boundaries are inert spies. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

interface Handle { terminalId: string; replay: string; sequence: number }
type Preview = (Handle & { kind: "script"; command: string }) | { kind: "static"; url: string };
interface Api {
  createTerminal(projectId: string, cols: number, rows: number, slotId: string): Promise<Handle>;
  startProjectPreview(projectId: string): Promise<Preview>;
  writeTerminal(): never;
  disposeTerminal(): never;
  stopProjectPreview(): never;
}
const sourcePath = path.join(process.env.BINY_TERMINAL_SOURCE_ROOT ?? process.cwd(), "src/desktop/renderer/src/components/TerminalView.tsx");
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const screen = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "TerminalScreen");
assert.ok(screen);
const selectors: ts.ArrowFunction[] = [];
const originalCalls: ts.CallExpression[] = [];
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "connect" && node.initializer && ts.isArrowFunction(node.initializer)) selectors.push(node.initializer);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "window.biny.createTerminal") originalCalls.push(node);
  ts.forEachChild(node, visit);
};
visit(screen);
assert.equal(originalCalls.length, 1, "select the sole actual TerminalScreen generic connection call");
assert.ok(selectors.length <= 1);
// The baseline call is copied from its real .then chain, not reimplemented by the fixture.
const selected = selectors.length ? selectors[0]!.getText(source) : `async () => (${originalCalls[0]!.getText(source)})`;
const compiled = ts.transpileModule(`(${selected})`, { fileName: "selector.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

function setup(slotId: string, restartToken: number, outcome: Preview | Error = Object.freeze({ kind: "script", terminalId: "preview-new", replay: "replay", sequence: 7, command: "npm run dev" })) {
  const calls: unknown[][] = [];
  const generic = Object.freeze({ terminalId: "generic", replay: "ordinary", sequence: 3 });
  const forbidden = (): never => { throw new Error("selector must not write, stop or dispose a terminal"); };
  const api: Api = {
    createTerminal: async (...args) => { calls.push(["create", ...args]); return generic; },
    startProjectPreview: async (...args) => { calls.push(["preview", ...args]); if (outcome instanceof Error) throw outcome; return outcome; },
    writeTerminal: forbidden, disposeTerminal: forbidden, stopProjectPreview: forbidden
  };
  const context = vm.createContext({ window: { biny: api }, projectId: "project", slotId, restartToken }, { codeGeneration: { strings: false, wasm: false } });
  const connect = vm.runInContext(compiled.outputText, context, { timeout: 1_000 }) as () => Promise<Handle>;
  return { connect, calls, generic, outcome };
}

for (const [slot, token] of [["default", 0], ["ordinary-uuid", 2], ["preview", 0]] as const) {
  test(`generic connection remains unchanged for ${slot}/${token}`, async () => {
    const fixture = setup(slot, token);
    assert.equal(await fixture.connect(), fixture.generic);
    assert.deepEqual(fixture.calls, [["create", "project", 80, 24, slot]]);
  });
}
test("explicit preview restart uses dedicated start and preserves the complete handle", async () => {
  const fixture = setup("preview", 1);
  assert.equal(await fixture.connect(), fixture.outcome);
  assert.deepEqual(fixture.calls, [["preview", "project"]]);
});
test("later explicit preview restarts still use the dedicated entry", async () => {
  const fixture = setup("preview", 3);
  assert.equal(await fixture.connect(), fixture.outcome);
  assert.deepEqual(fixture.calls, [["preview", "project"]]);
});
test("static preview has no terminal handle and never falls back to a bare shell", async () => {
  const fixture = setup("preview", 1, Object.freeze({ kind: "static", url: "http://127.0.0.1:3000/" }));
  await assert.rejects(fixture.connect(), /静态预览.*浏览器面板/u);
  assert.deepEqual(fixture.calls, [["preview", "project"]]);
});
for (const message of ["没有预览入口", "IPC unavailable"]) {
  test(`dedicated start preserves rejection identity: ${message}`, async () => {
    const error = new Error(message);
    const fixture = setup("preview", 1, error);
    await assert.rejects(fixture.connect(), reason => reason === error);
    assert.deepEqual(fixture.calls, [["preview", "project"]]);
  });
}
