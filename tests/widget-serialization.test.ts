import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { createWidgetDocument } from "../src/widgets/document.js";

// Parse the saved bootstrap without executing the document or the widget's HTML.
function readInitialHtml(document: string): string {
  const dom = new JSDOM(document);
  try {
    const source = dom.window.document.scripts.item(1)?.textContent;
    assert.ok(source, "saved widget includes its bootstrap");
    const file = ts.createSourceFile("widget.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const payloads: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setContent"
        && node.arguments.length === 2 && node.arguments[1]?.kind === ts.SyntaxKind.TrueKeyword) {
        const argument = node.arguments[0];
        assert.ok(argument && ts.isStringLiteral(argument), "initial content is a JSON string literal");
        payloads.push(JSON.parse(argument.getText(file)) as string);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.equal(payloads.length, 1, "saved widget initializes exactly once");
    return payloads[0]!;
  } finally { dom.window.close(); }
}

for (const marker of ["$$", "$&", "$`", "$'"]) {
  test(`widget export preserves the literal replacement marker ${marker}`, () => {
    const html = `<output>${marker}</output><script>const literal = ${JSON.stringify(marker)};</script>`;
    const document = createWidgetDocument({ token: "literal-widget", morphdomSource: "", widget: { title: "Literal", html } });
    assert.equal(readInitialHtml(document), html);
  });
}

test("widget CLI saves the same literal HTML as its JSON artifact without executing it", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-widget-serialization-"));
  const input = path.join(root, "fragment.html");
  const output = path.join(root, "widget.html");
  const html = '<output>$$ $& $` $\' 中文</output><script>const replacement = "$&";</script>';
  try {
    await writeFile(input, html);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"),
        "widget", "--html", input, "--title", "Literal <&> widget", "--out", output, "--json"], {
        env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") }
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const artifact = JSON.parse(result.stdout);
    assert.equal(artifact.kind, "widget");
    assert.equal(artifact.html, html);
    const saved = await readFile(output, "utf8");
    assert.equal(saved, artifact.document);
    assert.equal(readInitialHtml(saved), html);
    assert.match(saved, /<title>Literal &lt;&amp;&gt; widget<\/title>/);
    assert.match(saved, /connect-src 'none'; frame-src 'none'/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
