import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Product files are source text only. No product module, model, filesystem,
// recorder, Host or SDK is imported. The selected AST declarations are audited
// before evaluation, and all their effectful dependencies are in-memory fakes.
const root = new URL("../", import.meta.url);
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const extraction = source("src/agent/skillExtraction.ts");
const bridge = source("src/desktop/renderer/src/app/useDesktopEventBridge.ts");
const declarations = ["runSkillExtraction", "fileExists"].map((name) => {
  const found = extraction.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, name);
  assert.ok(found[0]!.body);
  return found[0]!;
});
const loops: ts.ForOfStatement[] = [];
function findLoops(node: ts.Node): void {
  if (ts.isForOfStatement(node) && node.expression.getText(bridge) === "currentEvents"
    && node.statement.getText(bridge).includes('event.type === "skill_extraction.updated"')) loops.push(node);
  ts.forEachChild(node, findLoops);
}
findLoops(bridge);
assert.equal(loops.length, 1, "extract exactly the skill notification loop");
const calls = new Set([
  "collectTurnMaterial", "analyzeWithModel", "authorWithModel", "input.onNotice",
  "input.refreshSkills", "defaultManagedSkillRoot", "path.join", "fileExists",
  "withGlobalConfigWriteLock", "fs.lstat", "fs.lstat(skillDirectory).catch",
  "status.isDirectory", "fs.mkdir", "fs.writeFile", "fs.rename", "fs.access",
  "randomBytes", 'randomBytes(6).toString', "setSkillExtraction"
]);
function audit(node: ts.Node, file: ts.SourceFile): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword, "no dynamic imports");
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(file), "Error");
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(file)), `Unexpected extracted call: ${node.expression.getText(file)}`);
  ts.forEachChild(node, (child) => audit(child, file));
}
for (const declaration of declarations) audit(declaration, extraction);
audit(loops[0]!, bridge);
const printer = ts.createPrinter();
function printFunction(node: ts.FunctionDeclaration): string {
  const local = ts.factory.updateFunctionDeclaration(node,
    node.modifiers?.filter((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword),
    node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, node.body);
  return printer.printNode(ts.EmitHint.Unspecified, local, extraction);
}
function compile(code: string): string {
  const result = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, isolatedModules: true },
    reportDiagnostics: true
  });
  assert.equal((result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
const extractionCode = compile(declarations.map(printFunction).join("\n") + "\nrunSkillExtraction;");
const bridgeCode = compile(`(function(currentEvents, current) {
  let card = current;
  const currentSessionId = "session";
  const setSkillExtraction = (next) => { card = typeof next === "function" ? next(card) : next; };
  ${printer.printNode(ts.EmitHint.Unspecified, loops[0]!, bridge)}
  return card;
});`);

interface Notice { stage: string; skillName?: string; updated?: boolean }
interface Outcome extends Notice { installedPath?: string }
interface Card extends Notice { sessionId: string; runId: string }
type Entry = "missing" | "directory" | "symlink" | "file";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial: Entry = "directory", priorBody = "old") {
  const managedRoot = "/inert/skills", directory = `${managedRoot}/workflow`, document = `${directory}/SKILL.md`;
  const versionDirectory = `${managedRoot}/.biny-versions/workflow/version/workflow`;
  let entry = initial, locked = false, extractionLockHeld = false, sequence = 0, refreshes = 0, lstatError: Error | undefined;
  let tail = Promise.resolve();
  const resolveFile = (target: string) => entry === "symlink" && target.startsWith(`${directory}/`)
    ? `${versionDirectory}${target.slice(directory.length)}` : target;
  const files = new Map<string, string>(initial === "missing" ? [] : [[resolveFile(document), priorBody]]);
  const notices: Notice[] = [], operations: string[] = [];
  const storageLocks: boolean[] = [], noticeLocks: boolean[] = [];
  const recordOperation = (operation: string) => { operations.push(operation); storageLocks.push(extractionLockHeld); };
  const requireDirectory = () => {
    if (entry === "missing") throw Object.assign(new Error("missing directory"), { code: "ENOENT" });
    if (entry === "file") throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  };
  async function lock<T>(target: string, operation: () => Promise<T>): Promise<T> {
    assert.equal(target, managedRoot);
    const previous = tail, release = deferred();
    tail = release.promise;
    await previous;
    locked = true;
    try { return await operation(); }
    finally { locked = false; release.resolve(); }
  }
  const fs = {
    async lstat(target: string) {
      recordOperation("lstat"); assert.equal(target, directory);
      if (lstatError) throw lstatError;
      if (entry === "missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isDirectory: () => entry === "directory" };
    },
    async mkdir(target: string, options?: { recursive?: boolean }) {
      recordOperation("mkdir"); assert.equal(target, directory);
      if (entry === "missing") { entry = "directory"; return; }
      if (options?.recursive && (entry === "directory" || entry === "symlink")) return;
      throw Object.assign(new Error("already exists"), { code: "EEXIST" });
    },
    async access(target: string) {
      recordOperation("access");
      if (!files.has(resolveFile(target))) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async writeFile(target: string, body: string) {
      recordOperation("write"); requireDirectory(); files.set(resolveFile(target), body);
    },
    async rename(from: string, to: string) {
      recordOperation("rename"); requireDirectory();
      assert.equal(to, document); const source = resolveFile(from), destination = resolveFile(to);
      assert.ok(files.has(source)); files.set(destination, files.get(source)!); files.delete(source);
    }
  };
  const run = runInNewContext(extractionCode, {
    fs, path: { join: (...parts: string[]) => parts.join("/") }, process: { pid: 1 },
    randomBytes: () => ({ toString: () => String(++sequence) }),
    defaultManagedSkillRoot: () => managedRoot,
    withGlobalConfigWriteLock: async <T>(target: string, operation: () => Promise<T>) => await lock(target, async () => {
      extractionLockHeld = true;
      try { return await operation(); }
      finally { extractionLockHeld = false; }
    }),
    collectTurnMaterial: () => ({ toolCalls: 5 }),
    analyzeWithModel: async () => { assert.equal(extractionLockHeld, false); return { worthy: true, skillName: "workflow", skillDescription: "workflow" }; },
    authorWithModel: async () => { assert.equal(extractionLockHeld, false); return { raw: "new", frontmatter: { name: "workflow", description: "workflow" } }; }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as (input: object) => Promise<Outcome>;
  return {
    files, notices, operations, storageLocks, noticeLocks, document, directory, managedRoot, lock,
    versionDocument: `${versionDirectory}/SKILL.md`,
    body: () => files.get(resolveFile(document)),
    get entry() { return entry; },
    get refreshes() { return refreshes; },
    setEntry(next: Entry) { assert.equal(locked, true); entry = next; },
    failLstat(error: Error) { lstatError = error; },
    run: () => run({ messageId: "message", events: [], installedSkills: [], model: {}, minToolCalls: 5,
      onNotice: (notice: Notice) => {
        noticeLocks.push(extractionLockHeld);
        notices.push(notice);
      },
      refreshSkills: async () => { assert.equal(extractionLockHeld, false); refreshes += 1; }
    })
  };
}

test("version alias and non-directory entries skip without writes or success notices", async () => {
  for (const entry of ["symlink", "file"] as const) {
    const f = fixture(entry);
    const outcome = await f.run();
    if (entry === "symlink") assert.equal(f.files.get(f.versionDocument), "old", "canonical version bytes must not be overwritten through the alias");
    assert.equal(f.body(), "old", "the actual version document must remain unchanged");
    assert.equal(outcome.stage, "skipped"); assert.equal(outcome.installedPath, undefined);
    assert.deepEqual(f.operations, ["lstat"]);
    assert.deepEqual(f.notices.map((item) => item.stage), ["extracting", "skipped"]);
    assert.equal(f.refreshes, 0);
  }
});

test("candidate storage is entirely under the shared lock; refresh and terminal notices are outside", async () => {
  const f = fixture("missing");
  await f.run();
  assert.ok(f.storageLocks.length > 0);
  assert.equal(f.storageLocks.every(Boolean), true);
  assert.deepEqual(f.noticeLocks, [false, true, false]);
});

test("ordinary directory creation and same-name update retain existing behavior", async () => {
  for (const entry of ["missing", "directory"] as const) {
    const f = fixture(entry), outcome = await f.run();
    assert.equal(outcome.stage, "done"); assert.equal(outcome.updated, entry === "directory");
    assert.equal(outcome.installedPath, f.document); assert.equal(f.files.get(f.document), "new");
    assert.equal(f.refreshes, 1);
    assert.deepEqual(f.notices.map((item) => item.stage), ["extracting", "saving", "done"]);
  }
});

test("unexpected lstat failures propagate without treating the path as missing", async () => {
  const f = fixture("directory"), error = Object.assign(new Error("denied"), { code: "EACCES" });
  f.failLstat(error);
  await assert.rejects(f.run(), (received: unknown) => received === error);
  assert.deepEqual(f.operations, ["lstat"]); assert.equal(f.files.get(f.document), "old");
  assert.equal(f.refreshes, 0);
});

test("publisher-first shared-lock ordering cannot overwrite the new alias", async () => {
  const f = fixture("missing"), entered = deferred(), release = deferred();
  const publisher = f.lock(f.managedRoot, async () => { entered.resolve(); await release.promise; f.setEntry("symlink"); });
  await entered.promise;
  const extractionRun = f.run();
  release.resolve(); await publisher;
  assert.equal((await extractionRun).stage, "skipped");
  assert.deepEqual(f.operations, ["lstat"]);
});

test("extraction-first leaves an ordinary directory for the publisher's existing-entry rejection", async () => {
  const f = fixture("missing");
  assert.equal((await f.run()).stage, "done");
  await assert.rejects(f.lock(f.managedRoot, async () => {
    if (f.entry !== "missing") throw new Error("Skill already installed");
    f.setEntry("symlink");
  }), /already installed/u);
  assert.equal(f.entry, "directory"); assert.equal(f.files.get(f.document), "new");
});

test("skipped notifications clear only their own card; ordinary done still displays", () => {
  const reduce = runInNewContext(bridgeCode, {}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as (events: object[], card?: Card) => Card | undefined;
  const current: Card = { sessionId: "session", runId: "new", stage: "extracting" };
  const event = (runId: string, stage: string, sessionId = "session") => ({ type: "skill_extraction.updated", sessionId, runId, stage, skillName: "workflow" });
  assert.equal(reduce([event("old", "skipped")], current), current);
  assert.equal(reduce([event("new", "skipped", "other-session")], current), current);
  assert.equal(reduce([event("new", "skipped")], current), undefined);
  const done = reduce([event("new", "done")]);
  assert.equal(done?.runId, "new"); assert.equal(done?.stage, "done");
  assert.equal(reduce([event("new", "extracting"), event("new", "skipped")]), undefined);
  assert.equal(reduce([event("new", "extracting"), event("old", "skipped")])?.runId, "new");
});
