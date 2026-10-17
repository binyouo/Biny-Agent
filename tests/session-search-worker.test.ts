import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { SessionSearchIndex } from "../src/session/searchIndex.js";
import { createHistoryQueryFixture } from "./fixtures/queryTools.js";

test("history indexing keeps the caller responsive while another connection holds the writer lock", { timeout: 10_000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-worker-"));
  const index = new SessionSearchIndex(root);
  let locker: Worker | undefined;
  try {
    const file = path.join(root, "session.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "user_message", messageId: "message", content: "worker responsive marker" })}\n`);
    index.status();
    const { readdir } = await import("node:fs/promises");
    const databaseName = (await readdir(path.join(root, "search"))).find(name => name.endsWith(".sqlite"));
    assert.ok(databaseName);
    locker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(workerData);
      database.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => { database.exec("COMMIT"); database.close(); parentPort.close(); }, 800);
    `, { eval: true, workerData: path.join(root, "search", databaseName) });
    await once(locker, "message");
    let previousTick = performance.now();
    let longestGap = 0;
    const recordTick = (): void => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - previousTick);
      previousTick = now;
    };
    const heartbeat = setInterval(recordTick, 5);
    try {
      await index.indexSessionFile("session", file);
      recordTick();
    } finally {
      clearInterval(heartbeat);
    }
    assert.ok(longestGap < 400, `caller timer blocked for ${Math.round(longestGap)} ms`);
    context.diagnostic(`longest caller heartbeat gap: ${Math.round(longestGap)} ms during an 800 ms writer lock`);
    assert.equal(index.search("responsive")[0]?.messageId, "message");
  } finally {
    await index.close();
    await locker?.terminate();
    await rm(root, { recursive: true, force: true });
  }
});

test("the real history tool keeps same-named sources independent through shared worker connections", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-shared-worker-"));
  const first = new SessionSearchIndex(root);
  const second = new SessionSearchIndex(root);
  try {
    const files = [path.join(root, "sessions", "first", "shared.jsonl"), path.join(root, "sessions", "second", "shared.jsonl")];
    for (const [position, file] of files.entries()) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify({ type: "user_message", messageId: `message-${position}`, content: `independent worker marker ${"long ".repeat(position * 20)}` })}\n`);
    }
    assert.deepEqual(await Promise.all(files.map((file, position) => (position ? second : first).indexSessionFile("shared", file))), [1, 1]);
    const tool = createHistoryQueryFixture({ getIndex: () => first });
    const execution = await tool.resolveExecution({ query: "independent worker marker" });
    assert.ok(!("isError" in execution));
    const result = await execution.execute({}) as { hits: Array<{ sessionId: string; messageId: string; sourcePath: string }> };
    assert.deepEqual(result.hits.map(hit => hit.messageId).sort(), ["message-0", "message-1"]);
    assert.deepEqual(result.hits.map(hit => hit.sourcePath).sort(), (await Promise.all(files.map(file => realpath(file)))).sort());
    assert.ok(result.hits.every(hit => hit.sessionId === "shared"));
    assert.deepEqual(await Promise.all(files.map(file => second.indexSessionFile("shared", file))), [0, 0]);
    await first.close();
    assert.deepEqual(first.status(), { indexedSessions: 2, indexedMessages: 2 });
    assert.equal(first.search("marker").length, 2);
    assert.equal(first.grep("marker").length, 2);
    await first.refreshAll();
    assert.equal(await first.indexSessionFile("shared", files[0]!), 0);
    await first.close();
    assert.equal(await second.indexSessionFile("shared", files[0]!), 0);
    assert.deepEqual(second.status(), { indexedSessions: 2, indexedMessages: 2 });
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("worker backpressure and cancellation release queued work without cancelling another owner", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-worker-cancel-"));
  const first = new SessionSearchIndex(root);
  const second = new SessionSearchIndex(root);
  try {
    const file = path.join(root, "retained.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "user_message", messageId: "retained", content: "retained worker marker" })}\n`);
    const controller = new AbortController();
    const reason = new Error("caller cancelled queued work");
    const requests = Array.from({ length: 64 }, () => first.indexSessionFile("retained", file, controller.signal));
    const settled = Promise.allSettled(requests);
    await assert.rejects(second.indexSessionFile("retained", file), /Too many pending/);
    controller.abort(reason);
    const surviving = second.indexSessionFile("retained", file);
    const closing = first.close();
    await assert.rejects(first.indexSessionFile("retained", file), /index is closing/);
    await closing;
    assert.ok((await settled).every(result => result.status === "rejected" && result.reason === reason));
    assert.equal(await surviving, 1);
    assert.deepEqual(second.status(), { indexedSessions: 1, indexedMessages: 1 });
    const invalid = second.indexSessionFile("directory", root);
    const afterFailure = second.indexSessionFile("retained", file);
    await assert.rejects(invalid, { code: "EISDIR" });
    assert.equal(await afterFailure, 0);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker deadline rejects queued writes without replay and releases the failed owner on close", { timeout: 10_000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-worker-deadline-"));
  const first = new SessionSearchIndex(root);
  const second = new SessionSearchIndex(root);
  try {
    const file = path.join(root, "retained.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "user_message", messageId: "retained", content: "worker timeout marker" })}\n`);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const writes = Promise.allSettled([
      first.indexSessionFile("retained", file), second.indexSessionFile("retained", file)
    ]);
    context.mock.timers.tick(30_000);
    const results = await writes;
    assert.ok(results.every(result => result.status === "rejected" && /indexing timed out/.test(String(result.reason))));
    await assert.rejects(second.indexSessionFile("retained", file), /indexing timed out/);
    context.mock.timers.reset();
    await Promise.all([first.close(), second.close()]);
    assert.equal(await first.indexSessionFile("retained", file), 1);
    assert.equal(first.search("timeout").length, 1);
  } finally {
    context.mock.timers.reset();
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
