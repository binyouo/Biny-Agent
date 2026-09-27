import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { projectSessionsDir } from "../src/config/paths.js";
import { agentDir, ensureAgentDirs, sessionFilePath } from "../src/session/store.js";

const event = (content: string): string => `${JSON.stringify({ type: "user_message", content })}\n`;

async function workspace(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-backfill-"));
  await ensureAgentDirs(root);
  const file = sessionFilePath(root, "backfill-test");
  return { root, file };
}

async function open(root: string): Promise<RuntimeEventAuthority> {
  return await RuntimeEventAuthority.open(root);
}

function watermark(root: string): { event_count: number; file_size: number; content_hash: string | null } {
  const db = new DatabaseSync(path.join(agentDir(root), "runtime.sqlite"));
  try {
    return db.prepare("SELECT event_count, file_size, content_hash FROM runtime_backfills WHERE session_id = ?").get("backfill-test") as { event_count: number; file_size: number; content_hash: string | null };
  } finally { db.close(); }
}

test("verified append projects only new events and advances the watermark", async () => {
  const { root, file } = await workspace();
  try {
    await writeFile(file, event("first").repeat(400));
    (await open(root)).close();
    const previous = watermark(root);
    assert.equal(previous.event_count, 400);
    assert.equal(previous.content_hash, createHash("sha256").update(await readFile(file)).digest("hex"));
    await appendFile(file, event("last"));
    const original = DatabaseSync.prototype.prepare;
    let oldEventLookups = 0;
    const spy = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.includes("FROM runtime_events WHERE event_id = ?")) oldEventLookups++;
      return original.call(this, sql);
    });
    let authority: RuntimeEventAuthority | undefined;
    try { authority = await open(root); }
    finally { spy.mock.restore(); }
    try {
      assert.ok(authority);
      assert.equal(authority.readEvents({ sessionId: "backfill-test", limit: 1000 }).events.length, 401);
      assert.ok(oldEventLookups <= 2, `append replay checked ${oldEventLookups} old events`);
    } finally { authority?.close(); }
    const current = watermark(root);
    assert.equal(current.event_count, 401);
    assert.equal(current.content_hash, createHash("sha256").update(await readFile(file)).digest("hex"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rewritten prefix takes the full conflict-check path without moving the watermark", async () => {
  const { root, file } = await workspace();
  try {
    await writeFile(file, event("first") + event("second"));
    (await open(root)).close();
    const previous = watermark(root);
    await writeFile(file, event("changed") + event("second") + event("third"));
    await assert.rejects(open(root), /already bound to another fact/);
    assert.deepEqual(watermark(root), previous);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema upgrade without an old content hash replays the next change conservatively", async () => {
  const { root, file } = await workspace();
  try {
    await writeFile(file, event("first"));
    (await open(root)).close();
    const db = new DatabaseSync(path.join(agentDir(root), "runtime.sqlite"));
    try { db.exec("ALTER TABLE runtime_backfills DROP COLUMN content_hash; PRAGMA user_version = 10"); }
    finally { db.close(); }
    await appendFile(file, event("second"));
    const authority = await open(root);
    try { assert.equal(authority.readEvents({ sessionId: "backfill-test" }).events.length, 2); }
    finally { authority.close(); }
    assert.equal(watermark(root).event_count, 2);
    assert.equal(watermark(root).content_hash, createHash("sha256").update(await readFile(file)).digest("hex"));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("same-size rewrite with restored mtime still checks the old projection", async () => {
  const { root, file } = await workspace();
  try {
    await writeFile(file, event("first"));
    (await open(root)).close();
    const before = await stat(file);
    const previous = watermark(root);
    await writeFile(file, event("other"));
    await utimes(file, before.atime, before.mtime);
    await assert.rejects(open(root), /already bound to another fact/);
    assert.deepEqual(watermark(root), previous);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid appended event leaves the previous projection and watermark intact", async () => {
  const { root, file } = await workspace();
  try {
    await writeFile(file, event("first"));
    (await open(root)).close();
    const previous = watermark(root);
    await appendFile(file, "{bad json}\n");
    const authority = await open(root);
    try { assert.equal(authority.readEvents({ sessionId: "backfill-test" }).events.length, 1); }
    finally { authority.close(); }
    assert.deepEqual(watermark(root), previous);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("reconciliation resolves each session from one validated directory enumeration", async () => {
  const { root } = await workspace();
  try {
    const directory = projectSessionsDir(await realpath(root));
    for (let i = 0; i < 50; i++) await writeFile(path.join(directory, `history-${i}.jsonl`), event(String(i)));
    (await open(root)).close();
    const original = realpath.bind((await import("node:fs")).promises);
    let resolutions = 0;
    const fs = (await import("node:fs")).promises;
    const spy = mock.method(fs, "realpath", async (...args: Parameters<typeof realpath>) => {
      if (String(args[0]) === root) resolutions++;
      return await original(...args);
    });
    try { (await open(root)).close(); }
    finally { spy.mock.restore(); }
    assert.ok(resolutions <= 3, `reopened authority resolved workspace storage ${resolutions} times`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
