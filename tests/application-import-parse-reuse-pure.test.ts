/** Actual execute + legacy importSessionFile wrapper; all persistence and parsing are inert. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const filename = "src/imports/service.ts";
const source = ts.createSourceFile(filename, readFileSync(path.join(process.cwd(), filename), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ApplicationImportService");
assert.ok(declaration);
const execute = declaration.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "execute");
assert.ok(execute);
const transfer = ts.createSourceFile("transfer.ts", readFileSync(path.join(process.cwd(), "src/session/transfer.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const importer = transfer.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "importSessionFile");
assert.ok(importer);
const allowedCalls = new Set([
  "randomUUID", "new Date().toISOString", "[history, ...state.history].slice", "this.scan", "preview.items.find", "history.results.push",
  "scanned?.preview.items.find", "canonicalFuturePath", "this.configStore.configPath", "this.configStore.configPath?.", "digest", "state.receipts.find",
  "scanned?.contents.get", "parsePreparedChatGptImport", "parseSessionImport", "bytes.toString", "state.receipts.push", "this.writeState",
  "ensureAgentDirs", "path.join", "fs.writeFile", "persistImportedSession", "importSessionFile", "scanned?.configurations.get", "candidate.apply",
  "error.retainedAttachmentPaths.slice", "error.retainedAttachmentPaths.slice(0, 8).map", "JSON.stringify", "file.slice", "retained.join",
  "result.detail.slice", "fs.rm", "stagedPath.slice", "result.detail?.slice", "fs.readFile"
]);
function audit(node: ts.Node, file: ts.SourceFile): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(file)), `Unreviewed call: ${node.expression.getText(file)}`);
  if (ts.isNewExpression(node)) assert.ok(["Date", "Error"].includes(node.expression.getText(file)), `Unreviewed constructor: ${node.expression.getText(file)}`);
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) assert.fail("Imports cannot enter the extracted closure");
  ts.forEachChild(node, child => audit(child, file));
}
audit(execute, source); audit(importer, transfer);
const wrapper = importer.getText(transfer).replace(/^export\s+/u, "");
const extracted = `${wrapper}\nclass ExtractedService { ${execute.getText(source)} }\nglobalThis.ExtractedService = ExtractedService;`;
assert.equal(/constructor|require\s*\(|import\s*\(|process|setTimeout|setInterval/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);

type Format = "claude" | "codex" | "chatgpt";
type Category = "sessions" | "mcp";
type Status = "imported" | "skipped" | "failed" | "unknown";
interface Item { id: string; category: Category; label: string; sourceHash: string; digest: string; sourcePath?: string; conversationId?: string; configurationId?: string }
interface Preview { source: Format; label: string; items: Item[]; filePath?: string }
interface Result { id: string; category: Category; label: string; status: Status; detail?: string; sessionId?: string }
interface History { id: string; source: Format; label: string; time: string; workspaceRoot: string; results: Result[] }
interface Receipt { key: string; scope: string; status: "attempting" | "imported" | "skipped" | "unknown"; historyId: string; itemId: string; sessionId?: string }
interface State { history: History[]; receipts: Receipt[] }
interface Parsed { format: Format; text: string; token: number }
interface Imported { sessionId: string; skippedContentCount: number; attachmentsSkipped: number }
interface Scanned { preview: Preview; contents: Map<string, Buffer>; configurations: Map<string, { apply(): Promise<{ status: "imported" | "skipped" }> }>; preparedChatGpt?: { text: string } }
interface Service {
  stateRoot: string;
  configStore: { configPath(): string };
  scan(): Promise<Scanned>;
  writeState(state: State): Promise<void>;
  execute(state: State, preview: Preview, ids: string[], workspaceRoot: string, scanned?: Scanned, effects?: { mcpImported: boolean }): Promise<History>;
}
class CleanupError extends Error { retainedAttachmentPaths: string[] = []; }
const workspace = "/synthetic-import/workspace", sourcePath = "/synthetic-import/source.jsonl";
const checksum = (value: string): string => `digest(${value})`;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture(format: Format, options: { invalid?: boolean; persistenceFails?: boolean; admissionFails?: boolean; unavailable?: boolean; changed?: boolean; configuration?: boolean } = {}) {
  const trace: string[] = [], parsed: Parsed[] = [], persisted: Parsed[] = [], snapshots: State[] = [];
  const files = new Map<string, string>();
  const counts = { parses: 0, preparedParses: 0, stagedWrites: 0, stagedReads: 0, stagedRemoves: 0, mkdirs: 0, applies: 0 };
  const item: Item = { id: "selected", category: options.configuration ? "mcp" : "sessions", label: "selected", sourceHash: "pinned", digest: "content", sourcePath, conversationId: "conversation", configurationId: "configuration" };
  const preview: Preview = { source: format, label: "fixture", items: [item] };
  const current: Item = { ...item, sourceHash: options.changed ? "changed" : item.sourceHash };
  const scanned: Scanned = { preview: { ...preview, items: options.unavailable ? [] : [current] }, contents: new Map([[sourcePath, Buffer.from("pinned source")]]),
    configurations: new Map([["configuration", { apply: async () => { counts.applies++; trace.push("apply"); return { status: "imported" }; } }]]), preparedChatGpt: { text: "pinned source" } };
  const state: State = { history: [], receipts: [] };
  let sequence = 0;
  const parse = (text: string, selectedFormat: Format): Parsed => {
    counts.parses++; trace.push("parse");
    if (options.invalid) throw new Error("synthetic malformed source");
    const result: Parsed = { format: selectedFormat, text, token: parsed.length + 1 }; parsed.push(result); return result;
  };
  const persist = async (target: string, data: Parsed): Promise<Imported> => {
    assert.equal(target, workspace); trace.push("persist"); persisted.push(data);
    assert.equal(state.receipts.at(-1)?.status, "attempting");
    assert.equal(snapshots.at(-1)?.receipts.at(-1)?.status, "attempting", "admission must be published before persistence");
    if (options.persistenceFails) throw new Error("synthetic persistence rejection");
    return { sessionId: `new-session-${persisted.length}`, skippedContentCount: 0, attachmentsSkipped: 0 };
  };
  const context = createContext({ Buffer, Error, Date, JSON, maxReceipts: 4096, randomUUID: () => `id-${++sequence}`, digest: checksum,
    canonicalFuturePath: async (value: string) => value,
    parseSessionImport: (text: string, file: string, input: { format: Format; conversationId?: string }) => {
      assert.ok(file === sourcePath || file.startsWith("/synthetic-import/state/session-snapshot-")); assert.equal(input.conversationId, "conversation"); return parse(text, input.format);
    },
    parsePreparedChatGptImport: (data: { text: string }, id?: string) => { assert.equal(data, scanned.preparedChatGpt); assert.equal(id, "conversation"); counts.preparedParses++; return parse(data.text, "chatgpt"); },
    persistImportedSession: persist,
    ensureAgentDirs: async (value: string) => { assert.equal(value, workspace); counts.mkdirs++; trace.push("ensureDirs"); },
    SessionImportCleanupError: CleanupError,
    path: { join: (...parts: string[]) => parts.join("/") },
    fs: {
      writeFile: async (file: string, bytes: Buffer, flags: { flag: string; mode: number }) => { assert.ok(file.startsWith("/synthetic-import/state/session-snapshot-")); assert.equal(flags.flag, "wx"); assert.equal(flags.mode, 0o600); counts.stagedWrites++; files.set(file, bytes.toString("utf8")); },
      readFile: async (file: string, encoding: string) => { assert.equal(encoding, "utf8"); assert.ok(files.has(file)); counts.stagedReads++; return files.get(file)!; },
      rm: async (file: string, flags: { force: boolean }) => { assert.equal(flags.force, true); assert.ok(files.has(file)); counts.stagedRemoves++; files.delete(file); }
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  const Constructor = context.ExtractedService as new() => Service;
  const service = new Constructor(); service.stateRoot = "/synthetic-import/state"; service.configStore = { configPath: () => "/synthetic-import/config.json" };
  service.scan = async () => scanned;
  service.writeState = async value => { trace.push("writeState"); if (options.admissionFails) throw new Error("synthetic admission rejection"); snapshots.push(plain(value)); };
  const run = () => service.execute(state, preview, [item.id], workspace);
  const seedReceipt = (status: Receipt["status"]) => { const scope = checksum(`${format}\0${item.id}\0${workspace}`); state.receipts.push({ key: checksum(`${scope}\0${item.digest}`), scope, status, historyId: "previous", itemId: item.id, sessionId: "previous-session" }); };
  return { run, service, state, preview, scanned, counts, trace, parsed, persisted, snapshots, files, seedReceipt };
}

for (const format of ["claude", "codex", "chatgpt"] as const) {
  test(`${format}: reuse the validated object, parse once, and avoid temporary snapshot I/O`, async () => {
    const f = fixture(format); const result = await f.run();
    assert.equal(result.results[0]?.status, "imported"); assert.equal(result.results[0]?.sessionId, "new-session-1");
    assert.equal(f.counts.parses, 1); assert.equal(f.persisted.length, 1); assert.equal(f.persisted[0], f.parsed[0]);
    assert.equal(f.persisted[0]?.format, format); assert.equal(f.persisted[0]?.text, "pinned source");
    assert.equal(f.counts.preparedParses, format === "chatgpt" ? 1 : 0);
    assert.deepEqual([f.counts.stagedWrites, f.counts.stagedReads, f.counts.stagedRemoves], [0, 0, 0]);
    assert.equal(f.files.size, 0); assert.equal(f.state.receipts[0]?.status, "imported");
    assert.deepEqual(f.trace, ["parse", "writeState", "ensureDirs", "persist", "writeState"]);
  });
  test(`${format}: invalid input fails before receipt admission or destination work`, async () => {
    const f = fixture(format, { invalid: true }); const result = await f.run();
    assert.equal(result.results[0]?.status, "failed"); assert.equal(f.state.receipts.length, 0); assert.equal(f.snapshots.length, 0);
    assert.equal(f.persisted.length, 0); assert.equal(f.counts.mkdirs, 0); assert.equal(f.counts.stagedWrites, 0);
  });
  test(`${format}: persistence rejection is unknown and a repeat cannot reparse or retry`, async () => {
    const f = fixture(format, { persistenceFails: true }); const result = await f.run();
    assert.equal(result.results[0]?.status, "unknown"); assert.equal(f.state.receipts[0]?.status, "unknown");
    const before = { ...f.counts }; const again = await f.run();
    assert.equal(again.results[0]?.status, "unknown"); assert.deepEqual(f.counts, before); assert.equal(f.persisted.length, 1);
  });
}
for (const status of ["imported", "skipped", "unknown", "attempting"] as const) {
  test(`${status} receipt prevents parsing or replay`, async () => {
    const f = fixture("claude"); f.seedReceipt(status); const result = await f.run();
    assert.equal(result.results[0]?.status, status === "imported" || status === "skipped" ? "skipped" : "unknown");
    assert.equal(f.counts.parses, 0); assert.equal(f.persisted.length, 0); assert.equal(f.snapshots.length, 0);
  });
}
for (const problem of ["unavailable", "changed"] as const) {
  test(`${problem} source fails without parsing or admitting a receipt`, async () => {
    const f = fixture("codex", { [problem]: true }); const result = await f.run();
    assert.equal(result.results[0]?.status, "failed"); assert.equal(f.counts.parses, 0); assert.equal(f.state.receipts.length, 0);
  });
}
test("admission failure cannot invoke destination persistence", async () => {
  const f = fixture("claude", { admissionFails: true }); await assert.rejects(f.run(), /synthetic admission rejection/u);
  assert.equal(f.persisted.length, 0); assert.equal(f.counts.mkdirs, 0); assert.equal(f.counts.stagedWrites, 0);
});
test("configuration still uses its apply boundary, without session parsing", async () => {
  const f = fixture("claude", { configuration: true }); const effects = { mcpImported: false };
  const result = await f.service.execute(f.state, f.preview, ["selected"], workspace, f.scanned, effects);
  assert.equal(result.results[0]?.status, "imported"); assert.equal(f.counts.applies, 1); assert.equal(f.counts.parses, 0);
  assert.equal(f.persisted.length, 0); assert.equal(effects.mcpImported, true);
});
test("prepared object remains pinned while admission awaits and scanned source changes", async () => {
  const f = fixture("codex"); let resume!: () => void; let entered!: () => void;
  const pending = new Promise<void>(resolve => { resume = resolve; }); const admitted = new Promise<void>(resolve => { entered = resolve; });
  const write = f.service.writeState.bind(f.service); let first = true;
  f.service.writeState = async state => { await write(state); if (first) { first = false; entered(); await pending; } };
  const running = f.run(); await admitted;
  f.scanned.contents.set(sourcePath, Buffer.from("replacement source"));
  resume(); const result = await running;
  assert.equal(result.results[0]?.status, "imported"); assert.equal(f.persisted[0]?.text, "pinned source");
  assert.equal(f.persisted[0], f.parsed[0]); assert.equal(f.counts.parses, 1);
});
