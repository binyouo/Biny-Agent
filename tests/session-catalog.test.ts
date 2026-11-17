import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildSessionTree, listSessionCatalog, querySessionCatalog, readSessionCatalogRecord, SessionCatalogConflictError, sessionCatalogDirectory, sessionCatalogRecordRevision, updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { forkSession } from "../src/session/fork.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

const execFileAsync = promisify(execFile);
const catalogModuleUrl = pathToFileURL(path.resolve("src/session/catalog.ts")).href;

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-catalog-"));
try {
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  recorder.record({ type: "user_message", content: "catalog root" });
  recorder.record({ type: "assistant_message", content: "root answer" });
  await recorder.close();

  const forked = await forkSession(root, recorder.sessionId);
  const catalog = await listSessionCatalog(root);
  const source = catalog.find((item) => item.id === recorder.sessionId);
  const child = catalog.find((item) => item.id === forked.sessionId);
  assert.ok(source);
  assert.ok(child);
  assert.equal(source.rootSessionId, source.id);
  assert.equal(child.parentSessionId, source.id);
  assert.equal(child.rootSessionId, source.id);
  assert.deepEqual(child.branchPoint, { kind: "event", index: 2 });
  const childRecord = await readSessionCatalogRecord(root, child.id);
  assert.deepEqual(childRecord, {
    version: 1,
    sessionId: child.id,
    rootSessionId: source.id,
    parentSessionId: source.id,
    branchPoint: { kind: "event", index: 2 },
    createdAt: childRecord?.createdAt,
    updatedAt: childRecord?.updatedAt
  });

  const childRevision = child.metadataRevision;
  await updateSessionCatalogMetadata(root, child.id, { title: "子会话", unread: true }, childRevision);
  const updatedChild = (await listSessionCatalog(root)).find(item => item.id === child.id);
  assert.equal(updatedChild?.title, "子会话");
  assert.equal(updatedChild?.unread, true);
  await assert.rejects(
    updateSessionCatalogMetadata(root, child.id, { archived: true }, childRevision),
    SessionCatalogConflictError
  );

  const readRecord = await updateSessionCatalogMetadata(
    root,
    child.id,
    { unread: false },
    updatedChild?.metadataRevision
  );
  const persistedReadRecord = await readSessionCatalogRecord(root, child.id);
  assert.ok(persistedReadRecord);
  const readRevision = sessionCatalogRecordRevision(persistedReadRecord);
  const noOpReadRecord = await updateSessionCatalogMetadata(root, child.id, { unread: false }, readRevision);
  assert.equal(noOpReadRecord.updatedAt, readRecord.updatedAt);
  assert.deepEqual(await readSessionCatalogRecord(root, child.id), persistedReadRecord);
  assert.equal(sessionCatalogRecordRevision(noOpReadRecord), readRevision);

  const casGate = await prepareProcessGate(root, "cas", 4);
  const casUpdates = [
    runCatalogUpdateProcess(root, child.id, { title: "并发标题" }, readRevision, casGate.readyPaths[0], casGate.releasePath),
    runCatalogUpdateProcess(root, child.id, { pinned: true }, readRevision, casGate.readyPaths[1], casGate.releasePath),
    runCatalogUpdateProcess(root, child.id, { archived: true }, readRevision, casGate.readyPaths[2], casGate.releasePath),
    runCatalogUpdateProcess(root, child.id, { labels: ["并发"] }, readRevision, casGate.readyPaths[3], casGate.releasePath)
  ];
  await releaseProcessGate(casGate);
  const casOutcomes = await Promise.all(casUpdates);
  assert.equal(casOutcomes.filter((outcome) => outcome === "updated").length, 1);
  assert.equal(casOutcomes.filter((outcome) => outcome === "conflict").length, 3);

  const mergeGate = await prepareProcessGate(root, "merge", 4);
  const mergeUpdates = [
    runCatalogUpdateProcess(root, child.id, { title: "合并标题" }, undefined, mergeGate.readyPaths[0], mergeGate.releasePath),
    runCatalogUpdateProcess(root, child.id, { pinned: true }, undefined, mergeGate.readyPaths[1], mergeGate.releasePath),
    runCatalogUpdateProcess(root, child.id, { archived: true }, undefined, mergeGate.readyPaths[2], mergeGate.releasePath),
    runCatalogUpdateProcess(root, child.id, { labels: ["合并"] }, undefined, mergeGate.readyPaths[3], mergeGate.releasePath)
  ];
  await releaseProcessGate(mergeGate);
  assert.deepEqual(await Promise.all(mergeUpdates), ["updated", "updated", "updated", "updated"]);
  const mergedRecord = await readSessionCatalogRecord(root, child.id);
  assert.equal(mergedRecord?.title, "合并标题");
  assert.equal(mergedRecord?.pinned, true);
  assert.equal(mergedRecord?.archived, true);
  assert.deepEqual(mergedRecord?.labels, ["合并"]);

  await Promise.all([
    updateSessionCatalogMetadata(root, child.id, { title: "进程内合并标题" }),
    updateSessionCatalogMetadata(root, child.id, { labels: ["进程内合并"] })
  ]);
  const inProcessMergedRecord = await readSessionCatalogRecord(root, child.id);
  assert.equal(inProcessMergedRecord?.title, "进程内合并标题");
  assert.deepEqual(inProcessMergedRecord?.labels, ["进程内合并"]);
  assert.equal(inProcessMergedRecord?.pinned, true);
  assert.equal(inProcessMergedRecord?.archived, true);

  const lockDirectory = path.join(sessionCatalogDirectory(await realpath(root)), ".locks");
  const sentinelPath = path.join(root, "catalog-lock-sentinel");
  await writeFile(sentinelPath, "sentinel\n", "utf8");
  const lockPath = path.join(lockDirectory, "unsafe-session.sqlite");
  await symlink(sentinelPath, lockPath);
  await assert.rejects(
    updateSessionCatalogMetadata(root, "unsafe-session", { unread: false }),
    /real directory|Unsafe session catalog lock database/u
  );
  assert.equal(await readFile(sentinelPath, "utf8"), "sentinel\n");
  await unlink(lockPath);

  const firstPage = await querySessionCatalog(root, { limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await querySessionCatalog(root, { limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.revision, firstPage.revision);
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);
  assert.equal(secondPage.nextCursor, undefined);

  const tree = buildSessionTree(catalog);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.session.id, source.id);
  assert.equal(tree[0]?.children[0]?.session.id, child.id);
  assert.equal(buildSessionTree(await listSessionCatalog(root))[0]?.children[0]?.session.id, child.id);
  console.log("session catalog tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

interface ProcessGate {
  readyPaths: string[];
  releasePath: string;
}

async function prepareProcessGate(root: string, name: string, participants: number): Promise<ProcessGate> {
  return {
    readyPaths: Array.from({ length: participants }, (_, index) => path.join(root, `${name}-${String(index)}.ready`)),
    releasePath: path.join(root, `${name}.release`)
  };
}

async function releaseProcessGate(gate: ProcessGate): Promise<void> {
  await Promise.all(gate.readyPaths.map(async (readyPath) => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (await access(readyPath).then(() => true, () => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for catalog update process: ${readyPath}`);
  }));
  await writeFile(gate.releasePath, "release\n", "utf8");
}

async function runCatalogUpdateProcess(
  root: string,
  sessionId: string,
  patch: Record<string, unknown>,
  expectedRevision: string | undefined,
  readyPath: string,
  releasePath: string
): Promise<string> {
  const script = `
    import { access, writeFile } from "node:fs/promises";
    const catalog = await import(process.env.BINY_TEST_CATALOG_MODULE);
    await writeFile(process.env.BINY_TEST_CATALOG_READY, "ready\\n", "utf8");
    while (!(await access(process.env.BINY_TEST_CATALOG_RELEASE).then(() => true, () => false))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      await catalog.updateSessionCatalogMetadata(
        process.env.BINY_TEST_CATALOG_ROOT,
        process.env.BINY_TEST_CATALOG_SESSION,
        JSON.parse(process.env.BINY_TEST_CATALOG_PATCH),
        process.env.BINY_TEST_CATALOG_REVISION
      );
      process.stdout.write("updated");
    } catch (error) {
      if (error instanceof catalog.SessionCatalogConflictError) process.stdout.write("conflict");
      else throw error;
    }
  `;
  const result = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BINY_TEST_CATALOG_MODULE: catalogModuleUrl,
      BINY_TEST_CATALOG_ROOT: root,
      BINY_TEST_CATALOG_SESSION: sessionId,
      BINY_TEST_CATALOG_PATCH: JSON.stringify(patch),
      BINY_TEST_CATALOG_REVISION: expectedRevision,
      BINY_TEST_CATALOG_READY: readyPath,
      BINY_TEST_CATALOG_RELEASE: releasePath
    }
  });
  return result.stdout.trim();
}
