/** 本地文件写入的跨进程互斥：独立内核锁覆盖 owner 判定、发布、业务操作和释放。 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, promises as fs, realpathSync, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const lockTimeoutMs = 5_000;
const lockPollMs = 25;
const maxLockBytes = 16 * 1024;

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LockAuthority {
  identity: FileIdentity;
  assertBinding(): void;
  close(): void;
}

interface OwnerRecord {
  pid?: unknown;
  nonce?: unknown;
  authority?: unknown;
}

// Only acquisition may discard this observation and retry. Publication and
// release still treat a missing/replaced marker as a binding failure.
class OwnerMarkerChangedError extends Error {
  constructor() { super("Local file lock changed during access."); }
}

export async function withLocalFileWriteLock<T>(root: string, lockFileName: string, operation: () => Promise<T>): Promise<T> {
  if (!lockFileName || lockFileName === "." || lockFileName === ".." || path.basename(lockFileName) !== lockFileName) throw new Error("Lock name must be a file name.");
  await ensureRealDirectory(root);
  const directory = await fs.realpath(path.resolve(root));
  const directoryIdentity = await fs.lstat(directory);
  const lockPath = path.join(directory, lockFileName);
  const deadline = Date.now() + lockTimeoutMs;
  let authority: LockAuthority | undefined;
  while (!authority) {
    authority = tryAcquireAuthority(lockPath, directoryIdentity);
    if (!authority) await waitForLock(deadline);
  }

  let handle: FileHandle | undefined;
  try {
    const nonce = randomBytes(8).toString("hex");
    while (!handle) {
      authority.assertBinding();
      try {
        handle = await fs.open(lockPath, writeNewFlags(), 0o600);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (await removeDeadOwnerLock(lockPath, authority)) continue;
        await waitForLock(deadline);
      }
    }
    // Keep pid/nonce readable by old binaries. Their fully published live markers
    // remain protected, but the full race guarantee requires all writers upgraded.
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce, authority: authority.identity })}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    const identity = await assertLockBinding(lockPath, handle);
    authority.assertBinding();
    try {
      return await operation();
    } finally {
      authority.assertBinding();
      await assertLockBinding(lockPath, handle, identity);
      await assertOwnerNonce(lockPath, nonce);
      authority.assertBinding();
      await fs.unlink(lockPath);
    }
  } finally {
    // Also runs when publication/binding validation fails before operation starts.
    // Closing the marker is safe; never open/close the SQLite inode through an
    // unrelated fd while it is locked (POSIX close can release process locks).
    await handle?.close().catch(() => undefined);
    authority.close();
  }
}

async function waitForLock(deadline: number): Promise<void> {
  if (Date.now() >= deadline) throw new Error("Timed out waiting for the local file write lock.");
  // A synchronous SQLite busy_timeout could deadlock two callers in this process.
  // Retry after yielding so the owner can finish its operation and release.
  await new Promise<void>((resolve) => setTimeout(resolve, lockPollMs));
}

function tryAcquireAuthority(lockPath: string, directoryIdentity: FileIdentity): LockAuthority | undefined {
  const directory = path.dirname(lockPath);
  const databasePath = `${lockPath}.authority.sqlite`;
  const assertDirectory = (): void => {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(stat, directoryIdentity)
      || realpathSync(directory) !== directory) throw new Error("Local file lock directory changed during access.");
  };
  assertDirectory();
  try {
    // This permanent zero-byte inode is the lock authority, never its JSON marker.
    // Never unlink/replace it, including on release, timeout, or crash recovery.
    const descriptor = openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(), 0o600);
    closeSync(descriptor);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const identityAtPath = (): FileIdentity => {
    assertDirectory();
    const stat = lstatSync(databasePath);
    const uid = process.getuid?.();
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size !== 0
      || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      throw new Error("Local file lock authority must be an empty, private, owned single-link file.");
    }
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { lstatSync(`${databasePath}${suffix}`); } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      throw new Error("Local file lock authority has an unexpected SQLite side file.");
    }
    return { dev: stat.dev, ino: stat.ino };
  };
  const identity = identityAtPath();
  const assertBinding = (): void => {
    if (!sameIdentity(identity, identityAtPath())) throw new Error("Local file lock authority changed during access.");
  };
  const database = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    assertBinding();
    // A dedicated, empty SQLite database per lock, with no data writes or side
    // files. Its write transaction is only a kernel-released election gate; this
    // does not hold any config/activity/business database transaction open.
    database.exec("PRAGMA journal_mode = MEMORY; BEGIN IMMEDIATE");
    assertBinding();
  } catch (error) {
    database.close();
    if (error instanceof Error && /database (?:table )?is locked/u.test(error.message)) return undefined;
    throw error;
  }
  let closed = false;
  return {
    identity,
    assertBinding,
    close(): void {
      if (closed) return;
      closed = true;
      try { database.exec("ROLLBACK"); } finally { database.close(); }
    }
  };
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

async function removeDeadOwnerLock(lockPath: string, authority: LockAuthority): Promise<boolean> {
  authority.assertBinding();
  const initial = await safeLockStat(lockPath);
  if (!initial) return true;
  let owner: OwnerRecord | undefined;
  try {
    owner = await readOwnerRecord(lockPath);
  } catch (error) {
    if (isNotFound(error)) return true;
    if (error instanceof OwnerMarkerChangedError) {
      // Legacy owners do not hold the kernel gate and can remove their marker
      // while it is being read. Never reclaim from that stale observation or
      // trust a replacement's contents; re-open it on the next bounded poll.
      authority.assertBinding();
      return false;
    }
    throw error;
  }
  const ownerAuthority = parseIdentity(owner?.authority);
  if (owner?.authority !== undefined && (!ownerAuthority || !sameIdentity(ownerAuthority, authority.identity))) {
    throw new Error("Local file lock authority changed; refusing to reclaim the owner marker.");
  }
  if (!ownerAuthority && Number.isSafeInteger(owner?.pid) && Number(owner?.pid) > 0 && processIsAlive(Number(owner?.pid))) return false;
  // The unchanged kernel gate proves a gated or partially published owner no
  // longer holds this lock. Do not rely on its PID, which may have been reused.
  const current = await safeLockStat(lockPath);
  if (!current || !sameIdentity(initial, current)) return false;
  authority.assertBinding();
  await fs.unlink(lockPath).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
  return true;
}

async function readOwnerRecord(lockPath: string): Promise<OwnerRecord | undefined> {
  const handle = await fs.open(lockPath, constants.O_RDONLY | noFollowFlag());
  try {
    const identity = await assertLockBinding(lockPath, handle);
    const stat = await handle.stat();
    if (stat.size > maxLockBytes) throw new Error("Local file lock owner marker is too large.");
    const raw = await handle.readFile("utf8");
    await assertLockBinding(lockPath, handle, identity);
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { return undefined; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as OwnerRecord;
  } finally {
    await handle.close();
  }
}

async function assertOwnerNonce(lockPath: string, nonce: string): Promise<void> {
  if ((await readOwnerRecord(lockPath))?.nonce !== nonce) throw new Error("Local file lock owner changed during access.");
}

function parseIdentity(value: unknown): FileIdentity | undefined {
  if (typeof value !== "object" || value === null || !("dev" in value) || !("ino" in value)) return undefined;
  if (typeof value.dev !== "number" || !Number.isSafeInteger(value.dev)
    || typeof value.ino !== "number" || !Number.isSafeInteger(value.ino)) return undefined;
  return { dev: value.dev, ino: value.ino };
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
  // Reject unsafe descriptors and target paths before classifying normal
  // unlink/replacement as turnover. In particular, extra hardlinks and symlinks
  // must never become retryable merely because the inode binding also changed.
  if (!descriptor.isFile() || (descriptor.nlink !== 0 && descriptor.nlink !== 1)) {
    throw new Error("Local file lock changed during access.");
  }
  if (expected && !sameIdentity(expected, descriptor)) throw new Error("Local file lock changed during access.");
  if (!target || descriptor.nlink === 0 || !sameIdentity(descriptor, target)) {
    // The first fstat can predate the path change. Check the still-open inode
    // again so newly added hardlinks cannot be hidden by removing its old name.
    const current = await handle.stat();
    if ((current.nlink !== 0 && current.nlink !== 1) || !sameIdentity(descriptor, current)) {
      throw new Error("Local file lock changed during access.");
    }
    throw new OwnerMarkerChangedError();
  }
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
    | noFollowFlag();
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
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
