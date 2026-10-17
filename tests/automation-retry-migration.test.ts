import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { agentDir } from "../src/session/store.js";

const workspaceId = "retry-migration-workspace";
const createdAt = "2035-01-01T00:00:00.000Z";
const legacyDeferredAt = "2035-06-12T08:00:00.123-12:00";

// Literal schema-13 DDL from RuntimeAuthority.ts at f3bf209edec7323a78f4ffb7c538c3e660cab300.
// This focused legacy fixture includes the original automation tables, event ledger,
// and task tables needed by optional startup index maintenance. Unrelated graph,
// capability and session-goal tables are omitted; session backfill is disabled.
// Never initialize this database through the current authority and lower its version:
// the migration must encounter a real table that has no retry_at column.
const legacySchema = `
  CREATE TABLE runtime_events (
    event_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    event_seq INTEGER,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, sequence)
  );
  CREATE INDEX runtime_events_toolcall_idx
    ON runtime_events (workspace_id, json_extract(payload_json, '$.toolCallId'), sequence)
    WHERE event_type IN ('session.tool_call', 'session.tool_execution', 'session.tool_result');
  CREATE INDEX runtime_events_run_idx ON runtime_events (workspace_id, run_id, sequence);
  CREATE INDEX runtime_events_session_idx ON runtime_events (workspace_id, session_id, sequence);
  CREATE UNIQUE INDEX runtime_events_session_event_seq_idx
    ON runtime_events (workspace_id, session_id, event_seq) WHERE event_seq IS NOT NULL;
  CREATE TABLE task_runs (
    task_run_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT,
    parent_run_id TEXT,
    status TEXT NOT NULL,
    task_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    terminal_event_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE task_attempts (
    attempt_id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL REFERENCES task_runs(task_run_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    parent_run_id TEXT,
    status TEXT NOT NULL,
    high_water_sequence INTEGER,
    retry_safety TEXT NOT NULL,
    verification_json TEXT,
    artifacts_json TEXT,
    failure_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE automations (
    automation_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    execution_template_json TEXT NOT NULL,
    status TEXT NOT NULL,
    next_fire_at TEXT,
    last_fire_at TEXT,
    fire_count INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    max_fires INTEGER,
    expires_at TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE automation_pending_fires (
    fire_id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(automation_id) ON DELETE CASCADE,
    scheduled_at TEXT NOT NULL,
    claim_token TEXT,
    claimed_at TEXT,
    status TEXT NOT NULL,
    run_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (automation_id, scheduled_at)
  );
  PRAGMA user_version = 13;
`;

const legacyFires = [
  ["legacy-deferred", legacyDeferredAt, "deferred", null, null, null, "Target was busy"],
  ["legacy-pending", "2036-01-01T00:00:00.000Z", "pending", null, null, null, null],
  ["legacy-running", "2035-01-02T00:00:00.000Z", "running", "running-owner", createdAt, "running-run", null],
  ["legacy-completed", "2035-01-03T00:00:00.000Z", "completed", "completed-owner", createdAt, "completed-run", null],
  ["legacy-failed", "2035-01-04T00:00:00.000Z", "failed", "failed-owner", createdAt, "failed-run", "Saved failure"],
  ["legacy-approval", "2035-01-05T00:00:00.000Z", "needs_approval", "old-owner", createdAt, "uncertain-run", "Check side effects"]
] as const;

function snapshot(database: DatabaseSync) {
  return {
    automations: database.prepare("SELECT rowid, * FROM automations ORDER BY rowid").all(),
    fires: database.prepare(`
      SELECT rowid, fire_id, automation_id, scheduled_at, claim_token, claimed_at,
        status, run_id, error, created_at FROM automation_pending_fires ORDER BY rowid
    `).all(),
    events: database.prepare("SELECT rowid, * FROM runtime_events ORDER BY rowid").all(),
    tasks: database.prepare("SELECT rowid, * FROM task_runs ORDER BY rowid").all(),
    attempts: database.prepare("SELECT rowid, * FROM task_attempts ORDER BY rowid").all()
  };
}

async function fixture(t: TestContext, legacy = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-automation-retry-migration-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const authorities: RuntimeEventAuthority[] = [];
  const stores: AutomationStore[] = [];
  t.after(async () => {
    try {
      try { for (const store of stores) store.close(); }
      finally { for (const authority of authorities) authority.close(); }
    } finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const databasePath = path.join(agentDir(root), "runtime.sqlite");
  if (legacy) {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      database.exec(legacySchema);
      const insertAutomation = database.prepare(`
        INSERT INTO automations (automation_id, workspace_id, name, trigger_type,
          schedule_json, execution_template_json, status, next_fire_at, last_fire_at,
          fire_count, consecutive_failures, max_fires, expires_at, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'once', ?, ?, 'active', NULL, ?, 7, 2, NULL, NULL, 9, ?, ?)
      `);
      for (const id of ["legacy-automation", "other-automation"]) {
        insertAutomation.run(id, workspaceId, id, JSON.stringify({ at: createdAt }),
          JSON.stringify({ prompt: "Synthetic reminder; do not execute" }), createdAt, createdAt, createdAt);
      }
      const insertFire = database.prepare(`
        INSERT INTO automation_pending_fires (fire_id, automation_id, scheduled_at,
          status, claim_token, claimed_at, run_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [id, at, status, claim, claimedAt, runId, error] of legacyFires) {
        insertFire.run(id, "legacy-automation", at, status, claim, claimedAt, runId, error, createdAt);
      }
      insertFire.run("other-completed", "other-automation", legacyDeferredAt,
        "completed", "other-owner", createdAt, "other-run", null, createdAt);
      database.prepare(`
        INSERT INTO runtime_events (event_id, workspace_id, session_id, invocation_id,
          run_id, turn_id, event_seq, sequence, event_type, payload_json, created_at)
        VALUES ('legacy-event', ?, 'legacy-session', 'legacy-invocation',
          'legacy-run', 'legacy-turn', 1, 1, 'fixture.saved', '{"keep":true}', ?)
      `).run(workspaceId, createdAt);
      database.prepare(`
        INSERT INTO task_runs (task_run_id, workspace_id, status, task_json, created_at, updated_at)
        VALUES ('legacy-task', ?, 'queued', '{"keep":"task"}', ?, ?)
      `).run(workspaceId, createdAt, createdAt);
      database.prepare(`
        INSERT INTO task_attempts (attempt_id, task_run_id, run_id, turn_id, status,
          retry_safety, created_at, updated_at)
        VALUES ('legacy-attempt', 'legacy-task', 'task-run', 'task-turn', 'queued', 'safe', ?, ?)
      `).run(createdAt, createdAt);
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 13);
      assert.equal(database.prepare("PRAGMA table_info(automation_pending_fires)").all()
        .some(column => column.name === "retry_at"), false);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { database.close(); }
  }
  return {
    root, databasePath,
    async open() {
      const authority = await RuntimeEventAuthority.open(root, { workspaceId, backfillLegacySessions: false });
      authorities.push(authority);
      return authority;
    },
    async openStore(authority: RuntimeEventAuthority) {
      const store = await AutomationStore.open(root, authority);
      stores.push(store);
      return store;
    }
  };
}

await test("schema 13 gains nullable retry_at without changing saved fires, counters or constraints", async t => {
  const f = await fixture(t);
  const legacy = new DatabaseSync(f.databasePath, { readOnly: true });
  const before = (() => {
    try { return snapshot(legacy); }
    finally { legacy.close(); }
  })();
  assert.equal(before.fires.length, 7);
  const bytes = await readFile(f.databasePath);
  await assert.rejects(RuntimeEventAuthority.openReadOnly(f.root), /requires an explicit runtime startup/u);
  assert.deepEqual(await readFile(f.databasePath), bytes, "read-only startup must leave schema 13 untouched");

  const authority = await f.open();
  const database = authority.databaseHandle();
  assert.equal(authority.schemaRevision(), 14);
  assert.deepEqual(snapshot(database), before, "migration preserves every original value and rowid");
  const columns = database.prepare("PRAGMA table_info(automation_pending_fires)").all();
  const retry = columns.filter(column => column.name === "retry_at");
  assert.equal(columns.length, 10);
  assert.equal(retry.length, 1);
  assert.equal(retry[0]?.type, "TEXT");
  assert.equal(retry[0]?.notnull, 0);
  assert.equal(retry[0]?.dflt_value, null);
  assert.deepEqual(database.prepare("SELECT retry_at FROM automation_pending_fires").all().map(row => row.retry_at),
    Array.from({ length: 7 }, () => null));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(automation_pending_fires)").all();
  assert.equal(foreignKeys.length, 1);
  assert.equal(foreignKeys[0]?.table, "automations");
  assert.equal(foreignKeys[0]?.from, "automation_id");
  assert.equal(foreignKeys[0]?.to, "automation_id");
  assert.equal(foreignKeys[0]?.on_delete, "CASCADE");
  const insert = database.prepare(`
    INSERT INTO automation_pending_fires (fire_id, automation_id, scheduled_at, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  assert.throws(() => insert.run("duplicate-occurrence", "legacy-automation", legacyDeferredAt, createdAt), /UNIQUE constraint failed/u);
  assert.throws(() => insert.run("orphan", "missing-automation", createdAt, createdAt), /FOREIGN KEY constraint failed/u);
  assert.deepEqual(snapshot(database), before);
  const schema = database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  authority.close();

  const reopened = await f.open();
  assert.equal(reopened.schemaRevision(), 14);
  assert.deepEqual(snapshot(reopened.databaseHandle()), before);
  assert.deepEqual(reopened.databaseHandle().prepare("SELECT * FROM sqlite_schema ORDER BY name").all(), schema);
  const reader = await RuntimeEventAuthority.openReadOnly(f.root);
  assert.ok(reader);
  try { assert.equal(reader.schemaRevision(), 14); }
  finally { reader.close(); }
  reopened.databaseHandle().prepare("DELETE FROM automations WHERE automation_id = ?").run("other-automation");
  assert.equal(reopened.databaseHandle().prepare("SELECT COUNT(*) AS count FROM automation_pending_fires").get()?.count, 6);
  assert.equal(reopened.databaseHandle().prepare("SELECT fire_id FROM automation_pending_fires WHERE fire_id = 'other-completed'").get(), undefined);
  assert.deepEqual(reopened.databaseHandle().prepare("PRAGMA foreign_key_check").all(), []);
});

await test("legacy deferred null retry_at uses its saved deadline and never becomes due early", async t => {
  const due = Date.parse(legacyDeferredAt);
  t.mock.timers.enable({ apis: ["Date"], now: due - 1 });
  const f = await fixture(t);
  let authority = await f.open();
  let store = await f.openStore(authority);
  assert.equal(store.getFire("legacy-deferred")?.scheduledAt, legacyDeferredAt);
  assert.equal(store.getFire("legacy-deferred")?.retryAt, undefined);
  const before = snapshot(authority.databaseHandle());
  assert.deepEqual(store.claimDue(new Date(due - 1)), []);
  assert.deepEqual(snapshot(authority.databaseHandle()), before);
  store.close(); authority.close();
  authority = await f.open();
  store = await f.openStore(authority);
  assert.deepEqual(store.claimDue(new Date(due - 1)), []);
  t.mock.timers.setTime(due);
  const fires = store.claimDue(new Date(due));
  assert.deepEqual(fires.map(fire => fire.fireId), ["legacy-deferred"]);
  assert.equal(fires[0]?.scheduledAt, legacyDeferredAt,
    "schema 13 already overwrote the original identity; migration must not invent an earlier time");
  assert.equal(fires[0]?.retryAt, undefined);
  assert.equal(fires[0]?.status, "pending");
  assert.deepEqual(store.claimDue(new Date(due)).map(fire => fire.fireId), ["legacy-deferred"]);
  assert.ok(store.claimFire("legacy-deferred", "new-owner"));
  store.completeFire("legacy-deferred", "completed-after-migration");
  assert.deepEqual(store.claimDue(new Date(due)), []);
  assert.equal(store.get("legacy-automation")?.fireCount, 8);
  assert.equal(store.getFire("legacy-deferred")?.scheduledAt, legacyDeferredAt);
  assert.equal(store.listPending().length, 7);
});

await test("schema 13 with an already-present retry column upgrades without replacing retry data", async t => {
  const f = await fixture(t);
  const setup = new DatabaseSync(f.databasePath);
  const retryAt = "2035-06-13T00:00:00.000Z";
  try {
    setup.exec("ALTER TABLE automation_pending_fires ADD COLUMN retry_at TEXT");
    setup.prepare("UPDATE automation_pending_fires SET retry_at = ? WHERE fire_id = 'legacy-deferred'").run(retryAt);
    assert.equal(setup.prepare("PRAGMA user_version").get()?.user_version, 13);
  } finally { setup.close(); }
  const authority = await f.open();
  assert.equal(authority.schemaRevision(), 14);
  assert.equal(authority.databaseHandle().prepare("PRAGMA table_info(automation_pending_fires)").all()
    .filter(column => column.name === "retry_at").length, 1);
  assert.equal(authority.databaseHandle().prepare("SELECT retry_at FROM automation_pending_fires WHERE fire_id = 'legacy-deferred'").get()?.retry_at, retryAt);
  assert.equal((await f.openStore(authority)).getFire("legacy-deferred")?.scheduledAt, legacyDeferredAt);
});

await test("fresh schema 14 defaults new fire retry_at to null", async t => {
  const f = await fixture(t, false);
  const authority = await f.open();
  const store = await f.openStore(authority);
  assert.equal(authority.schemaRevision(), 14);
  const automation = store.create({
    name: "Fresh retry schema", triggerType: "once", schedule: { at: "2036-01-01T00:00:00.000Z" },
    executionTemplate: { prompt: "Synthetic reminder; do not execute" }
  });
  const fire = store.forceFire(automation.automationId, createdAt);
  assert.equal(fire.retryAt, undefined);
  assert.equal(authority.databaseHandle().prepare("SELECT retry_at FROM automation_pending_fires WHERE fire_id = ?").get(fire.fireId)?.retry_at, null);
});
