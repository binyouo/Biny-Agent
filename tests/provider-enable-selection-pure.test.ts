/** Actual-source callbacks only: no React, product imports, provider, IPC or credential execution. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = "src/desktop/renderer/src/components/settings/ProviderSettings.tsx";
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const components = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === "ProviderSettings");
assert.equal(components.length, 1);
const body = components[0]!.body;
assert.ok(body);
const effects = body.statements.filter(ts.isExpressionStatement)
  .map(statement => statement.expression).filter(ts.isCallExpression)
  .filter(call => ts.isIdentifier(call.expression) && call.expression.text === "useEffect")
  .filter(call => {
    const dependencies = call.arguments[1];
    return dependencies !== undefined && ts.isArrayLiteralExpression(dependencies)
      && dependencies.elements.map(element => element.getText(source)).join(",") === "activeKey,entries";
  });
assert.equal(effects.length, 1, "select the actual missing-key reconciliation effect");
const reconciliation = effects[0]!.arguments[0];
assert.ok(reconciliation && ts.isArrowFunction(reconciliation));
const reconciliationCallback: ts.ArrowFunction = reconciliation;
const enables = body.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
  .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "enableProvider");
assert.equal(enables.length, 1);
const initializer = enables[0]!.initializer;
assert.ok(initializer && ts.isCallExpression(initializer));
assert.equal(initializer.expression.getText(source), "useCallback");
const enable = initializer.arguments[0];
assert.ok(enable && ts.isArrowFunction(enable));
const forbidden = new Set(["process", "require", "fetch", "window", "document", "globalThis", "eval", "Function", "WebSocket", "XMLHttpRequest"]);
function inspect(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && node.kind !== ts.SyntaxKind.ImportKeyword);
  if (ts.isIdentifier(node)) assert.ok(!forbidden.has(node.text), `unreviewed capability ${node.text}`);
  assert.ok(!ts.isNewExpression(node), "callbacks require no constructors");
  ts.forEachChild(node, inspect);
}
inspect(reconciliation);
inspect(enable);
function compile<T>(node: ts.ArrowFunction, bindings: Record<string, unknown>): T {
  const context = vm.createContext(bindings, { codeGeneration: { strings: false, wasm: false } });
  const expression = stripTypeScriptTypes(`(${node.getText(source)})`, { mode: "strip" });
  return vm.runInContext(expression, context, { timeout: 1000 }) as T;
}

type Selection = string | undefined;
type Update = Selection | ((current: Selection) => Selection);
interface Row { key: string; catalog?: { id: string } }
const configured: Row[] = [
  { key: "provider:example", catalog: { id: "anthropic" } },
  { key: "provider:openai", catalog: { id: "openai" } }
];
function selectionFixture(activeKey: Selection, current: Selection, entries = configured) {
  let selected = current;
  const updates: Update[] = [];
  const effect = compile<() => void>(reconciliationCallback, { activeKey, entries, setActiveKey: (update: Update) => { updates.push(update); } });
  return {
    effect,
    select(value: Selection) { selected = value; },
    flush() { for (const update of updates.splice(0)) selected = typeof update === "function" ? update(selected) : update; },
    get selected() { return selected; },
    get pending() { return updates.length; }
  };
}
test("valid newer provider selection is not migrated", () => {
  const h = selectionFixture("provider:example", "provider:example");
  h.effect(); assert.equal(h.pending, 0); h.flush(); assert.equal(h.selected, "provider:example");
});
test("selected catalog key migrates to its configured row, not the first row", () => {
  const h = selectionFixture("openai", "openai");
  h.effect(); h.flush(); assert.equal(h.selected, "provider:openai");
});
test("stale effect cannot replace a newer selection", () => {
  const h = selectionFixture("openai", "provider:example");
  h.effect(); h.flush(); assert.equal(h.selected, "provider:example");
});
test("queued reconciliation updater cannot replace a later selection", () => {
  const h = selectionFixture("openai", "openai");
  h.effect(); h.select("provider:example"); h.flush(); assert.equal(h.selected, "provider:example");
});
test("a genuinely removed configured row retains the undefined fallback", () => {
  const h = selectionFixture("provider:removed", "provider:removed");
  h.effect(); h.flush(); assert.equal(h.selected, undefined);
});
test("implicit first-row selection remains implicit", () => {
  const h = selectionFixture(undefined, undefined);
  h.effect(); assert.equal(h.pending, 0); h.flush(); assert.equal(h.selected, undefined);
});

interface Catalog { value: string; baseUrl: string; protocol: string; requiresApiKey: boolean; modelsRequiresApiKey?: boolean; models: Array<{ id: string }> }
const catalog: Catalog = { value: "openai", baseUrl: "https://synthetic.invalid/v1", protocol: "openai-compatible", requiresApiKey: true, models: [{ id: "synthetic-model" }] };
for (const saved of [true, false]) {
  test(`deferred enable does not select its result; refresh requires successful persistence (${saved})`, async () => {
    let resolve!: (value: boolean) => void;
    const gate = new Promise<boolean>(complete => { resolve = complete; });
    const writes: unknown[] = [];
    const selections: unknown[] = [];
    const refreshes: Array<{ alias: string; force?: boolean }> = [];
    const action = compile<(entry: Catalog) => Promise<void>>(enable, {
      providerAliasFor: (entry: Catalog) => entry.value,
      catalogModelUpsertInput: (...args: unknown[]) => args,
      defaultModelAlias: "existing-default",
      applyModelBatch: (input: unknown) => { writes.push(input); return gate; },
      setActiveKey: (value: unknown) => { selections.push(value); },
      refreshCatalog: async (alias: string, options: { force?: boolean }) => { refreshes.push({ alias, force: options.force }); }
    });
    const pending = action(catalog);
    assert.equal(writes.length, 1); assert.deepEqual(selections, []); assert.deepEqual(refreshes, []);
    resolve(saved); await pending;
    assert.deepEqual(selections, [], "only current-row reconciliation may migrate selection");
    assert.deepEqual(refreshes, saved ? [{ alias: "openai", force: true }] : []);
  });
}
