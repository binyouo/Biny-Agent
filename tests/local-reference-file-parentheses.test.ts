/** Inert producer/consumer contract: no product imports, filesystem fixtures, Host or storage.
 * Execute AST-selected production functions and graph regex with only an in-memory resolver.
 * This verifies serialization/composition, not actual filesystem resolution or graph persistence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

interface Reference { kind: string; id?: string; threadId?: string }
interface Result { kind: string; uri: string; label: string; content: string }
interface Token { start: number; end: number; label: string; uri: string; kind: string }
interface Draft { value: string; tokens: Token[] }
interface ReferenceFunctions {
  localReferenceUri(reference: Reference): string;
  parseLocalReferenceUri(uri: string): Reference;
  formatLocalReference(label: string, uri: string): string;
  localReferenceContext(input: string, service: { resolve(uri: string, projectId: string): Promise<Result> }, projectId: string): Promise<string>;
}
interface DraftFunctions {
  insertDraftReference(value: string, completion: { start: number; end: number; query: string }, result: Result, tokens: Token[]): Draft;
  materializeDraftReferences(value: string, tokens: Token[]): string;
  normalizeDraftReferences(value: string, tokens: Token[]): Draft;
}

function select(file: string, functions: string[], variables: string[] = []): string {
  const source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected: string[] = [];
  for (const name of functions) {
    const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `missing production function ${name}`);
    selected.push(declaration.getText(parsed).replace(/^export /u, ""));
  }
  for (const name of variables) {
    const declaration = parsed.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
      .find(node => ts.isIdentifier(node.name) && node.name.text === name);
    assert.ok(declaration?.initializer, `missing production variable ${name}`);
    selected.push(`const ${declaration.getText(parsed)};`);
  }
  return stripTypeScriptTypes(selected.join("\n"), { mode: "strip" });
}

const names = ["segment", "encoded", "parseLocalReferenceUri", "localReferenceUri", "formatLocalReference", "localReferenceContext"];
const functions = runInNewContext(`${select("src/session/localReferences.ts", names, ["labels"])}\n({${names.join(",")}});`, {
  validateDateReferenceRange: () => { throw new Error("Date reference execution is outside this fixture."); }
}, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as ReferenceFunctions;
const draftNames = ["validToken", "uniqueLabel", "insertDraftReference", "reconcileDraftReferenceChange", "materializeDraftReferences", "kindFromUri", "normalizeDraftReferences"];
const drafts = runInNewContext(`${select("src/desktop/renderer/src/components/composer/referenceCompletion.ts", draftNames, ["kinds"])}\n({${draftNames.join(",")}});`, {},
  { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as DraftFunctions;
const graphPatternSource = select("src/session/referenceGraph.ts", [], ["inlineReference"]);
function graphTargets(text: string): string[] {
  const expression = runInNewContext(`${graphPatternSource}\ninlineReference;`, {},
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as RegExp;
  return [...text.matchAll(expression)].map(match => match[1]!);
}

const fileCases = [
  ["notes(final).md", "biny://file/notes%28final%29.md"],
  ["docs (draft)/notes (v2).md", "biny://file/docs%20%28draft%29/notes%20%28v2%29.md"],
  ["资料(草稿)/说明.md", "biny://file/%E8%B5%84%E6%96%99%28%E8%8D%89%E7%A8%BF%29/%E8%AF%B4%E6%98%8E.md"],
  ["notes(final.md", "biny://file/notes%28final.md"],
  ["notes)final.md", "biny://file/notes%29final.md"],
  ["docs/notes.md", "biny://file/docs/notes.md"],
  ["notes final.md", "biny://file/notes%20final.md"]
] as const;

for (const [id, expected] of fileCases) {
  test(`generated file URI roundtrips through actual consumers: ${id}`, async () => {
    const uri = functions.localReferenceUri({ kind: "file", id });
    assert.equal(uri, expected);
    assert.equal(functions.parseLocalReferenceUri(uri).id, id);
    const result: Result = { kind: "file", uri, label: id, content: `Contents of ${id}` };
    const token = functions.formatLocalReference(id, uri);
    const resolved: string[] = [];
    const context = await functions.localReferenceContext(token, {
      resolve: async (requested, projectId) => {
        assert.equal(projectId, "inert-project");
        resolved.push(requested);
        if (requested !== expected) throw new Error("Only the exact fixture URI resolves.");
        return result;
      }
    }, "inert-project");
    assert.deepEqual(resolved, [expected]);
    assert.ok(context.includes(result.content));
    assert.deepEqual(graphTargets(token), [expected]);
    const draft = drafts.insertDraftReference("@", { start: 0, end: 1, query: "" }, result, []);
    assert.equal(drafts.materializeDraftReferences(draft.value, draft.tokens).trim(), token);
    const restored = drafts.normalizeDraftReferences(token, []);
    assert.equal(restored.tokens.length, 1);
    assert.equal(restored.tokens[0]?.uri, expected);
    assert.equal(drafts.materializeDraftReferences(restored.value, restored.tokens), token);
  });
}

for (const uri of ["biny://file/notes(final).md", "biny://file/notes%28final%29.md", "biny://file/notes%28final).md"]) {
  test(`CLI token canonicalizes existing direct file URI: ${uri}`, async () => {
    const output: string[] = [];
    const calls: string[] = [];
    const command = runInNewContext(`${select("src/cli/commands/references.ts", ["referenceTokenCommand"])}\nreferenceTokenCommand;`, {
      service: (workspace: string) => {
        assert.equal(workspace, "/inert/project");
        return { projectId: "inert-project", instance: { resolve: async (requested: string, projectId: string) => {
          assert.equal(projectId, "inert-project");
          calls.push(requested);
          assert.equal(functions.parseLocalReferenceUri(requested).id, "notes(final).md");
          return { uri: requested, label: "notes(final).md", kind: "file", content: "inert" };
        } } };
      },
      formatLocalReference: functions.formatLocalReference,
      console: { log: (text: string) => output.push(text) }
    }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as (workspace: string, uri: string, label?: string) => Promise<void>;
    await command("/inert/project", uri);
    assert.deepEqual(calls, [uri], "direct resolution still receives the supplied URI unchanged");
    assert.deepEqual(output, ["@[notes(final).md](biny://file/notes%28final%29.md)"]);
  });
}

test("non-file identifiers and token bytes remain unchanged", () => {
  for (const reference of [
    { kind: "thread", id: "session(final)" }, { kind: "message", threadId: "session(final)", id: "slot(v2)" },
    { kind: "tool-call", threadId: "session(final)", id: "call(v2)" }, { kind: "model", id: "model(final)" }
  ]) {
    const uri = functions.localReferenceUri(reference);
    assert.ok(uri.includes("(final)"));
    assert.equal(functions.formatLocalReference("Label", uri), `@[Label](${uri})`);
    assert.equal(JSON.stringify(functions.parseLocalReferenceUri(uri)), JSON.stringify(reference));
  }
});

test("file formatting is idempotent and explicit labels are preserved", () => {
  const uri = "biny://file/notes%28final%29.md";
  assert.equal(functions.localReferenceUri(functions.parseLocalReferenceUri(uri)), uri);
  assert.equal(functions.formatLocalReference("My notes", uri), `@[My notes](${uri})`);
  assert.throws(() => functions.formatLocalReference("bad\nlabel", uri));
  assert.throws(() => functions.formatLocalReference("bad]label", uri));
});

test("literal percent identifiers retain their existing rejection", () => {
  assert.throws(() => functions.localReferenceUri({ kind: "file", id: "notes%28final%29.md" }));
  assert.throws(() => functions.parseLocalReferenceUri("biny://file/notes%2528final%2529.md"));
});

test("generated parenthesized file token actually supplies context rather than being silently dropped", async () => {
  const uri = functions.localReferenceUri({ kind: "file", id: "notes(final).md" });
  const token = functions.formatLocalReference("Notes", uri);
  const content = "Expected ordinary notes body.";
  const requests: string[] = [];
  const context = await functions.localReferenceContext(token, {
    resolve: async (requested) => {
      requests.push(requested);
      if (functions.parseLocalReferenceUri(requested).id !== "notes(final).md") throw new Error("No such fixture file.");
      return { kind: "file", uri: requested, label: "Notes", content };
    }
  }, "inert-project");
  assert.ok(context.includes(content), "the actual context consumer must include the selected file body");
  assert.equal(requests.length, 1);
  assert.equal(functions.parseLocalReferenceUri(requests[0]!).id, "notes(final).md");
});

test("generated parenthesized file candidate is accepted by the unchanged draft consumer", () => {
  const result = { kind: "file", uri: functions.localReferenceUri({ kind: "file", id: "notes(final).md" }), label: "Notes", content: "inert" };
  const draft = drafts.insertDraftReference("@", { start: 0, end: 1, query: "" }, result, []);
  assert.equal(draft.tokens.length, 1);
  assert.equal(functions.parseLocalReferenceUri(draft.tokens[0]!.uri).id, "notes(final).md");
});

test("the actual graph matcher retains the complete generated file destination", () => {
  const token = functions.formatLocalReference("Notes", functions.localReferenceUri({ kind: "file", id: "notes(final).md" }));
  const targets = graphTargets(token);
  assert.equal(targets.length, 1);
  assert.equal(functions.parseLocalReferenceUri(targets[0]!).id, "notes(final).md");
});

test("existing non-file percent spelling is not canonicalized by formatting", () => {
  for (const uri of ["biny://thread/session%28final%29", "biny://model/%6dodel(final)", "biny://thread/a/tool/call%28v2%29"]) {
    assert.equal(functions.formatLocalReference("Label", uri), `@[Label](${uri})`);
  }
});
