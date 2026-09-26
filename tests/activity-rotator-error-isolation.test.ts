/** 截图轮转：坏图不阻断同轮其他截图、过期和容量清理。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";

await testBadSnapshotDoesNotBlockNextSnapshotOrExpiredCleanup();
await testBadSnapshotDoesNotBlockCapacityCleanup();
await testReplacementFailureDoesNotBlockNextSnapshot();
await testMissingSnapshotStillExpiresWithItsOcr();

async function testMissingSnapshotStillExpiresWithItsOcr(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-rotation-missing-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-09-20T12:00:00.000Z");
    const capture = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-09-20T12:00:00.000Z", eventType: "fallback_capture",
      application: "Missing", jpeg: Buffer.alloc(100, 1)
    });
    store.updateSnapshotOcr(capture.snapshotId!, "Missing file OCR evidence");
    await unlink(path.join(root, capture.snapshotPath!));
    const compressor = async (file: string) => {
      try {
        await readFile(file);
      } catch {
        throw new Error("截图图像无法读取");
      }
      return { data: Buffer.alloc(50, 2), width: 50, height: 50 };
    };

    await store.rotateSnapshots(1, new Date("2026-09-22T12:00:00.000Z"), compressor);
    assert.equal(store.getSessionDetail(sessionId)!.snapshots[0]?.storageTier, "warm", "丢失的源文件仍完成 hot 降级");

    await store.rotateSnapshots(1, new Date("2026-09-29T12:00:00.000Z"), compressor);
    assert.equal(store.getSessionDetail(sessionId)!.snapshots[0]?.storageTier, "cold", "丢失的源文件仍完成 warm 降级");

    await store.rotateSnapshots(1, new Date("2026-10-22T12:00:00.000Z"), compressor);
    assert.equal(store.getSessionDetail(sessionId)!.snapshots.length, 0, "过期后删除残留截图行");
    assert.equal(store.getHttpSessionDetail(sessionId)!.ocr.length, 0, "OCR 随截图行级联删除");
    assert.deepEqual(store.search("Missing file OCR evidence"), []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testBadSnapshotDoesNotBlockNextSnapshotOrExpiredCleanup(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-rotation-isolation-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const now = new Date("2026-09-25T12:00:00.000Z");
    const sessionId = store.startSession("2026-08-20T12:00:00.000Z");
    const bad = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-09-23T11:00:00.000Z", eventType: "fallback_capture",
      application: "Bad", jpeg: Buffer.alloc(100, 1)
    });
    const good = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-09-23T12:00:00.000Z", eventType: "fallback_capture",
      application: "Good", jpeg: Buffer.alloc(100, 2)
    });
    const expired = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-08-20T12:00:00.000Z", eventType: "fallback_capture",
      application: "Expired", jpeg: Buffer.alloc(100, 3)
    });
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    try {
      database.prepare("UPDATE activity_snapshots SET storage_tier = 'cold' WHERE id = ?").run(expired.snapshotId!);
    } finally {
      database.close();
    }
    const failures: string[] = [];
    await store.rotateSnapshots(1, now, async (file) => {
      if (file.endsWith(bad.snapshotPath!)) {
        failures.push(file);
        throw new Error("invalid image");
      }
      return { data: Buffer.alloc(50, 4), width: 50, height: 50 };
    });
    assert.equal(failures.length, 1);
    const snapshots = store.getSessionDetail(sessionId)!.snapshots;
    assert.equal(snapshots.find(row => row.id === bad.snapshotId)?.storageTier, "hot", "坏图保留档位以便下轮重试");
    assert.equal(snapshots.find(row => row.id === bad.snapshotId)?.bytes, 100, "坏图保留原始数据量");
    assert.equal(snapshots.find(row => row.id === good.snapshotId)?.storageTier, "warm", "后续图片仍降级");
    assert.equal(snapshots.find(row => row.id === good.snapshotId)?.bytes, 50);
    assert.equal(snapshots.some(row => row.id === expired.snapshotId), false, "过期清理仍运行");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testBadSnapshotDoesNotBlockCapacityCleanup(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-rotation-quota-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const now = new Date("2026-09-25T12:00:00.000Z");
    const sessionId = store.startSession("2026-09-23T12:00:00.000Z");
    const bad = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-09-23T12:00:00.000Z", eventType: "fallback_capture",
      application: "Bad", jpeg: Buffer.alloc(700_000, 1)
    });
    const fresh = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-09-25T11:59:00.000Z", eventType: "fallback_capture",
      application: "Fresh", jpeg: Buffer.alloc(700_000, 2)
    });
    await store.rotateSnapshots(1, now, async () => { throw new Error("invalid image"); });
    const snapshots = store.getSessionDetail(sessionId)!.snapshots;
    assert.equal(snapshots.some(row => row.id === bad.snapshotId), false, "容量上限仍可淘汰先前压缩失败的最旧图");
    assert.equal(snapshots.some(row => row.id === fresh.snapshotId), true);
    assert.equal(store.snapshot().storageBytes, 700_000);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testReplacementFailureDoesNotBlockNextSnapshot(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-rotation-replace-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const now = new Date("2026-09-25T12:00:00.000Z");
    const sessionId = store.startSession("2026-09-23T11:00:00.000Z");
    const blocked = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-09-23T11:00:00.000Z", eventType: "fallback_capture",
      application: "Blocked", jpeg: Buffer.alloc(100, 1)
    });
    const good = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-09-23T12:00:00.000Z", eventType: "fallback_capture",
      application: "Good", jpeg: Buffer.alloc(100, 2)
    });
    const blockedPath = path.join(root, blocked.snapshotPath!);
    await rm(blockedPath);
    await mkdir(blockedPath);
    await store.rotateSnapshots(1, now, async () => ({ data: Buffer.alloc(50, 3), width: 50, height: 50 }));
    const snapshots = store.getSessionDetail(sessionId)!.snapshots;
    assert.equal(snapshots.find(row => row.id === blocked.snapshotId)?.storageTier, "hot");
    assert.equal(snapshots.find(row => row.id === good.snapshotId)?.storageTier, "warm");
    assert.equal((await readdir(path.dirname(blockedPath))).some(name => name.startsWith(`.${path.basename(blockedPath)}.`)), false,
      "失败的替换不留下临时文件");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
