import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import {
  readSessionCatalogRecord,
  sessionCatalogDirectory,
  SessionCatalogConflictError,
  updateSessionCatalogMetadata
} from "../src/session/catalog.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-catalog-index-lifecycle-")));
  const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
  await ensureAgentDirs(root);
  await createSessionFile(root, "owned", Buffer.from('{"type":"user_message","content":"hello"}\n'));
  const indexPath = path.join(sessionCatalogDirectory(root), "..", "index.json");
  return {
    root, indexPath,
    async close() {
      await fs.rm(root, { recursive: true, force: true });
      if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
    }
  };
}

test("owned index publication releases the mutation lock and no-op updates do not join it", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const cleaned = deferred();
  let temporaryPath: string | undefined;
  const originalRename = fs.rename.bind(fs);
  const originalRm = fs.rm.bind(fs);
  let publications = 0;
  let settled = false;
  let update: ReturnType<typeof updateSessionCatalogMetadata> | undefined;
  const spy = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (path.resolve(String(args[1])) === path.resolve(f.indexPath)) {
      temporaryPath = String(args[0]);
      publications += 1;
      if (publications === 1) {
        entered.resolve();
        await release.promise;
      }
    }
    return await originalRename(...args);
  });
  const rmSpy = mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    await originalRm(...args);
    if (String(args[0]) === temporaryPath) cleaned.resolve();
  });
  try {
    update = updateSessionCatalogMetadata(f.root, "owned", { title: "Owned title" }, undefined, { indexRefresh: "wait" });
    void update.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    // A second operation on the same record must acquire/release its lock while
    // publication is gated. No-op wait mode must not join somebody else's work.
    const noOp = await updateSessionCatalogMetadata(f.root, "owned", { title: "Owned title" }, undefined, { indexRefresh: "wait" });
    assert.equal(noOp.title, "Owned title");
    assert.equal(settled, false, "the owner must still await its launched publication");
    assert.equal(publications, 1, "no-op must not schedule another refresh");
    release.resolve();
    await update;
    const index = JSON.parse(await fs.readFile(f.indexPath, "utf8")) as { sessions: Array<{ sessionId: string; title: string }> };
    assert.equal(index.sessions.find((session) => session.sessionId === "owned")?.title, "Owned title");
    assert.equal(publications, 1, "only actual changes request publication");
    await assert.rejects(
      updateSessionCatalogMetadata(f.root, "owned", { title: "stale" }, "wrong-revision", { indexRefresh: "wait" }),
      SessionCatalogConflictError
    );
    assert.equal(publications, 1, "failed CAS must not launch a refresh");
  } finally {
    release.resolve();
    await update?.catch(() => undefined);
    if (temporaryPath !== undefined) await cleaned.promise;
    spy.mock.restore();
    rmSpy.mock.restore();
    await f.close();
  }
});

test("owned index publication keeps derived-write failures best effort", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const originalRename = fs.rename.bind(fs);
  const sentinel = new Error("synthetic index publication failure");
  let publications = 0;
  const spy = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (path.resolve(String(args[1])) === path.resolve(f.indexPath)) {
      publications += 1;
      throw sentinel;
    }
    return await originalRename(...args);
  });
  try {
    const record = await updateSessionCatalogMetadata(f.root, "owned", { title: "Durable title" }, undefined, { indexRefresh: "wait" });
    assert.equal(record.title, "Durable title");
    assert.equal((await readSessionCatalogRecord(f.root, "owned"))?.title, "Durable title");
    assert.equal(publications, 1);
  } finally {
    spy.mock.restore();
    await f.close();
  }
});

test("default metadata completion does not wait for its background index publication", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const cleaned = deferred();
  const originalRename = fs.rename.bind(fs);
  const originalRm = fs.rm.bind(fs);
  let temporaryPath: string | undefined;
  let update: ReturnType<typeof updateSessionCatalogMetadata> | undefined;
  const renameSpy = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (path.resolve(String(args[1])) === path.resolve(f.indexPath)) {
      temporaryPath = String(args[0]);
      entered.resolve();
      await release.promise;
    }
    return await originalRename(...args);
  });
  const rmSpy = mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    await originalRm(...args);
    // This is the publisher's final filesystem operation, not a delay/drain API.
    if (String(args[0]) === temporaryPath) cleaned.resolve();
  });
  try {
    update = updateSessionCatalogMetadata(f.root, "owned", { title: "Background title" });
    await entered.promise;
    assert.equal((await update).title, "Background title", "the metadata response must arrive while its own publication is gated");
    release.resolve();
    await cleaned.promise;
    const index = JSON.parse(await fs.readFile(f.indexPath, "utf8")) as { sessions: Array<{ title: string }> };
    assert.equal(index.sessions[0]?.title, "Background title");
  } finally {
    release.resolve();
    await update?.catch(() => undefined);
    if (temporaryPath !== undefined) await cleaned.promise;
    renameSpy.mock.restore();
    rmSpy.mock.restore();
    await f.close();
  }
});

for (const failure of ["commit", "close"] as const) {
  test(`owned publication settles before reporting catalog ${failure} failure`, { timeout: 10_000 }, async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    const cleaned = deferred();
    let temporaryPath: string | undefined;
    const sentinel = new Error(`synthetic catalog ${failure} failure`);
    const originalRename = fs.rename.bind(fs);
    const originalRm = fs.rm.bind(fs);
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    let failNext = true;
    let settled = false;
    let update: ReturnType<typeof updateSessionCatalogMetadata> | undefined;
    const renameSpy = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (path.resolve(String(args[1])) === path.resolve(f.indexPath)) {
        temporaryPath = String(args[0]);
        entered.resolve();
        await release.promise;
      }
      return await originalRename(...args);
    });
    const rmSpy = mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      await originalRm(...args);
      if (String(args[0]) === temporaryPath) cleaned.resolve();
    });
    const execSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (failure === "commit" && sql === "COMMIT" && failNext) {
        failNext = false;
        throw sentinel;
      }
      return originalExec.call(this, sql);
    });
    const closeSpy = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
      originalClose.call(this);
      if (failure === "close" && failNext) {
        failNext = false;
        throw sentinel;
      }
    });
    try {
      update = updateSessionCatalogMetadata(f.root, "owned", { title: "Written before failure" }, undefined, { indexRefresh: "wait" });
      void update.then(() => { settled = true; }, () => { settled = true; });
      await entered.promise;
      const noOp = await updateSessionCatalogMetadata(f.root, "owned", { title: "Written before failure" }, undefined, { indexRefresh: "wait" });
      assert.equal(noOp.title, "Written before failure", "the lock must already be unwound despite its failure");
      assert.equal(failNext, false, "the synthetic lock failure must have occurred");
      assert.equal(settled, false, "the original failure cannot abandon the launched index writer");
      release.resolve();
      await assert.rejects(update, (error) => error === sentinel);
    } finally {
      release.resolve();
      await update?.catch(() => undefined);
      if (temporaryPath !== undefined) await cleaned.promise;
      renameSpy.mock.restore();
      rmSpy.mock.restore();
      execSpy.mock.restore();
      closeSpy.mock.restore();
      await f.close();
    }
  });
}
