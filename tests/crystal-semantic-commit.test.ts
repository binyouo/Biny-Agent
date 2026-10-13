import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Product source is read as text, never imported. Only the audited semantic
// scanner and its pure anchor projection run, with in-memory dependencies.
const filename = "src/agent/context/crystalService.ts";
const file = ts.createSourceFile(filename, readFileSync(new URL(`../${filename}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const owners = file.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "CrystalService");
assert.equal(owners.length, 1);
const methods = owners[0]!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(file) === "attachSemanticSeedMaterials");
assert.equal(methods.length, 1);
const helpers = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "anchorRef");
assert.equal(helpers.length, 1);
const allowedCalls = new Set([
  "seeds.filter", "text.toLowerCase", "text.toLowerCase().includes", "crystal.name.toLowerCase",
  "text.trim", "text.trim().slice", "this.embedText!", "this.embedText!(input, signal).catch",
  "signal?.throwIfAborted", "Object.values", "Object.values(crystal.checklist).map",
  "this.seedVectors.get", "this.seedVectors.set", "Number.isFinite", "this.storage.transaction",
  "this.storage.getCrystal", "JSON.stringify", "this.storage.addMaterial", "anchorRef",
  "this.now", "this.now().toISOString", "this.storage.putCrystal", "this.onEvent"
]);
function audit(node: ts.Node): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  assert.ok(!ts.isNewExpression(node), "no allocations with external constructors");
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(file);
    // Admit only the existing array-literal key construction, not arbitrary calls.
    const keyChain = callee === '[crystal.name, ...Object.values(crystal.checklist).map((field) => field.value)].filter'
      || callee === '[crystal.name, ...Object.values(crystal.checklist).map((field) => field.value)].filter(Boolean).join'
      || callee === '[crystal.name, ...Object.values(crystal.checklist).map((field) => field.value)].filter(Boolean).join(" | ").slice';
    assert.ok(allowedCalls.has(callee) || keyChain, `Unexpected extracted call: ${callee}`);
  }
  ts.forEachChild(node, audit);
}
methods.forEach(audit);
helpers.forEach(audit);
const printer = ts.createPrinter();
const helper = helpers[0]!;
const localHelper = ts.factory.updateFunctionDeclaration(helper, undefined, helper.asteriskToken, helper.name, helper.typeParameters, helper.parameters, helper.type, helper.body);
const extracted = [
  printer.printNode(ts.EmitHint.Unspecified, localHelper, file),
  "class FixtureScanner {", printer.printNode(ts.EmitHint.Unspecified, methods[0]!, file), "}",
  "FixtureScanner.prototype.attachSemanticSeedMaterials;"
].join("\n");
const transpiled = ts.transpileModule(extracted, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((transpiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);

interface Crystal {
  id: string; origin: string; stage: string; name: string; type?: string; dormant: boolean; slot?: number;
  checklist: Record<string, { value: string; sources: string[] }>; notified: boolean;
  createdAt: string; updatedAt: string; formalAt?: string;
}
interface Anchor { threadId: string; anchorId: string; day: string }
interface Scanner {
  storage: FakeStorage; seedVectors: Map<string, { key: string; vector: Float32Array }>;
  embedText(text: string, signal?: AbortSignal): Promise<Float32Array | undefined>;
  now(): Date; onEvent(event: { type: string; crystalId: string }): void;
}
type Scan = (this: Scanner, seeds: Crystal[], text: string, anchor: Anchor, signal?: AbortSignal) => Promise<number>;
const scan = runInNewContext(transpiled.outputText, {}, {
  timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
}) as Scan;
const clone = <T,>(value: T): T => structuredClone(value);
const timestamp = "2026-10-01T00:00:00.000Z";
const initial: Crystal = {
  id: "seed-one", origin: "seed", stage: "candidate", name: "Topic", type: "concept", dormant: false, slot: 1,
  checklist: { definition: { value: "Reviewed definition", sources: ["user:manual"] } },
  notified: true, createdAt: timestamp, updatedAt: timestamp
};
class FakeStorage {
  rows = new Map<string, Crystal>([[initial.id, clone(initial)]]);
  materials = new Set<string>();
  depth = 0; transactions = 0; commits = 0; rollbacks = 0;
  writeDepths: number[] = [];
  failWrite = false; failMaterial = false;
  getCrystal(id: string): Crystal | undefined { const value = this.rows.get(id); return value ? clone(value) : undefined; }
  putCrystal(value: Crystal): void {
    this.writeDepths.push(this.depth);
    if (this.failWrite) throw new Error("injected row write failure");
    this.rows.set(value.id, clone(value));
  }
  addMaterial(id: string, kind: string, ref: unknown, source: string): boolean {
    this.writeDepths.push(this.depth);
    if (this.failMaterial) throw new Error("injected material failure");
    const key = JSON.stringify([id, kind, ref, source]);
    if (this.materials.has(key)) return false;
    this.materials.add(key);
    return true;
  }
  transaction<T>(work: () => T): T {
    assert.equal(this.depth, 0);
    const rows = clone(this.rows), materials = clone(this.materials);
    this.depth += 1; this.transactions += 1;
    try { const result = work(); this.commits += 1; return result; }
    catch (error) { this.rows = rows; this.materials = materials; this.rollbacks += 1; throw error; }
    finally { this.depth -= 1; }
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { gate?: number; rejectCall?: number; absentCall?: number; lowSimilarity?: boolean } = {}) {
  const storage = new FakeStorage(), reached = deferred(), release = deferred();
  const events: string[] = [];
  let calls = 0;
  const context: Scanner = {
    storage, seedVectors: new Map(), now: () => new Date(timestamp),
    onEvent: (event) => { assert.equal(storage.depth, 0, "events follow commit"); events.push(event.crystalId); },
    embedText: async () => {
      const call = ++calls;
      if (call === options.gate) { reached.resolve(); await release.promise; }
      if (call === options.rejectCall) throw new Error("injected embedding failure");
      if (call === options.absentCall) return undefined;
      return new Float32Array(options.lowSimilarity && call > 1 ? [0, 1] : [1, 0]);
    }
  };
  return {
    storage, events, reached, release, context, calls: () => calls,
    run: (anchorId = "anchor-one", signal?: AbortSignal) => scan.call(context, [...storage.rows.values()].map(clone), "Unrelated input text", { threadId: "thread-one", anchorId, day: "2026-10-01" }, signal)
  };
}
const changes: Array<[string, (row: Crystal) => void]> = [
  ["confirm", (row) => { row.stage = "formal"; row.formalAt = timestamp; row.slot = undefined; }],
  ["cancel", (row) => { row.dormant = true; row.slot = undefined; }],
  ["checklist", (row) => { row.checklist.definition = { value: "Manual replacement", sources: ["manual:new"] }; }],
  ["type", (row) => { row.type = "project"; row.checklist = {}; }],
  ["name", (row) => { row.name = "Renamed topic"; }],
  ["slot", (row) => { row.slot = 2; }],
  ["notified", (row) => { row.notified = false; }]
];
for (const gate of [1, 2]) {
  for (const [name, change] of changes) {
    test(`${name} during embedding ${gate} preserves same-timestamp edit`, async () => {
      const f = fixture({ gate });
      const pending = f.run(); await f.reached.promise;
      const edited = f.storage.getCrystal(initial.id)!; change(edited);
      assert.equal(edited.updatedAt, initial.updatedAt, "timestamp cannot identify ownership");
      f.storage.rows.set(edited.id, clone(edited));
      f.release.resolve();
      assert.equal(await pending, 0);
      assert.deepEqual(f.storage.getCrystal(initial.id), edited);
      assert.equal(f.storage.materials.size, 0); assert.deepEqual(f.events, []);
      assert.equal(f.storage.transactions, 1); assert.equal(f.storage.depth, 0);
    });
  }
  test(`missing row during embedding ${gate} is not recreated`, async () => {
    const f = fixture({ gate }), pending = f.run(); await f.reached.promise;
    f.storage.rows.delete(initial.id); f.release.resolve();
    assert.equal(await pending, 0); assert.equal(f.storage.rows.size, 0);
    assert.equal(f.storage.materials.size, 0); assert.deepEqual(f.events, []);
  });
  test(`cancellation during embedding ${gate} commits nothing`, async () => {
    const f = fixture({ gate }), controller = new AbortController();
    const pending = f.run("cancelled", controller.signal); await f.reached.promise;
    controller.abort(new Error("owner cancelled")); f.release.resolve();
    await assert.rejects(pending, /owner cancelled/u);
    assert.equal(f.storage.transactions, 0); assert.equal(f.storage.materials.size, 0);
    assert.deepEqual(f.storage.getCrystal(initial.id), initial); assert.deepEqual(f.events, []);
  });
}
test("unchanged candidate commits; cache is reused; duplicate material stays idempotent", async () => {
  const f = fixture();
  assert.equal(await f.run(), 1); assert.equal(f.calls(), 2);
  assert.equal(f.storage.getCrystal(initial.id)?.notified, false);
  assert.equal(await f.run(), 0); assert.equal(f.calls(), 3);
  assert.equal(await f.run("anchor-two"), 1); assert.equal(f.calls(), 4);
  assert.equal(f.storage.materials.size, 2); assert.equal(f.storage.commits, 3);
  assert.ok(f.storage.writeDepths.every((depth) => depth === 1), "all mutations are transactional");
  assert.deepEqual(f.events, [initial.id, initial.id]);
});
test("low similarity makes no transaction or mutation", async () => {
  const f = fixture({ lowSimilarity: true }); assert.equal(await f.run(), 0);
  assert.equal(f.storage.transactions, 0); assert.equal(f.storage.materials.size, 0);
});
for (const call of [1, 2]) {
  for (const mode of ["reject", "absent"] as const) {
    test(`${mode} embedding ${call} remains best effort`, async () => {
      const f = fixture(mode === "reject" ? { rejectCall: call } : { absentCall: call });
      assert.equal(await f.run(), 0); assert.equal(f.storage.transactions, 0);
      assert.equal(f.storage.materials.size, 0); assert.deepEqual(f.events, []);
    });
  }
}
for (const mode of ["failWrite", "failMaterial"] as const) {
  test(`${mode} rolls back material and metadata without an event`, async () => {
    const f = fixture(); f.storage[mode] = true;
    assert.equal(await f.run(), 0); assert.equal(f.storage.rollbacks, 1);
    assert.equal(f.storage.materials.size, 0); assert.equal(f.storage.depth, 0);
    assert.deepEqual(f.storage.getCrystal(initial.id), initial); assert.deepEqual(f.events, []);
  });
}
