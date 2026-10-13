import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only these two current-source methods are executed. No product module is imported.
const filename = "src/session/threadBriefService.ts";
const file = ts.createSourceFile(filename, readFileSync(new URL(`../${filename}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const owners = file.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ThreadBriefService");
assert.equal(owners.length, 1);
const names = ["rewriteSuggestion", "mayPersist"];
const methods = names.map(name => {
  const matches = owners[0]!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(file) === name);
  assert.equal(matches.length, 1);
  return matches[0]!;
});
const allowedCalls = new Set([
  "this.store.suggestion", "this.store.putSuggestion", "this.mayPersist",
  "this.options.getModel", "this.options.canPersist", "this.options.onChange",
  "this.ask", "JSON.stringify", "revision.drop.some", "original.threads.some",
  "original.threads.filter", "revision.drop.includes",
  "z.object", "z.string", "z.array", "z.string().trim", "z.string().trim().min",
  "z.string().trim().min(1).max", "z.string().trim().max", "z.array(z.string()).max"
]);
function audit(node: ts.Node): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  if (ts.isNewExpression(node)) assert.ok(["Error", "AbortController"].includes(node.expression.getText(file)), "unexpected constructor");
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(file);
    // The sole z.object({...}).parse call must have a directly nested object schema.
    const schemaParse = ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "parse"
      && ts.isCallExpression(node.expression.expression)
      && node.expression.expression.expression.getText(file) === "z.object";
    assert.ok(allowedCalls.has(callee) || schemaParse, `Unexpected extracted call: ${callee}`);
  }
  ts.forEachChild(node, audit);
}
methods.forEach(audit);
const extracted = `class Fixture {\n${methods.map(node => node.getText(file)).join("\n")}\n}\nFixture.prototype;`;
const stripped = stripTypeScriptTypes(extracted, { mode: "strip" });

// This stub admits only schema-VALID fixtures below; it does not test Zod validation.
const chain = { trim() { return this; }, min(_n: number) { return this; }, max(_n: number) { return this; }, parse(value: unknown) { return value; } };
const z = { string: () => chain, array: (_value: unknown) => chain, object: (_value: unknown) => chain };
interface Thread { sessionId: string; projectId: string; title: string; createdAt: string }
interface Suggestion {
  id: string; signature: string; kind: "create" | "link"; status: "open" | "accepted" | "dismissed" | "rejected";
  projectId?: string; location?: string; name: string; brief: string; focus: string; reason: string; threads: Thread[]; createdAt: string;
}
interface Revision { name: string; brief: string; focus: string; drop: string[]; reason: string }
interface Fixture {
  store: { suggestion(id: string): Suggestion | undefined; putSuggestion(value: Suggestion): void };
  options: { getModel(): Promise<object>; canPersist(threads: readonly Thread[]): Promise<boolean>; onChange(): void };
  ask(model: object, prompt: string, input: unknown, signal: object): Promise<Revision>;
  rewriteSuggestion(id: string, feedback: string): Promise<void>;
  mayPersist(threads: readonly Thread[]): Promise<boolean>;
}
const prototype = runInNewContext(stripped, {
  z, shortText: chain, briefRevisionPrompt: "fixture-only",
  AbortController: class { signal = Object.freeze({}); }
}, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Pick<Fixture, "rewriteSuggestion" | "mayPersist">;
const clone = <T,>(value: T): T => structuredClone(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const original: Suggestion = {
  id: "suggestion", signature: "create:a,b", kind: "create", status: "open",
  name: "Original", brief: "Original brief", focus: "Original focus", reason: "Original reason",
  threads: ["a", "b"].map(sessionId => ({ sessionId, projectId: "workspace", title: sessionId, createdAt: "2026-10-01" })),
  createdAt: "2026-10-01"
};
const valid: Revision = { name: "Rewritten", brief: "Rewritten brief", focus: "Rewritten focus", drop: [], reason: "Rewritten reason" };
function fixture() {
  let row: Suggestion | undefined = clone(original);
  let writes = 0, changes = 0, reads = 0, asks = 0;
  const f: Fixture = {
    ...prototype,
    store: {
      suggestion(id) { assert.equal(id, original.id); reads++; return row && clone(row); },
      putSuggestion(value) { writes++; row = clone(value); }
    },
    options: {
      getModel: async () => ({}),
      canPersist: async () => true,
      onChange() { changes++; }
    },
    ask: async () => { asks++; return clone(valid); }
  };
  // Class prototype methods are non-enumerable.
  f.rewriteSuggestion = prototype.rewriteSuggestion;
  f.mayPersist = prototype.mayPersist;
  return { f, snapshot: () => row && clone(row), change(value: Suggestion | undefined) { row = value && clone(value); },
    counts: () => ({ writes, changes, reads, asks }) };
}
type Outcome = { ok: true } | { ok: false; message: string };
function outcome(promise: Promise<void>): Promise<Outcome> {
  return promise.then(() => ({ ok: true }), error => ({ ok: false, message: String(error?.message ?? error) }));
}
function assertRejected(result: Outcome, pattern: RegExp) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, pattern);
}
const mutations: Array<[string, (row: Suggestion) => Suggestion | undefined]> = [
  ["dismissed", row => ({ ...row, status: "dismissed" })],
  ["accepted", row => ({ ...row, status: "accepted", projectId: "accepted-project" })],
  ["manual fields", row => ({ ...row, name: "User name", brief: "User brief", focus: "User focus" })],
  ["threads", row => ({ ...row, threads: row.threads.slice(0, 1) })],
  ["location", row => ({ ...row, location: "/fixture/chosen-directory" })],
  ["replaced", row => ({ ...row, signature: "create:replacement", reason: "New suggestion identity" })],
  ["deleted", () => undefined]
];
for (const [label, mutate] of mutations) {
  test(`final visibility await preserves ${label}`, async () => {
    const x = fixture(), entered = deferred<void>(), release = deferred<boolean>();
    let checks = 0;
    x.f.options.canPersist = async () => {
      if (++checks === 2) { entered.resolve(); return await release.promise; }
      return true;
    };
    const pending = outcome(x.f.rewriteSuggestion(original.id, "feedback"));
    await entered.promise;
    const latest = mutate(clone(original));
    x.change(latest);
    release.resolve(true);
    const result = await pending;
    assertRejected(result, /已发生变化/u);
    assert.deepEqual(x.snapshot(), latest);
    assert.equal(x.counts().writes, 0);
    assert.equal(x.counts().changes, 0);
  });
}
test("unchanged valid revision succeeds and drops only selected sources", async () => {
  const x = fixture();
  const revision = { ...valid, drop: ["a"] };
  const visible: string[][] = [];
  x.f.ask = async () => clone(revision);
  x.f.options.canPersist = async threads => { visible.push(threads.map(thread => thread.sessionId)); return true; };
  await x.f.rewriteSuggestion(original.id, "feedback");
  assert.deepEqual(x.snapshot(), { ...original, name: valid.name, brief: valid.brief, focus: valid.focus, reason: valid.reason, threads: original.threads.slice(1) });
  assert.deepEqual(visible, [["a", "b"], ["b"]]);
  assert.equal(x.counts().writes, 1);
  assert.equal(x.counts().changes, 1);
});
for (const [drop, pattern] of [[['outside'], /建议之外/u], [['a', 'b'], /至少需要保留/u]] as const) {
  test(`valid-schema drop guard: ${drop.join(",")}`, async () => {
    const x = fixture();
    x.f.ask = async () => ({ ...valid, drop: [...drop] });
    assertRejected(await outcome(x.f.rewriteSuggestion(original.id, "feedback")), pattern);
    assert.deepEqual(x.snapshot(), original);
    assert.equal(x.counts().writes, 0);
    assert.equal(x.counts().changes, 0);
  });
}
for (const gate of [1, 2]) {
  test(`visibility denial at check ${gate} performs no write or notification`, async () => {
    const x = fixture();
    let checks = 0;
    x.f.options.canPersist = async () => ++checks !== gate;
    assertRejected(await outcome(x.f.rewriteSuggestion(original.id, "feedback")), /来源对话已不可用/u);
    assert.deepEqual(x.snapshot(), original);
    assert.equal(x.counts().writes, 0);
    assert.equal(x.counts().changes, 0);
    assert.equal(x.counts().asks, gate - 1);
  });
}
test("change during model wait still rejects", async () => {
  const x = fixture(), entered = deferred<void>(), answer = deferred<Revision>();
  x.f.ask = async () => { entered.resolve(); return await answer.promise; };
  const pending = outcome(x.f.rewriteSuggestion(original.id, "feedback"));
  await entered.promise;
  const latest: Suggestion = { ...clone(original), status: "dismissed" };
  x.change(latest);
  answer.resolve(clone(valid));
  assertRejected(await pending, /已发生变化/u);
  assert.deepEqual(x.snapshot(), latest);
  assert.equal(x.counts().writes, 0);
  assert.equal(x.counts().changes, 0);
});
test("concurrent rewrites commit one winner without overwriting it", async () => {
  const x = fixture(), asked = [deferred<void>(), deferred<void>()], answers = [deferred<Revision>(), deferred<Revision>()];
  const atCommit = [deferred<void>(), deferred<void>()], commits = [deferred<boolean>(), deferred<boolean>()];
  let asks = 0, checks = 0;
  x.f.ask = async () => { const i = asks++; asked[i]!.resolve(); return await answers[i]!.promise; };
  x.f.options.canPersist = async () => {
    const i = checks++;
    if (i < 2) return true;
    atCommit[i - 2]!.resolve();
    return await commits[i - 2]!.promise;
  };
  const first = outcome(x.f.rewriteSuggestion(original.id, "first"));
  await asked[0]!.promise;
  const second = outcome(x.f.rewriteSuggestion(original.id, "second"));
  await asked[1]!.promise;
  answers[0]!.resolve({ ...valid, name: "First" });
  await atCommit[0]!.promise;
  answers[1]!.resolve({ ...valid, name: "Second" });
  await atCommit[1]!.promise;
  commits[1]!.resolve(true);
  assert.deepEqual(await second, { ok: true });
  const winner = x.snapshot();
  commits[0]!.resolve(true);
  assertRejected(await first, /已发生变化/u);
  assert.deepEqual(x.snapshot(), winner);
  assert.equal(winner?.name, "Second");
  assert.equal(x.counts().writes, 1);
  assert.equal(x.counts().changes, 1);
});
