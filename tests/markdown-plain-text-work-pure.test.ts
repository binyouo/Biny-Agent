/** Pure source-derived work counts. Run from a complete source checkout; no application imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const root = process.cwd();
const componentSource = readFileSync(path.join(root, "src/desktop/renderer/src/components/MarkdownContent.tsx"), "utf8");
const helperSource = readFileSync(path.join(root, "src/desktop/renderer/src/markdownBlocks.ts"), "utf8");
const component = ts.createSourceFile("MarkdownContent.tsx", componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helper = ts.createSourceFile("markdownBlocks.ts", helperSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function initializer(name: string): ts.Expression {
  const matches: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) matches.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(component);
  assert.equal(matches.length, 1, `one ${name} initializer`);
  return matches[0]!;
}
const expressionKinds = new Set([
  ts.SyntaxKind.Identifier, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CallExpression, ts.SyntaxKind.PropertyAccessExpression, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.PrefixUnaryExpression, ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.EqualsGreaterThanToken, ts.SyntaxKind.QuestionToken, ts.SyntaxKind.ColonToken
]);
function validateExpression(node: ts.Node): void {
  assert.ok(expressionKinds.has(node.kind), `unexpected expression syntax ${ts.SyntaxKind[node.kind]}`);
  if (ts.isIdentifier(node)) assert.ok(["markdown", "content", "christmasMarker", "replaceAll", "useMemo", "partitioned", "parseBlocks", "displayContent"].includes(node.text));
  if (ts.isCallExpression(node)) assert.ok(["content.replaceAll", "useMemo", "parseBlocks"].includes(node.expression.getText(component)));
  ts.forEachChild(node, validateExpression);
}
const display = initializer("displayContent");
const blocks = initializer("blocks");
validateExpression(display);
validateExpression(blocks);
const marker = initializer("christmasMarker");
assert.ok(ts.isStringLiteral(marker));
assert.equal(marker.text, "<--Christmas-->");
// Preserve the plain branch's raw-content contract; never execute JSX or import React.
assert.ok(componentSource.includes('if (!markdown) return <div className={`markdown-body is-plain-text${variant ? ` ${variant}` : ""}`}>{content}</div>;'));

// Only the three audited pure helper declarations execute; imports and parser construction do not.
// Injection must match the real helper parser's imports and complete construction chain.
const helperImports = helper.statements.filter(ts.isImportDeclaration);
assert.deepEqual(helperImports.map(node => node.getText(helper).replace(/\s+/gu, " ").trim()), [
  'import { unified } from "unified";',
  'import remarkParse from "remark-parse";',
  'import remarkGfm from "remark-gfm";',
  'import remarkMath from "remark-math";'
]);
const helperVariables = helper.statements.filter(ts.isVariableStatement).flatMap(node => Array.from(node.declarationList.declarations));
assert.equal(helperVariables.length, 1);
assert.equal(helperVariables[0]!.name.getText(helper), "parser");
assert.equal(helperVariables[0]!.initializer?.getText(helper).replace(/\s+/gu, ""), "unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze()");
const names = ["parseBlocks", "splitMarkdownBlocks", "createMarkdownBlockParser"];
const functions = helper.statements.filter(ts.isFunctionDeclaration);
assert.deepEqual(functions.map(node => node.name?.text), names);
const allowedHelperCalls = new Set(["Boolean", "parser.parse", "hasDefinition", "node.children?.some", "tree.children.map", "content.lastIndexOf", "starts.map", "content.slice", "parseBlocks", "content.startsWith", "blocks.slice", "prefix.reduce"]);
for (const fn of functions) {
  const check = (node: ts.Node): void => {
    assert.ok(!ts.isNewExpression(node) && !ts.isImportDeclaration(node) && !ts.isAwaitExpression(node), `unexpected helper syntax ${ts.SyntaxKind[node.kind]}`);
    if (ts.isElementAccessExpression(node)) assert.equal(node.getText(helper), "starts[index + 1]");
    if (ts.isCallExpression(node)) assert.ok(allowedHelperCalls.has(node.expression.getText(helper)), `unexpected helper call ${node.expression.getText(helper)}`);
    ts.forEachChild(node, check);
  };
  check(fn);
}
const helperCode = functions.map(fn => {
  const start = fn.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return start ? helperSource.slice(start.end, fn.end) : fn.getText(helper);
}).join("\n");
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();
interface Snapshot { display: string; blocks: string[]; parses: number; replacements: number }
function harness(baseline = false) {
  let parses = 0;
  const context = vm.createContext({ parser: Object.freeze({ parse(content: string) { parses += 1; return parser.parse(content); } }) }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(stripTypeScriptTypes(helperCode, { mode: "strip" }), context, { timeout: 1_000 });
  const displayCode = baseline ? 'content.replaceAll(christmasMarker, "🎄")' : display.getText(component);
  const blocksCode = baseline ? 'useMemo(() => partitioned ? parseBlocks(displayContent) : [displayContent], [displayContent, parseBlocks, partitioned])' : blocks.getText(component);
  vm.runInContext(`
    const componentParseBlocks = createMarkdownBlockParser();
    const christmasMarker = "<--Christmas-->";
    let lastDependencies, memoized;
    function useMemo(factory, dependencies) {
      if (!lastDependencies || dependencies.length !== lastDependencies.length || dependencies.some((value, i) => !Object.is(value, lastDependencies[i]))) {
        memoized = factory(); lastDependencies = dependencies;
      }
      return memoized;
    }
    let replacements = 0;
    const originalReplaceAll = String.prototype.replaceAll;
    String.prototype.replaceAll = function(...args) { replacements += 1; return originalReplaceAll.apply(this, args); };
    function render(content, markdown, partitioned) {
      const parseBlocks = componentParseBlocks;
      const displayContent = ${displayCode};
      const blocks = ${blocksCode};
      return { display: displayContent, blocks, replacements };
    }
  `, context, { timeout: 1_000 });
  return {
    render(content: string, markdown: boolean, partitioned = true): Snapshot {
      Object.assign(context, { input: content, enabled: markdown, partitioned });
      const result = vm.runInContext("render(input, enabled, partitioned)", context, { timeout: 1_000 }) as Omit<Snapshot, "parses">;
      return { display: result.display, blocks: Array.from(result.blocks), replacements: result.replacements, parses };
    },
    full(content: string): string[] {
      context.input = content;
      return Array.from(vm.runInContext("splitMarkdownBlocks(input)", context, { timeout: 1_000 }) as string[]);
    }
  };
}

test("plain streamed HTML removes actual parse and replacement calls; no latency claim", () => {
  const old = harness(true), next = harness();
  const count = 80;
  let before!: Snapshot, after!: Snapshot;
  for (let i = 1; i <= count; i++) {
    const input = `<div>\n\n<--Christmas-->${"word ".repeat(i)}`;
    before = old.render(input, false);
    after = next.render(input, false);
    assert.equal(after.display, input);
    assert.deepEqual(after.blocks, []);
  }
  assert.equal(before.parses, count);
  assert.equal(before.replacements, count);
  assert.equal(after.parses, 0);
  assert.equal(after.replacements, 0);
});

test("static non-partitioned baseline already parses zero; only replacement work disappears", () => {
  const old = harness(true), next = harness();
  for (let i = 1; i <= 8; i++) {
    const input = `static ${i} <--Christmas-->`;
    const before = old.render(input, false, false);
    assert.equal(before.parses, 0);
    assert.equal(before.replacements, i);
    const result = next.render(input, false, false);
    assert.equal(result.parses, 0);
    assert.equal(result.replacements, 0);
    assert.equal(result.display, input);
  }
});

test("actual memo dependencies honor toggles with identical content and partition state", () => {
  const h = harness();
  const input = "# Header\n\nfirst\n\nlast"; // No Christmas marker: displayContent does not change on toggle.
  const enabled = h.render(input, true);
  const disabled = h.render(input, false);
  assert.deepEqual(disabled.blocks, []);
  assert.equal(disabled.parses, enabled.parses);
  const restored = h.render(input, true);
  assert.deepEqual(restored.blocks, enabled.blocks);
  // Identical renders must actually use the source dependency array, not force factory execution.
  assert.equal(h.render(input, true).parses, restored.parses);
});

const spans: Array<[string, string[]]> = [
  ["reference definition", ["first [link][id]\n\nsecond\n\nthird", "first [link][id]\n\nsecond\n\nthird\n\n[id]: https://example.invalid\n\nlast"]],
  ["HTML document scope", ["first\n\nsecond\n\nthird", "first\n\nsecond\n\nthird\n\n<details>\n<summary>title</summary>\n\n**body**\n\n</details>"]],
  ["fence close", ["first\n\n```ts\nconst a = 1;", "first\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nlast"]],
  ["shorten then replace", ["first\n\nsecond\n\nthird", "first", "# replacement\n\nbody"]],
  ["empty and emoji marker", ["first\n\nsecond", "", "新内容 🐈 <--Christmas-->\n\nlast"]]
];
for (const [label, inputs] of spans) test(`disabled span re-enables current complete content: ${label}`, () => {
  const h = harness();
  h.render(inputs[0]!, true);
  let last = inputs[0]!;
  for (const input of inputs) {
    last = input;
    const before = h.render(last, false);
    const after = h.render(last + " hidden", false);
    assert.equal(after.parses, before.parses);
    assert.equal(after.replacements, before.replacements);
  }
  const result = h.render(last, true);
  assert.deepEqual(result.blocks, h.full(last.replaceAll("<--Christmas-->", "🎄")));
});

test("stream ending while disabled retains partitioned history and latest content on re-enable", () => {
  const h = harness();
  h.render("first\n\nsecond", true, true);
  h.render("first\n\nsecond\n\nlast", false, true);
  // Component's existing wasStreaming means partitioned remains true after streaming=false.
  const final = "first\n\nsecond\n\nlast\n\n[id]: https://example.invalid";
  h.render(final, false, true);
  assert.deepEqual(h.render(final, true, true).blocks, h.full(final));
});

test("enabled append path remains equivalent to original derived expressions", () => {
  const old = harness(true), next = harness();
  const input = "# Header\n\nparagraph\n\n```ts\nx\n```\n\nlast <--Christmas-->";
  for (let end = 1; end <= input.length; end++) {
    const part = input.slice(0, end);
    const before = old.render(part, true), after = next.render(part, true);
    assert.equal(after.display, before.display);
    assert.deepEqual(after.blocks, before.blocks);
    assert.equal(after.parses, before.parses);
    assert.equal(after.replacements, before.replacements);
  }
});
