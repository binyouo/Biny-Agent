/** 本地文件写入的跨进程互斥：校验文件身份，只回收确认已退出进程持有的锁。 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const lockTimeoutMs = 5_000;
const lockPollMs = 25;

export async function withLocalFileWriteLock<T>(root: string, lockFileName: string, operation: () => Promise<T>): Promise<T> {
  if (!lockFileName || lockFileName === "." || lockFileName === ".." || path.basename(lockFileName) !== lockFileName) throw new Error("Lock name must be a file name.");
  await ensureRealDirectory(root);
  const lockPath = path.join(await fs.realpath(path.resolve(root)), lockFileName);
  const deadline = Date.now() + lockTimeoutMs;
  let handle: FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, writeNewFlags(), 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce: randomBytes(8).toString("hex") })}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await removeDeadOwnerLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the local file write lock.");
      await new Promise<void>((resolve) => setTimeout(resolve, lockPollMs));
    }
  }

  const identity = await assertLockBinding(lockPath, handle);
  try {
    return await operation();
  } finally {
    try {
      await assertLockBinding(lockPath, handle, identity);
      await fs.unlink(lockPath);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

async function ensureRealDirectory(root: string): Promise<void> {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Local storage root must be a real directory.");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Local storage root must be a real directory.");
  }
  await fs.chmod(root, 0o700);
}

async function removeDeadOwnerLock(lockPath: string): Promise<boolean> {
  const initial = await safeLockStat(lockPath);
  if (!initial) return true;
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
  let pid: number | undefined;
  try {
    const value = JSON.parse(raw) as { pid?: unknown };
    if (Number.isSafeInteger(value.pid) && Number(value.pid) > 0) pid = Number(value.pid);
  } catch {
    // 不删除无法验证所有者的锁文件；调用方会得到有界超时，而不是越权清理。
  }
  if (pid === undefined || processIsAlive(pid)) return false;
  const current = await safeLockStat(lockPath);
  if (!current || !sameIdentity(initial, current)) return false;
  await fs.unlink(lockPath).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
  return true;
}

async function safeLockStat(lockPath: string): Promise<Stats | undefined> {
  try {
    const stat = await fs.lstat(lockPath);
    const reason = stat.isSymbolicLink() ? "symbolic link"
      : !stat.isFile() ? "not a regular file"
      : stat.nlink !== 1 ? "multiple links"
      : await fs.realpath(lockPath) !== lockPath ? "noncanonical path" : undefined;
    if (reason) throw new Error(`Local file lock must be a single-link regular file (${path.basename(lockPath)}: ${reason}).`);
    return stat;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function assertLockBinding(
  lockPath: string,
  handle: FileHandle,
  expected?: Pick<Stats, "dev" | "ino">
): Promise<Pick<Stats, "dev" | "ino">> {
  const descriptor = await handle.stat();
  const target = await safeLockStat(lockPath);
  if (!target || !descriptor.isFile() || descriptor.nlink !== 1 || !sameIdentity(descriptor, target)) {
    throw new Error("Local file lock changed during access.");
  }
  if (expected && !sameIdentity(expected, descriptor)) throw new Error("Local file lock changed during access.");
  return { dev: descriptor.dev, ino: descriptor.ino };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function writeNewFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
}

function sameIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
