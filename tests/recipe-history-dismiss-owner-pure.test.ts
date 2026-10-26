import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

// Source-only UI test. No product imports, real IPC, store, filesystem mutation,
// application timers, model, Host, notifications or session persistence are evaluated.
// A runner-level watchdog is required: the VM timeout covers initialization only,
// not callbacks invoked later by this fixture or native Promise continuations.
const file = path.resolve(process.cwd(), "src/desktop/renderer/src/App.tsx");
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "DesktopApp");
assert.ok(app && ts.isFunctionDeclaration(app) && app.body);
const statements = app.body.statements;
function binding(name: string): string | undefined {
  return statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === name))?.getText(source);
}
function effect(contains: string): string {
  const found = statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === "useEffect" && node.getText(source).includes(contains));
  assert.equal(found.length, 1, contains);
  return found[0]!.getText(source);
}
const reset = effect("setRecipeNotices([])");
const history = effect("window.biny.recipeSuggestions");
const dismiss = binding("dismissRecipe"), extract = binding("extractRecipe");
assert.ok(dismiss && extract);
const selected = [binding("suppressedRecipeHistoryRef") ?? "", reset, history, dismiss, extract].join("\n");
const selectedAst = ts.createSourceFile("selected.ts", selected, ts.ScriptTarget.Latest, true);
const allowedCalls = new Set([
  "useRef", "useEffect", "useCallback", "setRecipeNotices", "setSkillExtraction", "setWarning", "errorMessage", "prefillComposer", "setToast",
  "window.biny.recipeSuggestions", "window.biny.recipeSuggestions().then", "window.biny.recipeSuggestions().then().catch",
  "window.biny.setRecipeState", "window.biny.setRecipeState().catch", "current.map", "current.filter", "recipes.filter", "recipes.filter().map", "seen.has", "dismissed.has", "suppressed.ids.add"
]);
function callRoot(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${callRoot(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${callRoot(node.expression)}()`;
  assert.fail(`unexpected callee shape: ${node.getText(selectedAst)}`);
}
const boundaryCalls: string[] = [];
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isTaggedTemplateExpression(node));
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  if (ts.isIdentifier(node)) assert.ok(!["process", "require", "fetch", "eval", "Function"].includes(node.text), node.text);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(selectedAst), "Set");
  if (ts.isCallExpression(node)) {
    const name = callRoot(node.expression);
    assert.ok(allowedCalls.has(name), `unexpected call: ${name}`);
    if (name === "window.biny.recipeSuggestions" || name === "window.biny.setRecipeState") boundaryCalls.push(name);
  }
  ts.forEachChild(node, audit);
}
audit(selectedAst);
assert.deepEqual(boundaryCalls, ["window.biny.recipeSuggestions", "window.biny.setRecipeState", "window.biny.setRecipeState"]);
const js = stripTypeScriptTypes(`
  let workspace, selectedSessionId;
  const selectedRef = { current: undefined }, projectRef = { current: undefined };
  ${binding("suppressedRecipeHistoryRef") ?? ""}
  ${dismiss}
  ${extract}
  globalThis.ui = {
    dismissRecipe, extractRecipe,
    enter(projectId, sessionId) {
      workspace = { project: { id: projectId } }; selectedSessionId = sessionId;
      projectRef.current = projectId; selectedRef.current = sessionId;
      ${reset}
      ${history}
    }
  };
`, { mode: "strip" });
interface Recipe { id: string; sessionId?: string; extractPrompt: string }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
// Yield one event-loop boundary to drain the native .then/.catch continuations.
async function flush(): Promise<void> { await setImmediate(); }
function fixture(rejectSave = false) {
  let notices: Recipe[] = [];
  const reads: Array<ReturnType<typeof deferred<Recipe[]>>> = [];
  const saves: unknown[][] = [], warnings: string[] = [], prompts: string[] = [];
  let effectIndex = 0;
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  const sandbox = {
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
    useEffect(callback: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectIndex++, previous = effects[index];
      if (previous && previous.deps.length === deps.length && deps.every((value, position) => Object.is(value, previous.deps[position]))) return;
      previous?.cleanup?.();
      effects[index] = { deps: Array.from(deps), cleanup: callback() };
    },
    setRecipeNotices(update: Recipe[] | ((current: Recipe[]) => Recipe[])) { notices = typeof update === "function" ? update(notices) : update; },
    setSkillExtraction() {}, setToast() {},
    setWarning(message: string) { warnings.push(message); }, errorMessage: (error: Error) => error.message,
    prefillComposer(prompt: string) { prompts.push(prompt); },
    window: { biny: {
      recipeSuggestions() { const read = deferred<Recipe[]>(); reads.push(read); return read.promise; },
      setRecipeState(...args: unknown[]) { saves.push(args); return rejectSave ? Promise.reject(new Error("save failed")) : Promise.resolve(); }
    } },
    ui: undefined as unknown as { enter(project: string, session: string): void; dismissRecipe(recipe: Recipe): void; extractRecipe(recipe: Recipe): void }
  };
  runInNewContext(js, sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  return {
    reads, saves, warnings, prompts, ui: sandbox.ui,
    enter(project = "P", session = "A") { effectIndex = 0; sandbox.ui.enter(project, session); },
    // Represents an already-delivered recipe.ready card, not execution of an event transport.
    show(recipe: Recipe) { notices.push(recipe); },
    ids() { return Array.from(notices, recipe => recipe.id); },
    cleanup() { for (const effect of effects) effect.cleanup?.(); effects.length = 0; }
  };
}
const first = { id: "repeatable-doc-task", sessionId: "A", extractPrompt: "extract first" };
const second = { id: "mcp-pipeline", sessionId: "A", extractPrompt: "extract second" };
for (const action of ["dismissRecipe", "extractRecipe"] as const) {
  for (const reject of [false, true]) {
    test(`${action}: late history preserves other cards, save rejection=${reject}`, async () => {
      const f = fixture(reject); f.enter(); f.show(first); f.ui[action](first);
      assert.deepEqual(f.ids(), []);
      await flush();
      assert.deepEqual(f.saves, [["P", "A", first.id, action === "dismissRecipe" ? "dismissed" : "extracted"]]);
      assert.deepEqual(f.warnings, reject ? ["save failed"] : []);
      f.reads[0]!.resolve([first, second]); await flush();
      assert.deepEqual(f.ids(), [second.id], "a stale historical read must not resurrect an optimistically closed card");
      assert.deepEqual(f.prompts, action === "extractRecipe" ? [first.extractPrompt] : []);
      f.cleanup();
    });
  }
}
test("ordinary history deduplicates an already visible card", async () => {
  const f = fixture(); f.enter(); f.show(first); f.reads[0]!.resolve([first, second]); await flush();
  assert.deepEqual(f.ids(), [first.id, second.id]); f.cleanup();
});
test("A to B to A resets suppression and rejects the previous A visit response", async () => {
  const f = fixture(true); f.enter(); f.show(first); f.ui.dismissRecipe(first); await flush();
  f.enter("P", "B"); f.enter("P", "A");
  f.reads[0]!.resolve([second]); f.reads[1]!.resolve([second]); await flush();
  assert.deepEqual(f.ids(), [], "cancelled reads from old visits must not publish, including ABA");
  f.reads[2]!.resolve([first]); await flush();
  assert.deepEqual(f.ids(), [first.id], "returning to a scope must respect the new authoritative history"); f.cleanup();
});
test("another project with the same session id has its own suppression scope", async () => {
  const f = fixture(); f.enter(); f.show(first); f.ui.dismissRecipe(first);
  f.enter("Q", "A"); f.reads[0]!.resolve([second]); f.reads[1]!.resolve([first]); await flush();
  assert.deepEqual(f.ids(), [first.id]); f.cleanup();
});
test("late history after cleanup cannot restore cards", async () => {
  const f = fixture(); f.enter(); f.cleanup(); f.reads[0]!.resolve([first]); await flush();
  assert.deepEqual(f.ids(), []);
});
