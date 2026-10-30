import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Product modules are source text only. Only the fixed declarations below are
// transpiled, after AST call auditing. Every model, storage and lock dependency
// used by extracted code is an inert in-memory fake.
const root = new URL("../", import.meta.url);
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const analysisSource = source("src/agent/context/emotionAnalysis.ts");
const storageSource = source("src/agent/context/emotionStorage.ts");
function functions(file: ts.SourceFile, names: readonly string[]): ts.FunctionDeclaration[] {
  return names.map((name) => {
    const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(found.length, 1, name);
    assert.ok(found[0]!.body);
    return found[0]!;
  });
}
const analysisFunctions = functions(analysisSource, ["analyzeContextEmotion", "normalizeMessages"]);
const storageFunctions = functions(storageSource, ["renderEmotionDocument", "parseEmotionDocument", "safeFileName"]);
const owners = storageSource.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "EmotionStorage");
assert.equal(owners.length, 1);
const storageMethods = ["writeContext", "writeState", "writeBase"].map((name) => {
  const found = owners[0]!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(storageSource) === name);
  assert.equal(found.length, 1, name);
  assert.ok(found[0]!.body);
  return found[0]!;
});
const limits = ["recentMessageLimit", "recentMessageMaxChars"].map((name) => {
  const found = analysisSource.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .filter((node) => node.name.getText(analysisSource) === name);
  assert.equal(found.length, 1);
  assert.ok(found[0]!.initializer && ts.isNumericLiteral(found[0]!.initializer));
  return `const ${found[0]!.getText(analysisSource)};`;
});
const emotionResultSchema = analysisSource.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .filter((node) => node.name.getText(analysisSource) === "autoEmotionResultSchema");
assert.equal(emotionResultSchema.length, 1);
const emotionResultSchemaCode = `const ${emotionResultSchema[0]!.getText(analysisSource)};`;
const storageNames = ["baseFileName", "contextDirectoryName"].map((name) => {
  const found = storageSource.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .filter((node) => node.name.getText(storageSource) === name);
  assert.equal(found.length, 1);
  assert.ok(found[0]!.initializer && ts.isStringLiteral(found[0]!.initializer));
  return `const ${found[0]!.getText(storageSource)};`;
});
const calls = new Set([
  "options.getModel", "options.getUsageModelInfo", "normalizeMessages", "options.getMessages", "generateNativeText",
  "result.text.trim", "JSON.parse", "autoEmotionResultSchema.safeParse",
  "messages.map", "options.onUsage", "options.signal?.throwIfAborted",
  "options.storage.readBase",
  "now().toISOString", "now", "options.storage.readContext", "options.storage.writeContext", "options.onUpdated",
  "Array.from", "Array.from(message.text).slice", "Array.from(message.text).slice(0, recentMessageMaxChars).join",
  "message.text.trim", "value.replace",
  "Math.min", "Math.max",
  "this.writeState", "path.join", "safeFileName", "path.dirname", "fs.mkdir", "fs.chmod",
  "randomUUID", "fs.open", "handle.writeFile", "renderEmotionDocument", "handle.sync", "handle.close",
  "signal?.throwIfAborted", "fs.rename", "handle?.close", "handle?.close().catch", "fs.unlink",
  "fs.unlink(temporary).catch", "withGlobalConfigWriteLock", "state.trigger?.trim", "state.mood.trim",
  "parseEmotionDocument", "content.replace", "normalized.match", "match[1]?.split", "line.trim", "line.indexOf", "line.slice", "line.slice(0, separator).trim", "line.slice(separator + 1).trim", "Number", "Number.isFinite", "Date.parse", "match[2]?.trim",
  "String", "frontmatter.join", "value.replace(/[^a-zA-Z0-9._-]/gu, \"-\").slice"
]);
function audit(node: ts.Node, file: ts.SourceFile): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword, "dynamic imports are forbidden");
  if (ts.isNewExpression(node)) assert.ok(["Date", "Error"].includes(node.expression.getText(file)), "only inert Date/Error allocations are allowed");
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(file);
    // Array literal joins and the exact normalization chain are pure; no
    // arbitrary property call is admitted by this exception.
    const literalJoin = ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "join" && ts.isArrayLiteralExpression(node.expression.expression);
    const normalizeChain = ts.isPropertyAccessExpression(node.expression)
      && ["map", "filter", "slice"].includes(node.expression.name.text)
      && node.getStart(file) >= analysisFunctions[1]!.getStart(analysisSource)
      && node.getEnd() <= analysisFunctions[1]!.getEnd()
      && file === analysisSource;
    assert.ok(calls.has(callee) || literalJoin || normalizeChain, `Unexpected extracted call: ${callee}`);
  }
  ts.forEachChild(node, (child) => audit(child, file));
}
for (const node of analysisFunctions) audit(node, analysisSource);
for (const node of [...storageFunctions, ...storageMethods]) audit(node, storageSource);
const printer = ts.createPrinter();
function printFunction(node: ts.FunctionDeclaration, file: ts.SourceFile): string {
  const local = ts.factory.updateFunctionDeclaration(node,
    node.modifiers?.filter((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword),
    node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, node.body);
  return printer.printNode(ts.EmitHint.Unspecified, local, file);
}
const selectedCode = [
  ...limits,
  emotionResultSchemaCode,
  ...storageNames,
  ...analysisFunctions.map((node) => printFunction(node, analysisSource)),
  ...storageFunctions.map((node) => printFunction(node, storageSource)),
  "class FixtureStorage {",
  ...storageMethods.map((node) => printer.printNode(ts.EmitHint.Unspecified, node, storageSource)),
  "}",
  "({ analyze: analyzeContextEmotion, storage: FixtureStorage.prototype });"
].join("\n");
const transpiled = ts.transpileModule(selectedCode, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, isolatedModules: true },
  reportDiagnostics: true
});
assert.equal((transpiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);

interface State { mood: string; valence: number; energy: number; updatedAt: string; trigger?: string }
interface Storage {
  writeContext(sessionId: string, state: State, signal?: AbortSignal): Promise<void>;
  writeBase(state: State): Promise<void>;
  readBase(): Promise<State | undefined>;
  readContext(sessionId: string): Promise<State | undefined>;
}
interface AnalyzeOptions {
  sessionId: string;
  storage: Storage;
  getModel(): { modelId: string };
  getMessages(): Promise<Array<{ role: "user"; text: string }>>;
  now(): Date;
  signal?: AbortSignal;
  onUpdated(state: State): Promise<void>;
}
interface Extracted {
  analyze(options: AnalyzeOptions): Promise<State | undefined>;
  storage: Storage;
}
type GateName = "readBase" | "readContext" | "mkdir" | "chmod" | "open" | "writeFile" | "sync" | "close" | "rename";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const state: State = { mood: "专注", valence: 8, energy: 7, updatedAt: "2026-09-01T00:00:00.000Z", trigger: "fixture" };
const target = "root/context/session-one.md";
function fixture(gateName?: GateName) {
  const reached = deferred(), release = deferred();
  let gated = false, notifications = 0, sequence = 0, locks = 0;
  const calls: string[] = [];
  const files = new Map<string, string>([[target, "previous-context"]]);
  const openHandles = new Set<string>();
  async function stage(name: GateName): Promise<void> {
    calls.push(name);
    if (name === gateName && !gated) { gated = true; reached.resolve(); await release.promise; }
  }
  const fs = {
    async mkdir(_path: string, _options: unknown) { await stage("mkdir"); },
    async chmod(_path: string, _mode: number) { await stage("chmod"); },
    async open(file: string, _flags: string, _mode: number) {
      await stage("open");
      files.set(file, "");
      openHandles.add(file);
      return {
        async writeFile(content: string, _encoding: string) { await stage("writeFile"); files.set(file, content); },
        async sync() { await stage("sync"); },
        async close() { await stage("close"); openHandles.delete(file); }
      };
    },
    async rename(from: string, to: string) {
      // Invocation is recorded before this optional wait: an admitted rename
      // may finish after cancellation, and its success still merits metadata.
      await stage("rename");
      assert.ok(files.has(from), "temporary content exists");
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    async unlink(file: string) { calls.push("unlink"); files.delete(file); }
  };
  const extracted = runInNewContext(transpiled.outputText, {
    z,
    fs,
    path: { join: (...parts: string[]) => parts.join("/"), dirname: (file: string) => file.slice(0, file.lastIndexOf("/")) },
    randomUUID: () => `fixture-${++sequence}`,
    withGlobalConfigWriteLock: async (_root: string, effect: () => Promise<void>) => { locks += 1; await effect(); },
    DEFAULT_EMOTION_STATE: { ...state },
    autoEmotionSystemPrompt: "inert fixture prompt",
    generateNativeText: async (_model: unknown, _messages: unknown, _options: unknown) => ({
      text: '{"mood":"专注","valence":8,"reason":"fixture"}'
    })
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Extracted;
  const storage = Object.assign(Object.create(extracted.storage) as Storage, {
    root: "root",
    async readBase(): Promise<State> { await stage("readBase"); return { ...state }; },
    async readContext(_sessionId: string): Promise<undefined> { await stage("readContext"); return undefined; }
  });
  const run = (signal?: AbortSignal) => extracted.analyze({
    sessionId: "session-one", storage,
    getModel: () => ({ modelId: "inert" }),
    getMessages: async () => [{ role: "user", text: "fixture source" }],
    now: () => new Date(state.updatedAt), signal,
    onUpdated: async (next) => { assert.equal(next.mood, state.mood); notifications += 1; }
  });
  return { run, storage, files, calls, reached, release, openHandles,
    notifications: () => notifications, locks: () => locks };
}

for (const gate of ["readBase", "readContext", "mkdir", "chmod", "open", "writeFile", "sync", "close"] as const) {
  test(`cancel during ${gate} prevents rename admission and notification`, { timeout: 5000 }, async () => {
    const f = fixture(gate), controller = new AbortController(), reason = new Error("fixture cancellation");
    const outcome = f.run(controller.signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await f.reached.promise;
    controller.abort(reason);
    f.release.resolve();
    const result = await outcome;
    assert.equal(result.ok, false, "cancelled preparation must reject");
    if (!result.ok) assert.equal(result.error, reason);
    assert.equal(f.calls.filter((item) => item === "rename").length, 0);
    assert.equal(f.notifications(), 0);
    assert.equal(f.files.get(target), "previous-context");
    assert.equal(f.files.size, 1, "temporary file is cleaned");
    assert.equal(f.openHandles.size, 0, "temporary handle is closed");
  });
}

test("rename already admitted wins cancellation and retains success notification", { timeout: 5000 }, async () => {
  const f = fixture("rename"), controller = new AbortController();
  const outcome = f.run(controller.signal);
  await f.reached.promise;
  controller.abort(new Error("late cancellation"));
  f.release.resolve();
  const result = await outcome;
  assert.equal(result?.mood, state.mood);
  assert.equal(f.calls.filter((item) => item === "rename").length, 1);
  assert.equal(f.notifications(), 1);
  assert.match(f.files.get(target)!, /mood: 专注/);
  assert.equal(f.files.size, 1);
  assert.equal(f.openHandles.size, 0);
});

for (const withSignal of [true, false]) {
  test(`normal analysis succeeds with ${withSignal ? "an active signal" : "no signal"}`, async () => {
    const f = fixture();
    const result = await f.run(withSignal ? new AbortController().signal : undefined);
    assert.equal(result?.mood, state.mood);
    assert.equal(f.notifications(), 1);
    assert.equal(f.calls.filter((item) => item === "rename").length, 1);
    assert.doesNotMatch(f.files.get(target)!, /energy:/, "context format stays unchanged");
    assert.equal(f.files.size, 1);
    assert.equal(f.openHandles.size, 0);
  });
}

test("direct context and base writes without a signal preserve their APIs and formats", async () => {
  const f = fixture();
  await f.storage.writeContext("session-one", state);
  assert.match(f.files.get(target)!, /mood: 专注/);
  assert.doesNotMatch(f.files.get(target)!, /energy:/);
  await f.storage.writeBase(state);
  assert.match(f.files.get("root/base.md")!, /energy: 7/);
  assert.equal(f.locks(), 1, "base still uses its existing lock");
  assert.equal(f.openHandles.size, 0);
  assert.equal(f.files.size, 2, "no temporary files remain");
});
