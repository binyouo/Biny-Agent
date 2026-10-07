/** 删除发生在 stat 与 open 之间时，历史搜索仍应返回其余有效会话。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createHistoryTools } from "../src/extensions/history.js";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";

const row = (messageId: string, content: string): string =>
  `${JSON.stringify({ type: "user_message", messageId, content })}\n`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-search-open-race-")));
  const workspace = path.join(root, "workspace");
  const agentRoot = path.join(root, "agent");
  const previousAgentRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = agentRoot;
  const index = new SessionSearchIndex(agentRoot);
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    index.close();
    if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(workspace);
  await ensureAgentDirs(workspace);
  return {
    workspace, index,
    create: async (id: string, text: string) => await createSessionFile(workspace, id, Buffer.from(text))
  };
}

for (const checkpoint of ["initial", "zero-offset", "incremental"] as const) {
  test(`history search survives completed deletion before opening its ${checkpoint} reader`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const deletedId = "a-deleted";
    const initial = row("deleted-message", "open race marker deleted");
    const file = await f.create(deletedId, checkpoint === "zero-offset" ? initial.slice(0, 10) : initial);
    if (checkpoint !== "initial") {
      await f.index.indexSessionFile(deletedId, file);
      await fs.appendFile(file, checkpoint === "zero-offset"
        ? initial.slice(10)
        : row("deleted-followup", "open race marker followup"));
    }
    const retainedFile = await f.create("z-retained", row("retained-message", "open race marker retained"));
    const retainedBytes = await fs.readFile(retainedFile);
    const opening = deferred();
    const resume = deferred();
    const originalOpen = fs.open;
    let paused = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === file && args[1] === "r" && !paused) {
        paused = true;
        opening.resolve();
        await resume.promise;
      }
      return await Reflect.apply(originalOpen, fs, args);
    });
    syncBuiltinESMExports();
    const [tool] = createHistoryTools({ getIndex: () => f.index });
    assert.ok(tool);
    const execution = await tool.resolveExecution({ query: "open race marker" });
    assert.ok(!("isError" in execution));
    const search = execution.execute({ toolCallId: checkpoint, operationId: checkpoint });
    try {
      await opening.promise;
      await deleteSessionArtifacts(f.workspace, deletedId);
      await assert.rejects(fs.access(file), { code: "ENOENT" });
      assert.equal(f.index.status().indexedMessages, 0, "cleanup removes only the old checkpoint; later files have not been scanned");
      resume.resolve();
      assert.deepEqual(await search, {
        query: "open race marker",
        hits: [{
          sessionId: "z-retained", messageId: "retained-message", role: "user",
          time: undefined, excerpt: "open race marker retained"
        }]
      }, "the public tool continues its scan and returns the unrelated live session");
      await f.index.refreshAll();
      assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
      assert.deepEqual(f.index.search("deleted"), []);
      assert.deepEqual(await fs.readFile(retainedFile), retainedBytes);
    } finally {
      resume.resolve();
      await search.catch(() => undefined);
    }
  });
}

for (const code of ["EACCES", "EIO", "ENOTDIR"] as const) {
  test(`history refresh propagates ${code} at open and retries after recovery`, async (t) => {
    const f = await fixture(t);
    const file = await f.create("retry-session", row("retry-message", "recovered open marker"));
    const reason = Object.assign(new Error(`injected open ${code}`), { code });
    const originalOpen = fs.open;
    let failed = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === file && args[1] === "r" && !failed) {
        failed = true;
        throw reason;
      }
      return await Reflect.apply(originalOpen, fs, args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.index.refreshAll({ maxAgeMs: 60_000 }), (error) => error === reason);
    assert.deepEqual(f.index.status(), { indexedSessions: 0, indexedMessages: 0 });
    await f.index.refreshAll({ maxAgeMs: 60_000 });
    assert.equal(f.index.search("recovered open marker")[0]?.messageId, "retry-message");
    assert.deepEqual(f.index.status(), { indexedSessions: 1, indexedMessages: 1 });
  });
}

for (const stage of ["stat", "read"] as const) {
  test(`ENOENT after open at reader ${stage} is propagated and closes the handle`, async (t) => {
    const f = await fixture(t);
    const file = await f.create("failed-reader", row("reader-message", "reader failure marker"));
    const reason = Object.assign(new Error(`injected reader ${stage} failure`), { code: "ENOENT" });
    const originalOpen = fs.open;
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await Reflect.apply(originalOpen, fs, args);
      if (String(args[0]) === file && args[1] === "r" && !opened) {
        opened = handle;
        if (stage === "stat") t.mock.method(handle, "stat", async () => { throw reason; });
        else t.mock.method(handle, "read", async () => { throw reason; });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(f.index.refreshAll({ maxAgeMs: 60_000 }), (error) => error === reason);
    assert.ok(opened);
    assert.equal(opened.fd, -1, "a reader failure still closes its acquired descriptor");
    assert.deepEqual(f.index.status(), { indexedSessions: 0, indexedMessages: 0 });
    await f.index.refreshAll({ maxAgeMs: 60_000 });
    assert.equal(f.index.search("reader failure marker")[0]?.messageId, "reader-message");
  });
}

test("cancellation during a missing-file open retains the abort reason", async (t) => {
  const f = await fixture(t);
  const file = await f.create("cancel-session", row("cancel-message", "cancel open marker"));
  const controller = new AbortController();
  const reason = new Error("cancel the opening history reader");
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === file && args[1] === "r") {
      await deleteSessionArtifacts(f.workspace, "cancel-session");
      controller.abort(reason);
    }
    return await Reflect.apply(originalOpen, fs, args);
  });
  syncBuiltinESMExports();
  await assert.rejects(f.index.indexSessionFile("cancel-session", file, controller.signal), (error) => error === reason);
  assert.deepEqual(f.index.status(), { indexedSessions: 0, indexedMessages: 0 });
});

for (const [code, cached] of [["EIO", false], ["EACCES", false], ["ENOTDIR", false], ["EIO", true]] as const) {
  test(`history search reports transcript stat ${code} with cached history ${cached} and retries immediately`, async (t) => {
    const f = await fixture(t);
    t.mock.method(performance, "now", () => 20_000);
    const file = await f.create("stat-retry", row("stat-message", "recoverable stat marker"));
    if (cached) {
      await f.index.indexSessionFile("stat-retry", file);
      await fs.appendFile(file, row("appended-message", "recoverable stat marker appended"));
    }
    const original = await fs.readFile(file);
    const reason = Object.assign(new Error(`${code}: failed to stat conversation transcript`), { code });
    const originalStat = fs.stat;
    let failed = false;
    t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === file && !failed) {
        failed = true;
        throw reason;
      }
      return await Reflect.apply(originalStat, fs, args);
    });
    syncBuiltinESMExports();
    const [tool] = createHistoryTools({ getIndex: () => f.index });
    assert.ok(tool);
    const execution = await tool.resolveExecution({ query: "recoverable stat marker" });
    assert.ok(!("isError" in execution));
    await assert.rejects(execution.execute({ toolCallId: "stat-failure", operationId: "stat-failure" }), (error) => error === reason);
    const retry = await execution.execute({ toolCallId: "stat-retry", operationId: "stat-retry" }) as { hits: Array<{ messageId?: string }> };
    assert.deepEqual(retry.hits.map((hit) => hit.messageId).sort(), cached ? ["appended-message", "stat-message"] : ["stat-message"],
      "a failed scan must not suppress the immediate retry as fresh");
    assert.deepEqual(await fs.readFile(file), original, "reporting and retrying search failures must preserve the transcript");
  });
}

for (const cancelled of [false, true]) {
  test(`a transcript deleted before stat preserves ${cancelled ? "cancellation" : "remaining search results"}`, async (t) => {
    const f = await fixture(t);
    const file = await f.create("a-deleted-stat", row("deleted-message", "stat deletion marker"));
    await f.create("z-retained-stat", row("retained-message", "stat deletion marker"));
    const controller = new AbortController();
    const reason = new Error("cancel during transcript stat");
    const originalStat = fs.stat;
    t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === file) {
        await deleteSessionArtifacts(f.workspace, "a-deleted-stat");
        if (cancelled) controller.abort(reason);
      }
      return await Reflect.apply(originalStat, fs, args);
    });
    syncBuiltinESMExports();
    const [tool] = createHistoryTools({ getIndex: () => f.index });
    assert.ok(tool);
    const execution = await tool.resolveExecution({ query: "stat deletion marker" });
    assert.ok(!("isError" in execution));
    const search = cancelled
      ? f.index.indexSessionFile("a-deleted-stat", file, controller.signal)
      : execution.execute({ toolCallId: "stat-deletion", operationId: "stat-deletion", signal: controller.signal });
    if (cancelled) await assert.rejects(search, (error) => error === reason);
    else {
      const result = await search as { hits: Array<{ messageId?: string }> };
      assert.deepEqual(result.hits.map((hit) => hit.messageId), ["retained-message"]);
    }
  });
}

for (const json of [false, true]) {
  test(`history CLI reports stat failure with nonzero exit instead of an empty ${json ? "JSON" : "text"} result`, { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    const file = await f.create("cli-stat", row("cli-stat-message", "CLI stat marker"));
    const preload = path.join(f.workspace, "fail-stat.mjs");
    await fs.writeFile(preload, `
      import { promises as fs } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const originalStat = fs.stat;
      fs.stat = async (...args) => {
        if (String(args[0]) === ${JSON.stringify(file)}) {
          throw Object.assign(new Error("EIO: failed to stat conversation transcript"), { code: "EIO" });
        }
        return await Reflect.apply(originalStat, fs, args);
      };
      syncBuiltinESMExports();
    `);
    const args = ["history", "search", "CLI stat marker", ...(json ? ["--json"] : [])];
    const cli = path.resolve("src/cli/index.ts");
    const run = (fail: boolean) => spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), ...(fail ? ["--import", preload] : []), cli, ...args
    ], { cwd: f.workspace, env: process.env, encoding: "utf8", timeout: 20_000 });
    const failed = run(true);
    assert.ifError(failed.error);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.stdout, "", "failed search must not emit success-shaped empty results");
    assert.match(failed.stderr, /EIO: failed to stat conversation transcript/u);
    const retry = run(false);
    assert.ifError(retry.error);
    assert.equal(retry.status, 0, retry.stderr);
    if (json) assert.deepEqual((JSON.parse(retry.stdout) as { hits: Array<{ messageId?: string }> }).hits.map((hit) => hit.messageId), ["cli-stat-message"]);
    else assert.match(retry.stdout, /CLI stat marker/u);
  });
}
