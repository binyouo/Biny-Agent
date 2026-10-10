import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";

const fingerprint = "scoped-vector-fixture";
const dimensions = 4;
const ids = ["alpha-z", "beta-a", "alpha-a", "beta-z", "alpha-'quoted'", "beta-[json]", "中文", "alpha-last"];

async function fixture(run: (index: MemoryVectorIndex, database: DatabaseSync) => void): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-vector-scope-"));
  const database = new DatabaseSync(path.join(root, "agent.sqlite"));
  let index: MemoryVectorIndex | undefined;
  try {
    database.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, revision INTEGER, user_id TEXT)");
    for (const id of ids) database.prepare("INSERT INTO memories VALUES (?, 1, ?)").run(id, id.startsWith("alpha-") ? "alpha" : "beta");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM json_each(?)").get('["first","second"]')?.count, 2);
    index = new MemoryVectorIndex(root);
    index.replaceAll(fingerprint, dimensions, ids.map((entryId, offset) => ({
      entryId, revision: 1, embedding: Array.from({ length: dimensions }, (_, coordinate) => coordinate === offset % dimensions ? 1 : 0)
    })));
    run(index, database);
  } finally { index?.close(); database.close(); await rm(root, { recursive: true, force: true }); }
}

function measuredRead(t: TestContext, index: MemoryVectorIndex, options: Parameters<MemoryVectorIndex["listActiveEmbeddings"]>[0]) {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const measured = { calls: 0, rows: 0, blobBytes: 0, boundArguments: [] as number[] };
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith("SELECT memory_id, embedding FROM memory_embeddings")) {
      const originalAll = statement.all;
      t.mock.method(statement, "all", (...args: Parameters<typeof statement.all>) => {
        const rows = Reflect.apply(originalAll, statement, args) as Array<Record<string, unknown>>;
        measured.calls++;
        measured.rows += rows.length;
        measured.boundArguments.push(args.length);
        for (const row of rows) {
          assert.ok(row.embedding instanceof Uint8Array, "measure actual SQLite vector BLOB transfer");
          measured.blobBytes += row.embedding.byteLength;
        }
        return rows;
      });
    }
    return statement;
  });
  try { return { entries: index.listActiveEmbeddings(options), ...measured }; }
  finally { t.mock.restoreAll(); }
}

await test("subset scopes transfer only selected BLOBs and retain binary ID order and vectors", async (t) => {
  await fixture((index) => {
    const all = index.listActiveEmbeddings({ modelFingerprint: fingerprint });
    assert.deepEqual(all.map(({ entryId }) => entryId), [...ids].sort());
    const selected = new Set(["beta-z", "alpha-a", "alpha-a", "missing"]);
    const measured = measuredRead(t, index, { modelFingerprint: fingerprint, entryIds: selected });
    assert.deepEqual(measured.entries, all.filter(({ entryId }) => selected.has(entryId)));
    assert.deepEqual(measured.entries.map(({ entryId }) => entryId), ["alpha-a", "beta-z"]);
    assert.equal(measured.rows, 2);
    assert.equal(measured.blobBytes, 2 * dimensions * 4);
  });
});

await test("empty and nonexistent scopes transfer no vector BLOBs", async (t) => {
  await fixture((index) => {
    for (const entryIds of [new Set<string>(), new Set(["nonexistent"])]) {
      const measured = measuredRead(t, index, { modelFingerprint: fingerprint, entryIds });
      assert.deepEqual(measured.entries, []);
      assert.equal(measured.rows, 0);
      assert.equal(measured.blobBytes, 0);
    }
  });
});

await test("scopes preserve current-fact joins across namespaces and omit stale or removed facts", async (t) => {
  await fixture((index, database) => {
    database.prepare("UPDATE memories SET revision = 2 WHERE id = ?").run("alpha-z");
    database.prepare("DELETE FROM memories WHERE id = ?").run("beta-z");
    const scopes = [new Set(["alpha-a", "alpha-z"]), new Set(["beta-a", "beta-z"]), new Set(["alpha-a", "beta-a", "alpha-z", "beta-z"])];
    const all = index.listActiveEmbeddings({ modelFingerprint: fingerprint });
    assert.equal(all.length, ids.length - 2);
    for (const entryIds of scopes) {
      const expected = all.filter(({ entryId }) => entryIds.has(entryId));
      const measured = measuredRead(t, index, { modelFingerprint: fingerprint, entryIds });
      assert.deepEqual(measured.entries, expected);
      assert.equal(measured.rows, expected.length);
      assert.equal(measured.blobBytes, expected.length * dimensions * 4);
    }
  });
});

await test("unscoped output is unchanged and another model returns no vector rows", async (t) => {
  await fixture((index) => {
    const expected = ids.map((entryId, offset) => ({ entryId, embedding: Float32Array.from({ length: dimensions }, (_, coordinate) => coordinate === offset % dimensions ? 1 : 0) }))
      .sort((left, right) => left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0);
    const unscoped = measuredRead(t, index, { modelFingerprint: fingerprint });
    assert.deepEqual(unscoped.entries, expected);
    assert.equal(unscoped.rows, ids.length);
    assert.equal(unscoped.blobBytes, ids.length * dimensions * 4);
    const mismatch = measuredRead(t, index, { modelFingerprint: "other-model", entryIds: new Set(ids) });
    assert.deepEqual(mismatch.entries, []);
    assert.equal(mismatch.calls, 0);
    assert.equal(mismatch.blobBytes, 0);
  });
});

await test("large JSON scopes and quoted or Unicode IDs use fixed parameter count", async (t) => {
  await fixture((index) => {
    const selected = new Set([...Array.from({ length: 1200 }, (_, offset) => `absent-${offset}`), "alpha-'quoted'", "beta-[json]", "中文"]);
    const measured = measuredRead(t, index, { modelFingerprint: fingerprint, entryIds: selected });
    assert.deepEqual(measured.entries.map(({ entryId }) => entryId), ["alpha-'quoted'", "beta-[json]", "中文"]);
    assert.equal(measured.rows, 3);
    assert.equal(measured.blobBytes, 3 * dimensions * 4);
    assert.deepEqual(measured.boundArguments, [2]);
  });
});
