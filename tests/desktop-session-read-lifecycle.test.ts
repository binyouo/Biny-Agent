import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { readSessionCatalogRecord, refreshSessionIndex, sessionCatalogDirectory } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type ObservedSessionRead = { completion: ReturnType<DesktopProjectService["markSessionRead"]> };

function observeNextSessionRead(context: TestContext, projects: DesktopProjectService): Promise<ObservedSessionRead> {
  let observe!: (read: ObservedSessionRead) => void;
  const started = new Promise<ObservedSessionRead>((resolve) => { observe = resolve; });
  const markSessionRead = projects.markSessionRead;
  context.mock.method(projects, "markSessionRead", function (this: DesktopProjectService, ...args: Parameters<DesktopProjectService["markSessionRead"]>) {
    const completion = markSessionRead.apply(this, args);
    // 包装对象避免观测 promise 提前承接后台失败；manager 仍收到同一个原始 promise。
    observe({ completion });
    return completion;
  });
  return started;
}

async function waitForRead(dataRoot: string, sessionId: string, started: Promise<ObservedSessionRead>): Promise<void> {
  // 等待指定后台写入完成后再读盘，不消费为后续元数据操作保留的 revision 映射。
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    await Promise.race([
      (async () => {
        const { completion } = await started;
        await completion;
        if (expired) return;
        assert.equal((await readSessionCatalogRecord(dataRoot, sessionId))?.unread, false,
          "opening did not persist its read marker");
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("opening did not persist its read marker"));
        }, 2_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(context: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-session-read-lifecycle-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const dataRoot = await projects.dataRoot(project);
  const recorder = new SessionRecorder(dataRoot, "read-lifecycle");
  recorder.record({ type: "user_message", content: "Browse this saved conversation" });
  await recorder.close();
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  context.after(async () => {
    context.mock.restoreAll();
    await manager.closeAll();
    await refreshSessionIndex(dataRoot);
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  return { manager, projects, project, dataRoot, sessionId: recorder.sessionId };
}

for (const expireReadCache of [false, true]) {
test(`opening and pinning stay responsive while shutdown drains reads (cache elapsed: ${expireReadCache})`, { timeout: 10_000 }, async (context) => {
  const f = await fixture(context);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  await refreshSessionIndex(f.dataRoot);
  const indexPath = path.join(sessionCatalogDirectory(f.dataRoot), "..", "index.json");
  const heldPath = expireReadCache ? path.join(sessionCatalogDirectory(f.dataRoot), `${f.sessionId}.json`) : indexPath;
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename;
  context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (path.resolve(String(args[1])) === path.resolve(heldPath)) {
      entered.resolve();
      await release.promise;
    }
    return await Reflect.apply(rename, fs, args);
  });
  const cleanups: Array<() => void> = [];
  if (expireReadCache) {
    const schedule = globalThis.setTimeout;
    context.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 30_000) cleanups.push(() => Reflect.apply(args[0], undefined, args.slice(2)));
      return schedule(...args);
    });
  }
  const started = observeNextSessionRead(context, f.projects);
  let completion: ObservedSessionRead["completion"] | undefined;
  let closing: Promise<void> | undefined;
  try {
    const opened = await f.manager.openSession(f.project.id, f.sessionId);
    assert.equal(opened.session.unread, false);
    ({ completion } = await started);
    await entered.promise;
    if (expireReadCache) {
      for (const cleanup of cleanups) cleanup();
      const pinning = f.manager.pinSession(f.project.id, f.sessionId, true, opened.session.metadataRevision);
      release.resolve();
      await pinning;
      assert.equal((await readSessionCatalogRecord(f.dataRoot, f.sessionId))?.pinned, true,
        "cache expiry must not discard an unfinished read's revision mapping");
    } else {
      await completion;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          f.manager.pinSession(f.project.id, f.sessionId, true, opened.session.metadataRevision),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("pinning waited for background index publication")), 2_000); })
        ]);
      } finally { clearTimeout(timer); }
      await Promise.allSettled(f.manager["runtimeInitializations"].values());
      closing = f.manager.closeAll();
      const premature = await Promise.race([closing.then(() => true), delay(300).then(() => false)]);
      assert.equal(premature, false, "shutdown must retain the read's index publication after the read revision is consumed");
    }
    closing ??= f.manager.closeAll();
    release.resolve();
    await closing;
    await completion;
    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as { sessions: Array<{ sessionId: string }> };
    assert.ok(index.sessions.some((session) => session.sessionId === f.sessionId));
    assert.equal((await readSessionCatalogRecord(f.dataRoot, f.sessionId))?.unread, false);
  } finally {
    release.resolve();
    await completion?.catch(() => undefined);
    await closing?.catch(() => undefined);
  }
});
}

test("opening history after shutdown does not admit a late read-marker write", { timeout: 10_000 }, async (context) => {
  const f = await fixture(context);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  await refreshSessionIndex(f.dataRoot);
  await f.manager.closeAll();
  await f.manager.openSession(f.project.id, f.sessionId);
  await f.manager.closeAll();
  assert.equal((await readSessionCatalogRecord(f.dataRoot, f.sessionId))?.unread, true);
});

test("reopening after another completion clears its persisted unread flag while the previous read is retained", { timeout: 10_000 }, async (context) => {
  const f = await fixture(context);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  const read = observeNextSessionRead(context, f.projects);
  const first = await f.manager.openSession(f.project.id, f.sessionId);
  assert.equal(first.session.unread, false);
  await waitForRead(f.dataRoot, f.sessionId, read);
  // 后台运行完成也通过这个元数据入口设置未读。
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  assert.equal((await readSessionCatalogRecord(f.dataRoot, f.sessionId))?.unread, true);
  const reopened = await f.manager.openSession(f.project.id, f.sessionId);
  assert.equal(reopened.session.unread, false);
  await f.manager.pinSession(f.project.id, f.sessionId, true, reopened.session.metadataRevision);
  await f.manager.closeAll();
  const persisted = await readSessionCatalogRecord(f.dataRoot, f.sessionId);
  assert.equal(persisted?.unread, false,
    "reopening must persist the new read even when a completed read is cached for metadata CAS");
  assert.equal(persisted?.pinned, true, "reopening keeps the latest read revision available to immediate metadata edits");
});

test("concurrent openings of the same catalog revision share the pending read and keep immediate pinning valid", { timeout: 10_000 }, async (context) => {
  const f = await fixture(context);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  const target = path.join(sessionCatalogDirectory(f.dataRoot), `${f.sessionId}.json`);
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename;
  context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === target) {
      entered.resolve();
      await release.promise;
    }
    return await Reflect.apply(rename, fs, args);
  });
  const lockDatabase = path.join(sessionCatalogDirectory(f.dataRoot), ".locks", `${f.sessionId}.sqlite`);
  let transactions = 0;
  const exec = DatabaseSync.prototype.exec;
  context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    // 打开会话也会预热 Host；这里只统计本会话的 catalog 写入事务。
    if (sql === "BEGIN IMMEDIATE" && this.prepare("PRAGMA database_list").get()?.file === lockDatabase) transactions++;
    return exec.call(this, sql);
  });
  try {
    const first = await f.manager.openSession(f.project.id, f.sessionId);
    await entered.promise;
    const second = await f.manager.openSession(f.project.id, f.sessionId);
    assert.equal(second.session.metadataRevision, first.session.metadataRevision);
    release.resolve();
    await f.manager.pinSession(f.project.id, f.sessionId, true, second.session.metadataRevision);
    const persisted = await readSessionCatalogRecord(f.dataRoot, f.sessionId);
    assert.equal(persisted?.unread, false);
    assert.equal(persisted?.pinned, true);
    assert.equal(transactions, 2, "one coalesced read transaction plus the requested pin transaction");
  } finally {
    release.resolve();
  }
});

test("a completion after the latest opening persisted its read remains unread", { timeout: 10_000 }, async (context) => {
  const f = await fixture(context);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  const read = observeNextSessionRead(context, f.projects);
  await f.manager.openSession(f.project.id, f.sessionId);
  await waitForRead(f.dataRoot, f.sessionId, read);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  await f.manager.closeAll();
  assert.equal((await readSessionCatalogRecord(f.dataRoot, f.sessionId))?.unread, true,
    "retaining a completed read for metadata CAS must not retry it over a later completion");
});

test("reopening retries a failed background read instead of retaining its rejection for thirty seconds", { timeout: 10_000 }, async (context) => {
  const f = await fixture(context);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  const target = path.join(sessionCatalogDirectory(f.dataRoot), `${f.sessionId}.json`);
  const failed = deferred();
  const rename = fs.rename;
  let failOnce = true;
  context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === target && failOnce) {
      failOnce = false;
      failed.resolve();
      throw Object.assign(new Error("read marker storage temporarily unavailable"), { code: "EIO" });
    }
    return await Reflect.apply(rename, fs, args);
  });
  await f.manager.openSession(f.project.id, f.sessionId);
  await failed.promise;
  const reopened = await f.manager.openSession(f.project.id, f.sessionId);
  assert.equal(reopened.session.unread, false);
  await f.manager.closeAll();
  assert.equal((await readSessionCatalogRecord(f.dataRoot, f.sessionId))?.unread, false,
    "a fresh explicit open must recover once the storage failure is gone");
});

for (const failOlderRead of [false, true]) {
  test(`shutdown drains a replaced pending read and persists the newer marker (older failure: ${failOlderRead})`, { timeout: 10_000 }, async (context) => {
    const f = await fixture(context);
    await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
    await refreshSessionIndex(f.dataRoot);
    const directory = sessionCatalogDirectory(f.dataRoot);
    const entered = deferred();
    const release = deferred();
    const mkdir = fs.mkdir;
    let holdFirst = true;
    context.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === directory && holdFirst) {
        holdFirst = false;
        entered.resolve();
        await release.promise;
        if (failOlderRead) throw Object.assign(new Error("older read failed before lock admission"), { code: "EIO" });
      }
      return await Reflect.apply(mkdir, fs, args);
    });
    try {
      await f.manager.openSession(f.project.id, f.sessionId);
      await entered.promise;
      await f.projects.updateSessionMetadata(f.project, f.sessionId, { title: "Changed in another window" });
      await f.manager.openSession(f.project.id, f.sessionId);
      const closing = f.manager.closeAll();
      // 真实文件系统回调需要推进；最多观察 300ms 内的错误提前关闭，成功仍须等待显式释放。
      const premature = await Promise.race([closing.then(() => true), delay(300).then(() => false)]);
      release.resolve();
      await closing;
      assert.equal(premature, false, "closeAll must drain every admitted read, even after a newer revision replaces its mapping");
      const persisted = await readSessionCatalogRecord(f.dataRoot, f.sessionId);
      assert.equal(persisted?.unread, false, "an older failure must not prevent the newer opening from marking the session read");
      assert.equal(persisted?.title, "Changed in another window");
    } finally {
      release.resolve();
    }
  });
}

test("a superseded read rejection preserves the newer opening revision for immediate pinning", { timeout: 10_000 }, async (context) => {
  const f = await fixture(context);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  await refreshSessionIndex(f.dataRoot);
  const directory = sessionCatalogDirectory(f.dataRoot);
  const entered = deferred();
  const release = deferred();
  const mkdir = fs.mkdir;
  let holdFirst = true;
  context.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === directory && holdFirst) {
      holdFirst = false;
      entered.resolve();
      await release.promise;
      throw Object.assign(new Error("superseded read failed before lock admission"), { code: "EIO" });
    }
    return await Reflect.apply(mkdir, fs, args);
  });
  try {
    await f.manager.openSession(f.project.id, f.sessionId);
    await entered.promise;
    await f.projects.updateSessionMetadata(f.project, f.sessionId, { title: "Changed in another window" });
    const read = observeNextSessionRead(context, f.projects);
    const latest = await f.manager.openSession(f.project.id, f.sessionId);
    release.resolve();
    await waitForRead(f.dataRoot, f.sessionId, read);
    await f.manager.pinSession(f.project.id, f.sessionId, true, latest.session.metadataRevision);
    const persisted = await readSessionCatalogRecord(f.dataRoot, f.sessionId);
    assert.equal(persisted?.unread, false);
    assert.equal(persisted?.pinned, true, "the older rejection must not discard the newer read-to-pin revision mapping");
    assert.equal(persisted?.title, "Changed in another window");
  } finally {
    release.resolve();
  }
});
