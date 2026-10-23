/** Inert public-command contract. Only AST-selected pure production declarations and label
 * expressions execute; no product imports, CLI bootstrap, config, storage, Host or fixture files.
 * Resolution is supplied in memory. This does not certify real object lookup or persistence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

interface Result { kind: string; uri: string; label: string; content: string }
interface Reference { kind: string; id?: string; threadId?: string }
interface Functions {
  localReferenceUri(reference: Reference): string;
  formatLocalReference(label: string, uri: string): string;
}
const options = { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } };

function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function select(file: string, names: string[], variables: string[] = []): string {
  const parsed = source(file);
  const parts = names.map(name => {
    const nodes = parsed.statements.filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1, `exactly one production function ${name}`);
    return nodes[0]!.getText(parsed).replace(/^export /u, "");
  });
  for (const name of variables) {
    const nodes = parsed.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
      .filter(node => ts.isIdentifier(node.name) && node.name.text === name);
    assert.equal(nodes.length, 1);
    parts.push(`const ${nodes[0]!.getText(parsed)};`);
  }
  return stripTypeScriptTypes(parts.join("\n"), { mode: "strip" });
}

/** Select the actual return object's label expression, not a copied producer implementation. */
function producerLabel(file: string, className: string, methodName: string, kind: string,
  bindings: Record<string, unknown>): string {
  const parsed = source(file);
  const owner = parsed.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(owner);
  const method = owner.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node)
    && ts.isIdentifier(node.name) && node.name.text === methodName);
  assert.ok(method?.body);
  const expressions: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const properties = node.expression.properties.filter(ts.isPropertyAssignment);
      const field = (name: string): ts.PropertyAssignment | undefined => properties.find(property =>
        ts.isIdentifier(property.name) && property.name.text === name);
      const tag = field("kind")?.initializer;
      if (tag && ts.isStringLiteral(tag) && tag.text === kind) {
        const label = field("label")?.initializer;
        assert.ok(label);
        expressions.push(label);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(method.body);
  assert.equal(expressions.length, 1, `unique ${className}.${methodName} ${kind} label`);
  const expression = expressions[0]!.getText(parsed);
  // Fail closed if producer refactoring introduces anything except the reviewed inert label access.
  assert.ok(["ref.id", "message.content.slice(0, 80)", "content.slice(0, 80)", "quote.slice(0, 80)",
    "row.content.slice(0, 80)", "row.quote.slice(0, 80)"].includes(expression));
  return runInNewContext(stripTypeScriptTypes(`(${expression})`, { mode: "strip" }), bindings, options) as string;
}

const library = "src/session/localReferences.ts";
const graph = "src/session/referenceGraph.ts";
const names = ["segment", "encoded", "parseLocalReferenceUri", "localReferenceUri", "formatLocalReference"];
const functions = runInNewContext(`${select(library, names, ["labels"])}\n({${names.join(",")}})`, {
  validateDateReferenceRange: () => { throw new Error("Dates are outside this fixture."); }
}, options) as Functions;
const commandSource = select("src/cli/commands/references.ts", ["referenceTokenCommand"]);

function commandFixture(result: Result, rejection?: Error): {
  invoke(label?: string): Promise<void>; output: string[]; calls: string[][];
} {
  const output: string[] = [];
  const calls: string[][] = [];
  const command = runInNewContext(`${commandSource}\nreferenceTokenCommand`, {
    service: (workspace: string) => {
      assert.equal(workspace, "/inert/project");
      return { projectId: "inert-project", instance: { resolve: async (uri: string, projectId: string) => {
        calls.push([uri, projectId]);
        if (rejection) throw rejection;
        return result;
      } } };
    }, formatLocalReference: functions.formatLocalReference, console: { log: (value: string) => output.push(value) }
  }, options) as (workspace: string, uri: string, label?: string) => Promise<void>;
  return { invoke: label => command("/inert/project", result.uri, label), output, calls };
}

function fileResult(id: string): Result {
  return { kind: "file", uri: functions.localReferenceUri({ kind: "file", id }), content: "Inert contents",
    label: producerLabel(library, "LocalReferenceService", "resolve", "file", { ref: { id } }) };
}

const cases: Array<{ name: string; result: Result; expected: string }> = [
  { name: "bracket filename", result: fileResult("notes].txt"), expected: "notes .txt" },
  { name: "long filename", result: fileResult(`${"n".repeat(90)}.txt`), expected: "n".repeat(80) },
  { name: "bracket-only filename", result: fileResult("]"), expected: "引用" },
  { name: "ordinary filename", result: fileResult("notes.txt"), expected: "notes.txt" }
];
for (const content of ["First line\nSecond line", "First\r\nSecond] line", " ".repeat(80) + "Later text", "Normal message"]) {
  const expected = content === "Normal message" ? content : content.startsWith(" ") ? "引用"
    : content.includes("\r") ? "First  Second  line" : "First line Second line";
  cases.push({ name: `message ${JSON.stringify(content)}`, expected, result: {
    kind: "message", uri: functions.localReferenceUri({ kind: "message", threadId: "thread-1", id: "slot-1" }), content,
    label: producerLabel(library, "LocalReferenceService", "resolve", "message", { message: { content } })
  } });
}
for (const kind of ["scratch", "snippet"] as const) {
  const content = "First line\nSecond] line";
  const bindings = kind === "scratch" ? { content } : { quote: content };
  const created = producerLabel(graph, "LocalReferenceGraph", kind === "scratch" ? "createScratch" : "captureSnippet", kind, bindings);
  const resolved = producerLabel(graph, "LocalReferenceGraph", "resolve", kind, { row: { content, quote: content } });
  assert.equal(created, resolved);
  cases.push({ name: `${kind} multiline producer and resolution`, expected: "First line Second  line", result: {
    kind, content, uri: functions.localReferenceUri({ kind, id: "fixture-id" }), label: resolved
  } });
}

for (const { name, result, expected } of cases) {
  test(`omitted token label handles ${name}`, async () => {
    const original = { ...result };
    const fixture = commandFixture(result);
    await fixture.invoke();
    assert.deepEqual(fixture.calls, [[result.uri, "inert-project"]]);
    assert.deepEqual(fixture.output, [`@[${expected}](${result.uri})`]);
    assert.deepEqual(result, original, "default formatting must not mutate the resolved object");
  });
}

test("explicit valid label is preserved exactly despite an unsafe resolved default", async () => {
  const result = fileResult("notes].txt");
  for (const label of ["My notes", "  Keep spaces  ", "x".repeat(80)]) {
    const fixture = commandFixture(result);
    await fixture.invoke(label);
    assert.deepEqual(fixture.output, [`@[${label}](${result.uri})`]);
    assert.deepEqual(fixture.calls, [[result.uri, "inert-project"]]);
  }
});

for (const label of ["", "   ", "bad]label", "bad\nlabel", "bad\rlabel", "x".repeat(81)]) {
  test(`explicit invalid label remains rejected: ${JSON.stringify(label)}`, async () => {
    const fixture = commandFixture(fileResult("notes.txt"));
    await assert.rejects(fixture.invoke(label), /Invalid reference label\./u);
    assert.deepEqual(fixture.output, []);
    assert.equal(fixture.calls.length, 1);
    assert.throws(() => functions.formatLocalReference(label, "biny://file/notes.txt"), /Invalid reference label\./u);
  });
}

test("resolution failure remains authoritative even with an explicit safe label", async () => {
  const fixture = commandFixture(fileResult("notes].txt"), new Error("File is not available."));
  await assert.rejects(fixture.invoke("Safe"), /File is not available\./u);
  assert.deepEqual(fixture.output, []);
  assert.equal(fixture.calls.length, 1);
});

test("default-label formatting preserves resolved URI percent spelling", async () => {
  const result = { ...fileResult("notes].txt"), uri: "biny://file/%6eotes%5d.txt" };
  const fixture = commandFixture(result);
  await fixture.invoke();
  assert.deepEqual(fixture.output, ["@[notes .txt](biny://file/%6eotes%5d.txt)"]);
  assert.deepEqual(fixture.calls, [[result.uri, "inert-project"]]);
});
