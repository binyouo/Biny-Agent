/** 文件锁异常只公开锁文件名和失败类别，便于定位跨进程竞态。 */
import assert from "node:assert/strict";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withLocalFileWriteLock } from "../src/utils/localFileLock.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-lock-diagnostics-"));
try {
  const target = path.join(root, "target");
  await writeFile(target, "held");
  const lockName = ".diagnostic.lock";
  const lockPath = path.join(root, lockName);
  await symlink(target, lockPath);
  await assert.rejects(withLocalFileWriteLock(root, lockName, async () => undefined),
    /Local file lock must be a single-link regular file \(\.diagnostic\.lock: symbolic link\)/u);
  await rm(lockPath);
  await link(target, lockPath);
  await assert.rejects(withLocalFileWriteLock(root, lockName, async () => undefined),
    /Local file lock must be a single-link regular file \(\.diagnostic\.lock: multiple links\)/u);
  console.log("local file lock diagnostics tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
