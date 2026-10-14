/** 清理线程退出后才算完成；调用线程不打开清理连接，也不关闭已有检索连接。 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";
import { sessionSearchDatabaseFileName } from "../src/session/searchIndexStore.js";
import type { SessionSearchCleanupScope } from "../src/session/searchCleanup.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cleanup-resources-"));
  const workspace = path.join(root, "workspace");
  const agentRoot = path.join(root, "agent");
  const previousAgentRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = agentRoot;
  const index = new SessionSearchIndex(agentRoot);
  const databases = new Set<DatabaseSync>();
  t.after(async () => {
    t.mock.restoreAll();
    await index.close();
    for (const database of databases) if (database.isOpen) database.close();
    if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentRoot;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  const prepare = DatabaseSync.prototype.prepare;
  // 只观察真实连接，不替换 SQLite 的打开、查询或关闭行为。
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA journal_mode") databases.add(this);
    return prepare.call(this, sql);
  });
  return {
    workspace, agentRoot, index, databases,
    create: async (id: string) => await createSessionFile(workspace, id,
      Buffer.from(`${JSON.stringify({ type: "user_message", content: `marker ${id}` })}\n`))
  };
}

test("repeated public cleanup releases each owned connection and keeps an existing search owner usable", async (t) => {
  const f = await fixture(t);
  const retained = await f.create("retained-session");
  await f.index.indexSessionFile("retained-session", retained);
  assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
  const [owner] = f.databases;
  assert.ok(owner);
  for (let i = 0; i < 12; i++) {
    const id = `deleted-session-${i}`;
    await f.index.indexSessionFile(id, await f.create(id));
    await deleteSessionArtifacts(f.workspace, id);
    assert.equal(f.databases.size, 1, "cleanup must not open a SQLite connection on the caller thread");
    for (const database of f.databases) {
      assert.equal(database.isOpen, database === owner, "only the pre-existing search owner may remain open");
    }
    assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
    assert.equal(f.index.grep("retained-session")[0]?.sessionId, "retained-session");
    assert.deepEqual(f.index.grep(id), []);
  }
});

test("closing a reopened query owner releases its new SQLite connection", async (t) => {
  const f = await fixture(t);
  await f.index.indexSessionFile("reopened-session", await f.create("reopened-session"));
  assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
  await f.index.close();
  assert.equal(f.databases.size, 1);
  for (const database of f.databases) assert.equal(database.isOpen, false);
  assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
  assert.equal(f.databases.size, 2);
  assert.equal([...f.databases].filter(database => database.isOpen).length, 1);
  await f.index.close();
  for (const database of f.databases) assert.equal(database.isOpen, false);
});

for (const missingTranscript of [false, true]) {
  test(`public cleanup preserves a same-id source in another workspace (missing transcript: ${missingTranscript})`, async (t) => {
    const f = await fixture(t);
    const targetFile = await f.create("shared-session");
    const otherWorkspace = path.join(path.dirname(f.workspace), "other-workspace");
    await mkdir(otherWorkspace);
    await ensureAgentDirs(otherWorkspace);
    const otherFile = await createSessionFile(otherWorkspace, "shared-session", Buffer.from(`${JSON.stringify({
      type: "user_message", messageId: "retained-message", content: "another workspace retained marker"
    })}\n`));
    const original = await readFile(otherFile);
    await f.index.indexSessionFile("shared-session", otherFile);
    assert.equal(f.index.search("retained marker")[0]?.messageId, "retained-message");
    if (missingTranscript) {
      await rm(targetFile);
      await assert.rejects(deleteSessionArtifacts(f.workspace, "shared-session"), /Session not found/);
    } else {
      await deleteSessionArtifacts(f.workspace, "shared-session");
    }
    assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
    assert.equal(f.index.search("retained marker")[0]?.messageId, "retained-message");
    assert.deepEqual(await readFile(otherFile), original);
  });
}

test("missing transcript cleanup removes only its workspace's indexed orphan", async (t) => {
  const f = await fixture(t);
  const targetFile = await f.create("orphan-session");
  const otherWorkspace = path.join(path.dirname(f.workspace), "orphan-neighbor");
  await mkdir(otherWorkspace);
  await ensureAgentDirs(otherWorkspace);
  const otherFile = await createSessionFile(otherWorkspace, "orphan-session", Buffer.from(`${JSON.stringify({
    type: "user_message", messageId: "retained-orphan-id", content: "another workspace orphan marker"
  })}\n`));
  await f.index.indexSessionFile("orphan-session", targetFile);
  await f.index.indexSessionFile("orphan-session", otherFile);
  assert.deepEqual(f.index.status(), { indexedSessions: 2, indexedMessages: 2 });
  await rm(targetFile);
  await assert.rejects(deleteSessionArtifacts(f.workspace, "orphan-session"), /Session not found/);
  assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
  assert.deepEqual(f.index.grep("marker").map(hit => hit.messageId), ["retained-orphan-id"]);
});

for (const missingTranscript of [false, true]) {
  test(`failed search deletion closes its connection and preserves the first cleanup error (missing transcript: ${missingTranscript})`, async (t) => {
    const f = await fixture(t);
    const file = await f.create("failed-session");
    await f.index.indexSessionFile("failed-session", file);
    assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
    await f.index.close();
    const setup = new DatabaseSync(path.join(f.agentRoot, "search", sessionSearchDatabaseFileName));
    try {
      setup.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON session_index_state BEGIN SELECT RAISE(ABORT, 'cleanup blocked'); END");
    } finally {
      setup.close();
    }
    if (missingTranscript) await rm(file);
    await assert.rejects(deleteSessionArtifacts(f.workspace, "failed-session"),
      missingTranscript ? /Session not found/ : /cleanup blocked/);
    assert.equal(f.databases.size, 1, "the cleanup connection belongs to the worker");
    for (const database of f.databases) assert.equal(database.isOpen, false);
    assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 }, "a failed cleanup rolls back transcript rows and offset together");
    assert.equal(f.index.grep("failed-session")[0]?.sessionId, "failed-session");
  });
}

test("earlier cleanup failure still releases a successfully cleaned search index", async (t) => {
  const f = await fixture(t);
  await assert.rejects(deleteSessionArtifacts(f.workspace, "already-missing"), /Session not found/);
  assert.equal(f.databases.size, 0);
  for (const database of f.databases) assert.equal(database.isOpen, false);
});

test("cleanup leaves a legacy index untouched and does not create the current index", async (t) => {
  const f = await fixture(t);
  await f.create("legacy-session");
  const searchRoot = path.join(f.agentRoot, "search");
  await mkdir(searchRoot);
  const legacyPath = path.join(searchRoot, "sessions.sqlite");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE session_index_state (session_id TEXT PRIMARY KEY, byte_offset INTEGER, updated_at TEXT)");
  legacy.prepare("INSERT INTO session_index_state VALUES (?, ?, ?)").run("legacy-session", 40, "2026-10-14");
  legacy.close();
  const original = await readFile(legacyPath);
  await deleteSessionArtifacts(f.workspace, "legacy-session");
  assert.deepEqual(await readFile(legacyPath), original);
  await assert.rejects(access(path.join(searchRoot, sessionSearchDatabaseFileName)), { code: "ENOENT" });
  assert.equal(f.databases.size, 0);
});

test("source-root deletion respects a complete directory boundary", async (t) => {
  const f = await fixture(t);
  const sourceRoot = path.join(f.workspace, "source");
  const neighborRoot = `${sourceRoot}-neighbor`;
  await mkdir(sourceRoot);
  await mkdir(neighborRoot);
  const sourceFile = path.join(sourceRoot, "boundary-session.jsonl");
  const neighborFile = path.join(neighborRoot, "boundary-session.jsonl");
  await writeFile(sourceFile, `${JSON.stringify({ type: "user_message", content: "remove target marker" })}\n`);
  await writeFile(neighborFile, `${JSON.stringify({ type: "user_message", content: "retain neighbor marker" })}\n`);
  await f.index.indexSessionFile("boundary-session", sourceFile);
  await f.index.indexSessionFile("boundary-session", neighborFile);
  assert.deepEqual(f.index.status(), { indexedSessions: 2, indexedMessages: 2 });
  await f.index.forgetSession("boundary-session", { sourceRoot });
  assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
  assert.equal(f.index.search("neighbor marker")[0]?.excerpt, "retain neighbor marker");
  assert.deepEqual(f.index.search("target marker"), []);
});

test("an abort-shaped failure after search work is propagated only after its owned connection is released", async (t) => {
  const f = await fixture(t);
  await f.index.indexSessionFile("interrupted-session", await f.create("interrupted-session"));
  assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
  await f.index.close();
  const reason = new DOMException("cleanup interrupted", "AbortError");
  const forget = SessionSearchIndex.prototype.forgetSession;
  // cleanup 本身没有取消 API；注入取消类异常，覆盖异常退出时的资源所有权。
  t.mock.method(SessionSearchIndex.prototype, "forgetSession", async function (this: SessionSearchIndex, id: string, scope: SessionSearchCleanupScope) {
    await forget.call(this, id, scope);
    throw reason;
  });
  await assert.rejects(deleteSessionArtifacts(f.workspace, "interrupted-session"), (error) => error === reason);
  assert.equal(f.databases.size, 1);
  for (const database of f.databases) assert.equal(database.isOpen, false);
  assert.deepEqual(f.index.status(), { indexedSessions: 0, indexedMessages: 0 });
  assert.deepEqual(f.index.grep("interrupted-session"), []);
});

test("search initialization failure preserves its error without leaking or double-closing the database", async (t) => {
  const f = await fixture(t);
  await f.create("broken-index-session");
  await mkdir(path.join(f.agentRoot, "search"));
  await writeFile(path.join(f.agentRoot, "search", sessionSearchDatabaseFileName), "not a sqlite database");
  await assert.rejects(deleteSessionArtifacts(f.workspace, "broken-index-session"), /not a database/);
  assert.equal(f.databases.size, 0);
  for (const database of f.databases) assert.equal(database.isOpen, false);
});

// A competing WAL writer must not prevent the caller's event loop from releasing that lock.
test("search deletion keeps the caller responsive while a real SQLite writer holds the index", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const lockedFile = await f.create("locked-session");
  const nextFile = await f.create("next-session");
  await f.index.indexSessionFile("locked-session", lockedFile);
  await f.index.indexSessionFile("next-session", nextFile);
  const writer = new DatabaseSync(path.join(f.agentRoot, "search", sessionSearchDatabaseFileName));
  writer.exec("BEGIN IMMEDIATE");
  let released = false;
  const release = setImmediate(() => { writer.exec("COMMIT"); released = true; });
  try {
    const first = f.index.forgetSession("locked-session", { sourcePath: lockedFile });
    const next = f.index.forgetSession("next-session", { sourcePath: nextFile });
    await Promise.all([first, next]);
    assert.equal(released, true, "the caller can process events before the delete finishes");
    assert.deepEqual(f.index.status(), { indexedSessions: 0, indexedMessages: 0 });
  } finally {
    clearImmediate(release);
    if (!released) writer.exec("ROLLBACK");
    writer.close();
  }
});
