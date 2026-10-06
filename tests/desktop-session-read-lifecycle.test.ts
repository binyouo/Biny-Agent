import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
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

async function waitForRead(dataRoot: string, sessionId: string): Promise<void> {
  // 等待真实后台落盘，不消费为后续元数据操作保留的 revision 映射。
  const deadline = performance.now() + 2_000;
  while ((await readSessionCatalogRecord(dataRoot, sessionId))?.unread !== false) {
    assert.ok(performance.now() < deadline, "opening did not persist its read marker");
    await setImmediate();
  }
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-read-lifecycle-"));
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
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  return { manager, projects, project, dataRoot, sessionId: recorder.sessionId };
}

test("reopening after another completion clears its persisted unread flag while the previous read is retained", { timeout: 10_000 }, async (context) => {
  const f = await fixture(context);
  await f.projects.updateSessionMetadata(f.project, f.sessionId, { unread: true });
  const first = await f.manager.openSession(f.project.id, f.sessionId);
  assert.equal(first.session.unread, false);
  await waitForRead(f.dataRoot, f.sessionId);
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
  let transactions = 0;
  const exec = DatabaseSync.prototype.exec;
  context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") transactions++;
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
  await f.manager.openSession(f.project.id, f.sessionId);
  await waitForRead(f.dataRoot, f.sessionId);
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
    const latest = await f.manager.openSession(f.project.id, f.sessionId);
    release.resolve();
    await waitForRead(f.dataRoot, f.sessionId);
    await f.manager.pinSession(f.project.id, f.sessionId, true, latest.session.metadataRevision);
    const persisted = await readSessionCatalogRecord(f.dataRoot, f.sessionId);
    assert.equal(persisted?.unread, false);
    assert.equal(persisted?.pinned, true, "the older rejection must not discard the newer read-to-pin revision mapping");
    assert.equal(persisted?.title, "Changed in another window");
  } finally {
    release.resolve();
  }
});
