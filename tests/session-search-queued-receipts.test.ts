import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SessionSearchStore, sessionSearchDatabaseFileName } from "../src/session/searchIndexStore.js";

const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
const receipt = (content: string, queuedDelivery: "queue" | "steer") => ({
  type: "user_message", messageId: `${content}-receipt`, content, auditOnly: true, metadata: { queuedDelivery }
});

async function fixture(run: (index: SessionSearchStore, root: string, file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-queued-receipts-"));
  const index = new SessionSearchStore(root);
  try {
    const directory = path.join(root, "sessions", "project");
    await mkdir(directory, { recursive: true });
    await run(index, root, path.join(directory, "session.jsonl"));
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const delivery of ["queue", "steer"] as const) {
  test(`${delivery} admissions are absent until canonical delivery, without duplicate hits`, async () => {
    await fixture(async (index, _root, file) => {
      const original = line(receipt("withdrawnmarker", delivery)) + line(receipt("deliveredmarker", delivery));
      await writeFile(file, original);
      assert.equal(await index.indexSessionFile("session", file), 0);
      assert.equal(index.status().indexedMessages, 0);
      assert.equal(index.search("withdrawnmarker").length, 0);
      assert.equal(index.grep("withdrawnmarker").length, 0);
      const delivered = line({ type: "user_message", messageId: "canonical", content: "deliveredmarker" });
      await appendFile(file, delivered);
      assert.equal(await index.indexSessionFile("session", file), 1);
      assert.deepEqual(index.search("deliveredmarker").map(hit => hit.messageId), ["canonical"]);
      assert.deepEqual(index.grep("deliveredmarker").map(hit => hit.messageId), ["canonical"]);
      assert.equal(await readFile(file, "utf8"), original + delivered, "indexing never rewrites the authority");
    });
  });
}

test("hosted audit-only users and non-audit queued metadata remain conversational", async () => {
  await fixture(async (index, _root, file) => {
    const events = [
      { type: "user_message", messageId: "hosted", content: "hostedmarker", auditOnly: true },
      { type: "user_message", messageId: "other", content: "othermarker", auditOnly: true, metadata: { queuedDelivery: "other" } },
      { type: "user_message", messageId: "canonical", content: "canonicalmarker", metadata: { queuedDelivery: "queue" } },
      { type: "assistant_message", messageId: "assistant", content: "assistantmarker" }
    ];
    await writeFile(file, events.map(line).join(""));
    assert.equal(await index.indexSessionFile("session", file), events.length);
    for (const event of events) assert.equal(index.search(event.content)[0]?.messageId, event.messageId);
  });
});

test("receipt-only batches advance offsets and remain excluded across reopen and refresh", async () => {
  await fixture(async (index, root, file) => {
    await writeFile(file, Array.from({ length: 300 }, (_, i) => line(receipt(`auditmarker${i}`, "queue"))).join(""));
    assert.equal(await index.indexSessionFile("session", file), 0);
    assert.equal(await index.indexSessionFile("session", file), 0);
    const database = new DatabaseSync(path.join(root, "search", sessionSearchDatabaseFileName));
    try {
      assert.equal(database.prepare("SELECT byte_offset FROM session_index_state").get()?.byte_offset,
        Buffer.byteLength(await readFile(file, "utf8")));
    } finally { database.close(); }
    index.close();
    await index.refreshAll();
    assert.equal(index.status().indexedMessages, 0);
    await appendFile(file, line({ type: "user_message", content: "latestmarker", messageId: "latest" }));
    await index.refreshAll();
    assert.equal(index.search("latestmarker").length, 1);
    assert.equal(index.grep("auditmarker").length, 0);
    await index.forgetSession("session", { sourcePath: await realpath(file) });
    assert.equal(index.status().indexedMessages, 0);
  });
});

test("old v2 cache and its live writer cannot supply queued receipts to the new cache", async () => {
  await fixture(async (index, root, file) => {
    const raw = line(receipt("oldreceiptmarker", "queue"))
      + line({ type: "user_message", content: "canonicalmarker", messageId: "canonical" });
    await writeFile(file, raw);
    await mkdir(path.join(root, "search"), { recursive: true });
    const oldPath = path.join(root, "search", "sessions-v2.sqlite");
    const old = new DatabaseSync(oldPath);
    try {
      old.exec("CREATE TABLE session_index_state (source_path TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, byte_offset INTEGER NOT NULL, updated_at TEXT NOT NULL, source_dev INTEGER NOT NULL, source_ino INTEGER NOT NULL, source_size INTEGER NOT NULL, source_mtime_ms REAL NOT NULL);"
        + "CREATE TABLE transcript_rows (rowid INTEGER PRIMARY KEY, source_path TEXT NOT NULL);"
        + "CREATE VIRTUAL TABLE session_transcripts USING fts5(session_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, time UNINDEXED, body, tokens); PRAGMA user_version = 2;");
      const insert = old.prepare("INSERT INTO session_transcripts (session_id, message_id, role, body, tokens) VALUES ('session', ?, 'user', ?, ?)");
      const first = insert.run("old-receipt", "oldreceiptmarker", "oldreceiptmarker");
      old.prepare("INSERT INTO transcript_rows VALUES (?, ?)").run(first.lastInsertRowid, file);
      const oldBytes = await readFile(oldPath);
      assert.notEqual(sessionSearchDatabaseFileName, "sessions-v2.sqlite");
      assert.equal(index.search("oldreceiptmarker").length, 0);
      await index.refreshAll();
      assert.equal(index.search("canonicalmarker").length, 1);
      assert.equal(index.grep("oldreceiptmarker").length, 0);
      assert.deepEqual(await readFile(oldPath), oldBytes, "opening/refreshing v3 does not mutate the old cache");
      const next = insert.run("late-receipt", "lateauditmarker", "lateauditmarker");
      old.prepare("INSERT INTO transcript_rows VALUES (?, ?)").run(next.lastInsertRowid, file);
      assert.equal(index.search("lateauditmarker").length, 0, "an old live connection cannot contaminate v3");
      await index.forgetSession("session", { sourcePath: await realpath(file) });
      assert.equal(index.search("canonicalmarker").length, 0);
      assert.equal(old.prepare("SELECT count(*) AS count FROM session_transcripts").get()?.count, 2);
      assert.equal(await readFile(file, "utf8"), raw);
    } finally { old.close(); }
  });
});
