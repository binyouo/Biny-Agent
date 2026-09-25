/** 多连接及真实子进程验证截图写入与清理互斥；全部使用临时目录，不读取用户屏幕。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActivityStore } from "../src/activity/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-store-concurrent-"));
const writer = new ActivityStore();
const cleaner = new ActivityStore();
try {
  await writer.open(root, root);
  await cleaner.open(root, root);
  const sessionId = writer.startSession(new Date().toISOString());
  const captures = Array.from({ length: 20 }, (_, index) => writer.recordFallbackCapture({
    sessionId, occurredAt: new Date(Date.now() + index).toISOString(), eventType: "fallback_capture",
    jpeg: Buffer.from(`snapshot-${index}`), captureId: `capture-${index}`
  }));
  const readers = Array.from({ length: 10 }, async () => {
    const reader = new ActivityStore();
    try { await reader.open(root, root); reader.snapshot(); await reader.reconcileSnapshotFiles(); }
    finally { await reader.close(); }
  });
  const stored = await Promise.all(captures);
  await Promise.all(readers);
  assert.equal(writer.snapshot().fallbackCaptures, 20);
  for (const [index, capture] of stored.entries()) {
    assert.equal(await readFile(path.join(root, capture.snapshotPath!), "utf8"), `snapshot-${index}`,
      "查询连接的孤儿清理不能删除尚在落盘的截图");
  }

  // 清空与旧 session 的在途写入相遇：先提交再清空，或外键拒绝迟到写入，不能复活旧会话。
  const clear = cleaner.clear();
  const late = writer.recordFallbackCapture({
    sessionId, occurredAt: new Date().toISOString(), eventType: "fallback_capture", jpeg: Buffer.from("late")
  }).catch(() => undefined);
  await Promise.all([clear, late]);
  assert.equal(writer.snapshot().sessions, 0);
  assert.equal(writer.snapshot().fallbackCaptures, 0);
  const nextSession = writer.startSession(new Date().toISOString());
  const next = await writer.recordFallbackCapture({
    sessionId: nextSession, occurredAt: new Date().toISOString(), eventType: "fallback_capture", jpeg: Buffer.from("new")
  });
  assert.equal(await readFile(path.join(root, next.snapshotPath!), "utf8"), "new");

  // 独立进程持锁时，另一个进程不能开始快照目录清理。
  const fixture = path.join(root, "owner.mjs");
  await writeFile(fixture, `
import { withLocalFileWriteLock } from ${JSON.stringify(pathToFileURL(path.resolve("src/utils/localFileLock.ts")).href)};
await withLocalFileWriteLock(${JSON.stringify(root)}, '.activity.files.lock', async () => {
  process.stdout.write('locked\\n');
  await new Promise(resolve => process.stdin.once('data', resolve));
});
process.exit(0);
`);
  const owner = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve) => owner.once("exit", resolve));
  const reader = new ActivityStore();
  try {
    await new Promise<void>((resolve, reject) => {
      owner.stdout.once("data", (data: Buffer) => data.toString().includes("locked") ? resolve() : reject(new Error("Unexpected lock owner output")));
      owner.once("error", reject);
      owner.once("exit", () => reject(new Error("Lock owner exited before acquiring lock")));
    });
    await reader.open(root, root);
    let cleaned = false;
    const cleaning = reader.reconcileSnapshotFiles().then(() => { cleaned = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(cleaned, false);
    owner.stdin.end("release");
    assert.equal(await exited, 0);
    await cleaning;
    assert.equal(reader.snapshot().fallbackCaptures, 1);
  } finally {
    owner.stdin.end();
    if (owner.exitCode === null) owner.kill();
    await exited;
    await reader.close();
  }
} finally {
  await writer.close();
  await cleaner.close();
  await rm(root, { recursive: true, force: true });
}
