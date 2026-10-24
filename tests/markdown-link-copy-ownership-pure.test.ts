/** Actual source callbacks with VM-local hooks/events/clipboard only; no renderer imports or native clipboard. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/desktop/renderer/src/components/MarkdownWebLink.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("MarkdownWebLink.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "MarkdownWebLink");
assert.ok(component && ts.isFunctionDeclaration(component) && component.body);
const renderReturn = component.body.statements.find(ts.isReturnStatement);
assert.ok(renderReturn?.expression && ts.isJsxFragment(renderReturn.expression));
const handlers = new Map<string, string>();
function visit(node: ts.Node): void {
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === "a") {
    for (const name of ["onMouseUp", "onKeyUp"]) {
      const attr = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === name);
      assert.ok(attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression);
      assert.ok(ts.isArrowFunction(attr.initializer.expression));
      handlers.set(name, attr.initializer.expression.getText(ast));
    }
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "button" && node.children.some(child => ts.isJsxText(child) && child.text.trim() === "复制链接")) {
    const attr = node.openingElement.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === "onClick");
    assert.ok(attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression);
    handlers.set("copyClick", attr.initializer.expression.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(renderReturn);
assert.equal(handlers.size, 3);
assert.equal(handlers.get("copyClick"), "() => void copyLink()");
const componentCode = stripTypeScriptTypes(`function renderComponent() {${source.slice(component.body.getStart(ast) + 1, renderReturn.getStart(ast))}
  return { anchor, panel, firstItem, menuItems, showContextMenu, open, onMenuKeyDown, ${[...handlers].map(([name, code]) => `${name}: ${code}`).join(", ")} };
}`, { mode: "strip" });
const helperSource = readFileSync(new URL("../src/desktop/renderer/src/copyToClipboard.ts", import.meta.url), "utf8");
const helperAst = ts.createSourceFile("copyToClipboard.ts", helperSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(helperAst.statements.length, 1);
const helper = helperAst.statements[0];
assert.ok(helper && ts.isFunctionDeclaration(helper) && helper.name?.text === "copyToClipboard");
const exportToken = helper.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
assert.ok(exportToken);
const helperCode = stripTypeScriptTypes(helperSource.slice(0, exportToken.getStart(helperAst)) + helperSource.slice(exportToken.end), { mode: "strip" });

const setup = `"use strict";
let href = "https://example.test/doc";
const children = "Doc", internalByDefault = false;
const linkText = () => "Doc", parseWebUrl = () => undefined;
let cursor = 0, slots = [], stateSlots = [], layoutQueue = [], passiveQueue = [], unmounted = false;
let focus = "none", focusCalls = [], afterUnmount = 0, selectedText = false, writes = [], fallbackCalls = 0, opened = [];
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
function useState(initial) {
  const index = cursor++;
  if (!slots[index]) {
    const cell = { kind: "state", value: initial };
    cell.set = value => { if (unmounted) afterUnmount++; cell.value = typeof value === "function" ? value(cell.value) : value; };
    slots[index] = cell; stateSlots.push(cell);
  }
  return [slots[index].value, slots[index].set];
}
function useRef(initial) { const index = cursor++; slots[index] ??= { kind: "ref", value: { current: initial } }; return slots[index].value; }
function useCallback(fn, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { kind: "callback", value: fn, deps }; return slots[index].value; }
function effect(fn, deps, queue) {
  const index = cursor++, old = slots[index];
  if (old && sameDeps(old.deps, deps)) return;
  const next = { kind: "effect", deps, cleanup: undefined }; slots[index] = next;
  queue.push(() => { old?.cleanup?.(); next.cleanup = fn(); });
}
const useEffect = (fn, deps) => effect(fn, deps, passiveQueue);
const useLayoutEffect = (fn, deps) => effect(fn, deps, layoutQueue);
function flush(queue) { for (const callback of queue.splice(0)) callback(); }
const listeners = new Map();
function add(prefix, kind, callback) { const key = prefix + kind; if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(callback); }
function remove(prefix, kind, callback) { listeners.get(prefix + kind)?.delete(callback); }
function dispatch(prefix, kind, event = {}) { for (const callback of [...(listeners.get(prefix + kind) ?? [])]) callback(event); }
const node = name => ({ name, focus() { focus = name; focusCalls.push(name); document.activeElement = this; }, contains(target) { return target === this; }, getBoundingClientRect() { return { left: 20, bottom: 40 }; } });
const document = {
  activeElement: null, addEventListener: (kind, callback) => add("d", kind, callback), removeEventListener: (kind, callback) => remove("d", kind, callback),
  createElement(tag) { if (tag !== "textarea") throw new Error("unexpected element"); return { ...node("fallback"), value: "", style: {}, setAttribute() {}, select() {}, setSelectionRange() {} }; },
  body: { appendChild() {}, removeChild() {} }, execCommand(command) { if (command !== "copy") throw new Error("unexpected command"); fallbackCalls++; return false; }
};
const window = {
  innerWidth: 1000, innerHeight: 800, addEventListener: (kind, callback) => add("w", kind, callback), removeEventListener: (kind, callback) => remove("w", kind, callback),
  setTimeout() { return 1; }, clearTimeout() {},
  getSelection() { return { isCollapsed: !selectedText, toString: () => selectedText ? "Doc" : "", rangeCount: 1, getRangeAt: () => ({ intersectsNode: () => true }) }; },
  biny: { async openBrowser(value) { opened.push(value); } }
};
const onOpenExternal = value => { opened.push(value); };
const navigator = { clipboard: { writeText(value) { const entry = { value }; writes.push(entry); return new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; }); } } };
${helperCode}
${componentCode}
const anchorNode = node("anchor"), panelNode = node("panel"), firstNode = node("first"), copyNode = node("copy"), composerNode = node("composer");
let api;
function render(commitLayout = true, commitPassive = true) {
  cursor = 0; api = renderComponent();
  api.anchor.current = anchorNode; api.panel.current = panelNode; api.firstItem.current = firstNode; api.menuItems.current = [firstNode, node("internal"), copyNode];
  if (commitLayout) flush(layoutQueue); if (commitPassive) flush(passiveQueue);
}
function contextMenu() { api.showContextMenu({ preventDefault() {}, clientX: 60, clientY: 80 }); }
function start() { render(); contextMenu(); render(); api.copyClick(); }
function settle(index, success) { if (success) writes[index].resolve(); else writes[index].reject(new Error("synthetic clipboard failure")); }
function unmount() { for (const slot of slots) if (slot.kind === "effect") slot.cleanup?.(); api.anchor.current = null; unmounted = true; }
function snapshot() { return JSON.stringify({ overlay: stateSlots[0].value ?? null, feedback: stateSlots[1].value ?? null, focus, focusCalls, writes: writes.map(entry => entry.value), fallbackCalls, afterUnmount, opened }); }
start();
`;
interface Snapshot {
  overlay: { kind: string } | null;
  feedback: { message: string } | null;
  focus: string;
  focusCalls: string[];
  writes: string[];
  fallbackCalls: number;
  afterUnmount: number;
  opened: string[];
}
function harness() {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  const run = (code: string): unknown => new vm.Script(code).runInContext(context, { timeout: 1_000 });
  run(setup);
  return { run, read: (): Snapshot => JSON.parse(run("snapshot()") as string) as Snapshot };
}
function currentResult(result: Snapshot, success: boolean): void {
  assert.equal(result.overlay, null);
  assert.equal(result.feedback?.message, success ? "已复制链接" : "复制链接失败");
  assert.equal(result.focus, "anchor");
  assert.equal(result.fallbackCalls, success ? 0 : 1);
}
for (const success of [true, false]) {
  test(`current owner retains ${success ? "success" : "failure"} close/focus/feedback`, () => {
    const h = harness(); h.run(`settle(0, ${success});`); currentResult(h.read(), success);
  });
  test(`harmless rerender and effect commit retain pending ${success ? "success" : "failure"}`, () => {
    const h = harness(); h.run(`render(false, false); flush(layoutQueue); flush(passiveQueue); settle(0, ${success});`); currentResult(h.read(), success);
  });
}
for (const success of [true, false]) {
  test(`ordinary overlay passive commit preserves the copy started after its render: success=${success}`, () => {
    const h = harness();
    h.run(`contextMenu(); render(true, false); api.copyClick(); flush(passiveQueue); settle(1, ${success});`);
    assert.equal(h.read().writes.length, 2);
    currentResult(h.read(), success);
  });
}
const dismissals = {
  outside: 'dispatch("d", "pointerdown", { target: composerNode }); composerNode.focus();',
  escape: 'dispatch("d", "keydown", { key: "Escape" }); composerNode.focus();',
  tab: 'dispatch("d", "keydown", { key: "Tab", preventDefault() {} }); composerNode.focus();',
  scroll: 'dispatch("w", "scroll"); composerNode.focus();',
  resize: 'dispatch("w", "resize"); composerNode.focus();',
  reopen: 'dispatch("d", "keydown", { key: "Escape" }); contextMenu();',
  mouseup: 'api.onMouseUp(); composerNode.focus();',
  keyup: 'api.onKeyUp({ key: "ArrowRight" }); composerNode.focus();',
  selection: 'selectedText = true; api.onMouseUp();',
  open: 'api.open(false); composerNode.focus();'
} as const;
for (const [name, action] of Object.entries(dismissals)) for (const success of [true, false]) {
  test(`${name}: old ${success ? "success" : "failure"} cannot close/refocus/announce over newer interaction`, () => {
    const h = harness(); h.run(`${action} render();`);
    const before = h.read(); h.run(`settle(0, ${success});`); const after = h.read();
    assert.deepEqual(after.overlay, before.overlay, "old completion must not close the newer overlay");
    assert.deepEqual(after.feedback, before.feedback, "old completion must not announce");
    assert.equal(after.focusCalls.filter(value => value === "anchor").length, before.focusCalls.filter(value => value === "anchor").length, "component must not refocus the old anchor");
    assert.equal(after.focus, success ? before.focus : "fallback", "failure may still focus the helper fallback textarea");
    assert.equal(after.writes.length, 1, "the existing write is allowed to settle, not cancelled or duplicated");
  });
}
for (const success of [true, false]) {
  test(`dismiss before React commit synchronously retires ${success ? "success" : "failure"}`, () => {
    const h = harness(); h.run(dismissals.outside); const before = h.read();
    h.run(`settle(0, ${success});`); const after = h.read();
    assert.deepEqual(after.feedback, before.feedback);
    assert.equal(after.focusCalls.filter(value => value === "anchor").length, 0);
    assert.equal(after.focus, success ? "composer" : "fallback");
  });
  test(`href layout cleanup retires old ${success ? "success" : "failure"} before passive effects`, () => {
    const h = harness(); h.run('href = "https://example.test/other"; render(true, false); composerNode.focus();'); const before = h.read();
    h.run(`settle(0, ${success});`); const after = h.read();
    assert.deepEqual(after.overlay, before.overlay);
    assert.equal(after.feedback, null);
    assert.equal(after.focusCalls.filter(value => value === "anchor").length, 0);
  });
  test(`unmount retires old ${success ? "success" : "failure"} UI updates`, () => {
    const h = harness(); h.run(`unmount(); composerNode.focus(); settle(0, ${success});`); const after = h.read();
    assert.equal(after.afterUnmount, 0);
    assert.equal(after.focusCalls.filter(value => value === "anchor").length, 0);
  });
}
for (const olderFirst of [true, false]) for (const success of [true, false]) {
  test(`same-overlay newer copy owns feedback: olderFirst=${olderFirst}, oldSuccess=${success}`, () => {
    const h = harness(); h.run("api.copyClick();");
    assert.equal(h.read().writes.length, 2, "existing repeated activation remains dispatchable");
    if (olderFirst) {
      const before = h.read(); h.run(`settle(0, ${success});`); const after = h.read();
      assert.deepEqual(after.overlay, before.overlay);
      assert.equal(after.feedback, null);
      assert.equal(after.focusCalls.filter(value => value === "anchor").length, 0);
      h.run("settle(1, true);");
      assert.equal(h.read().feedback?.message, "已复制链接");
      assert.equal(h.read().focusCalls.filter(value => value === "anchor").length, 1);
    } else {
      h.run("settle(1, true);"); const before = h.read(); h.run(`settle(0, ${success});`); const after = h.read();
      assert.deepEqual(after.feedback, before.feedback);
      assert.equal(after.focusCalls.filter(value => value === "anchor").length, 1);
    }
  });
}
test("Arrow navigation and Escape keyup do not retire current copy", () => {
  const h = harness(); h.run('api.onMenuKeyDown({ key: "ArrowDown", preventDefault() {} }); api.onKeyUp({ key: "Escape" }); render(); settle(0, true);');
  currentResult(h.read(), true);
});
test("selection overlay replacement and its actual selectionchange dismissal retire prior copy", () => {
  const h = harness(); h.run('selectedText = true; api.onMouseUp(); render(); selectedText = false; dispatch("d", "selectionchange"); render(); composerNode.focus(); settle(0, true);');
  const after = h.read(); assert.equal(after.overlay, null); assert.equal(after.feedback, null); assert.equal(after.focus, "composer");
});
