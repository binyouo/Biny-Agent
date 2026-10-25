import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Read the complete dependency-free helper, never import application modules.
// All synthesis/utterance objects below are inert; no audio or native APIs run.
const filename = process.env.BINY_SPEECH_SOURCE ?? path.join(process.cwd(), "src/desktop/renderer/src/speech.ts");
const source = readFileSync(filename, "utf8");
const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.deepEqual(parsed.statements.map(node => ts.isFunctionDeclaration(node) ? node.name?.text
  : ts.isVariableStatement(node) ? node.declarationList.declarations.map(item => item.name.getText(parsed)).join(",") : "unexpected"),
["finishActive", "speechSupported", "speak", "stop"]);
const calls = new Set(["stop", "/[一-鿿]/.test", "onDone", "window.speechSynthesis.speak", "window.speechSynthesis.cancel", "finish"]);
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
    && !ts.isExportDeclaration(node) && !ts.isAwaitExpression(node) && !ts.isTaggedTemplateExpression(node));
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(parsed), "SpeechSynthesisUtterance");
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(parsed)), `Unreviewed call: ${node.expression.getText(parsed)}`);
  ts.forEachChild(node, audit);
}
audit(parsed);
// Remove only export modifiers by AST positions. Retain every production body.
let executable = source;
const exports = parsed.statements.flatMap(node => ts.canHaveModifiers(node)
  ? (ts.getModifiers(node) ?? []).filter(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) : []);
for (const modifier of exports.reverse()) executable = executable.slice(0, modifier.getStart(parsed)) + executable.slice(modifier.end);
const code = stripTypeScriptTypes(executable, { mode: "strip" });
type Terminal = "end" | "error";
type CancelMode = "silent" | "sync" | "deferred";
function fixture(mode: CancelMode = "silent") {
  // Fakes and callbacks live inside the VM too, so invocation timeouts cover them.
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const run = (expression: string): unknown => new Script(expression).runInContext(context, { timeout: 1_000 });
  run(`
    "use strict";
    const utterances = [], deferred = [], completions = [];
    let current, cancels = 0, shownSpeaking = false;
    class SpeechSynthesisUtterance {
      constructor(text) { this.text = text; this.lang = ""; this.onend = null; this.onerror = null; utterances.push(this); }
    }
    function terminal(utterance, kind) {
      if (current === utterance) current = undefined;
      const callback = kind === "end" ? utterance.onend : utterance.onerror;
      callback?.();
    }
    const window = { speechSynthesis: {
      speak(utterance) { current = utterance; },
      cancel() {
        cancels++;
        const retired = current;
        current = undefined;
        if (!retired) return;
        if (${JSON.stringify(mode)} === "sync") terminal(retired, "error");
        if (${JSON.stringify(mode)} === "deferred") deferred.push(() => terminal(retired, "error"));
      }
    }};
    ${code}
    const handles = [];
    function start(text) {
      const index = handles.length;
      completions[index] = 0;
      shownSpeaking = true;
      handles.push(speak(text, () => { completions[index]++; shownSpeaking = false; }));
      return index;
    }
  `);
  return {
    start: (text = "reply"): number => run(`start(${JSON.stringify(text)})`) as number,
    stop: (index: number): void => { run(`handles[${index}]()`); },
    emit: (index: number, kind: Terminal): void => { run(`terminal(utterances[${index}], ${JSON.stringify(kind)})`); },
    flush: (): void => { run("while (deferred.length) deferred.shift()()"); },
    count: (index: number): number => run(`completions[${index}]`) as number,
    speaking: (): boolean => run("shownSpeaking") as boolean,
    current: (): number => run("utterances.indexOf(current)") as number,
    cancels: (): number => run("cancels") as number,
    lang: (index: number): string => run(`utterances[${index}].lang`) as string,
    supported: (): boolean => run("speechSupported()") as boolean,
    run
  };
}

test("manual stop completes immediately even when cancellation emits no event", () => {
  const f = fixture(); const a = f.start();
  f.stop(a);
  assert.equal(f.count(a), 1); assert.equal(f.speaking(), false); assert.equal(f.current(), -1);
  const cancels = f.cancels(); f.stop(a);
  assert.equal(f.cancels(), cancels); assert.equal(f.count(a), 1);
});
test("synchronous cancellation error and explicit finish complete only once", () => {
  const f = fixture("sync"); const a = f.start(); f.stop(a);
  assert.equal(f.count(a), 1); assert.equal(f.speaking(), false); assert.equal(f.current(), -1);
});
test("deferred cancellation error after manual stop and replay cannot reset new speech", () => {
  const f = fixture("deferred"); const a = f.start(); f.stop(a);
  assert.equal(f.count(a), 1);
  const b = f.start(); assert.equal(f.speaking(), true);
  f.flush();
  assert.equal(f.count(a), 1); assert.equal(f.count(b), 0);
  assert.equal(f.speaking(), true); assert.equal(f.current(), b);
  f.stop(b); assert.equal(f.count(b), 1); assert.equal(f.speaking(), false);
  f.flush(); assert.equal(f.count(b), 1);
});
test("replacement reports old completion once despite its deferred cancellation error", () => {
  const f = fixture("deferred"); const a = f.start(); const b = f.start();
  assert.equal(f.count(a), 1); assert.equal(f.count(b), 0);
  f.flush(); assert.equal(f.count(a), 1); assert.equal(f.count(b), 0); assert.equal(f.current(), b);
  const cancels = f.cancels(); f.stop(a);
  assert.equal(f.cancels(), cancels); assert.equal(f.current(), b);
  f.stop(b); f.flush(); assert.equal(f.count(b), 1); assert.equal(f.current(), -1);
});
test("replacement with synchronous cancellation completes retired owner once", () => {
  const f = fixture("sync"); const a = f.start(); const b = f.start();
  assert.equal(f.count(a), 1); assert.equal(f.current(), b); assert.equal(f.count(b), 0);
});
for (const kind of ["end", "error"] as const) {
  test(`natural ${kind} completes once and retires its owned stop handle`, () => {
    const f = fixture(); const a = f.start(); f.emit(a, kind);
    assert.equal(f.count(a), 1); assert.equal(f.current(), -1); assert.equal(f.speaking(), false);
    const b = f.start(); const cancels = f.cancels(); f.stop(a);
    assert.equal(f.cancels(), cancels); assert.equal(f.current(), b); assert.equal(f.speaking(), true);
    f.stop(b); assert.equal(f.count(b), 1);
  });
  test(`robustness: repeated ${kind} callback cannot complete twice`, () => {
    const f = fixture(); const a = f.start(); f.emit(a, kind); f.emit(a, kind);
    assert.equal(f.count(a), 1);
  });
  test(`robustness: old ${kind} callback after replay cannot reset current speech`, () => {
    const f = fixture(); const a = f.start(); f.emit(a, kind); const b = f.start(); f.emit(a, kind);
    assert.equal(f.count(a), 1); assert.equal(f.count(b), 0); assert.equal(f.speaking(), true); assert.equal(f.current(), b);
  });
}
// The Web Speech spec prohibits both terminal event types for one utterance.
// This deliberately adversarial case tests wrapper idempotence, not browser behavior.
test("robustness: mixed terminal callbacks after stop remain no-ops", () => {
  const f = fixture(); const a = f.start(); f.stop(a); f.emit(a, "end"); f.emit(a, "error");
  assert.equal(f.count(a), 1);
});
test("language selection and support detection are unchanged", () => {
  const f = fixture(); assert.equal(f.supported(), true);
  const a = f.start("Hello"); assert.equal(f.lang(a), "en-US");
  const b = f.start("你好"); assert.equal(f.lang(b), "zh-CN");
  f.run("delete window.speechSynthesis"); assert.equal(f.supported(), false);
});
test("completion is retired before user callback reenters a terminal handler", () => {
  const f = fixture();
  f.run(`let reentered = false, calls = 0;
    speak("reentrant", () => { calls++; if (!reentered) { reentered = true; utterances[0].onend(); } });
    terminal(utterances[0], "end");`);
  assert.equal(f.run("calls"), 1);
});
