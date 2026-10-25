import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";
import { RuntimeHostEventJournal, type RuntimeHostJournalRecord } from "../src/runtime/host/journal.js";

const snapshot = { revision: 0, info: {}, permissionMode: "ask", state: { kind: "idle" } } as AgentRuntimeUpdate["snapshot"];
const preview = (sequence: number, html: string, runId = "run"): RuntimeHostJournalRecord => ({ sequence, update: {
  snapshot, event: { type: "tool.input", sessionId: "session", runId, toolCallId: "widget", tool: "WidgetRenderer",
    timestamp: "2026-10-22T00:00:00.000Z", args: { title: `Preview ${sequence}`, html } }
} });
const args = (record: RuntimeHostJournalRecord | undefined) => record?.update.event?.type === "tool.input"
  ? record.update.event.args : undefined;

function append(history: RuntimeHostJournalRecord[], record: RuntimeHostJournalRecord, limit: number): void {
  const event = record.update.event;
  if (event?.type === "tool.input") {
    const previous = history.findLastIndex(row => row.update.event?.type === "tool.input"
      && row.update.event.sessionId === event.sessionId && row.update.event.runId === event.runId
      && row.update.event.toolCallId === event.toolCallId);
    const row = history[previous];
    if (row?.update.event?.type === "tool.input") history[previous] = {
      ...row, update: { ...row.update, event: { ...row.update.event, args: {} } }
    };
  }
  history.push(record);
  if (history.length > limit) history.splice(0, history.length - limit);
}

test("growing Widget previews append bounded deltas and reopen as one complete latest preview", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-widget-journal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "events.jsonl");
  const journal = new RuntimeHostEventJournal(file, 4000);
  t.after(() => journal.close());
  await journal.initialize();
  const history = Array.from({ length: 1000 }, (_, index) => ({ sequence: index + 1, update: {
    snapshot, event: { type: "assistant.delta" as const, sessionId: "session", runId: "old", timestamp: "now", content: "x".repeat(1024) }
  } }));
  await journal.persist(1000, () => history);
  const initialBytes = (await fs.stat(file)).size;
  const rename = t.mock.method(fs, "rename");
  let html = "<main>";
  for (let index = 1; index <= 100; index++) {
    html += `<p>${"内容🙂".repeat(128)}</p>`;
    const row = preview(1000 + index, html);
    append(history, row, 4000);
    await journal.persist(row.sequence, () => history);
  }
  assert.equal(rename.mock.callCount(), 0, "previews must not atomically rewrite unrelated history");
  assert.ok((await fs.stat(file)).size - initialBytes < Buffer.byteLength(html) + 100 * 1024,
    "disk growth must track the generated HTML and event metadata, not every full prefix");
  const reopened = new RuntimeHostEventJournal(file, 4000);
  const loaded = await reopened.initialize();
  assert.equal(loaded.sequence, 1100);
  assert.deepEqual(loaded.records.map(row => row.sequence), Array.from({ length: 1100 }, (_, index) => index + 1));
  assert.deepEqual(args(loaded.records[1000]), {});
  assert.deepEqual(args(loaded.records.at(-1)), { title: "Preview 1100", html });
  assert.equal(reopened.status(1100).state, "healthy");
  await reopened.close();
});

test("HTML tail correction, metadata changes, run isolation and checkpoints round-trip", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-widget-roundtrip-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "events.jsonl");
  let journal = new RuntimeHostEventJournal(file, 5);
  t.after(() => journal.close());
  await journal.initialize();
  const history: RuntimeHostJournalRecord[] = [];
  const rows = [preview(1, "<p>🙂旧内容</p>"), preview(2, "<p>🙂修正</p>"), preview(3, "Other run", "other"),
    preview(4, "<p>🙂"), preview(5, "<p>🙂完整</p>"), preview(6, "<p>🙂完整</p><footer>Done</footer>")];
  for (const row of rows) {
    append(history, row, 5);
    await journal.persist(row.sequence, () => history);
    if (row.sequence === 4) {
      await journal.close();
      journal = new RuntimeHostEventJournal(file, 5);
      const loaded = await journal.initialize();
      assert.deepEqual(args(loaded.records[0]), {});
      assert.deepEqual(args(loaded.records[1]), {});
      assert.deepEqual(args(loaded.records[2]), { title: "Preview 3", html: "Other run" });
      assert.deepEqual(args(loaded.records[3]), { title: "Preview 4", html: "<p>🙂" });
    }
  }
  const reopened = new RuntimeHostEventJournal(file, 5);
  const loaded = await reopened.initialize();
  assert.deepEqual(loaded.records.map(row => row.sequence), [2, 3, 4, 5, 6]);
  assert.deepEqual(args(loaded.records[1]), { title: "Preview 3", html: "Other run" });
  assert.deepEqual(args(loaded.records[3]), {});
  assert.deepEqual(args(loaded.records[4]), { title: "Preview 6", html: "<p>🙂完整</p><footer>Done</footer>" });
  assert.equal(reopened.status(6).state, "healthy");
  await reopened.close();
});

test("bad delta baselines and payloads invalidate replay without losing the sequence high-water", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-widget-corrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.jsonl");
  const journal = new RuntimeHostEventJournal(source, 10);
  await journal.initialize();
  const history = [preview(1, "<p>First</p>")];
  await journal.persist(1, () => history);
  append(history, preview(2, "<p>First</p><p>Second</p>"), 10);
  await journal.persist(2, () => history);
  await journal.close();
  const lines = (await fs.readFile(source, "utf8")).trim().split("\n");
  const mutations = [
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.baseSequence = 0; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.baseSequence = 2; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.prefixLength = -1; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.prefixLength = 1000; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.prefixLength = 0.5; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.suffix = null; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.update.event.sessionId = "other"; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.update.event.runId = "other"; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.update.event.toolCallId = "other"; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.update.event.tool = "Bash"; },
    (row: ReturnType<typeof JSON.parse>) => { row.widgetPreview.update.event.args.html = "Conflicting body"; }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const row = JSON.parse(lines[1]!);
    mutate(row);
    const file = path.join(root, `corrupt-${index}.jsonl`);
    await fs.writeFile(file, `${lines[0]}\n${JSON.stringify(row)}\n`);
    const reader = new RuntimeHostEventJournal(file, 10);
    assert.deepEqual(await reader.initialize(), { sequence: 2, records: [] });
    assert.equal(reader.status(2).state, "degraded");
    await reader.persist(3, () => [preview(3, "Repaired")]);
    assert.deepEqual(reader.status(3), { state: "healthy", sequence: 3, persistedSequence: 3 });
    await reader.close();
    const repaired = new RuntimeHostEventJournal(file, 10);
    assert.deepEqual((await repaired.initialize()).records, [preview(3, "Repaired")]);
    await repaired.close();
  }
  const missingBase = path.join(root, "missing-base.jsonl");
  await fs.writeFile(missingBase, `${lines[1]}\n`);
  const reader = new RuntimeHostEventJournal(missingBase, 10);
  assert.deepEqual(await reader.initialize(), { sequence: 2, records: [] });
  assert.equal(reader.status(2).state, "degraded");
  await reader.close();
});

test("failed preview append repairs from the current window and close drains queued previews", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-widget-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "journal");
  const file = path.join(directory, "events.jsonl");
  const journal = new RuntimeHostEventJournal(file, 5);
  t.after(() => journal.close());
  await journal.initialize();
  const history = [preview(1, "First")];
  await journal.persist(1, () => history);
  const moved = path.join(root, "saved");
  await fs.rename(directory, moved);
  await fs.writeFile(directory, "Block journal path");
  append(history, preview(2, "First failed append"), 5);
  await journal.persist(2, () => history);
  assert.equal(journal.status(2).state, "degraded");
  assert.equal(journal.status(2).persistedSequence, 1);
  await fs.unlink(directory);
  await fs.rename(moved, directory);
  append(history, preview(3, "First recovered"), 5);
  await journal.persist(3, () => history);
  assert.deepEqual(journal.status(3), { state: "healthy", sequence: 3, persistedSequence: 3 });
  const repaired = new RuntimeHostEventJournal(file, 5);
  const repairedRows = (await repaired.initialize()).records;
  assert.deepEqual(repairedRows.map(row => row.sequence), [1, 2, 3]);
  assert.deepEqual(repairedRows.map(row => args(row)), [{}, {}, { title: "Preview 3", html: "First recovered" }]);
  await repaired.close();

  // Gate the real filesystem append while later previews supersede and evict queued inputs.
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const originalAppend = fs.appendFile;
  const appendFile = t.mock.method(fs, "appendFile", async (...parameters: Parameters<typeof fs.appendFile>) => {
    entered();
    await gate;
    return originalAppend(...parameters);
  });
  try {
    append(history, preview(4, "First recovered four"), 5);
    void journal.persist(4, () => history);
    await writing;
    for (let sequence = 5; sequence <= 12; sequence++) {
      append(history, preview(sequence, `Preview ${sequence}`), 5);
      void journal.persist(sequence, () => history);
    }
    let closed = false;
    const closing = journal.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, "close cannot pass a blocked journal write");
    release();
    await closing;
    assert.deepEqual(journal.status(12), { state: "healthy", sequence: 12, persistedSequence: 12 });
    const reopened = new RuntimeHostEventJournal(file, 5);
    const loaded = await reopened.initialize();
    assert.deepEqual(loaded.records.map(row => row.sequence), [8, 9, 10, 11, 12]);
    assert.deepEqual(loaded.records.slice(0, -1).map(row => args(row)), [{}, {}, {}, {}]);
    assert.deepEqual(args(loaded.records.at(-1)), { title: "Preview 12", html: "Preview 12" });
    assert.equal(reopened.status(12).state, "healthy");
    await reopened.close();
  } finally { release(); appendFile.mock.restore(); await journal.close(); }
});
