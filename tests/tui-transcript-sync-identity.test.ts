import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Stubbed behavioral/work-count evidence only, not terminal rendering evidence.
// Select the actual class and factory without importing pi-tui, the app or Host.
// Existing real-render/terminal tests remain the integration coverage in CI.
const sourcePath = path.resolve(process.cwd(), "src/tui/components/transcriptView.ts");
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
const classes = source.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "TranscriptView");
const factories = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "createItemComponent");
assert.equal(classes.length, 1, "select exactly the production TranscriptView");
assert.equal(factories.length, 1, "select exactly the production component factory");
const declaration = classes[0]!;
const selectedClass = ts.factory.updateClassDeclaration(declaration,
  declaration.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword),
  declaration.name, declaration.typeParameters, declaration.heritageClauses, declaration.members);
const printer = ts.createPrinter();
const selected = [selectedClass, factories[0]!]
  .map(node => printer.printNode(ts.EmitHint.Unspecified, node, source)).join("\n");
const compiled = ts.transpileModule(selected, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

const stubs = `
let themeRevision = 0;
let failUpdate = false;
let failUpdateId;
let constructed = 0;
class Container {
  children = [];
  invalidations = 0;
  invalidate() {
    this.invalidations++;
    for (const child of this.children) child.invalidate();
  }
}
class ItemComponent extends Container {
  expanded = false;
  updates = 0;
  leadingSpace = true;
  constructor(item) {
    super();
    constructed++;
    this.itemId = item.id;
    this.item = item;
    this.colorRevision = themeRevision;
  }
  update(item) {
    if (failUpdate || item.id === failUpdateId) throw new Error("inert update failure");
    this.updates++;
    this.item = item;
    this.colorRevision = themeRevision;
  }
  toggleDetails() { this.expanded = !this.expanded; }
  setLeadingSpace(value) { this.leadingSpace = value; }
}
class UserMessageComponent extends ItemComponent {}
class AssistantMessageComponent extends ItemComponent {}
class ActivitySummaryComponent extends ItemComponent {}
class ThinkingComponent extends ItemComponent {}
class ToolExecutionComponent extends ItemComponent {}
class CardComponent extends ItemComponent {}
class NoticeComponent extends ItemComponent {}
const item = (id, kind = "user", content = id) => ({ id, kind, content });
const snapshot = (committed = [], active = []) => ({ committed, active });
const ids = view => view.children.map(component => component.itemId);
`;

function evaluate(body: string): unknown {
  const context = createContext(Object.create(null) as Record<string, unknown>, {
    codeGeneration: { strings: false, wasm: false }
  });
  const script = new Script(`${stubs}\n${compiled}\nJSON.stringify((() => { ${body}\n})());`, {
    filename: "transcript-sync-inert.js"
  });
  const serialized: unknown = script.runInContext(context, { timeout: 1000 });
  assert.equal(typeof serialized, "string");
  return JSON.parse(serialized as string) as unknown;
}

test("first empty sync reads the snapshot and identical snapshots avoid all entry traversal", () => {
  assert.deepEqual(evaluate(`
    const view = new TranscriptView();
    let emptyReads = 0;
    const empty = { get committed() { emptyReads++; return []; }, active: [] };
    const emptyFirst = view.sync(empty);
    const emptySecond = view.sync(empty);
    let visits = 0;
    const entries = Array.from({ length: 1000 }, (_, index) => item(String(index)));
    entries[Symbol.iterator] = function* () {
      for (let index = 0; index < this.length; index++) { visits++; yield this[index]; }
    };
    const state = snapshot(entries);
    const first = view.sync(state);
    const initialVisits = visits;
    visits = 0;
    const unchanged = Array.from({ length: 20 }, () => view.sync(state));
    return { emptyFirst, emptySecond, emptyReads, first, initialVisits,
      visits, unchanged: unchanged.every(value => value === false), count: view.children.length };
  `), { emptyFirst: false, emptySecond: false, emptyReads: 1, first: true,
    initialVisits: 1000, visits: 0, unchanged: true, count: 1000 });
});

test("new wrappers reconcile unchanged items, additions, removals, reorders and immutable updates", () => {
  assert.deepEqual(evaluate(`
    const view = new TranscriptView();
    const a = item("a"), b = item("b", "assistant"), c = item("c", "activity");
    view.sync(snapshot([a], [b]));
    const original = view.componentFor("a");
    const unchanged = view.sync(snapshot([a], [b]));
    const same = view.componentFor("a") === original;
    const added = view.sync(snapshot([a, c], [b]));
    const addedIds = ids(view);
    const reordered = view.sync(snapshot([b, a, c]));
    const reorderedIds = ids(view);
    const updated = view.sync(snapshot([b, { ...a, content: "replacement" }]));
    return { unchanged, same, added, addedIds, reordered, reorderedIds, updated,
      finalIds: ids(view), removed: view.componentFor("c") === undefined,
      retained: view.componentFor("a") === original,
      content: original.item.content, updates: original.updates };
  `), { unchanged: false, same: true, added: true, addedIds: ["a", "c", "b"],
    reordered: true, reorderedIds: ["b", "a", "c"], updated: true,
    finalIds: ["b", "a"], removed: true, retained: true, content: "replacement", updates: 1 });
});

test("reset clears identity and components even when the next snapshot object is reused", () => {
  assert.deepEqual(evaluate(`
    const view = new TranscriptView();
    const state = snapshot([item("same")]);
    view.sync(state);
    const previous = view.componentFor("same");
    view.reset();
    const empty = view.children.length === 0 && view.componentFor("same") === undefined;
    const rebuilt = view.sync(state);
    const replaced = previous !== view.componentFor("same");
    view.reset();
    const reusedId = view.sync(snapshot([item("same", "assistant", "new session")]));
    return { empty, rebuilt, replaced, reusedId, constructed,
      kind: view.componentFor("same").item.kind };
  `), { empty: true, rebuilt: true, replaced: true, reusedId: true, constructed: 3, kind: "assistant" });
});

test("theme invalidation and local expansion remain independent of identical sync", () => {
  assert.deepEqual(evaluate(`
    const view = new TranscriptView();
    const state = snapshot([item("tool", "tool"), item("card", "card"), item("notice", "notification")]);
    view.sync(state);
    const tool = view.componentFor("tool"), card = view.componentFor("card");
    tool.toggleDetails(); card.toggleDetails();
    const localSync = view.sync(state);
    themeRevision++;
    view.invalidate();
    const themeSync = view.sync(state);
    return { localSync, themeSync, expanded: [tool.expanded, card.expanded],
      revisions: view.children.map(child => child.colorRevision),
      updates: view.children.map(child => child.updates),
      invalidations: view.children.map(child => child.invalidations),
      retained: tool === view.componentFor("tool") && card === view.componentFor("card") };
  `), { localSync: false, themeSync: false, expanded: [true, true], revisions: [1, 1, 1],
    updates: [1, 1, 1], invalidations: [1, 1, 1], retained: true });
});

test("new snapshot ordering refreshes adjacent tool spacing without replacing unchanged tools", () => {
  assert.deepEqual(evaluate(`
    const view = new TranscriptView();
    const a = item("a", "tool"), b = item("b", "tool"), notice = item("n", "notification");
    view.sync(snapshot([a, b]));
    const original = view.componentFor("b");
    const initial = [view.componentFor("a").leadingSpace, original.leadingSpace];
    view.sync(snapshot([a, notice, b]));
    const separated = original.leadingSpace;
    view.sync(snapshot([b, a]));
    return { initial, separated, reordered: view.children.map(child => child.leadingSpace),
      retained: view.componentFor("b") === original };
  `), { initial: [true, false], separated: true, reordered: [true, false], retained: true });
});

test("failed synchronization does not cache its snapshot before a successful retry", () => {
  assert.deepEqual(evaluate(`
    const view = new TranscriptView();
    view.sync(snapshot([item("a")]));
    const next = snapshot([item("a", "user", "changed")]);
    failUpdate = true;
    let failed = false;
    try { view.sync(next); } catch (error) { failed = error.message === "inert update failure"; }
    failUpdate = false;
    const retry = view.sync(next);
    return { failed, retry, content: view.componentFor("a").item.content,
      settled: view.sync(next), updates: view.componentFor("a").updates };
  `), { failed: true, retry: true, content: "changed", settled: false, updates: 1 });
});

test("partially failed different sync invalidates the previous successful snapshot identity", () => {
  assert.deepEqual(evaluate(`
    const view = new TranscriptView();
    const previous = snapshot([item("a"), item("b")]);
    const next = snapshot([item("a", "user", "changed-a"), item("b", "user", "changed-b")]);
    view.sync(previous);
    failUpdateId = "b";
    let failed = false;
    try { view.sync(next); } catch (error) { failed = error.message === "inert update failure"; }
    const partial = view.componentFor("a").item.content;
    failUpdateId = undefined;
    const restored = view.sync(previous);
    const restoredContent = view.children.map(child => child.item.content);
    const retry = view.sync(next);
    return { failed, partial, restored, restoredContent, retry,
      finalContent: view.children.map(child => child.item.content), settled: view.sync(next) };
  `), { failed: true, partial: "changed-a", restored: true, restoredContent: ["a", "b"],
    retry: true, finalContent: ["changed-a", "changed-b"], settled: false });
});
