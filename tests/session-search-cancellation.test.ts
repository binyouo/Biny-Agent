/** Cancellation stops history work at I/O/transaction boundaries without narrowing its global scope. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHistoryTools } from "../src/extensions/history.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";
import { listAllSessionFiles } from "../src/session/store.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const row = (messageId: string, content = "history cancellation marker"): string =>
  `${JSON.stringify({ type: "user_message", messageId, content })}\n`;

test("pre-aborted history calls never acquire an index or touch transcript storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-preabort-"));
  const reason = new Error("history cancelled before admission");
  const signal = AbortSignal.abort(reason);
  const index = new SessionSearchIndex(root);
  let gets = 0;
  let flushes = 0;
  const [tool] = createHistoryTools({
    getIndex: () => { gets++; return index; },
    flushCurrentSession: async () => { flushes++; }
  });
  assert.ok(tool);
  const execution = await tool.resolveExecution({ query: "history" });
  assert.ok(!("isError" in execution));
  try {
    await assert.rejects(execution.execute({ toolCallId: "preabort", operationId: "preabort", signal }), (error) => error === reason);
    await assert.rejects(index.refreshAll({ signal }), (error) => error === reason);
    await assert.rejects(index.indexSessionFile("missing", path.join(root, "missing.jsonl"), signal), (error) => error === reason);
    await assert.rejects(listAllSessionFiles(root, signal), (error) => error === reason);
    assert.throws(() => index.search("history", { signal }), (error) => error === reason);
    assert.equal(gets, 0);
    assert.equal(flushes, 0);
    await assert.rejects(fs.access(path.join(root, "search")), { code: "ENOENT" });
  } finally {
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const stage of ["flush", "refresh", "search"] as const) {
  test(`history forwards cancellation through ${stage} and suppresses later work/results`, async (t) => {
    const controller = new AbortController();
    const reason = new Error(`cancel during ${stage}`);
    const index = new SessionSearchIndex(() => { throw new Error("Test must not open storage."); });
    const calls: string[] = [];
    t.mock.method(index, "refreshAll", async (options: Parameters<SessionSearchIndex["refreshAll"]>[0]) => {
      calls.push("refresh");
      assert.equal(options?.signal, controller.signal);
      if (stage === "refresh") controller.abort(reason);
    });
    t.mock.method(index, "search", (_query: string, options: Parameters<SessionSearchIndex["search"]>[1]) => {
      calls.push("search");
      assert.equal(options?.signal, controller.signal);
      assert.equal(options?.sessionIds, undefined, "history still searches across projects");
      if (stage === "search") controller.abort(reason);
      return [];
    });
    const [tool] = createHistoryTools({
      getIndex: () => index,
      flushCurrentSession: async (signal) => {
        calls.push("flush");
        assert.equal(signal, controller.signal);
        if (stage === "flush") controller.abort(reason);
      }
    });
    assert.ok(tool);
    const execution = await tool.resolveExecution({ query: "marker" });
    assert.ok(!("isError" in execution));
    await assert.rejects(execution.execute({ toolCallId: stage, operationId: stage, signal: controller.signal }), (error) => error === reason);
    assert.deepEqual(calls, stage === "flush" ? ["flush"] : stage === "refresh" ? ["flush", "refresh"] : ["flush", "refresh", "search"]);
  });
}

test("live cancellable history searches retain global cross-project scope and current-session flush", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-scope-"));
  const current = path.join(root, "sessions", "current-project", "current.jsonl");
  const external = path.join(root, "sessions", "other-project", "external.jsonl");
  await fs.mkdir(path.dirname(current), { recursive: true });
  await fs.mkdir(path.dirname(external), { recursive: true });
  await fs.writeFile(current, row("current"));
  await fs.writeFile(external, row("external"));
  const index = new SessionSearchIndex(root);
  const controller = new AbortController();
  const [tool] = createHistoryTools({
    getIndex: () => index,
    flushCurrentSession: async (signal) => { await index.indexSessionFile("current", current, signal); }
  });
  assert.ok(tool);
  const execution = await tool.resolveExecution({ query: "history cancellation marker" });
  assert.ok(!("isError" in execution));
  try {
    const result = await execution.execute({ toolCallId: "scope", operationId: "scope", signal: controller.signal }) as { hits: Array<{ sessionId: string }> };
    assert.deepEqual(result.hits.map((hit) => hit.sessionId).sort(), ["current", "external"]);
    assert.deepEqual(index.search("history cancellation marker", { sessionIds: ["current"], signal: controller.signal }).map((hit) => hit.sessionId), ["current"]);
    assert.equal(index.status().indexedMessages, 2, "current flush plus global scan does not duplicate messages");
  } finally {
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const cancelOwner of [true, false]) {
  test(`cancelling a shared refresh ${cancelOwner ? "owner" : "joiner"} leaves its live caller intact`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-shared-abort-"));
    const directory = path.join(root, "sessions");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "shared.jsonl"), row("shared"));
    const gate = deferred();
    const started = deferred();
    const originalReaddir = fs.readdir;
    let scans = 0;
    t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
      if (path.resolve(String(args[0])) === directory) {
        scans++;
        started.resolve();
        await gate.promise;
      }
      return await Reflect.apply(originalReaddir, fs, args);
    });
    syncBuiltinESMExports();
    const index = new SessionSearchIndex(root);
    const controller = new AbortController();
    const reason = new Error("cancel one shared caller");
    const owner = index.refreshAll(cancelOwner ? { signal: controller.signal } : {});
    const joiner = index.refreshAll(cancelOwner ? {} : { signal: controller.signal });
    const cancelled = cancelOwner ? owner : joiner;
    const live = cancelOwner ? joiner : owner;
    const rejected = assert.rejects(cancelled, (error) => error === reason);
    try {
      await started.promise;
      controller.abort(reason);
      await rejected;
      assert.equal(scans, 1);
      gate.resolve();
      await live;
      assert.equal(index.search("history cancellation marker").length, 1);
      await index.refreshAll({ maxAgeMs: 60_000 });
      assert.equal(scans, 1, "the live caller's completed scan can populate freshness cache");
    } finally {
      gate.resolve();
      await Promise.allSettled([owner, joiner]);
      index.close();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("the last cancelled waiter drains traversal; a new caller retries after cleanup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-all-abort-"));
  const directory = path.join(root, "sessions");
  const project = path.join(directory, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "resumed.jsonl"), row("resumed"));
  const gate = deferred();
  const started = deferred();
  const originalReaddir = fs.readdir;
  const scans: string[] = [];
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const target = path.resolve(String(args[0]));
    scans.push(target);
    if (scans.length === 1) {
      started.resolve();
      await gate.promise;
    }
    return await Reflect.apply(originalReaddir, fs, args);
  });
  syncBuiltinESMExports();
  const index = new SessionSearchIndex(root);
  const firstController = new AbortController();
  const lastController = new AbortController();
  const firstReason = new Error("first caller cancelled");
  const lastReason = new Error("last caller cancelled");
  const first = index.refreshAll({ signal: firstController.signal });
  const last = index.refreshAll({ signal: lastController.signal });
  const firstRejected = assert.rejects(first, (error) => error === firstReason);
  const lastRejected = assert.rejects(last, (error) => error === lastReason);
  let drained = false;
  void lastRejected.then(() => { drained = true; });
  let replacement: Promise<void> | undefined;
  try {
    await started.promise;
    firstController.abort(firstReason);
    await firstRejected;
    lastController.abort(lastReason);
    replacement = index.refreshAll({ maxAgeMs: 60_000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false, "the final cancelled caller must wait for the uncancellable readdir to settle");
    assert.deepEqual(scans, [directory], "replacement cannot overlap cancelled traversal cleanup");
    gate.resolve();
    await lastRejected;
    await replacement;
    assert.deepEqual(scans, [directory, directory, project], "abandoned scan stops before descending and does not set freshness");
    assert.equal(index.status().indexedMessages, 1);
    assert.equal(index.search("history cancellation marker").length, 1);
  } finally {
    gate.resolve();
    await Promise.allSettled([first, last, ...(replacement ? [replacement] : [])]);
    index.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancelled transcript reads close their handle before returning and preserve index offsets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-read-abort-"));
  const file = path.join(root, "read.jsonl");
  await fs.writeFile(file, row("read"));
  const gate = deferred();
  const started = deferred();
  const originalOpen = fs.open;
  let closes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await Reflect.apply(originalOpen, fs, args);
    if (path.resolve(String(args[0])) === file) {
      const originalRead = handle.read;
      const originalClose = handle.close;
      t.mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
        started.resolve();
        await gate.promise;
        return await Reflect.apply(originalRead, handle, readArgs);
      });
      t.mock.method(handle, "close", async () => { closes++; await originalClose.call(handle); });
    }
    return handle;
  });
  syncBuiltinESMExports();
  const index = new SessionSearchIndex(root);
  const controller = new AbortController();
  const reason = new Error("cancel transcript read");
  const read = index.indexSessionFile("read", file, controller.signal);
  const rejected = assert.rejects(read, (error) => error === reason);
  let settled = false;
  void rejected.then(() => { settled = true; });
  try {
    await started.promise;
    controller.abort(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(closes, 0);
    gate.resolve();
    await rejected;
    assert.equal(closes, 1);
    assert.deepEqual(index.status(), { indexedSessions: 0, indexedMessages: 0 });
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(await index.indexSessionFile("read", file), 1);
    assert.equal(await index.indexSessionFile("read", file), 0);
  } finally {
    gate.resolve();
    await Promise.allSettled([read]);
    index.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancellation rolls back the current batch and resumes from the last committed byte offset", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-batch-abort-"));
  const file = path.join(root, "batch.jsonl");
  const lines = Array.from({ length: 300 }, (_, offset) => row(`message-${offset}`, `history batch marker ${offset}`));
  await fs.writeFile(file, lines.join(""));
  const index = new SessionSearchIndex(root);
  const controller = new AbortController();
  const reason = new Error("cancel in second batch");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let inserts = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith("INSERT INTO session_transcripts")) {
      const originalRun = statement.run;
      t.mock.method(statement, "run", (...args: Parameters<typeof statement.run>) => {
        const result = Reflect.apply(originalRun, statement, args);
        inserts++;
        if (inserts === 130) controller.abort(reason);
        return result;
      });
    }
    return statement;
  });
  let database: DatabaseSync | undefined;
  try {
    await assert.rejects(index.indexSessionFile("batch", file, controller.signal), (error) => error === reason);
    assert.equal(index.status().indexedMessages, 128, "only complete batches remain committed");
    database = new DatabaseSync(path.join(root, "search", "sessions.sqlite"));
    const state = database.prepare("SELECT byte_offset FROM session_index_state WHERE session_id = ?").get("batch");
    assert.equal(state?.byte_offset, Buffer.byteLength(lines.slice(0, 128).join("")));
    t.mock.restoreAll();
    assert.equal(await index.indexSessionFile("batch", file), 172);
    assert.equal(await index.indexSessionFile("batch", file), 0);
    assert.equal(index.status().indexedMessages, 300);
    assert.equal(index.search("history batch marker 299").length, 1);
  } finally {
    t.mock.restoreAll();
    database?.close();
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancellation during truncated-file reset rolls back transcript rows and offset together", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-truncate-abort-"));
  const file = path.join(root, "truncated.jsonl");
  const original = row("old-first", `original transcript marker ${"x".repeat(1_000)}`)
    + row("old-second", `original transcript marker ${"x".repeat(1_000)}`);
  await fs.writeFile(file, original);
  const index = new SessionSearchIndex(root);
  let database: DatabaseSync | undefined;
  try {
    assert.equal(await index.indexSessionFile("truncated", file), 2);
    database = new DatabaseSync(path.join(root, "search", "sessions.sqlite"));
    await fs.writeFile(file, row("new", "rebuilt transcript marker"));
    const controller = new AbortController();
    const reason = new Error("cancel after resetting transcript rows");
    const originalPrepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql === "DELETE FROM session_transcripts WHERE session_id = ?") {
        const originalRun = statement.run;
        t.mock.method(statement, "run", (...args: Parameters<typeof statement.run>) => {
          const result = Reflect.apply(originalRun, statement, args);
          controller.abort(reason);
          return result;
        });
      }
      return statement;
    });

    await assert.rejects(index.indexSessionFile("truncated", file, controller.signal), (error) => error === reason);
    assert.equal(index.status().indexedMessages, 2, "cancelled reset restores the previous transcript rows");
    const state = database.prepare("SELECT byte_offset FROM session_index_state WHERE session_id = ?").get("truncated");
    assert.equal(state?.byte_offset, Buffer.byteLength(original), "cancelled reset restores the matching committed offset");
    assert.equal(index.search("original transcript marker").length, 2);
    t.mock.restoreAll();
    assert.equal(await index.indexSessionFile("truncated", file), 1);
    assert.equal(await index.indexSessionFile("truncated", file), 0);
    assert.equal(index.status().indexedMessages, 1);
    assert.equal(index.search("original transcript marker").length, 0);
    assert.equal(index.search("rebuilt transcript marker").length, 1);
  } finally {
    t.mock.restoreAll();
    database?.close();
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
