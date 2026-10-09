import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";

const schemaQuery = "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('memory_embeddings', 'memory_embedding_versions', 'memories')";

async function fixture(run: (root: string, file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-readonly-cleanup-"));
  try { await run(root, path.join(root, "agent.sqlite")); }
  finally { await rm(root, { recursive: true, force: true }); }
}

await test("repeated corrupt read-only opens close every failed schema probe without changing bytes", async (t) => {
  await fixture(async (root, file) => {
    const bytes = Buffer.from("synthetic corrupt SQLite header\n");
    await writeFile(file, bytes);
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalClose = DatabaseSync.prototype.close;
    const probed: DatabaseSync[] = [];
    const closed: DatabaseSync[] = [];
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql === schemaQuery) probed.push(this);
      return originalPrepare.call(this, sql);
    });
    t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
      closed.push(this);
      originalClose.call(this);
    });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        assert.throws(() => MemoryVectorIndex.openReadOnly(root), /file is not a database/u);
      }
      assert.equal(probed.length, 4);
      assert.deepEqual(closed, probed, "a failed factory must release each constructed connection");
      for (const database of probed) assert.throws(() => originalPrepare.call(database, "SELECT 1"), /not open/u);
      assert.deepEqual(await readFile(file), bytes);
      assert.deepEqual(await readdir(root), ["agent.sqlite"]);
    } finally {
      t.mock.restoreAll();
      // A red regression must not leak its own fixture handles.
      for (const database of probed) { try { originalClose.call(database); } catch { /* Already closed. */ } }
    }
  });
});

await test("schema errors retain their identity even if cleanup also reports a failure", async (t) => {
  await fixture(async (root, file) => {
    const setup = new DatabaseSync(file);
    setup.close();
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalClose = DatabaseSync.prototype.close;
    const primary = new Error("synthetic schema inspection failure");
    const cleanup = new Error("synthetic close failure after releasing handle");
    const opened: DatabaseSync[] = [];
    let closes = 0;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql === schemaQuery) { opened.push(this); throw primary; }
      return originalPrepare.call(this, sql);
    });
    t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
      closes++;
      originalClose.call(this);
      throw cleanup;
    });
    try {
      assert.throws(() => MemoryVectorIndex.openReadOnly(root), (error: unknown) => error === primary);
      assert.equal(closes, 1);
      assert.equal(opened.length, 1);
      assert.throws(() => originalPrepare.call(opened[0]!, "SELECT 1"), /not open/u);
    } finally {
      t.mock.restoreAll();
      for (const database of opened) { try { originalClose.call(database); } catch { /* Already closed. */ } }
    }
  });
});

await test("missing database and absent vector schema remain undefined without creating or upgrading files", async (t) => {
  await fixture(async (root, file) => {
    assert.equal(MemoryVectorIndex.openReadOnly(root), undefined);
    assert.deepEqual(await readdir(root), []);
    const setup = new DatabaseSync(file);
    setup.exec("CREATE TABLE unrelated (value TEXT)");
    setup.close();
    const before = await readFile(file);
    const originalClose = DatabaseSync.prototype.close;
    let closes = 0;
    t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) { closes++; originalClose.call(this); });
    assert.equal(MemoryVectorIndex.openReadOnly(root), undefined);
    assert.equal(closes, 1);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(root), ["agent.sqlite"]);
  });
});

await test("a valid read-only schema transfers the open connection to its caller", async (t) => {
  await fixture(async (root, file) => {
    // Only this owned fixture is created. The production factory must remain read-only.
    const setup = new DatabaseSync(file);
    setup.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, revision INTEGER); CREATE TABLE memory_embeddings (memory_id TEXT, embedding BLOB); CREATE TABLE memory_embedding_versions (memory_id TEXT PRIMARY KEY, revision INTEGER); CREATE TABLE memory_metadata (key TEXT PRIMARY KEY, value TEXT)");
    setup.close();
    const before = await readFile(file);
    const originalClose = DatabaseSync.prototype.close;
    let closes = 0;
    t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) { closes++; originalClose.call(this); });
    const index = MemoryVectorIndex.openReadOnly(root);
    try {
      assert.ok(index);
      assert.equal(closes, 0, "successful opening does not release caller ownership");
      assert.deepEqual(index.status(), {});
      assert.equal(index.storedModelId(), null);
    } finally { index?.close(); }
    assert.equal(closes, 1);
    index?.close();
    assert.equal(closes, 1, "explicit repeated close remains idempotent");
    assert.throws(() => index?.status(), /closed/u);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(root), ["agent.sqlite"]);
  });
});
