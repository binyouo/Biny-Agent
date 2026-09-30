import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ActivityStore, type ActivitySnapshotCompressor } from "../src/activity/store.js";

const capturedAt = "2026-09-28T12:00:00.000Z";
const now = new Date("2026-09-30T12:00:00.000Z");

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function beforeRelease<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation was blocked by paused compression")), 1_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-rotation-short-lock-"));
  const store = new ActivityStore();
  await store.open(root, root);
  const sessionId = store.startSession(capturedAt);
  const capture = await store.recordFallbackCapture({
    sessionId, occurredAt: capturedAt, eventType: "screenshot", jpeg: Buffer.alloc(200, 1)
  });
  assert.ok(capture.snapshotId);
  const snapshotId = capture.snapshotId;
  const source = store.getSnapshotPath(snapshotId);
  assert.ok(source);
  const entered = barrier();
  const release = barrier();
  const compressor: ActivitySnapshotCompressor = async () => {
    entered.resolve();
    await release.promise;
    return { data: Buffer.alloc(50, 2), width: 50, height: 50 };
  };
  return { root, store, sessionId, snapshotId, source, entered, release, compressor,
    cleanup: async () => { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("paused compression does not hold the capture file lock, including another store", async () => {
  const f = await fixture();
  const other = new ActivityStore();
  await other.open(f.root, f.root);
  const rotation = f.store.rotateSnapshots(100, now, f.compressor);
  await f.entered.promise;
  const capture = other.recordFallbackCapture({ sessionId: f.sessionId, occurredAt: now.toISOString(), eventType: "screenshot", jpeg: Buffer.alloc(100, 3) });
  try {
    await beforeRelease(capture);
    assert.equal(other.snapshot().fallbackCaptures, 2);
  } finally {
    f.release.resolve();
    await Promise.all([rotation, capture]);
    await other.close();
    await f.cleanup();
  }
});

for (const operation of ["clear", "delete"] as const) {
  test(`${operation} while compression is paused does not resurrect its result`, async () => {
    const f = await fixture();
    f.store.endSession(f.sessionId, "2026-09-28T13:00:00.000Z");
    const rotation = f.store.rotateSnapshots(100, now, f.compressor);
    await f.entered.promise;
    const removal = operation === "clear" ? f.store.clear() : f.store.deleteSession(f.sessionId);
    try {
      await beforeRelease(removal);
      f.release.resolve();
      await rotation;
      assert.equal(f.store.snapshot().fallbackCaptures, 0);
      await assert.rejects(readFile(f.source), { code: "ENOENT" });
      const names = await readdir(path.join(f.root, "snapshots"), { recursive: true });
      assert.equal(names.some((name) => name.endsWith(".tmp") || name.endsWith(".jpg")), false);
    } finally {
      f.release.resolve();
      await Promise.all([rotation, removal]);
      await f.cleanup();
    }
  });
}

test("a late encoder cannot overwrite an externally replaced source", async () => {
  const f = await fixture();
  const rotation = f.store.rotateSnapshots(100, now, f.compressor);
  try {
    await f.entered.promise;
    const replacement = `${f.source}.replacement`;
    await writeFile(replacement, Buffer.alloc(200, 9));
    await rename(replacement, f.source);
    f.release.resolve();
    await rotation;
    assert.deepEqual(await readFile(f.source), Buffer.alloc(200, 9));
    assert.equal(f.store.getSessionDetail(f.sessionId)?.snapshots[0]?.storageTier, "hot");
  } finally {
    f.release.resolve(); await rotation; await f.cleanup();
  }
});

test("same-inode, same-size source edits invalidate a pending encoding", async () => {
  const f = await fixture();
  const rotation = f.store.rotateSnapshots(100, now, f.compressor);
  try {
    await f.entered.promise;
    await writeFile(f.source, Buffer.alloc(200, 8));
    f.release.resolve();
    await rotation;
    assert.deepEqual(await readFile(f.source), Buffer.alloc(200, 8));
    assert.equal(f.store.getSessionDetail(f.sessionId)?.snapshots[0]?.storageTier, "hot");
  } finally {
    f.release.resolve(); await rotation; await f.cleanup();
  }
});

test("a missing source during encoding advances retention without recreating the file", async () => {
  const f = await fixture();
  const rotation = f.store.rotateSnapshots(100, now, f.compressor);
  try {
    await f.entered.promise;
    await unlink(f.source);
    f.release.resolve();
    await rotation;
    await assert.rejects(readFile(f.source), { code: "ENOENT" });
    assert.equal(f.store.getSessionDetail(f.sessionId)?.snapshots[0]?.storageTier, "warm");
  } finally {
    f.release.resolve(); await rotation; await f.cleanup();
  }
});

test("a symlink source is never handed to the compressor", async () => {
  const f = await fixture();
  let called = false;
  try {
    const target = path.join(f.root, "outside-snapshot.jpg");
    await writeFile(target, Buffer.alloc(200, 7));
    await unlink(f.source);
    await symlink(target, f.source);
    await f.store.rotateSnapshots(100, now, async () => {
      called = true;
      return { data: Buffer.alloc(50, 2), width: 50, height: 50 };
    });
    assert.equal(called, false);
    assert.deepEqual(await readFile(target), Buffer.alloc(200, 7));
  } finally { await f.cleanup(); }
});

test("concurrent rotations cannot commit an obsolete encoding", async () => {
  const f = await fixture();
  const other = new ActivityStore();
  await other.open(f.root, f.root);
  const first = f.store.rotateSnapshots(100, now, f.compressor);
  await f.entered.promise;
  const second = other.rotateSnapshots(100, now, async () => ({ data: Buffer.alloc(40, 4), width: 40, height: 40 }));
  try {
    await beforeRelease(second);
    f.release.resolve();
    await first;
    assert.deepEqual(await readFile(f.source), Buffer.alloc(40, 4));
    assert.equal(f.store.getSessionDetail(f.sessionId)?.snapshots[0]?.bytes, 40);
  } finally {
    f.release.resolve(); await Promise.all([first, second]); await other.close(); await f.cleanup();
  }
});

test("reconcile during compression preserves the source and leaves no staging files", async () => {
  const f = await fixture();
  const rotation = f.store.rotateSnapshots(100, now, f.compressor);
  const reconciliation = f.entered.promise.then(async () => await f.store.reconcileSnapshotFiles());
  try {
    await beforeRelease(reconciliation);
    f.release.resolve();
    await rotation;
    assert.equal((await readFile(f.source)).length, 50);
    const names = await readdir(path.join(f.root, "snapshots"), { recursive: true });
    assert.equal(names.some((name) => name.endsWith(".tmp")), false);
  } finally {
    f.release.resolve(); await Promise.all([rotation, reconciliation]); await f.cleanup();
  }
});

test("close and reopen during encoding never applies the old rotation to the new store", async () => {
  const f = await fixture();
  const rotation = f.store.rotateSnapshots(100, now, f.compressor);
  try {
    await f.entered.promise;
    await f.store.close();
    await f.store.open(f.root, f.root);
    f.release.resolve();
    await rotation;
    assert.equal((await readFile(f.source)).length, 200);
    assert.equal(f.store.getSessionDetail(f.sessionId)?.snapshots[0]?.storageTier, "hot");
  } finally {
    f.release.resolve(); await rotation.catch(() => undefined); await f.cleanup();
  }
});
