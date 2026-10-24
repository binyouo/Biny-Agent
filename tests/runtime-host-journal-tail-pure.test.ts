import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Product files are read as text only. All evaluated journal I/O is synthetic.
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(`../src/runtime/host/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}
function declaration(ast: ts.SourceFile, name: string): ts.Statement {
  const item = ast.statements.find(node => (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(ast) === name));
  assert.ok(item, name);
  return item;
}
const journalSource = source("journal.ts"), protocolSource = source("protocol.ts");
const owner = declaration(journalSource, "RuntimeHostEventJournal");
assert.ok(ts.isClassDeclaration(owner));
// Native strip mode cannot erase constructor parameter properties. Keep every
// actual field and method, and supply those two inert parameters explicitly.
const members = owner.members.filter(member => !ts.isConstructorDeclaration(member)).map(member => member.getText(journalSource));
const selected = [
  ...["journalFailureMessage", "previewKey", "widgetArgs"].map(name => declaration(journalSource, name).getText(journalSource)),
  ...["isRuntimeUpdate", "isSnapshot", "asRecord"].map(name => declaration(protocolSource, name).getText(protocolSource).replace(/^export /, "")),
  `class Journal { constructor(filePath, historyLimit) { this.filePath = filePath; this.historyLimit = historyLimit; } ${members.join("\n")} }`
].join("\n");
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node));
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  if (ts.isIdentifier(node)) assert.ok(!["process", "require", "fetch", "eval", "Function"].includes(node.text));
  ts.forEachChild(node, audit);
}
audit(ts.createSourceFile("selected.ts", selected, ts.ScriptTarget.Latest, true));
const javascript = stripTypeScriptTypes(selected, { mode: "strip" });
interface Row { sequence: number; update: { snapshot: object; event?: { type: string; sessionId: string; runId: string; toolCallId: string; tool: string; timestamp: string; args: Record<string, unknown> } } }
interface Journal {
  initialize(): Promise<{ sequence: number; records: Row[] }>;
  persist(sequence: number, history: () => readonly Row[], rewrite?: boolean): Promise<void>;
  close(): Promise<void>;
  status(sequence: number): { state: string; sequence: number; persistedSequence: number };
}
function harness(text: string, limit = 100) {
  const disk = { text, appends: 0, rewrites: 0, failRewrite: false, failAppend: false, rewriteGate: undefined as Promise<void> | undefined };
  const Constructor = runInNewContext(`${javascript}\nJournal`, {
    fs: {
      mkdir: async () => undefined,
      readFile: async () => disk.text,
      appendFile: async (_file: string, content: string) => {
        disk.appends++;
        if (disk.failAppend) {
          disk.text += content.slice(0, Math.floor(content.length / 2));
          throw new Error("Synthetic partial append failure");
        }
        disk.text += content;
      }
    },
    path: { dirname: () => "/synthetic" },
    writeRuntimeHostJournalAtomically: async (_file: string, content: string) => {
      disk.rewrites++;
      await disk.rewriteGate;
      if (disk.failRewrite) throw new Error("Synthetic atomic replacement failure");
      disk.text = content;
    }
  }, { timeout: 1_000 }) as new (file: string, limit: number) => Journal;
  return { disk, create: () => new Constructor("/synthetic/journal.jsonl", limit) };
}
const snapshot = { revision: 0, info: {}, permissionMode: "ask", state: { kind: "idle" } };
function preview(sequence: number, html: string): Row {
  return { sequence, update: { snapshot, event: { type: "tool.input", sessionId: "session", runId: "run", toolCallId: "widget", tool: "WidgetRenderer", timestamp: "synthetic", args: { html } } } };
}
function append(history: Row[], row: Row, limit = 100): void {
  if (row.update.event) {
    let previous = -1;
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index]?.update.event?.toolCallId === row.update.event.toolCallId) { previous = index; break; }
    }
    const old = history[previous];
    if (old?.update.event) history[previous] = { ...old, update: { ...old.update, event: { ...old.update.event, args: {} } } };
  }
  history.push(row);
  if (history.length > limit) history.splice(0, history.length - limit);
}
async function assertLatest(h: ReturnType<typeof harness>, sequence: number, html?: string, sequences?: number[]): Promise<void> {
  const reader = h.create(), loaded = await reader.initialize();
  assert.equal(loaded.sequence, sequence);
  assert.equal(reader.status(sequence).state, "healthy");
  if (html !== undefined) assert.equal(loaded.records.at(-1)?.update.event?.args.html, html);
  assert.equal(loaded.records.at(-1)?.sequence, sequence);
  if (sequences) assert.deepEqual(Array.from(loaded.records, row => row.sequence), sequences);
}

for (const ending of ["", "\r", "  "]) {
  test(`complete base without LF preserves replay and normalizes before append (${JSON.stringify(ending)})`, async () => {
    const original = JSON.stringify(preview(1, "A")) + ending;
    const h = harness(original), writer = h.create();
    const loaded = await writer.initialize();
    assert.equal(loaded.records[0]?.update.event?.args.html, "A");
    assert.equal(writer.status(1).state, "healthy");
    assert.equal(h.disk.text, original, "initialize stays read-only");
    await writer.persist(1, () => loaded.records);
    assert.equal(h.disk.rewrites + h.disk.appends, 0, "no-op persist must not mutate disk");
    append(loaded.records, preview(2, "AB"));
    await writer.persist(2, () => loaded.records);
    assert.equal(h.disk.rewrites, 1);
    assert.equal(h.disk.appends, 0);
    await assertLatest(h, 2, "AB", [1, 2]);
    append(loaded.records, preview(3, "ABC"));
    await writer.persist(3, () => loaded.records);
    assert.equal(h.disk.rewrites, 1, "normalization happens once");
    assert.equal(h.disk.appends, 1);
    await assertLatest(h, 3, "ABC", [1, 2, 3]);
  });
}

test("complete non-widget record without LF retains its high-water", async () => {
  const row: Row = { sequence: 41, update: { snapshot } };
  const h = harness(JSON.stringify(row)), writer = h.create();
  const loaded = await writer.initialize();
  loaded.records.push({ sequence: 42, update: { snapshot } });
  await writer.persist(42, () => loaded.records);
  await assertLatest(h, 42, undefined, [41, 42]);
});

test("complete delta without LF is restored before its next atomic checkpoint", async () => {
  const h = harness(JSON.stringify(preview(1, "🙂A")) + "\n");
  let writer = h.create();
  let loaded = await writer.initialize();
  append(loaded.records, preview(2, "🙂AB"));
  await writer.persist(2, () => loaded.records);
  assert.match(h.disk.text, /"widgetPreview"/);
  h.disk.text = h.disk.text.slice(0, -1);
  writer = h.create(); loaded = await writer.initialize();
  assert.equal(loaded.sequence, 2);
  assert.equal(loaded.records.at(-1)?.update.event?.args.html, "🙂AB");
  append(loaded.records, preview(3, "🙂ABC"));
  await writer.persist(3, () => loaded.records);
  assert.equal(h.disk.rewrites, 1);
  await assertLatest(h, 3, "🙂ABC", [1, 2, 3]);
});

test("normal LF and repeated initialization keep ordinary delta appends", async () => {
  const h = harness(JSON.stringify(preview(1, "A")) + "\n"), writer = h.create();
  await writer.initialize();
  const loaded = await writer.initialize();
  append(loaded.records, preview(2, "AB"));
  await writer.persist(2, () => loaded.records);
  await writer.persist(2, () => loaded.records);
  assert.equal(h.disk.rewrites, 0);
  assert.equal(h.disk.appends, 1);
  await assertLatest(h, 2, "AB", [1, 2]);
});

test("empty journal does not require normalization", async () => {
  const h = harness(""), writer = h.create();
  const loaded = await writer.initialize();
  assert.equal(loaded.sequence, 0);
  await writer.persist(1, () => [preview(1, "A")]);
  assert.equal(h.disk.rewrites, 0);
  assert.equal(h.disk.appends, 1);
  await assertLatest(h, 1, "A");
});

test("invalid partial tail still invalidates replay and repairs at known high-water", async () => {
  const h = harness(JSON.stringify(preview(7, "A")) + '\n{"sequence":8,"widgetPreview":'), writer = h.create();
  const loaded = await writer.initialize();
  assert.equal(loaded.sequence, 7);
  assert.equal(loaded.records.length, 0);
  assert.equal(writer.status(7).state, "degraded");
  await writer.persist(8, () => [preview(8, "Repaired")]);
  assert.equal(h.disk.rewrites, 1);
  await assertLatest(h, 8, "Repaired");
});

test("failed normalization preserves high-water and retries atomically", async () => {
  const original = JSON.stringify(preview(1, "A"));
  const h = harness(original), writer = h.create();
  const loaded = await writer.initialize();
  append(loaded.records, preview(2, "AB"));
  h.disk.failRewrite = true;
  await writer.persist(2, () => loaded.records);
  assert.equal(writer.status(2).state, "degraded");
  assert.equal(writer.status(2).persistedSequence, 1);
  assert.equal(h.disk.text, original);
  h.disk.failRewrite = false;
  await writer.persist(2, () => loaded.records);
  assert.equal(h.disk.rewrites, 2);
  assert.equal(h.disk.appends, 0);
  await assertLatest(h, 2, "AB", [1, 2]);
});

test("partial append failure retains existing atomic recovery", async () => {
  const h = harness(JSON.stringify(preview(1, "A")) + "\n"), writer = h.create();
  const loaded = await writer.initialize();
  append(loaded.records, preview(2, "AB")); h.disk.failAppend = true;
  await writer.persist(2, () => loaded.records);
  assert.equal(writer.status(2).state, "degraded");
  assert.equal(writer.status(2).persistedSequence, 1);
  append(loaded.records, preview(3, "ABC")); h.disk.failAppend = false;
  await writer.persist(3, () => loaded.records);
  assert.equal(h.disk.rewrites, 1);
  await assertLatest(h, 3, "ABC", [1, 2, 3]);
});

test("normalization composes with the existing count checkpoint and bounded history", async () => {
  const h = harness(JSON.stringify(preview(4, "A")), 5), writer = h.create();
  const loaded = await writer.initialize();
  for (let sequence = 5; sequence <= 11; sequence++) {
    append(loaded.records, preview(sequence, `Preview ${sequence}`), 5);
    await writer.persist(sequence, () => loaded.records);
  }
  assert.equal(h.disk.rewrites, 2);
  const recovered = await h.create().initialize();
  assert.equal(recovered.records.length, 5);
  assert.equal(recovered.records[0]?.sequence, 7);
  await assertLatest(h, 11, "Preview 11");
});

test("queued previews and close drain a blocked normalization", async () => {
  const h = harness(JSON.stringify(preview(1, "A"))), writer = h.create();
  const loaded = await writer.initialize();
  let release!: () => void;
  h.disk.rewriteGate = new Promise<void>(resolve => { release = resolve; });
  append(loaded.records, preview(2, "AB"));
  const first = writer.persist(2, () => loaded.records);
  for (let count = 0; count < 10; count++) await Promise.resolve();
  assert.equal(h.disk.rewrites, 1);
  append(loaded.records, preview(3, "ABC"));
  const second = writer.persist(3, () => loaded.records);
  let closed = false;
  const closing = writer.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); await Promise.all([first, second, closing]);
  assert.equal(closed, true);
  assert.equal(h.disk.rewrites, 1);
  assert.equal(h.disk.appends, 1);
  await assertLatest(h, 3, "ABC", [1, 2, 3]);
});
