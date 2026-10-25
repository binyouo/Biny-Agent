/** Inert source contract: no production module is imported or initialized. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

interface Token { start: number; end: number; label: string; uri: string; kind: string }
interface Draft { value: string; tokens: Token[] }
interface Result { kind: string; label: string; uri: string; content: string }
interface Pure {
  insertDraftReference(value: string, completion: {start: number; end: number; query: string}, result: Result, tokens: Token[]): Draft;
  materializeDraftReferences(value: string, tokens: Token[]): string;
  normalizeDraftReferences(value: string, tokens: Token[]): Draft;
  localReferenceContext(value: string, service: {resolve(uri: string, projectId: string): Promise<Result>}, projectId: string): Promise<string>;
}
const root = '';
const composer = 'src/desktop/renderer/src/components/composer/referenceCompletion.ts';
const library = 'src/session/localReferences.ts';
const options = { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } };
function select(file: string, names: string[], variables: string[] = []): string {
  const parsed = ts.createSourceFile(file, readFileSync(root + file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parts = names.map(name => {
    const nodes = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1, `exactly one production function ${name}`);
    return nodes[0]!.getText(parsed).replace(/^export /u, '');
  });
  for (const name of variables) {
    const nodes = parsed.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
      .filter(node => ts.isIdentifier(node.name) && node.name.text === name);
    assert.equal(nodes.length, 1);
    parts.push(`const ${nodes[0]!.getText(parsed)};`);
  }
  return stripTypeScriptTypes(parts.join('\n'), { mode: 'strip' });
}
const names = ['validToken', 'uniqueLabel', 'insertDraftReference', 'reconcileDraftReferenceChange', 'materializeDraftReferences', 'kindFromUri', 'normalizeDraftReferences'];
const selected = select(composer, names, ['kinds']) + '\n' + select(library, ['localReferenceContext']);
const pure = runInNewContext(`${selected}\n({${names.join(',')}, localReferenceContext})`, {}, options) as Pure;
function ref(id: string, label = 'Project milestone summary '.repeat(4).slice(0, 80)): Result {
  return {kind: 'message', label, uri: `biny://thread/demo/message/${id}`, content: `Content for ${id}`};
}
function append(draft: Draft, result: Result): Draft {
  return pure.insertDraftReference(draft.value, {start: draft.value.length, end: draft.value.length, query: ''}, result, draft.tokens);
}
function insert(results: Result[]): Draft { return results.reduce(append, {value: '', tokens: []}); }
function materialize(draft: Draft): string { return pure.materializeDraftReferences(draft.value, draft.tokens); }
async function context(draft: Draft, results: Result[]): Promise<{content: string; calls: string[]}> {
  const calls: string[] = [];
  const content = await pure.localReferenceContext(materialize(draft), {resolve: async (uri, projectId) => {
    assert.equal(projectId, 'inert'); calls.push(uri);
    const found = results.find(result => result.uri === uri); assert.ok(found); return found;
  }}, 'inert');
  return {content, calls};
}
for (const size of [79, 80]) test(`two ordinary same-prefix references retain context at ${size} units`, async () => {
  const results = [ref('a', 'r'.repeat(size)), ref('b', 'r'.repeat(size))];
  const draft = insert(results);
  const actual = await context(draft, results);
  assert.deepEqual(actual.calls, results.map(result => result.uri), `generated lengths=${draft.tokens.map(token => token.label.length)}`);
  for (const result of results) assert.ok(actual.content.includes(result.content));
  assert.ok(draft.tokens.every(token => token.label.length <= 80));
});
test('materialized history normalizes both references into editable tokens', () => {
  const results = [ref('a'), ref('b')]; const draft = insert(results);
  const restored = pure.normalizeDraftReferences(materialize(draft), []);
  assert.deepEqual(Array.from(restored.tokens, token => token.uri), results.map(result => result.uri));
  assert.equal(materialize(restored), materialize(draft));
});
test('normalizing independently valid same-label references retains context', async () => {
  const results = [ref('a'), ref('b')];
  const input = results.map(result => `@[${result.label}](${result.uri})`).join(' ');
  const normalized = pure.normalizeDraftReferences(input, []);
  const actual = await context(normalized, results);
  assert.equal(actual.calls.length, 2, `generated lengths=${normalized.tokens.map(token => token.label.length)}`);
  assert.ok(normalized.tokens.every(token => token.label.length <= 80));
});
test('truncated suffix candidate is checked against natural existing labels', () => {
  const results = [ref('a', 'r'.repeat(80)), ref('natural', `${'r'.repeat(78)} 2`), ref('b', 'r'.repeat(80))];
  const draft = insert(results); const labels = Array.from(draft.tokens, token => token.label);
  assert.ok(labels.every(label => label.length <= 80), JSON.stringify(labels.map(label => label.length)));
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(labels[2], `${'r'.repeat(78)} 3`);
});
test('short labels and repeated same URI remain unchanged', async () => {
  const a = ref('a', 'Summary'); const b = ref('b', 'Summary');
  const draft = insert([a, a, b, b]);
  assert.deepEqual(Array.from(draft.tokens, token => token.label), ['Summary', 'Summary', 'Summary 2', 'Summary 3']);
  assert.deepEqual((await context(draft, [a,b])).calls, [a.uri, b.uri]);
});
test('non-BMP character at suffix boundary is never split', () => {
  const label = 'r'.repeat(77) + '😀' + 'z'; assert.equal(label.length, 80);
  const draft = insert([ref('a', label), ref('b', label)]); const generated = draft.tokens[1]!.label;
  assert.ok(generated.length <= 80);
  assert.doesNotMatch(generated, /[\uD800-\uDFFF]/u);
  assert.equal(generated, 'r'.repeat(77) + ' 2');
});
test('supported unrestricted draft insertion stays unique after suffix 99', () => {
  // Composer has no token-count or textarea maxLength cap. Context expansion's eight-reference cap is separate.
  const results = Array.from({length: 101}, (_, index) => ref(`item${index}-shared`, 'r'.repeat(80)));
  const draft = insert(results); const labels = Array.from(draft.tokens, token => token.label);
  assert.equal(new Set(labels).size, 101);
  assert.ok(labels.every(label => label.length <= 80));
});
