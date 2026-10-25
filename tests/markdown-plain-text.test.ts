import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { markdownPlainText } from "../src/desktop/renderer/src/markdownPlainText.ts";

const cases: readonly [string, string, string][] = [
  ["inline code preserves identifiers and operators", "`user_id = 2 * 3`", "user_id = 2 * 3"],
  ["fenced code is never reinterpreted", "```text\n# comment\nuser_id = 2 * 3\n[docs](https://example.test)\n```", "# comment\nuser_id = 2 * 3\n[docs](https://example.test)"],
  ["literal identifiers", "foo_bar and user_id", "foo_bar and user_id"],
  ["single tilde remains literal", "~5 minutes", "~5 minutes"],
  ["multiplication remains literal", "2 * 3 = 6", "2 * 3 = 6"],
  ["escaped delimiters become visible text", "\\*literal\\* and \\_name\\_", "*literal* and _name_"],
  ["existing copy fixture", "# 检查结果\n\n**保留原文** [链接](https://example.com)\n末行\n", "检查结果\n\n保留原文 链接\n末行"],
  ["Unicode and numbers remain intact", "中文🙂 123.45 foo_bar", "中文🙂 123.45 foo_bar"],
  ["nested formatting", "**outer *inner* and `a_b`**", "outer inner and a_b"],
  ["CJK formatting matches renderer", "你好**世界**，~~旧词~~和~约数", "你好世界，旧词和~约数"],
  ["long fence preserves embedded backticks", "````text\n```\n* _ ~\n````", "```\n* _ ~"],
  ["tilde fence", "~~~text\n# _value * 2\n~~~", "# _value * 2"],
  ["indented code", "    # _value * 2\n    [x](y)", "# _value * 2\n[x](y)"],
  ["inline code can contain backticks", "``a`b_c``", "a`b_c"],
  ["nested link label and balanced URL", "[**name** and `a_b`](https://example.test/a_(b))", "name and a_b"],
  ["image alt is visible text", "![a_b *label*](https://example.test/a.png)", "a_b label"],
  ["entities and escaped Unicode labels", "&#x1F642; &amp; \\*中文\\*", "🙂 & *中文*"],
  ["placeholder-looking text has no special meaning", "@@CODE0@@ __TOKEN_0__ `__TOKEN_0__`", "@@CODE0@@ TOKEN_0 __TOKEN_0__"],
  ["list and blockquote markers preserved", "- **one**\n- `two_id`\n\n> **quote**", "- one\n- two_id\n\n> quote"],
  ["multiline list markers preserved", "- first\n  second_id and \\*literal\\*", "- first\n  second_id and *literal*"],
  ["multiline blockquote markers preserved", "> first\n> second_id and &amp;", "> first\n> second_id and &"],
  ["nested multiline markers preserved", "> - first\n>   second_id\n>   third", "> - first\n>   second_id\n>   third"],
  ["CRLF paragraphs and quote lines preserved", "# 标题🙂\r\n\r\n> foo_bar\r\n> second", "标题🙂\r\n\r\n> foo_bar\r\n> second"],
  ["ordinary paragraph continuation indentation preserved", "first\n   second_id", "first\n   second_id"],
  ["newline entities retain source rather than guessing line alignment", "first &#10; \\*literal\\*", "first &#10; \\*literal\\*"],
  ["entity-derived spaces cannot consume a quote prefix", "> a\n> &#32;&#32;b", "> a\n> &#32;&#32;b"],
  ["entity-derived tab cannot consume a quote prefix", "> a\n> &#9;b", "> a\n> &#9;b"],
  ["entity-derived space cannot consume list indentation", "- a\n  &#32;b", "- a\n  &#32;b"],
  ["entity-derived double space retains list indentation", "- a\n  &#32;&#32;b", "- a\n  &#32;&#32;b"],
  ["entity-derived tab retains list indentation", "- a\n  &#9;b", "- a\n  &#9;b"],
  ["entity-derived double space retains paragraph indentation", "a\n   &#32;&#32;b", "a\n   &#32;&#32;b"],
  ["entity-derived tab retains paragraph indentation", "a\n   &#9;b", "a\n   &#9;b"],
  ["table layout preserved", "| **Name** | Value |\n| --- | --- |\n| `a_b` | 2 * 3 |", "| Name | Value |\n| --- | --- |\n| a_b | 2 * 3 |"],
  ["raw HTML preserved", "<div>**raw** &amp; _value</div>", "<div>**raw** &amp; _value</div>"],
  ["inline HTML tags preserved around parsed formatting", "<span>**text**</span>", "<span>text</span>"],
  ["reference definitions and reference markup preserved", "[name][id]\n\n[id]: https://example.test/a_b \"title\"", "[name][id]\n\n[id]: https://example.test/a_b \"title\""],
  ["reference label formatting without rewriting reference syntax", "[**name**][id]\n\n[id]: https://example.test/a_b", "[name][id]\n\n[id]: https://example.test/a_b"],
  ["math delimiters are not enabled", "$x_y$ and $$x_y$$", "$x_y$ and $$x_y$$"],
  ["internal paragraph gaps preserved", "  # Title\n\n\n**Body**\nlast\n", "Title\n\n\nBody\nlast"],
  ["unmatched delimiters remain literal", "a * b _ c ~ d ` e", "a * b _ c ~ d ` e"],
  ["empty content", " \n\t", ""]
];

for (const [name, input, expected] of cases) {
  test(name, () => assert.equal(markdownPlainText(input), expected));
}

test("all existing consumers use the complete local transform wrapper", () => {
  const source = readFileSync(new URL("../src/desktop/renderer/src/components/MessageTimeline.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("MessageTimeline.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "plainTextFromMarkdown");
  assert.equal(functions.length, 1);
  const compiled = ts.transpileModule(functions[0]!.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  assert.doesNotMatch(compiled, /\b(?:import|require)\s*\(/u);
  const wrapper = vm.runInNewContext(`${compiled}\nplainTextFromMarkdown`, { markdownPlainText }, { timeout: 1_000 }) as (content: string) => string;
  for (const [, input, expected] of cases) assert.equal(wrapper(input), expected);
  assert.match(source, /copyText\(plainTextFromMarkdown\(message\.text\)\)/u);
  assert.match(source, /copyToClipboard\(kind === "markdown" \? content : plainTextFromMarkdown\(content\)\)/u);
  assert.match(source, /speak\(plainTextFromMarkdown\(content\),/u);
});
