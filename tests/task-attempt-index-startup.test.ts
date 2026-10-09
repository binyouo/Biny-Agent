import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { agentDir, sessionFilePath } from "../src/session/store.js";

const indexName = "task_attempts_task_run_idx";
const createIndex = `CREATE INDEX IF NOT EXISTS ${indexName} ON task_attempts(task_run_id)`;
const originalExec = DatabaseSync.prototype.exec;
const originalPrepare = DatabaseSync.prototype.prepare;
const originalClose = DatabaseSync.prototype.close;
const currentTimeout = 137;
const noBackfill = { backfillLegacySessions: false } as const;

interface Fixture {
  root: string;
  databasePath: string;
  open(): Promise<RuntimeEventAuthority>;
  connect(): DatabaseSync;
}

async function fixture(run: (value: Fixture) => Promise<void>, seeded = true): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-optional-attempt-index-"));
  const root = path.join(directory, "workspace");
  await mkdir(root);
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(directory, "agent-state");
  const databasePath = path.join(agentDir(root), "runtime.sqlite");
  const authorities: RuntimeEventAuthority[] = [];
  const connections: DatabaseSync[] = [];
  const value: Fixture = {
    root,
    databasePath,
    async open() {
      const authority = await RuntimeEventAuthority.open(root, noBackfill);
      authorities.push(authority);
      return authority;
    },
    connect() {
      const database = new DatabaseSync(databasePath, { timeout: 0, enableForeignKeyConstraints: true });
      connections.push(database);
      return database;
    }
  };
  try {
    if (seeded) {
      const authority = await value.open();
      const tasks = await DurableTaskRunStore.open(root, authority);
      for (const taskRunId of ["", "任务/🦋", "ordinary"]) {
        tasks.create({ taskRunId, task: { text: taskRunId, nested: { evidence: true } } });
        for (let ordinal = 0; ordinal < 3; ordinal++) {
          tasks.createAttempt(taskRunId, {
            attemptId: `${taskRunId}:attempt:${ordinal}`,
            runId: `${taskRunId}:run:${ordinal}`,
            turnId: `${taskRunId}:turn:${ordinal}`
          });
        }
      }
      authority.databaseHandle().exec(`
        UPDATE task_attempts SET created_at = '2099-01-01T00:00:00.000Z', updated_at = '2099-01-01T00:00:00.000Z' WHERE rowid % 3 IN (1, 2);
        UPDATE task_attempts SET created_at = '1900-01-01T00:00:00.000Z', updated_at = '1900-01-01T00:00:00.000Z' WHERE rowid % 3 = 0;
        DROP INDEX IF EXISTS ${indexName};
      `);
      tasks.close();
      authority.close();
    }
    await run(value);
  } finally {
    for (const authority of authorities) authority.close();
    for (const database of connections) {
      try { originalClose.call(database); } catch { /* Some tests deliberately close the fixture connection early. */ }
    }
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function exec(database: DatabaseSync, sql: string): void { originalExec.call(database, sql); }
function prepare(database: DatabaseSync, sql: string): StatementSync { return originalPrepare.call(database, sql); }
function timeout(database: DatabaseSync): number { return Number(prepare(database, "PRAGMA busy_timeout").get()?.timeout); }
function schemaObject(database: DatabaseSync) {
  return prepare(database, "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = ?").get(indexName);
}
function snapshot(database: DatabaseSync) {
  const names = prepare(database, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
  return {
    tables: names.map(({ name }) => {
      assert.equal(typeof name, "string");
      const identifier = String(name).replaceAll('"', '""');
      return [name, prepare(database, `SELECT rowid AS fixture_rowid, * FROM "${identifier}" ORDER BY rowid`).all()];
    }),
    foreignKeys: prepare(database, "PRAGMA foreign_key_check").all()
  };
}
function assertIndex(database: DatabaseSync): void {
  const object = schemaObject(database);
  assert.equal(object?.type, "index");
  assert.equal(object?.tbl_name, "task_attempts");
  const description = prepare(database, "PRAGMA index_list(task_attempts)").all().find(row => row.name === indexName);
  assert.equal(description?.unique, 0);
  assert.equal(description?.partial, 0);
  const shape = prepare(database, `PRAGMA index_xinfo(${indexName})`).all().map(row => ({
    name: row.name, cid: row.cid, desc: row.desc, coll: row.coll, key: row.key
  }));
  assert.deepEqual(shape, [
    { name: "task_run_id", cid: 1, desc: 0, coll: "BINARY", key: 1 },
    { name: null, cid: -1, desc: 0, coll: "BINARY", key: 0 }
  ]);
}

interface Hooks {
  exec?(database: DatabaseSync, sql: string, proceed: () => void): void;
  prepare?(database: DatabaseSync, sql: string, proceed: () => StatementSync): StatementSync;
}
function instrument(t: TestContext, hooks: Hooks = {}, customTimeout = true) {
  const statements: string[] = [];
  const closed: Array<{ database: DatabaseSync; timeout: number }> = [];
  const execMock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string): void {
    statements.push(sql);
    const proceed = () => {
      originalExec.call(this, sql);
      if (customTimeout && /PRAGMA journal_mode/iu.test(sql)) exec(this, `PRAGMA busy_timeout = ${currentTimeout}`);
    };
    if (hooks.exec) hooks.exec(this, sql, proceed);
    else proceed();
  });
  const prepareMock = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string): StatementSync {
    statements.push(sql);
    const proceed = () => originalPrepare.call(this, sql);
    return hooks.prepare ? hooks.prepare(this, sql, proceed) : proceed();
  });
  const closeMock = t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync): void {
    closed.push({ database: this, timeout: timeout(this) });
    originalClose.call(this);
  });
  return {
    statements, closed,
    restore() { execMock.mock.restore(); prepareMock.mock.restore(); closeMock.mock.restore(); }
  };
}
function begins(statements: readonly string[]): string[] { return statements.filter(sql => /^BEGIN\b/iu.test(sql.trim())); }
function creates(statements: readonly string[]): string[] { return statements.filter(sql => /CREATE\s+(?:UNIQUE\s+)?INDEX/iu.test(sql) && sql.includes(indexName)); }
function sqliteError(errcode: unknown, code: unknown = "ERR_SQLITE_ERROR"): Error {
  return Object.assign(new Error("sentinel without lock-message dependence"), { code, errcode });
}
async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try { await action(); } catch (error) { return error; }
  assert.fail("Expected the exact startup failure to propagate.");
}
function assertClosedWithTimeout(observed: ReturnType<typeof instrument>, expected = currentTimeout): void {
  assert.equal(observed.closed.length, 1, "failed startup must close its connection once");
  assert.equal(observed.closed[0]?.timeout, expected, "timeout must be restored before close");
  assert.throws(() => prepare(observed.closed[0]!.database, "SELECT 1"), /not open|closed/iu);
}

test("fresh writable open installs the optional index in its sole schema transaction and emits no facts", async t => {
  await fixture(async f => {
    let indexRevision: number | undefined;
    const observed = instrument(t, {
      exec(database, sql, proceed) {
        if (creates([sql]).length) indexRevision = Number(prepare(database, "PRAGMA user_version").get()?.user_version);
        proceed();
      }
    }, false);
    const authority = await f.open();
    assert.equal(authority.schemaRevision(), 13);
    assertIndex(authority.databaseHandle());
    assert.deepEqual(authority.readEvents().events, []);
    assert.deepEqual(prepare(authority.databaseHandle(), "PRAGMA foreign_key_check").all(), []);
    assert.equal(timeout(authority.databaseHandle()), 5_000);
    assert.equal(indexRevision, 0, "the index must be created before the initial schema commits");
    assert.deepEqual(begins(observed.statements), ["BEGIN IMMEDIATE"]);
    assert.equal(creates(observed.statements).length, 1);
    assert.equal(observed.statements.filter(sql => /^COMMIT$/iu.test(sql)).length, 1);
    assert.equal(observed.statements.some(sql => /busy_timeout\s*=/iu.test(sql)), false);
    observed.restore();
  }, false);
});

for (const phase of ["before-create", "after-create", "commit"] as const) test(`fresh ${phase} failure rolls back the initial schema with the index`, async t => {
  await fixture(async f => {
    const expected = sqliteError(5);
    let indexAttempted = false;
    const observed = instrument(t, {
      exec(_database, sql, proceed) {
        if (creates([sql]).length) {
          indexAttempted = true;
          if (phase === "before-create") throw expected;
          if (phase === "after-create") { proceed(); throw expected; }
        }
        if (phase === "commit" && indexAttempted && /^COMMIT$/iu.test(sql)) throw expected;
        proceed();
      }
    }, false);
    assert.equal(await rejection(() => f.open()), expected);
    assert.equal(indexAttempted, true);
    assertClosedWithTimeout(observed, 5_000);
    const observer = f.connect();
    assert.equal(prepare(observer, "PRAGMA user_version").get()?.user_version, 0);
    assert.deepEqual(prepare(observer, "SELECT name FROM sqlite_schema").all(), []);
    assert.deepEqual(begins(observed.statements), ["BEGIN IMMEDIATE"]);
    assert.equal(observed.statements.filter(sql => /^ROLLBACK$/iu.test(sql)).length, 1);
    observed.restore();
  }, false);
});

test("fresh required BEGIN busy remains fatal without optional timeout changes or schema writes", async t => {
  await fixture(async f => {
    const expected = sqliteError(5);
    const observed = instrument(t, {
      exec(database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) {
          assert.equal(timeout(database), 5_000);
          throw expected;
        }
        proceed();
      }
    }, false);
    assert.equal(await rejection(() => f.open()), expected);
    assertClosedWithTimeout(observed, 5_000);
    const observer = f.connect();
    assert.equal(prepare(observer, "PRAGMA user_version").get()?.user_version, 0);
    assert.deepEqual(prepare(observer, "SELECT name FROM sqlite_schema").all(), []);
    assert.deepEqual(begins(observed.statements), ["BEGIN IMMEDIATE"]);
    assert.equal(observed.statements.some(sql => /busy_timeout\s*=|^COMMIT$|^ROLLBACK$/iu.test(sql)), false);
    observed.restore();
  }, false);
});

test("partial revision 0 rejects an inherited NOCASE index before committing any initial schema", async t => {
  await fixture(async f => {
    await mkdir(path.dirname(f.databasePath), { recursive: true });
    const observer = f.connect();
    exec(observer, `
      CREATE TABLE task_runs (task_run_id TEXT PRIMARY KEY);
      CREATE TABLE task_attempts (attempt_id TEXT PRIMARY KEY, task_run_id TEXT COLLATE NOCASE REFERENCES task_runs(task_run_id), run_id TEXT);
      INSERT INTO task_runs VALUES ('任务/🦋');
      INSERT INTO task_attempts VALUES ('fixture-attempt', '任务/🦋', 'fixture-run');
    `);
    const before = snapshot(observer);
    const beforeSchema = prepare(observer, "SELECT * FROM sqlite_schema ORDER BY name").all();
    const observed = instrument(t, {}, false);
    const error = await rejection(() => f.open());
    assert.ok(error instanceof Error);
    assert.equal(error.message, `Optional task-attempt index ${indexName} has an incompatible definition.`);
    assertClosedWithTimeout(observed, 5_000);
    assert.equal(schemaObject(observer), undefined, "an invalid newly created index must roll back");
    assert.equal(prepare(observer, "PRAGMA user_version").get()?.user_version, 0);
    assert.deepEqual(prepare(observer, "SELECT * FROM sqlite_schema ORDER BY name").all(), beforeSchema);
    assert.deepEqual(snapshot(observer), before);
    assert.deepEqual(begins(observed.statements), ["BEGIN IMMEDIATE"]);
    assert.equal(observed.statements.filter(sql => /^COMMIT$/iu.test(sql)).length, 0);
    assert.equal(observed.statements.filter(sql => /^ROLLBACK$/iu.test(sql)).length, 1);
    observed.restore();
  }, false);
});

test("current schema 13 installs once, preserves every row and rowid, and restores the actual timeout", async t => {
  await fixture(async f => {
    const observer = f.connect();
    const before = snapshot(observer);
    const observed = instrument(t);
    const authority = await f.open();
    assertIndex(authority.databaseHandle());
    assert.equal(authority.schemaRevision(), 13);
    assert.equal(timeout(authority.databaseHandle()), currentTimeout);
    assert.deepEqual(snapshot(observer), before);
    assert.deepEqual(begins(observed.statements), ["BEGIN IMMEDIATE"]);
    assert.equal(creates(observed.statements).length, 1);
    assert.equal(observed.statements.filter(sql => /^COMMIT$/iu.test(sql)).length, 1);
    authority.close();
    observed.statements.length = 0;
    const again = await f.open();
    assertIndex(again.databaseHandle());
    assert.deepEqual(begins(observed.statements), []);
    assert.deepEqual(creates(observed.statements), []);
    observed.restore();
  });
});

for (const revision of [1, 9, 11, 12]) test(`required migration from revision ${revision} finishes before optional index work`, async t => {
  await fixture(async f => {
    const observer = f.connect();
    exec(observer, `PRAGMA user_version = ${revision}`);
    if (revision <= 9) exec(observer, "DROP INDEX runtime_events_toolcall_idx");
    exec(observer, "CREATE TABLE goals (goal_id TEXT PRIMARY KEY); ALTER TABLE graphs ADD COLUMN goal_id TEXT");
    const beforeAttempts = prepare(observer, "SELECT rowid, * FROM task_attempts ORDER BY rowid").all();
    let createdAtRevision: number | undefined;
    const observed = instrument(t, {
      exec(database, sql, proceed) {
        if (creates([sql]).length) createdAtRevision = Number(prepare(database, "PRAGMA user_version").get()?.user_version);
        proceed();
      }
    });
    const authority = await f.open();
    assert.equal(createdAtRevision, 13);
    assert.equal(authority.schemaRevision(), 13);
    assertIndex(observer);
    assert.equal(prepare(observer, "SELECT name FROM sqlite_schema WHERE name = 'goals'").get(), undefined);
    assert.deepEqual(prepare(observer, "SELECT rowid, * FROM task_attempts ORDER BY rowid").all(), beforeAttempts);
    assert.ok(begins(observed.statements).length >= 2);
    observed.restore();
  });
});

test("read-only absence creates no store or directory", async () => {
  await fixture(async f => {
    assert.equal(await RuntimeEventAuthority.openReadOnly(f.root), undefined);
    await assert.rejects(access(f.databasePath), { code: "ENOENT" });
    await assert.rejects(access(agentDir(f.root)), { code: "ENOENT" });
  }, false);
});

for (const indexed of [false, true]) test(`read-only current schema 13 ${indexed ? "with" : "without"} optional index preserves file bytes`, async t => {
  await fixture(async f => {
    const setup = f.connect();
    if (indexed) exec(setup, createIndex);
    originalClose.call(setup);
    const bytes = await readFile(f.databasePath);
    const observed = instrument(t);
    const authority = await RuntimeEventAuthority.openReadOnly(f.root);
    assert.ok(authority);
    assert.equal(authority.schemaRevision(), 13);
    assert.equal(Boolean(schemaObject(authority.databaseHandle())), indexed);
    assert.equal(timeout(authority.databaseHandle()), 5_000);
    assert.equal(authority.readEvents({ limit: 1000 }).events.length, 12);
    assert.deepEqual(begins(observed.statements), []);
    assert.deepEqual(creates(observed.statements), []);
    assert.equal(observed.statements.some(sql => /busy_timeout\s*=/iu.test(sql)), false);
    authority.close();
    observed.restore();
    assert.deepEqual(await readFile(f.databasePath), bytes);
  });
});

for (const revision of [0, 1, 12, 14]) test(`read-only revision ${revision} preserves the existing version guard and bytes`, async () => {
  await fixture(async f => {
    const setup = f.connect();
    exec(setup, `PRAGMA user_version = ${revision}`);
    originalClose.call(setup);
    const bytes = await readFile(f.databasePath);
    await assert.rejects(RuntimeEventAuthority.openReadOnly(f.root), /requires an explicit runtime startup/iu);
    assert.deepEqual(await readFile(f.databasePath), bytes);
    const observer = f.connect();
    assert.equal(Number(prepare(observer, "PRAGMA user_version").get()?.user_version), revision);
    assert.equal(schemaObject(observer), undefined);
  });
});

test("equivalent metadata with different SQL formatting takes no BEGIN or timeout path under another writer lock", async t => {
  await fixture(async f => {
    const blocker = f.connect();
    exec(blocker, `CREATE INDEX "${indexName}" ON "task_attempts" ( "task_run_id" COLLATE BINARY ASC )`);
    exec(blocker, "BEGIN IMMEDIATE");
    const observed = instrument(t);
    try {
      const authority = await f.open();
      assertIndex(authority.databaseHandle());
      assert.deepEqual(begins(observed.statements), []);
      assert.deepEqual(creates(observed.statements), []);
      assert.equal(observed.statements.some(sql => /busy_timeout/iu.test(sql)), false);
    } finally { observed.restore(); exec(blocker, "ROLLBACK"); }
  });
});

test("native optional BEGIN busy 5 defers once, restores timeout, and only a later writable open retries", async t => {
  await fixture(async f => {
    const blocker = f.connect();
    const before = snapshot(blocker);
    let busy: unknown;
    let admissions = 0;
    const observed = instrument(t, {
      exec(database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) {
          admissions++;
          assert.equal(timeout(database), 0);
          exec(blocker, "BEGIN IMMEDIATE");
          try { proceed(); } catch (error) { busy = error; throw error; }
        } else proceed();
      }
    });
    const authority = await f.open();
    assert.ok(busy instanceof Error);
    assert.equal(Reflect.get(busy, "code"), "ERR_SQLITE_ERROR");
    assert.equal(Reflect.get(busy, "errcode"), 5);
    assert.equal(admissions, 1);
    assert.equal(timeout(authority.databaseHandle()), currentTimeout);
    assert.equal(schemaObject(authority.databaseHandle()), undefined);
    assert.deepEqual(snapshot(authority.databaseHandle()), before);
    exec(blocker, "ROLLBACK");
    await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(admissions, 1);
    assert.equal(schemaObject(authority.databaseHandle()), undefined, "unlocking alone must not create the index");
    const tasks = await DurableTaskRunStore.open(f.root, authority);
    assert.equal(tasks.get("任务/🦋")?.attempts.at(-1)?.attemptId, "任务/🦋:attempt:2");
    tasks.close();
    observed.restore();
    authority.close();
    const later = await f.open();
    assertIndex(later.databaseHandle());
    assert.deepEqual(snapshot(later.databaseHandle()), before);
  });
});

test("a second writer installing between missing pre-read and BEGIN converges without duplicate DDL", async t => {
  await fixture(async f => {
    const winner = f.connect();
    const before = snapshot(winner);
    let raced = false;
    const observed = instrument(t, {
      exec(_database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) {
          assert.equal(raced, false);
          raced = true;
          exec(winner, "BEGIN IMMEDIATE");
          exec(winner, createIndex);
          exec(winner, "COMMIT");
        }
        proceed();
      }
    });
    const authority = await f.open();
    assert.equal(raced, true);
    assertIndex(authority.databaseHandle());
    assert.deepEqual(creates(observed.statements), [], "transaction-local recheck must observe the winning writer");
    assert.equal(timeout(authority.databaseHandle()), currentTimeout);
    assert.deepEqual(snapshot(winner), before);
    observed.restore();
  });
});

for (const revision of [12, 14]) test(`schema revision changing to ${revision} before optional BEGIN is rejected without optional DDL`, async t => {
  await fixture(async f => {
    const changer = f.connect();
    const before = snapshot(changer);
    const observed = instrument(t, {
      exec(_database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) exec(changer, `PRAGMA user_version = ${revision}`);
        proceed();
      }
    });
    const error = await rejection(() => f.open());
    assert.ok(error instanceof Error);
    assert.match(error.message, /schema.*(?:revision|version)/iu);
    assert.equal(schemaObject(changer), undefined);
    assert.deepEqual(creates(observed.statements), []);
    assert.deepEqual(snapshot(changer), before);
    assertClosedWithTimeout(observed);
    observed.restore();
  });
});

const refusedAdmissionErrors: Array<[string, unknown]> = [
  ["LOCKED 6", sqliteError(6)], ["BUSY_RECOVERY 261", sqliteError(261)],
  ["BUSY_SNAPSHOT 517", sqliteError(517)], ["BUSY_TIMEOUT 773", sqliteError(773)],
  ["FULL 13", sqliteError(13)], ["CORRUPT 11", sqliteError(11)],
  ["IOERR 10", sqliteError(10)], ["READONLY 8", sqliteError(8)],
  ["string code 5", sqliteError("5")], ["wrong Node error code", sqliteError(5, "OTHER")],
  ["message only", new Error("database is locked: SQLITE_BUSY")],
  ["non-Error shaped lookalike", { code: "ERR_SQLITE_ERROR", errcode: 5 }],
  ["plain error", new Error("plain startup sentinel")], ["undefined throw", undefined], ["null throw", null]
];
for (const [name, expected] of refusedAdmissionErrors) test(`optional BEGIN propagates the exact ${name} and restores timeout`, async t => {
  await fixture(async f => {
    const observer = f.connect();
    const before = snapshot(observer);
    const observed = instrument(t, {
      exec(_database, sql, proceed) { if (/^BEGIN IMMEDIATE$/iu.test(sql)) throw expected; proceed(); }
    });
    assert.equal(await rejection(() => f.open()), expected);
    assert.deepEqual(snapshot(observer), before);
    assert.equal(schemaObject(observer), undefined);
    assert.deepEqual(creates(observed.statements), []);
    assertClosedWithTimeout(observed);
    observed.restore();
  });
});

test("required migration BEGIN busy 5 remains fatal and is never treated as optional contention", async t => {
  await fixture(async f => {
    const observer = f.connect();
    exec(observer, "PRAGMA user_version = 12");
    const expected = sqliteError(5);
    const before = snapshot(observer);
    const observed = instrument(t, {
      exec(database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) {
          assert.equal(timeout(database), currentTimeout, "required migration keeps its normal busy timeout");
          throw expected;
        }
        proceed();
      }
    });
    assert.equal(await rejection(() => f.open()), expected);
    assert.equal(Number(prepare(observer, "PRAGMA user_version").get()?.user_version), 12);
    assert.deepEqual(snapshot(observer), before);
    assert.equal(schemaObject(observer), undefined);
    assertClosedWithTimeout(observed);
    observed.restore();
  });
});

for (const phase of ["callback-version-read", "before-create", "after-create", "commit"] as const) {
  for (const errcode of [5, 13]) test(`${phase} error ${errcode} is never deferred and rolls back atomic index work`, async t => {
    await fixture(async f => {
      const observer = f.connect();
      const before = snapshot(observer);
      const expected = sqliteError(errcode);
      let bodyStarted = false;
      let faulted = false;
      const observed = instrument(t, {
        exec(_database, sql, proceed) {
          if (/^BEGIN IMMEDIATE$/iu.test(sql)) { proceed(); bodyStarted = true; return; }
          if (phase === "before-create" && creates([sql]).length) { faulted = true; throw expected; }
          if (phase === "after-create" && creates([sql]).length) { proceed(); faulted = true; throw expected; }
          if (phase === "commit" && /^COMMIT$/iu.test(sql)) { faulted = true; throw expected; }
          proceed();
        },
        prepare(_database, sql, proceed) {
          if (phase === "callback-version-read" && bodyStarted && /PRAGMA user_version/iu.test(sql)) { faulted = true; throw expected; }
          return proceed();
        }
      });
      assert.equal(await rejection(() => f.open()), expected);
      assert.equal(faulted, true);
      assert.equal(bodyStarted, true);
      assert.ok(observed.statements.some(sql => /^ROLLBACK$/iu.test(sql)));
      assert.equal(schemaObject(observer), undefined);
      assert.deepEqual(snapshot(observer), before);
      assertClosedWithTimeout(observed);
      observed.restore();
    });
  });
}

for (const phase of ["success", "deferred-busy", "nondeferred-error"] as const) test(`timeout restoration failure after ${phase} follows primary-error precedence and closes startup`, async t => {
  await fixture(async f => {
    const observer = f.connect();
    const before = snapshot(observer);
    const primary = sqliteError(phase === "deferred-busy" ? 5 : 13);
    const restoreError = new Error("timeout restoration sentinel");
    let attemptedRestore = false;
    const observed = instrument(t, {
      exec(_database, sql, proceed) {
        if (/busy_timeout\s*=\s*137/iu.test(sql)) { attemptedRestore = true; throw restoreError; }
        if (/^BEGIN IMMEDIATE$/iu.test(sql) && phase !== "success") throw primary;
        proceed();
      }
    });
    assert.equal(await rejection(() => f.open()), phase === "nondeferred-error" ? primary : restoreError);
    assert.equal(attemptedRestore, true);
    assertClosedWithTimeout(observed, 0);
    assert.equal(Boolean(schemaObject(observer)), phase === "success");
    assert.deepEqual(snapshot(observer), before);
    observed.restore();
  });
});

test("code-5 failure while setting zero timeout is propagated and the saved timeout is restored", async t => {
  await fixture(async f => {
    const expected = sqliteError(5);
    const observed = instrument(t, {
      exec(_database, sql, proceed) {
        proceed();
        if (/busy_timeout\s*=\s*0\b/iu.test(sql)) throw expected;
      }
    });
    assert.equal(await rejection(() => f.open()), expected);
    assert.deepEqual(begins(observed.statements), []);
    assertClosedWithTimeout(observed);
    observed.restore();
  });
});

const invalidDefinitions: Array<[string, string]> = [
  ["wrong table", `CREATE INDEX ${indexName} ON task_runs(task_run_id)`],
  ["wrong column", `CREATE INDEX ${indexName} ON task_attempts(run_id)`],
  ["unique", `DELETE FROM task_attempts WHERE rowid NOT IN (SELECT MAX(rowid) FROM task_attempts GROUP BY task_run_id); CREATE UNIQUE INDEX ${indexName} ON task_attempts(task_run_id)`],
  ["partial", `CREATE INDEX ${indexName} ON task_attempts(task_run_id) WHERE status = 'queued'`],
  ["descending", `CREATE INDEX ${indexName} ON task_attempts(task_run_id DESC)`],
  ["NOCASE collation", `CREATE INDEX ${indexName} ON task_attempts(task_run_id COLLATE NOCASE)`],
  ["extra key column", `CREATE INDEX ${indexName} ON task_attempts(task_run_id, run_id)`],
  ["expression", `CREATE INDEX ${indexName} ON task_attempts(lower(task_run_id))`],
  ["table object", `CREATE TABLE ${indexName} (preserved TEXT); INSERT INTO ${indexName} VALUES ('keep me')`],
  ["view object", `CREATE VIEW ${indexName} AS SELECT task_run_id FROM task_runs`]
];
for (const [name, definition] of invalidDefinitions) test(`incompatible same-name ${name} is preserved and rejected clearly before BEGIN`, async t => {
  await fixture(async f => {
    const observer = f.connect();
    exec(observer, definition);
    const object = schemaObject(observer);
    const before = snapshot(observer);
    const observed = instrument(t);
    const error = await rejection(() => f.open());
    assert.ok(error instanceof Error);
    assert.match(error.message, /task_attempts_task_run_idx/u);
    assert.match(error.message, /incompatib/iu);
    assert.deepEqual(schemaObject(observer), object);
    assert.deepEqual(snapshot(observer), before);
    assert.deepEqual(begins(observed.statements), []);
    assert.deepEqual(creates(observed.statements), []);
    assert.equal(observed.statements.some(sql => /busy_timeout/iu.test(sql)), false);
    assertClosedWithTimeout(observed);
    observed.restore();
  });
});

test("incompatible name installed by a racing writer is rechecked and preserved inside the transaction", async t => {
  await fixture(async f => {
    const winner = f.connect();
    const before = snapshot(winner);
    const observed = instrument(t, {
      exec(_database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) exec(winner, `CREATE INDEX ${indexName} ON task_attempts(run_id)`);
        proceed();
      }
    });
    const error = await rejection(() => f.open());
    assert.ok(error instanceof Error);
    assert.match(error.message, /incompatib/iu);
    assert.match(String(schemaObject(winner)?.sql), /\(run_id\)/u);
    assert.deepEqual(creates(observed.statements), []);
    assert.deepEqual(snapshot(winner), before);
    assertClosedWithTimeout(observed);
    observed.restore();
  });
});

test("optional installation precedes session backfill, whose code-5 failure is still propagated", async t => {
  await fixture(async f => {
    await writeFile(sessionFilePath(f.root, "backfill-sentinel"), `${JSON.stringify({ type: "user_message", content: "sentinel", time: "2026-01-01T00:00:00.000Z" })}\n`);
    const observer = f.connect();
    const before = snapshot(observer);
    const expected = sqliteError(5);
    let beginsSeen = 0;
    const observed = instrument(t, {
      exec(database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) {
          beginsSeen++;
          if (beginsSeen === 2) {
            assertIndex(database);
            assert.equal(timeout(database), currentTimeout);
            throw expected;
          }
        }
        proceed();
      }
    });
    assert.equal(await rejection(() => RuntimeEventAuthority.open(f.root)), expected);
    assert.equal(beginsSeen, 2);
    assertIndex(observer);
    assert.deepEqual(snapshot(observer), before);
    assertClosedWithTimeout(observed);
    observed.restore();
  });
});

test("native optional busy deferral continues backfill after restoring the timeout", async t => {
  await fixture(async f => {
    await writeFile(sessionFilePath(f.root, "backfill-after-busy"), `${JSON.stringify({ type: "user_message", content: "backfill after native busy", time: "2026-01-01T00:00:00.000Z" })}\n`);
    const blocker = f.connect();
    let attempts = 0;
    let nativeBusy: unknown;
    const observed = instrument(t, {
      exec(database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) {
          attempts++;
          if (attempts === 1) {
            assert.equal(timeout(database), 0);
            exec(blocker, "BEGIN IMMEDIATE");
            try { proceed(); } catch (error) { nativeBusy = error; throw error; }
            finally { exec(blocker, "ROLLBACK"); }
            return;
          }
          assert.equal(timeout(database), currentTimeout);
        }
        proceed();
      }
    });
    const authority = await RuntimeEventAuthority.open(f.root);
    try {
      assert.ok(nativeBusy instanceof Error);
      assert.equal(Reflect.get(nativeBusy, "errcode"), 5);
      assert.equal(attempts, 2, "exactly one optional admission and one backfill transaction");
      assert.equal(schemaObject(authority.databaseHandle()), undefined);
      const events = authority.readEvents({ sessionId: "backfill-after-busy" }).events;
      assert.equal(events.length, 1);
      assert.equal(events[0]?.eventType, "legacy.user_message");
      assert.equal(timeout(authority.databaseHandle()), currentTimeout);
    } finally { authority.close(); observed.restore(); }
  });
});

test("future writable schema stays rejected before optional work", async t => {
  await fixture(async f => {
    const observer = f.connect();
    exec(observer, "PRAGMA user_version = 14");
    const before = snapshot(observer);
    const observed = instrument(t);
    await assert.rejects(f.open(), /Unsupported runtime schema revision 14/u);
    assert.deepEqual(begins(observed.statements), []);
    assert.deepEqual(creates(observed.statements), []);
    assert.equal(schemaObject(observer), undefined);
    assert.deepEqual(snapshot(observer), before);
    assertClosedWithTimeout(observed);
    observed.restore();
  });
});

for (const primary of [undefined, null]) test(`timeout restore failure preserves a thrown ${String(primary)} primary error`, async t => {
  await fixture(async f => {
    const restoreError = new Error("restoration must not replace non-Error primary");
    const observed = instrument(t, {
      exec(_database, sql, proceed) {
        if (/^BEGIN IMMEDIATE$/iu.test(sql)) throw primary;
        if (/busy_timeout\s*=\s*137/iu.test(sql)) throw restoreError;
        proceed();
      }
    });
    assert.equal(await rejection(() => f.open()), primary);
    assertClosedWithTimeout(observed, 0);
    observed.restore();
  });
});

test("callback failure preserves the exact primary even if ROLLBACK itself fails", async t => {
  await fixture(async f => {
    const observer = f.connect();
    const before = snapshot(observer);
    const primary = sqliteError(5);
    const rollbackError = new Error("rollback sentinel");
    const observed = instrument(t, {
      exec(_database, sql, proceed) {
        if (creates([sql]).length) { proceed(); throw primary; }
        if (/^ROLLBACK$/iu.test(sql)) throw rollbackError;
        proceed();
      }
    });
    assert.equal(await rejection(() => f.open()), primary);
    assertClosedWithTimeout(observed);
    assert.equal(schemaObject(observer), undefined, "closing the failed connection rolls back the uncommitted index");
    assert.deepEqual(snapshot(observer), before);
    observed.restore();
  });
});

test("equivalent case-insensitive index identifier is recognized without creating or acquiring a transaction", async t => {
  await fixture(async f => {
    const observer = f.connect();
    exec(observer, 'CREATE INDEX "TASK_ATTEMPTS_TASK_RUN_IDX" ON "TASK_ATTEMPTS" ("TASK_RUN_ID" ASC)');
    const observed = instrument(t);
    const authority = await f.open();
    assert.equal(authority.schemaRevision(), 13);
    assert.deepEqual(begins(observed.statements), []);
    assert.deepEqual(creates(observed.statements), []);
    assert.equal(prepare(observer, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ? COLLATE NOCASE").get(indexName)?.count, 1);
    observed.restore();
  });
});

test("task get/list and public transitions retain rowid order, Unicode and empty IDs, and append semantics", async () => {
  await fixture(async f => {
    const reader = await RuntimeEventAuthority.openReadOnly(f.root);
    assert.ok(reader);
    const oldTasks = await DurableTaskRunStore.open(f.root, reader);
    const ids = ["", "任务/🦋", "ordinary"];
    const before = ids.map(id => oldTasks.get(id));
    const beforeList = oldTasks.list({ order: "asc", limit: 100 });
    oldTasks.close(); reader.close();
    const authority = await f.open();
    const tasks = await DurableTaskRunStore.open(f.root, authority);
    assert.deepEqual(ids.map(id => tasks.get(id)), before);
    assert.deepEqual(tasks.list({ order: "asc", limit: 100 }), beforeList);
    for (const id of ids) {
      assert.deepEqual(tasks.get(id)?.attempts.map(attempt => attempt.attemptId), [0, 1, 2].map(number => `${id}:attempt:${number}`));
      const prior = snapshot(authority.databaseHandle());
      assert.throws(() => tasks.transition(id, "running", { attemptId: `${id}:attempt:0` }), /stale/iu);
      assert.deepEqual(snapshot(authority.databaseHandle()), prior);
      const latest = tasks.createAttempt(id, { attemptId: `${id}:appended`, runId: `${id}:appended-run`, turnId: `${id}:appended-turn` });
      assert.equal(tasks.get(id)?.attempts.at(-1)?.attemptId, latest.attemptId);
      tasks.transition(id, "running");
      const completed = tasks.transition(id, "completed", { attemptId: latest.attemptId, artifacts: { output: `canonical ${id}` } });
      assert.equal(completed.attempts.at(-1)?.status, "completed");
      assert.deepEqual(completed.attempts.at(-1)?.artifacts, { output: `canonical ${id}` });
      const terminal = snapshot(authority.databaseHandle());
      tasks.transition(id, "completed");
      assert.deepEqual(snapshot(authority.databaseHandle()), terminal);
    }
    const plan = prepare(authority.databaseHandle(), "EXPLAIN QUERY PLAN SELECT * FROM task_attempts WHERE task_run_id = ? ORDER BY rowid DESC LIMIT 1").all("任务/🦋");
    assert.ok(plan.some(row => String(row.detail).includes(indexName)), "the unhinted latest-attempt query should use the optional index");
    assert.deepEqual(prepare(authority.databaseHandle(), "PRAGMA foreign_key_check").all(), []);
    tasks.close();
  });
});
