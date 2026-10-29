/** Real discovery/URI declarations, inert directory and storage adapters. No product imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync("src/session/localReferences.ts", "utf8");
const parsed = ts.createSourceFile("localReferences.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations: string[] = [];
for (const name of ["segment", "encoded", "localReferenceUri", "parseLocalReferenceUri"]) {
  const nodes = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1);
  declarations.push(nodes[0]!.getText(parsed).replace(/^export /u, ""));
}
for (const name of ["labels", "localReferenceKinds"]) {
  const node = parsed.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
  assert.ok(node);
  declarations.push(`const ${node.getText(parsed)};`);
}
const owner = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "LocalReferenceService");
assert.ok(owner);
const search = owner.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(parsed) === "search");
assert.ok(search);
declarations.push(search.getText(parsed).replace(/^async search/u, "async function search"));
const javascript = stripTypeScriptTypes(declarations.join("\n"), { mode: "strip" });
interface Result { kind: string; uri: string; label: string }
interface Entry { name: string; directory?: boolean }
const root = "/inert-reference-project";
function fixture(tree: Record<string, Entry[] | Error>) {
  const functions = runInNewContext(`${javascript}\n({ search, localReferenceUri, parseLocalReferenceUri });`, {
    path,
    LocalReferenceGraph: class {
      async pins(): Promise<never[]> { return []; }
      async searchStored(): Promise<never[]> { return []; }
      close(): void {}
    },
    MemoryStorage: class { async listEntries(): Promise<{ entries: never[] }> { return { entries: [] }; } close(): void {} },
    validateDateReferenceRange: (value: unknown) => value,
    readdir: async (directory: string) => {
      assert.ok(Object.hasOwn(tree, directory), `Unexpected directory: ${directory}`);
      const entries = tree[directory]!;
      if (entries instanceof Error) throw entries;
      return entries.map(entry => ({ name: entry.name, isDirectory: () => Boolean(entry.directory), isFile: () => !entry.directory }));
    }
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as {
    search(this: object, query: string, id: string, kind?: string, limit?: number, zone?: string): Promise<Result[]>;
    localReferenceUri(reference: { kind: string; id: string }): string;
    parseLocalReferenceUri(uri: string): { id: string };
  };
  const receiver = { root: "/inert-state", project: () => ({ id: "p", name: "Project", path: root }),
    sessions: async () => [], existingEntries: async () => [] };
  return { functions, search: (query = "", limit = 30, combined = false) => functions.search.call(receiver, query, "p", combined ? undefined : "file", limit, "UTC") };
}
const files = (names: string[]) => ({ [root]: names.map(name => ({ name })) });
for (const names of [["100%.txt", "healthy.md"], ["healthy.md", "100%.txt"], ["100%.txt", "notes%28draft%29.md", "healthy.md"]]) {
  test(`unsupported entries do not discard healthy discovery: ${names.join(", ")}`, async () => {
    assert.deepEqual(Array.from(await fixture(files(names)).search(), result => result.uri), ["biny://file/healthy.md"]);
  });
}
test("unsupported entries do not consume quota", async () => {
  const f = fixture(files(["100%.txt", "one.md", "200%.txt", "two.md", "later.md"]));
  assert.deepEqual(Array.from(await f.search("", 2), result => result.label), ["one.md", "two.md"]);
});
test("unsupported parent component does not hide later sibling", async () => {
  const f = fixture({ [root]: [{ name: "100%", directory: true }, { name: "healthy.md" }], [path.join(root, "100%")]: [{ name: "child.md" }] });
  assert.deepEqual(Array.from(await f.search(), result => result.label), ["healthy.md"]);
});
test("all unsupported files yield empty success", async () => {
  assert.equal((await fixture(files(["100%.txt", "line\nbreak.txt"])).search()).length, 0);
});
test("combined search retains other kinds and healthy files", async () => {
  const results = await fixture(files(["100%.txt", "healthy.md"])).search("", 30, true);
  assert.ok(results.some(result => result.kind === "project" && result.uri === "biny://project/p"));
  assert.ok(results.some(result => result.kind === "file" && result.uri === "biny://file/healthy.md"));
});
test("healthy roundtrips and query filtering remain intact", async () => {
  const names = ["notes (final).md", "说明.md", "healthy.md"];
  const f = fixture(files(names));
  assert.deepEqual(Array.from(await f.search(), result => f.functions.parseLocalReferenceUri(result.uri).id), names);
  assert.deepEqual(Array.from(await f.search("healthy"), result => result.label), ["healthy.md"]);
});
test("enumeration failures still propagate", async () => {
  const error = new Error("inert read failure");
  await assert.rejects(fixture({ [root]: error }).search(), value => value === error);
});
test("direct parser restrictions remain unchanged", () => {
  const f = fixture(files([]));
  assert.throws(() => f.functions.localReferenceUri({ kind: "file", id: "100%.txt" }));
  for (const uri of ["biny://file/100%25.txt", "biny://file/%252e%252e/secret", "biny://file/%2e%2e/secret", "biny://file/a%2fb"])
    assert.throws(() => f.functions.parseLocalReferenceUri(uri));
});
