import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, mock } from "node:test";
import { buildSessionTree, refreshSessionIndex, getSessionCatalogItem, updateSessionCatalogMetadata, sessionCatalogDirectory, type SessionCatalogItem } from "../src/session/catalog.js";
import { listSessionSummaries, readStoredSessionEvents, parseSessionEventsDetailed } from "../src/session/events.js";
import { maxSessionEvents } from "../src/session/limits.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-performance-"));
  await ensureAgentDirs(root);
  return await fs.realpath(root);
}

function item(id: string, parentSessionId?: string): SessionCatalogItem {
  return { id, fileName: `${id}.jsonl`, rootSessionId: "0", parentSessionId, hasChildren: false,
    summary: { fileName: `${id}.jsonl`, firstUserMessage: id, lastAssistantMessage: "", eventCount: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" } };
}

test("deep session trees preserve every node without recursive stack growth", () => {
  const items = Array.from({ length: 12000 }, (_, i) => item(String(i), i ? String(i - 1) : undefined));
  const tree = buildSessionTree(items);
  assert.equal(tree.length, 1);
  let nodes = tree;
  let count = 0;
  while (nodes.length) {
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.session.id, String(count++));
    nodes = nodes[0]!.children;
  }
  assert.equal(count, items.length);
  const cycle = buildSessionTree([item("a", "b"), item("b", "a"), item("orphan", "missing"), item("self", "self")]);
  const seen = new Set<string>();
  const pending = [...cycle];
  while (pending.length) { const node = pending.pop()!; assert.ok(!seen.has(node.session.id)); seen.add(node.session.id); pending.push(...node.children); }
  assert.equal(seen.size, 4);
});

test("list scans cache summaries without evicting active events or rereading bodies", async () => {
  const root = await workspace();
  try {
    for (let i = 0; i < 40; i++) await createSessionFile(root, `s-${i}`, Buffer.from(`${JSON.stringify({ type: "user_message", content: String(i) })}\n`));
    const opened = await readStoredSessionEvents(root, "s-0");
    await listSessionSummaries(root);
    const originalOpen = fs.open.bind(fs);
    const reads: Array<{ mock: { callCount(): number } }> = [];
    const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".jsonl")) reads.push(mock.method(handle, "read"));
      return handle;
    });
    try {
      assert.equal((await listSessionSummaries(root)).length, 40);
      assert.equal((await readStoredSessionEvents(root, "s-0")).events, opened.events);
      assert.equal(reads.reduce((sum, read) => sum + read.mock.callCount(), 0), 0, "warm reads must validate identity without reading JSONL bytes");
    } finally { spy.mock.restore(); }
    const file = (await readStoredSessionEvents(root, "s-0")).filePath;
    const beforeRewrite = await fs.stat(file);
    await fs.writeFile(file, `${JSON.stringify({ type: "user_message", content: "x" })}\n`);
    await fs.utimes(file, beforeRewrite.atime, beforeRewrite.mtime);
    assert.equal((await readStoredSessionEvents(root, "s-0")).events[0]?.type, "user_message");
    assert.equal((await listSessionSummaries(root)).find(s => s.fileName === "s-0.jsonl")?.firstUserMessage, "x", "same-size rewrites must invalidate even when mtime is restored");
    await fs.link(file, `${file}.hardlink`);
    await assert.rejects(readStoredSessionEvents(root, "s-0"));
    await fs.unlink(`${file}.hardlink`);
    await fs.appendFile(file, `${JSON.stringify({ type: "assistant_message", content: "new" })}\n`);
    assert.equal((await listSessionSummaries(root)).find(s => s.fileName === "s-0.jsonl")?.eventCount, 2);
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, `${JSON.stringify({ type: "user_message", content: "replacement" })}\n`);
    assert.equal((await listSessionSummaries(root)).find(s => s.fileName === "s-0.jsonl")?.firstUserMessage, "replacement");
    await fs.unlink(file);
    await fs.symlink(`${file}.old`, file);
    await assert.rejects(readStoredSessionEvents(root, "s-0"));
    assert.equal((await listSessionSummaries(root)).length, 39);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("single catalog lookup does not read unrelated JSONL bodies", async () => {
  const root = await workspace();
  try {
    for (const id of ["target", "unrelated"]) await createSessionFile(root, id, Buffer.from('{"type":"user_message","content":"hello"}\n'));
    const originalOpen = fs.open.bind(fs);
    let unrelatedReads = 0;
    const spy = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith("unrelated.jsonl")) unrelatedReads++;
      return handle;
    });
    try {
      assert.equal((await getSessionCatalogItem(root, "target"))?.id, "target");
      assert.equal(unrelatedReads, 0);
      assert.equal(await getSessionCatalogItem(root, "missing"), undefined);
    } finally { spy.mock.restore(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("tool lookup uses the tool ID index after reopening an existing database", async () => {
  const root = await workspace();
  let authority = await RuntimeEventAuthority.open(root);
  try {
    authority.appendEvent({ sessionId: "s", runId: "r", turnId: "t", eventType: "session.tool_call", payload: { toolCallId: "wanted" } });
    const databasePath = authority.databasePath;
    authority.close();
    const old = new DatabaseSync(databasePath);
    old.exec("DROP INDEX IF EXISTS runtime_events_toolcall_idx; PRAGMA user_version = 9");
    old.close();
    authority = await RuntimeEventAuthority.open(root);
    let lookupSql = "";
    const connection = authority.databaseHandle();
    const prepare = connection.prepare.bind(connection);
    const spy = mock.method(connection, "prepare", (sql: string) => {
      lookupSql = sql;
      return prepare(sql);
    });
    try { assert.equal(authority.readToolEvents(["wanted", "another", "wanted"]).length, 1); }
    finally { spy.mock.restore(); }
    const db = new DatabaseSync(databasePath);
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${lookupSql}`).all(authority.workspaceId, "wanted", "another");
      assert.match(JSON.stringify(plan), /runtime_events_toolcall_idx/);
    } finally { db.close(); }
  } finally { authority.close(); await fs.rm(root, { recursive: true, force: true }); }
});

for (const mode of ["writer", "reader"] as const) test(`catalog ${mode} contention leaves the event loop available to release its owner`, { timeout: 10000 }, async () => {
  const root = await workspace();
  let child: ReturnType<typeof fork> | undefined;
  try {
    await createSessionFile(root, "locked", Buffer.from('{"type":"user_message","content":"hello"}\n'));
    await updateSessionCatalogMetadata(root, "locked", { title: "before" });
    const dbPath = path.join(sessionCatalogDirectory(root), ".locks", "locked.sqlite");
    const script = path.join(root, "lock.cjs");
    await fs.writeFile(script, `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[2]); db.exec(${JSON.stringify(mode === "writer" ? "BEGIN IMMEDIATE" : "BEGIN")}); db.prepare('SELECT name FROM sqlite_master').all(); process.send('locked'); const done=()=>{db.exec('COMMIT');db.close();process.exit(0)}; process.once('message',done); setTimeout(done,2000);`);
    child = fork(script, [dbPath], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    await new Promise<void>((resolve, reject) => { child!.once("message", () => resolve()); child!.once("error", reject); child!.once("exit", () => reject(new Error("lock owner exited before ready"))); });
    const start = performance.now();
    const timer = setTimeout(() => child?.send("release"), 50);
    try { await updateSessionCatalogMetadata(root, "locked", { title: "after" }); }
    finally { clearTimeout(timer); }
    assert.ok(performance.now() - start < 1000, "waiting for SQLite must yield so the release timer can run");
  } finally { child?.kill(); await fs.rm(root, { recursive: true, force: true }); }
});

test("overflow retains ordered tail and still rejects invalid terminated rows", () => {
  const raw = Array.from({ length: 2 * maxSessionEvents + 7 }, (_, i) => JSON.stringify({ type: "user_message", content: String(i) })).join("\n") + "\n";
  const parsed = parseSessionEventsDetailed(raw, { overflow: "truncate" });
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.events.length, maxSessionEvents);
  assert.deepEqual(parsed.events[0], { type: "user_message", content: String(maxSessionEvents + 7) });
  assert.deepEqual(parsed.events.at(-1), { type: "user_message", content: String(2 * maxSessionEvents + 6) });
  assert.throws(() => parseSessionEventsDetailed(raw + '{}\n', { overflow: "truncate" }));
  assert.throws(() => parseSessionEventsDetailed(raw));
});


test("concurrent index refreshes serialize publication and include writes during a scan", { timeout: 10000 }, async () => {
  const root = await workspace();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const originalRename = fs.rename.bind(fs);
  let publishes = 0;
  let active = 0;
  let maxActive = 0;
  const spy = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (path.basename(String(args[1])) !== "index.json") return await originalRename(...args);
    active++;
    maxActive = Math.max(maxActive, active);
    publishes++;
    if (publishes === 1) { entered(); await gate; }
    try { await originalRename(...args); } finally { active--; }
  });
  try {
    const file = await createSessionFile(root, "refresh", Buffer.from('{"type":"user_message","content":"hello"}\n'));
    const first = refreshSessionIndex(root);
    await started;
    await fs.appendFile(file, '{"type":"assistant_message","content":"new"}\n');
    const later = Array.from({ length: 10 }, () => refreshSessionIndex(root));
    release();
    await Promise.all([first, ...later]);
    assert.equal(maxActive, 1);
    assert.equal(publishes, 2);
    const index = JSON.parse(await fs.readFile(path.join(sessionCatalogDirectory(root), "..", "index.json"), "utf8")) as { sessions: Array<{ eventCount: number }> };
    assert.equal(index.sessions[0]?.eventCount, 2);
  } finally { release(); spy.mock.restore(); await fs.rm(root, { recursive: true, force: true }); }
});
