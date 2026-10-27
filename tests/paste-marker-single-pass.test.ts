// Parse dependency source only: never import or instantiate Editor/TUI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

type Entries = ReadonlyArray<readonly [number, string]>;
type Mode = "patched" | "baseline";
const expectedPatchedMethod = "expandPasteMarkers(text) {\n        // Scan only the draft; inserted paste content must remain literal.\n        const markerRegex = /\\[paste #([1-9]\\d*)( (\\+\\d+ lines|\\d+ chars))?\\]/g;\n        return text.replace(markerRegex, (marker, pasteId) => {\n            const id = Number(pasteId);\n            return String(id) === pasteId ? (this.pastes.get(id) ?? marker) : marker;\n        });\n    }";
const expectedBaselineMethod = "expandPasteMarkers(text) {\n        let result = text;\n        for (const [pasteId, pasteContent] of this.pastes) {\n            const markerRegex = new RegExp(`\\\\[paste #${pasteId}( (\\\\+\\\\d+ lines|\\\\d+ chars))?\\\\]`, \"g\");\n            result = result.replace(markerRegex, () => pasteContent);\n        }\n        return result;\n    }";

function tokens(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    result.push(`${kind}:${scanner.getTokenText()}`);
  }
  return result;
}

function methods(text: string): (name: string) => ts.MethodDeclaration {
  const ast = ts.createSourceFile("editor.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.ok("parseDiagnostics" in ast && Array.isArray(ast.parseDiagnostics));
  assert.equal(ast.parseDiagnostics.length, 0);
  const editors = ast.statements.filter(ts.isClassDeclaration).filter((node) => node.name?.text === "Editor");
  assert.equal(editors.length, 1);
  const editor = editors[0];
  assert.ok(editor);
  return (name) => {
    const matches = editor.members.filter(ts.isMethodDeclaration)
      .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
    assert.equal(matches.length, 1);
    const method = matches[0];
    assert.ok(method?.body);
    return method;
  };
}

function reviewedBody(text: string, mode: Mode): string {
  const method = methods(text)("expandPasteMarkers");
  assert.deepEqual(tokens(method.getText()), tokens(mode === "patched" ? expectedPatchedMethod : expectedBaselineMethod));
  assert.ok(method.body);
  const identifiers = new Set(mode === "patched"
    ? ["text", "markerRegex", "marker", "pasteId", "id", "Number", "String", "pastes", "get", "replace"]
    : ["text", "result", "pasteId", "pasteContent", "pastes", "markerRegex", "RegExp", "replace"]);
  const callees = new Set(mode === "patched" ? ["text.replace", "Number", "String", "this.pastes.get"] : ["result.replace"]);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) assert.ok(identifiers.has(node.text), `unreviewed identifier: ${node.text}`);
    if (ts.isCallExpression(node)) assert.ok(callees.has(node.expression.getText().replace(/\s/gu, "")), "unreviewed callee");
    if (ts.isNewExpression(node)) {
      assert.equal(mode, "baseline");
      assert.ok(ts.isIdentifier(node.expression) && node.expression.text === "RegExp");
    }
    assert.ok(!ts.isElementAccessExpression(node) && !ts.isComputedPropertyName(node), "dynamic property access is forbidden");
    ts.forEachChild(node, visit);
  };
  visit(method.body);
  return method.body.getText();
}

function harness(body: string, entries: Entries) {
  // No host functions, arrays, Maps, receivers or prototypes cross into the VM.
  const context = createContext(Object.create(null) as Record<string, unknown>, {
    codeGeneration: { strings: false, wasm: false },
  });
  const evaluate = (code: string): unknown => new Script(code).runInContext(context, { timeout: 1000 });
  evaluate(`globalThis.expand = function(text) ${body}; globalThis.receiver = {pastes: new Map(${JSON.stringify(entries)})};`);
  return {
    call(text: string): string {
      const result = evaluate(`expand.call(receiver, ${JSON.stringify(text)})`);
      assert.equal(typeof result, "string");
      return result as string;
    },
    replace(entries: Entries): void {
      evaluate(`receiver.pastes = new Map(${JSON.stringify(entries)});`);
    },
    snapshot(): string {
      const result = evaluate("JSON.stringify([...receiver.pastes])");
      assert.equal(typeof result, "string");
      return result as string;
    },
  };
}

const require = createRequire(import.meta.url);
const target = join(dirname(require.resolve("@earendil-works/pi-tui")), "components/editor.js");
const manifest: unknown = JSON.parse(readFileSync(join(dirname(target), "../../package.json"), "utf8"));
assert.ok(typeof manifest === "object" && manifest !== null && "name" in manifest && "version" in manifest);
assert.equal(manifest.name, "@earendil-works/pi-tui");
assert.equal(manifest.version, "0.82.1");
const source = readFileSync(target, "utf8");
const body = reviewedBody(source, "patched");
const run = (text: string, entries: Entries): string => harness(body, entries).call(text);
const first = ["literal [paste #2]", ...Array.from({ length: 10 }, (_, i) => `first ${i}`)].join("\n");
const second = Array.from({ length: 11 }, (_, i) => `second ${i}`).join("\n");
const display = "[paste #1 +11 lines]\n[paste #2 +11 lines]";

test("forward embedded marker stays literal while both genuine markers expand", () => {
  assert.equal(run(display, [[1, first], [2, second]]), `${first}\n${second}`);
});

test("expansion is independent of map order, including cyclic and self markers", () => {
  const entries: Entries = [[1, "one [paste #2] [paste #1]"], [2, "two [paste #1]"]];
  const expected = "one [paste #2] [paste #1]|two [paste #1]";
  assert.equal(run("[paste #1]|[paste #2]", entries), expected);
  assert.equal(run("[paste #1]|[paste #2]", [...entries].reverse()), expected);
});

test("existing suffix grammar, repeated occurrences and unknown IDs", () => {
  assert.equal(run("[paste #1]|[paste #1 +999 lines]|[paste #1 0 chars]|[paste #8]", [[1, "ok"]]), "ok|ok|ok|[paste #8]");
  assert.equal(run("[paste #1]", []), "[paste #1]");
});

test("canonical generated positive IDs do not accept aliases or malformed markers", () => {
  const unchanged = ["[paste #01]", "[paste #0]", "[paste #-1]", "[paste #+1]", "[paste #1.0]", "[Paste #1]", "[paste #1  +11 lines]", "[paste #1 +11 chars]", "[paste #1 11 lines]", "[paste #1\t11 chars]", "[paste #1 11 chars ]", "[paste #9007199254740993]"].join("|");
  assert.equal(run(unchanged, [[1, "one"], [9007199254740992, "huge"]]), unchanged);
  assert.equal(run("[paste #9007199254740992]", [[9007199254740992, "huge"]]), "huge");
});

test("empty, Unicode and replacement-dollar payloads are literal", () => {
  const payload = "中文 👩‍💻 e\u0301 $& $1 $$ $` $' [paste #9]";
  assert.equal(run("a[paste #1]b[paste #2]c", [[1, ""], [2, payload], [9, "wrong"]]), `ab${payload}c`);
});

test("expansion preserves whitespace and map state and observes replacement Map", () => {
  const receiver = harness(body, [[1, " first "]]);
  const before = receiver.snapshot();
  assert.equal(receiver.call(" \n[paste #1]\n "), " \n first \n ");
  assert.equal(receiver.call(" \n[paste #1]\n "), " \n first \n ");
  assert.equal(receiver.snapshot(), before);
  receiver.replace([[1, "restored"]]);
  assert.equal(receiver.call("[paste #1]"), "restored");
});

test("both callers preserve exact expansion input and Enter-only trim", () => {
  const lookup = methods(source);
  assert.deepEqual(tokens(lookup("getExpandedText").body?.getText() ?? ""), tokens('{ return this.expandPasteMarkers(this.state.lines.join("\\n")); }'));
  const submit = lookup("submitValue");
  assert.ok(submit.body);
  const results = submit.body.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "result");
  assert.equal(results.length, 1);
  assert.deepEqual(tokens(results[0]?.initializer?.getText() ?? ""), tokens('this.expandPasteMarkers(this.state.lines.join("\\n")).trim()'));
});

// Optional local baseline bytes, never a baseline package import or remote URL.
const baselinePath = process.env.BINY_PASTE_MARKER_BASELINE;
if (baselinePath) {
  assert.ok(isAbsolute(baselinePath));
  const baseline = readFileSync(realpathSync(baselinePath), "utf8");
  assert.equal(createHash("sha256").update(baseline).digest("hex"), "592cd809404d7c7e0abc2cd9427f31ae5bf440e6a3256b00c29e614a061c3238");
  const oldBody = reviewedBody(baseline, "baseline");
  test("unpatched exact source reproduces forward recursive expansion", () => {
    assert.notEqual(harness(oldBody, [[1, first], [2, second]]).call(display), `${first}\n${second}`);
  });
  test("ordinary inputs retain baseline behavior", () => {
    const entries: Entries = [[1, "hello $& 中文"], [2, ""], [9007199254740992, "large"]];
    for (const input of ["plain", "[paste #1]", "[paste #2]", "[paste #9]", "[paste #01]", "[paste #1 +01 lines]", "[paste #9007199254740993]", "[paste #9007199254740992]", "x[paste #1] [paste #2]y"]) {
      assert.equal(run(input, entries), harness(oldBody, entries).call(input));
    }
  });
}
