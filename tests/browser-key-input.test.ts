import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { describeBrowserKey } from "../src/browser/keyInput.js";

const keys = [
  ["Backspace", 8, "Backspace"], ["Tab", 9, "Tab"], ["Enter", 13, "Enter"], ["Escape", 27, "Escape"],
  [" ", 32, "Space"], ["PageUp", 33, "PageUp"], ["PageDown", 34, "PageDown"], ["End", 35, "End"],
  ["Home", 36, "Home"], ["ArrowLeft", 37, "ArrowLeft"], ["ArrowUp", 38, "ArrowUp"],
  ["ArrowRight", 39, "ArrowRight"], ["ArrowDown", 40, "ArrowDown"], ["Insert", 45, "Insert"], ["Delete", 46, "Delete"]
] as const;

for (const [key, vk, code] of keys) test(`named key identity: ${JSON.stringify(key)}`, () => {
  assert.deepEqual(describeBrowserKey(key), { key, windowsVirtualKeyCode: vk, code,
    text: key === "Enter" ? "\r" : key === " " ? " " : undefined });
});

test("ASCII letter shortcuts have stable virtual and DOM codes without changing case", () => {
  for (let vk = 65; vk <= 90; vk++) {
    const upper = String.fromCharCode(vk);
    for (const key of [upper, upper.toLowerCase()]) assert.deepEqual(describeBrowserKey(key),
      { key, windowsVirtualKeyCode: vk, code: `Key${upper}`, text: key });
  }
});

test("unmapped keys preserve previous text behavior without Unicode or prototype guesses", () => {
  for (const key of ["中", "é", "K", "ſ", "😀", "1", ";", "CustomKey", "constructor", "__proto__", ""]) {
    assert.deepEqual(describeBrowserKey(key), { key, text: key.length === 1 ? key : undefined });
  }
});

// Exercise complete original service method bodies, not a rewritten dispatcher.
// Only Electron/page boundaries are inert; no native UI behavior is simulated.
const serviceFile = new URL("../src/desktop/electron/main/DesktopBrowserService.ts", import.meta.url);
const source = ts.createSourceFile(serviceFile.pathname, readFileSync(serviceFile, "utf8"), ts.ScriptTarget.Latest, true);
const cls = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopBrowserService");
assert.ok(cls);
const methods = ["press", "performCoordinateAction", "sendDebuggerCommand"].map(name => {
  const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  assert.ok(method, name);
  return method.getText(source);
});
const code = ts.transpileModule(`class Subject { ${methods.join("\n")} }; Subject;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
interface Command { method: string; params: Record<string, unknown> }
interface Owner {
  isDestroyed(): boolean;
  debugger: { isAttached(): boolean; attach(): void; sendCommand(method: string, params: Record<string, unknown>): Promise<unknown> };
}
interface Subject {
  ensureContents(owner?: Owner): Promise<Owner>;
  pageOperation(operation: string, args: unknown, signal: AbortSignal | undefined, owner: Owner): Promise<unknown>;
  pageState(owner: Owner): Promise<unknown>;
  press(selector: string | undefined, key: string, signal?: AbortSignal): Promise<unknown>;
  performCoordinateAction(action: { action: "keypress"; key: string; modifiers: string[] },
    signal: AbortSignal | undefined, onAction: ((owner: Owner) => void) | undefined, owner: Owner): Promise<unknown>;
}
const SubjectClass = vm.runInNewContext(code, { describeBrowserKey,
  z: new Proxy({}, { get() { throw new Error("Non-key coordinate branches are outside this fixture."); } })
}) as new () => Subject;

function fixture(onCommand?: (command: Command) => void) {
  const commands: Command[] = [], operations: string[] = [];
  const owner: Owner = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      attach() { assert.fail("No native debugger attachment."); },
      async sendCommand(method, params) {
        const command = { method, params }; commands.push(command); onCommand?.(command); return {};
      }
    }
  };
  const subject = new SubjectClass();
  subject.ensureContents = async requested => { assert.ok(requested === undefined || requested === owner); return owner; };
  subject.pageOperation = async (operation, _args, _signal, requested) => { assert.equal(requested, owner); operations.push(operation); };
  subject.pageState = async requested => { assert.equal(requested, owner); return { url: "about:blank", title: "Fixture" }; };
  return { subject, owner, commands, operations };
}

for (const [key, vk, domCode] of keys) test(`BrowserPress uses matching key identity through release: ${JSON.stringify(key)}`, async () => {
  for (const selector of [undefined, "#field"]) {
    const f = fixture(); await f.subject.press(selector, key);
    assert.deepEqual(f.operations, selector ? ["reveal", "wait", "press"] : []);
    assert.equal(f.commands.length, 2);
    for (const [index, command] of f.commands.entries()) {
      assert.equal(command.method, "Input.dispatchKeyEvent");
      assert.deepEqual(JSON.parse(JSON.stringify(command.params)), { type: index === 0 ? "keyDown" : "keyUp",
        key, windowsVirtualKeyCode: vk, code: domCode,
        ...(index === 0 && (key === "Enter" || key === " ") ? { text: key === "Enter" ? "\r" : " " } : {}) });
    }
  }
});

for (const [key, modifiers, bits, vk, domCode] of [
  ["c", ["Control"], 2, 67, "KeyC"], ["A", ["Meta"], 4, 65, "KeyA"],
  ["ArrowLeft", ["Shift"], 8, 37, "ArrowLeft"], ["Backspace", ["Alt", "Shift"], 9, 8, "Backspace"],
  ["Enter", [], 0, 13, "Enter"], ["Enter", ["Shift"], 8, 13, "Enter"],
  ["c", ["Control", "Control"], 2, 67, "KeyC"], ["x", ["Alt", "Control", "Meta", "Shift"], 15, 88, "KeyX"]
] as const) test(`CUA preserves modifiers: ${key} ${modifiers.join("+")}`, async () => {
  const f = fixture(); const observed: Owner[] = [];
  await f.subject.performCoordinateAction({ action: "keypress", key, modifiers: [...modifiers] }, undefined, owner => observed.push(owner), f.owner);
  assert.equal(f.commands.length, 2); assert.deepEqual(observed, [f.owner]);
  for (const [index, { params }] of f.commands.entries()) {
    assert.equal(params.type, index === 0 ? "keyDown" : "keyUp");
    assert.equal(params.key, key); assert.equal(params.modifiers, bits);
    assert.equal(params.windowsVirtualKeyCode, vk); assert.equal(params.code, domCode);
    assert.equal(params.text, index === 0 && bits === 0 && key === "Enter" ? "\r" : undefined);
    assert.equal(Object.hasOwn(params, "nativeVirtualKeyCode"), false);
  }
});

test("service printable and unknown fallback remain unchanged", async () => {
  for (const key of ["x", "中", "K", "😀", "CustomKey"]) {
    const f = fixture(); await f.subject.press(undefined, key);
    assert.equal(f.commands[0]!.params.text, key.length === 1 ? key : undefined);
    assert.equal(f.commands[1]!.params.text, undefined);
    if (key !== "x") assert.equal(f.commands[0]!.params.windowsVirtualKeyCode, undefined);
  }
});

for (const route of ["press", "cua"] as const) test(`${route} preserves release after an in-flight abort`, async () => {
  const controller = new AbortController();
  const f = fixture(({ params }) => { if (params.type === "keyDown") controller.abort(); });
  if (route === "press") await f.subject.press(undefined, "Enter", controller.signal);
  else await f.subject.performCoordinateAction({ action: "keypress", key: "Enter", modifiers: [] }, controller.signal, undefined, f.owner);
  assert.deepEqual(f.commands.map(x => x.params.type), ["keyDown", "keyUp"]);
  assert.equal(f.commands[1]!.params.windowsVirtualKeyCode, 13);
});

for (const route of ["press", "cua"] as const) test(`${route} keeps release retry and original error`, async () => {
  const expected = new Error("inert release failure");
  let releases = 0;
  const f = fixture(({ params }) => { if (params.type === "keyUp" && ++releases === 1) throw expected; });
  await assert.rejects(route === "press" ? f.subject.press(undefined, "Backspace")
    : f.subject.performCoordinateAction({ action: "keypress", key: "Backspace", modifiers: ["Control"] }, undefined, undefined, f.owner),
  error => error === expected);
  assert.deepEqual(f.commands.map(x => x.params.type), ["keyDown", "keyUp", "keyUp"]);
  assert.deepEqual(f.commands[1]!.params, f.commands[2]!.params);
});

test("already aborted press still dispatches no key", async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture(); await assert.rejects(f.subject.press(undefined, "Enter", controller.signal));
  assert.equal(f.commands.length, 0);
});
