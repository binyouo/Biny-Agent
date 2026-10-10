/** Derived SQLite initialization failures release their unassigned connections. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { LocalReferenceGraph, LocalReferenceService } from "../src/session/localReferences.js";
import { TemporalMemoryIndex } from "../src/session/temporalMemory.js";

interface Owner { read(): Promise<unknown[]>; close(): void }
interface Subject {
  name: string;
  file: string;
  incompatibleSchema: string;
  missingColumn: RegExp;
  schemaMarker: string;
  create(root: string): Owner;
}

const subjects: Subject[] = [
  {
    name: "temporal memory", file: "temporal-memory.sqlite",
    incompatibleSchema: "CREATE TABLE temporal_clues(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,session_id TEXT NOT NULL,message_id TEXT NOT NULL,expression TEXT NOT NULL,end_date TEXT,time TEXT,offset INTEGER NOT NULL,quote TEXT NOT NULL,ignored INTEGER NOT NULL DEFAULT 0)",
    missingColumn: /no such column: date/u,
    schemaMarker: "CREATE TABLE IF NOT EXISTS temporal_sources",
    create(root) {
      const index = new TemporalMemoryIndex(root);
      return {
        read: async () => index.queryClues({ startDate: "2026-10-01", endDate: "2026-10-02" }).clues,
        close: () => index.close()
      };
    }
  },
  {
    name: "local reference graph", file: "local-references.sqlite",
    incompatibleSchema: "CREATE TABLE ref_links(project_id TEXT NOT NULL,source_uri TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(project_id,source_uri,kind))",
    missingColumn: /no such column: target_uri/u,
    schemaMarker: "CREATE TABLE IF NOT EXISTS ref_links",
    create(root) {
      const service = new LocalReferenceService({ root, projects: [] });
      const graph = new LocalReferenceGraph(root, service);
      // No pins exist: this public read does not resolve any project, session, or user object.
      return { read: () => graph.pins("synthetic-project"), close: () => graph.close() };
    }
  }
];

const initPragmas = "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON";

async function fixture(t: TestContext, subject: Subject, seed: "healthy" | "corrupt" | "incompatible", run: (f: {
  createOwner(): Owner;
  opened: DatabaseSync[];
  closed: DatabaseSync[];
  schemaFailure?: Error;
  closeFailure?: Error;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-derived-init-cleanup-"));
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  const owners: Owner[] = [];
  const opened: DatabaseSync[] = [];
  const closed: DatabaseSync[] = [];
  const f = {
    opened, closed,
    schemaFailure: undefined as Error | undefined,
    closeFailure: undefined as Error | undefined,
    createOwner(): Owner {
      const owner = subject.create(root);
      owners.push(owner);
      return owner;
    }
  };
  try {
    const file = path.join(root, subject.file);
    if (seed === "corrupt") await writeFile(file, "synthetic corrupt SQLite header\n");
    if (seed === "incompatible") {
      const setup = new DatabaseSync(file);
      try { setup.exec(subject.incompatibleSchema); } finally { setup.close(); }
    }
    // Observe actual connections before the first operation can fail. Do not mock construction.
    t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === initPragmas) opened.push(this);
      if (opened.includes(this) && f.schemaFailure && sql.includes(subject.schemaMarker)) throw f.schemaFailure;
      return originalExec.call(this, sql);
    });
    t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
      const tracked = opened.includes(this);
      if (tracked) closed.push(this);
      originalClose.call(this);
      if (tracked && f.closeFailure) throw f.closeFailure;
    });
    await run(f);
  } finally {
    // Restore first; a red assertion must not leak either retained or unassigned fixture handles.
    t.mock.restoreAll();
    try {
      for (const owner of owners) {
        try { owner.close(); } catch { /* Captured handles are released below. */ }
      }
      for (const database of opened) if (database.isOpen) originalClose.call(database);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

// Top-level awaits keep prototype instrumentation serial. Each failure stage is independently visible.
for (const subject of subjects) {
  for (const seed of ["corrupt", "incompatible"] as const) {
    await test(`${subject.name}: repeated ${seed} initialization releases each connection`, async (t) => {
      await fixture(t, subject, seed, async (f) => {
        const owner = f.createOwner();
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(owner.read(), seed === "corrupt" ? /file is not a database/u : subject.missingColumn);
          assert.equal(f.opened.length, attempt + 1, "a failed initialization must not retain an assigned connection");
          assert.equal(new Set(f.opened).size, attempt + 1, "each retry constructs a new owned connection");
          assert.deepEqual(f.closed, f.opened, "initialization releases its handle before returning the failure");
          for (const database of f.opened) assert.equal(database.isOpen, false);
          owner.close();
          assert.deepEqual(f.closed, f.opened, "caller finally/close does not double-close a failed initialization");
        }
      });
    });
  }

  await test(`${subject.name}: initialization error keeps its identity when close also reports failure`, async (t) => {
    await fixture(t, subject, "healthy", async (f) => {
      const primary = new Error("synthetic initialization failure");
      f.schemaFailure = primary;
      f.closeFailure = new Error("synthetic close failure after releasing handle");
      const owner = f.createOwner();
      await assert.rejects(owner.read(), (error: unknown) => error === primary);
      assert.equal(f.opened.length, 1);
      assert.deepEqual(f.closed, f.opened, "cleanup was actually attempted once");
      assert.equal(f.opened[0]!.isOpen, false);
      owner.close();
      assert.equal(f.closed.length, 1, "failed initialization never transfers ownership to the caller");
    });
  });

  await test(`${subject.name}: healthy reads reuse their connection until that owner explicitly closes`, async (t) => {
    await fixture(t, subject, "healthy", async (f) => {
      const first = f.createOwner();
      assert.deepEqual(await first.read(), []);
      assert.deepEqual(await first.read(), []);
      assert.equal(f.opened.length, 1);
      assert.equal(f.closed.length, 0);
      const peer = f.createOwner();
      assert.deepEqual(await peer.read(), []);
      assert.equal(f.opened.length, 2);
      assert.notEqual(f.opened[0], f.opened[1]);
      for (const database of f.opened) assert.equal(database.isOpen, true);
      first.close();
      first.close();
      assert.deepEqual(f.closed, [f.opened[0]], "explicit repeated close is idempotent and owner-scoped");
      assert.equal(f.opened[0]!.isOpen, false);
      assert.equal(f.opened[1]!.isOpen, true);
      assert.deepEqual(await peer.read(), []);
      assert.equal(f.opened.length, 2, "closing another owner does not force the retained owner to reopen");
      peer.close();
      assert.deepEqual(f.closed, f.opened);
      for (const database of f.opened) assert.equal(database.isOpen, false);
    });
  });
}
