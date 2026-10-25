import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Read only source text. Never import the CLI, storage, configuration or process
// modules. All product collaborators and even process.env are inert VM objects.
const filename = process.env.BINY_SOUL_EDITOR_SOURCE ?? path.join(process.cwd(), "src/cli/commands/soul.ts");
const source = readFileSync(filename, "utf8");
const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const selected = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && ["editSoulCommand", "parseEditorCommand"].includes(node.name?.text ?? ""));
assert.equal(selected.filter(node => node.name?.text === "editSoulCommand").length, 1);
assert.ok(selected.filter(node => node.name?.text === "parseEditorCommand").length <= 1);
const calls = new Set(["storage.ensureEditable", "process.env.VISUAL?.trim", "process.env.EDITOR?.trim",
  "configuredEditor.split", "configuredEditor.split(/\\s+/u).slice", "parseEditorCommand", "editor.slice",
  "console.log", "spawnSync", "String", "args.push", "Math.floor", '"\\\\".repeat', "/\\s/u.test"]);
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
    && !ts.isExportDeclaration(node) && !ts.isTaggedTemplateExpression(node));
  if (ts.isNewExpression(node)) assert.ok(["SoulStorage", "Error"].includes(node.expression.getText(parsed)));
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(parsed)), `Unreviewed call: ${node.expression.getText(parsed)}`);
  if (ts.isAwaitExpression(node)) assert.equal(node.expression.getText(parsed), "storage.ensureEditable()");
  ts.forEachChild(node, audit);
}
selected.forEach(audit);
const code = stripTypeScriptTypes(selected.map(node => node.getText(parsed)).join("\n"), { mode: "strip" });
interface Outcome {
  prepared: number;
  calls: { command: string; args: string[]; options: { stdio: string; shell?: boolean } }[];
  logs: string[];
  error?: string;
  done: boolean;
}
interface Options {
  visual?: string;
  editor?: string;
  platform?: string;
  file?: string;
  storageError?: boolean;
  spawnError?: boolean;
  status?: number | null;
}
function invoke(options: Options = {}): Outcome {
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  // Every promise and collaborator is constructed inside the VM; its own queue
  // drains under runInContext's timeout, including edit's post-await tokenizer.
  new Script(`"use strict";
    const settings = ${JSON.stringify(options)};
    const output = { prepared: 0, calls: [], logs: [], done: false };
    const process = Object.freeze({ env: Object.freeze({ VISUAL: settings.visual, EDITOR: settings.editor }), platform: settings.platform ?? "linux" });
    const console = { log(value) { output.logs.push(value); } };
    class SoulStorage {
      async ensureEditable() {
        output.prepared++;
        if (settings.storageError) throw new Error("synthetic storage failure");
        return Object.freeze({ path: settings.file ?? "/synthetic/My Soul/SOUL.md" });
      }
    }
    function spawnSync(command, args, options) {
      output.calls.push({ command, args, options });
      return { status: settings.status === undefined ? 0 : settings.status,
        error: settings.spawnError ? new Error("synthetic spawn failure") : undefined };
    }
    ${code}
    void editSoulCommand().then(() => { output.done = true; }, error => { output.error = error.message; output.done = true; });
  `).runInContext(context, { timeout: 1_000 });
  const outcome = JSON.parse(new Script("JSON.stringify(output)").runInContext(context, { timeout: 1_000 }) as string) as Outcome;
  assert.equal(outcome.done, true);
  assert.equal(outcome.prepared, 1);
  return outcome;
}
const file = "/synthetic/My Soul/SOUL.md";
function check(options: Options, argv: string[]): Outcome {
  const result = invoke(options);
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]!.command, argv[0]);
  assert.deepEqual(result.calls[0]!.args, [...argv.slice(1), options.file ?? file]);
  assert.equal(result.calls[0]!.options.stdio, "inherit");
  assert.notEqual(result.calls[0]!.options.shell, true);
  assert.deepEqual(result.logs, ["Soul file: " + (options.file ?? file)]);
  return result;
}
const cases: [string, string, string[]][] = [
  ["ordinary command", "code --wait", ["code", "--wait"]],
  ["double-quoted executable", '"/opt/My Editor/editor" --wait', ["/opt/My Editor/editor", "--wait"]],
  ["single-quoted executable", "'/opt/My Editor/editor' --wait", ["/opt/My Editor/editor", "--wait"]],
  ["quoted arguments", `code --title "two words" 'three words'`, ["code", "--title", "two words", "three words"]],
  ["empty arguments", `code "" '' --wait`, ["code", "", "", "--wait"]],
  ["concatenated fragments", `co"de" --title=pre"two words"post`, ["code", "--title=pretwo wordspost"]],
  ["opposite quotes literal", `code "it's fine" 'say "hello"'`, ["code", "it's fine", 'say "hello"']],
  ["Windows executable", String.raw`"C:\Program Files\Editor\editor.exe" --wait`, [String.raw`C:\Program Files\Editor\editor.exe`, "--wait"]],
  ["Windows unquoted trailing backslash", "code C:\\folder\\ --wait", ["code", "C:\\folder\\", "--wait"]],
  ["POSIX escaped whitespace stays split", String.raw`code /tmp/my\ folder --wait`, ["code", "/tmp/my\\", "folder", "--wait"]],
  ["UNC prefix", String.raw`\\server\share\editor.exe --wait`, [String.raw`\\server\share\editor.exe`, "--wait"]],
  ["quoted UNC prefix", String.raw`"\\server\My Share\editor.exe"`, [String.raw`\\server\My Share\editor.exe`]],
  ["single-quoted trailing backslash", "code 'C:\\folder\\'", ["code", "C:\\folder\\"]],
  ["ordinary backslashes", String.raw`code a\b a\\b tail` + "\\", ["code", String.raw`a\b`, String.raw`a\\b`, "tail\\"]],
  ["separator whitespace", "  code\t--wait\n--new-window  ", ["code", "--wait", "--new-window"]],
  ["literal shell tokens", "code $HOME %NAME% `whoami` $(whoami) ; | && > out #tag ~/*.md", ["code", "$HOME", "%NAME%", "`whoami`", "$(whoami)", ";", "|", "&&", ">", "out", "#tag", "~/*.md"]],
  ["quoted shell tokens", 'code "$HOME $(not run) ; | >"', ["code", "$HOME $(not run) ; | >"]]
];
for (const [label, input, expected] of cases) {
  test(label, () => { check({ editor: input }, expected); });
}
for (const count of [1, 2, 3, 4, 5, 6]) {
  test(`double-quote backslash parity ${count}`, () => {
    const slashes = "\\".repeat(count);
    const odd = count % 2 === 1;
    const input = 'code "C:\\folder' + slashes + '"' + (odd ? 'tail"' : " --wait");
    const expected = "C:\\folder" + "\\".repeat(Math.floor(count / 2)) + (odd ? '"tail' : "");
    check({ editor: input }, ["code", expected, ...(odd ? [] : ["--wait"])]);
  });
}
test("parity before opening quote in a concatenated token", () => {
  check({ editor: 'code pre' + "\\".repeat(2) + '"two words"post' }, ["code", "pre\\two wordspost"]);
});
test("single quotes preserve backslash before double quote", () => {
  check({ editor: `code 'a` + "\\".repeat(2) + `"b'` }, ["code", "a" + "\\".repeat(2) + '"b']);
});
test("VISUAL wins and ignores malformed EDITOR", () => {
  check({ visual: ' "visual editor" --wait ', editor: "'broken" }, ["visual editor", "--wait"]);
});
test("blank VISUAL falls back to EDITOR", () => { check({ visual: " \t", editor: "code --wait" }, ["code", "--wait"]); });
for (const editor of [undefined, "", " \t\n"]) {
  for (const platform of ["darwin", "linux", "win32"]) {
    test(`${platform} missing/blank editor ${JSON.stringify(editor)}`, () => {
      const options = { platform, visual: " \t", editor };
      if (platform === "darwin") check(options, ["open", "-e"]);
      else {
        const result = invoke(options);
        assert.equal(result.error, undefined);
        assert.deepEqual(result.calls, []);
        assert.deepEqual(result.logs, ["Soul file: " + file, "Set EDITOR or VISUAL to open it automatically."]);
      }
    });
  }
}
for (const input of ['"broken', "'broken", 'code "broken', 'code "broken\\"', '"" --wait', "''"]) {
  test(`malformed selected editor rejects: ${JSON.stringify(input)}`, () => {
    const result = invoke({ visual: input, editor: "fallback", platform: "darwin" });
    assert.match(result.error ?? "", /EDITOR or VISUAL.*(?:quote|executable)/u);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.logs, []);
  });
}
test("path is appended unchanged as exactly one argument", () => {
  check({ editor: "code --wait", file: '/synthetic/space ; $(literal)/SOUL "note".md' }, ["code", "--wait"]);
});
test("shell is explicitly disabled", () => { assert.equal(check({ editor: "code" }, ["code"]).calls[0]!.options.shell, false); });
test("storage rejection prevents spawn", () => {
  const result = invoke({ editor: "code", storageError: true });
  assert.equal(result.error, "synthetic storage failure"); assert.deepEqual(result.calls, []); assert.deepEqual(result.logs, []);
});
test("spawn error is preserved", () => {
  const result = invoke({ editor: "code", spawnError: true });
  assert.equal(result.error, "synthetic spawn failure"); assert.equal(result.calls.length, 1); assert.deepEqual(result.logs, []);
});
test("nonzero status remains an error", () => {
  const result = invoke({ editor: "code", status: 7 });
  assert.equal(result.error, "Soul editor exited with status 7."); assert.equal(result.calls.length, 1); assert.deepEqual(result.logs, []);
});
test("null status preserves existing behavior", () => { check({ editor: "code", status: null }, ["code"]); });
