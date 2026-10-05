/** 临时检索索引必须随一次清理结束释放，不能依赖 GC 或关闭其它调用方的连接。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";
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
    index.close();
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
  const [owner] = f.databases;
  assert.ok(owner);
  for (let i = 0; i < 12; i++) {
    const id = `deleted-session-${i}`;
    await f.index.indexSessionFile(id, await f.create(id));
    await deleteSessionArtifacts(f.workspace, id);
    assert.equal(f.databases.size, i + 2, "each cleanup opens its own temporary index");
    for (const database of f.databases) {
      assert.equal(database.isOpen, database === owner, "only the pre-existing search owner may remain open");
    }
    assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
    assert.equal(f.index.grep("retained-session")[0]?.sessionId, "retained-session");
    assert.deepEqual(f.index.grep(id), []);
  }
});

for (const missingTranscript of [false, true]) {
  test(`failed search deletion closes its connection and preserves the first cleanup error (missing transcript: ${missingTranscript})`, async (t) => {
    const f = await fixture(t);
    const file = await f.create("failed-session");
    await f.index.indexSessionFile("failed-session", file);
    f.index.close();
    const setup = new DatabaseSync(path.join(f.agentRoot, "search", "sessions.sqlite"));
    try {
      setup.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON session_index_state BEGIN SELECT RAISE(ABORT, 'cleanup blocked'); END");
    } finally {
      setup.close();
    }
    if (missingTranscript) await rm(file);
    await assert.rejects(deleteSessionArtifacts(f.workspace, "failed-session"),
      missingTranscript ? /Session not found/ : /cleanup blocked/);
    assert.equal(f.databases.size, 2, "cleanup reached a separate real search connection");
    for (const database of f.databases) assert.equal(database.isOpen, false);
  });
}

test("earlier cleanup failure still releases a successfully cleaned search index", async (t) => {
  const f = await fixture(t);
  await assert.rejects(deleteSessionArtifacts(f.workspace, "already-missing"), /Session not found/);
  assert.equal(f.databases.size, 1);
  for (const database of f.databases) assert.equal(database.isOpen, false);
});

test("an abort-shaped failure after search work is propagated only after its owned connection is released", async (t) => {
  const f = await fixture(t);
  await f.create("interrupted-session");
  const reason = new DOMException("cleanup interrupted", "AbortError");
  const forget = SessionSearchIndex.prototype.forgetSession;
  // cleanup 本身没有取消 API；注入取消类异常，覆盖异常退出时的资源所有权。
  t.mock.method(SessionSearchIndex.prototype, "forgetSession", function (this: SessionSearchIndex, id: string) {
    forget.call(this, id);
    throw reason;
  });
  await assert.rejects(deleteSessionArtifacts(f.workspace, "interrupted-session"), (error) => error === reason);
  assert.equal(f.databases.size, 1);
  for (const database of f.databases) assert.equal(database.isOpen, false);
});

test("search initialization failure preserves its error without leaking or double-closing the database", async (t) => {
  const f = await fixture(t);
  await f.create("broken-index-session");
  await mkdir(path.join(f.agentRoot, "search"));
  await writeFile(path.join(f.agentRoot, "search", "sessions.sqlite"), "not a sqlite database");
  await assert.rejects(deleteSessionArtifacts(f.workspace, "broken-index-session"), /not a database/);
  assert.equal(f.databases.size, 1);
  for (const database of f.databases) assert.equal(database.isOpen, false);
});
