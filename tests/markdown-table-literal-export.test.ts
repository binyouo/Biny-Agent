import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from "jsdom";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import type { serializeMarkdownTable as Serializer } from "../src/desktop/renderer/src/components/markdownTableExport.js";

// Read both complete functions, without importing application modules or transpiling behavior.
const source = readFileSync(new URL("../src/desktop/renderer/src/components/markdownTableExport.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("markdownTableExport.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(ast.statements.length, 2);
assert.ok(ast.statements.every(statement => ts.isFunctionDeclaration(statement)));
const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "serializeMarkdownTable");
assert.ok(declaration && ts.isFunctionDeclaration(declaration));
const exportToken = declaration.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
assert.ok(exportToken);
const executable = source.slice(0, exportToken.getStart(ast)) + source.slice(exportToken.end);
const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(stripTypeScriptTypes(executable, { mode: "strip" }), context, { timeout: 1_000 });
const serializeMarkdownTable: typeof Serializer = (table, format) => {
  context.table = table;
  context.format = format;
  return vm.runInContext("serializeMarkdownTable(table, format)", context, { timeout: 1_000 }) as string;
};

type Cell = string | Array<string | null>;
interface TextNode { type: string; value?: string; children?: TextNode[] }

// No scripts, resource loading, URLs, global DOM bindings, application imports or UI actions.
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).freeze();
function fixture(headers: Cell[], rows: Cell[][]) {
  const dom = new JSDOM('');
  const document = dom.window.document;
  const table = document.createElement('table');
  const add = (section: HTMLElement, values: Cell[], tag: "th" | "td") => {
    const tr = document.createElement('tr');
    for (const value of values) {
      const cell = document.createElement(tag);
      const parts = Array.isArray(value) ? value : [value];
      for (const part of parts) cell.append(part === null ? document.createElement('br') : document.createTextNode(part));
      tr.append(cell);
    }
    section.append(tr);
  };
  const head = document.createElement('thead');
  const body = document.createElement('tbody');
  add(head, headers, 'th');
  for (const row of rows) add(body, row, 'td');
  table.append(head, body);
  return { table, dispose: () => dom.window.close() };
}
function visible(node: TextNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? "";
  if (node.type === 'html' && node.value === '<br>') return '\n';
  assert.ok(Array.isArray(node.children), `Unexpected node ${node.type}`);
  return node.children!.map(visible).join('');
}
function cells(markdown: string) {
  const root = parser.parse(markdown);
  assert.equal(root.children.length, 1);
  const table = root.children[0];
  assert.ok(table && table.type === 'table');
  return table.children.map(row => row.children.map(visible));
}
for (const value of ['*draft*', '**draft**', '_draft_', '~~draft~~', '`draft`', '[notes](plain)',
  '<br>', '<b>literal</b>', 'a &copy; b', '&#124;', '&#x1F408;', '&amp;copy;',
  '<https://example.test>', '<name@example.test>', '<!-- literal -->', '\\<br> &notanentity;']) {
  test(`literal visible text roundtrips: ${value}`, () => {
    const f = fixture(['Status'], [[value]]);
    try {
      assert.equal(serializeMarkdownTable(f.table, 'csv'), `Status\n${value}`);
      assert.equal(serializeMarkdownTable(f.table, 'tsv'), `Status\n${value}`);
      assert.deepEqual(cells(serializeMarkdownTable(f.table, 'markdown')), [['Status'], [value]]);
    } finally { f.dispose(); }
  });
}
test('literal inline syntax in header also roundtrips', () => {
  const f = fixture(['*Status*'], [['draft']]);
  try { assert.deepEqual(cells(serializeMarkdownTable(f.table, 'markdown')), [['*Status*'], ['draft']]); }
  finally { f.dispose(); }
});
test('literal HTML and entities remain distinct from structural line breaks in headers and cells', () => {
  const f = fixture([['<br>', null, '&copy;']], [[['<b>literal</b>', null, '&#124;']]]);
  try {
    assert.deepEqual(cells(serializeMarkdownTable(f.table, 'markdown')), [['<br>\n&copy;'], ['<b>literal</b>\n&#124;']]);
    assert.equal(serializeMarkdownTable(f.table, 'csv'), '"<br>\n&copy;"\n"<b>literal</b>\n&#124;"');
    assert.equal(serializeMarkdownTable(f.table, 'tsv'), '<br>\\n&copy;\n<b>literal</b>\\n&#124;');
  } finally { f.dispose(); }
});
test('pipes, backslashes, Unicode and empty columns remain aligned', () => {
  const rows = [['a|b', ''], ['C:\\notes\\file', '中文 🐈 café'], ['\\|', 'last']];
  const f = fixture(['Name', 'Value'], rows);
  try { assert.deepEqual(cells(serializeMarkdownTable(f.table, 'markdown')), [['Name', 'Value'], ...rows]); }
  finally { f.dispose(); }
});
test('CSV quotes commas, quotes, and structural line breaks; TSV retains escapes', () => {
  const f = fixture(['Name', 'Value'], [['a,"b"', ['north', null, 'south']]]);
  try {
    assert.equal(serializeMarkdownTable(f.table, 'csv'), 'Name,Value\n"a,""b""","north\nsouth"');
    assert.equal(serializeMarkdownTable(f.table, 'tsv'), 'Name\tValue\na,"b"\tnorth\\nsouth');
    assert.deepEqual(cells(serializeMarkdownTable(f.table, 'markdown')), [['Name', 'Value'], ['a,"b"', 'north\nsouth']]);
  } finally { f.dispose(); }
});
test('leading, trailing and repeated BR markers retain existing semantics', () => {
  const f = fixture(['H'], [[[null, 'leading']], [['trailing', null]], [['north', null, null, 'south']]]);
  try {
    assert.equal(serializeMarkdownTable(f.table, 'csv'), 'H\n"\nleading"\n"trailing\n"\n"north\n\nsouth"');
    assert.equal(serializeMarkdownTable(f.table, 'tsv'), 'H\n\\nleading\ntrailing\\n\nnorth\\n\\nsouth');
    assert.deepEqual(cells(serializeMarkdownTable(f.table, 'markdown')), [['H'], ['\nleading'], ['trailing\n'], ['north\n\nsouth']]);
  } finally { f.dispose(); }
});
test('short rows keep existing Markdown padding', () => {
  const f = fixture(['A', 'B'], [['one']]);
  try { assert.deepEqual(cells(serializeMarkdownTable(f.table, 'markdown')), [['A', 'B'], ['one', '']]); }
  finally { f.dispose(); }
});

for (const value of ["*draft*`code`_[notes](plain)~", "**[notes](plain)**", "`*draft*`~~later~~"]) {
  test(`adjacent mixed literal delimiters roundtrip: ${value}`, () => {
    const f = fixture(["H"], [[value]]);
    try { assert.deepEqual(cells(serializeMarkdownTable(f.table, "markdown")), [["H"], [value]]); }
    finally { f.dispose(); }
  });
}
test("repeated backslashes and pipes are escaped exactly once", () => {
  const values = ["\\".repeat(2) + "|", "\\|\\|", "\\".repeat(3), "a||b", "\\".repeat(2) + "*draft*\\|"];
  const f = fixture(["H"], values.map(value => [value]));
  try { assert.deepEqual(cells(serializeMarkdownTable(f.table, "markdown")), [["H"], ...values.map(value => [value])]); }
  finally { f.dispose(); }
});
