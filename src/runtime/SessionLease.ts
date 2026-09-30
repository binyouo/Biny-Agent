/**
 * 会话执行租约。
 *
 * 一个 session 同时只能被一个 Desktop、TUI 或 CLI 运行时写入。这里仅负责跨进程互斥，
 * 对话和运行历史继续以 session JSONL 为准，不再维护第二套 root-run 生命周期。
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentDir, ensureAgentDirs } from "../session/store.js";

// Keep the v1 envelope readable by older binaries, so a normally published live
// writer is still protected there. The authority field identifies gated owners.
// Old binaries' unsafe partial/stale reclaim cannot be made safe by this reader;
// all concurrently competing writers must be upgraded for the full guarantee.
const leaseVersion = 1;
const maxLeaseBytes = 16 * 1024;
const leasePrefix = "session-";
const leaseSuffix = ".lock";

interface FileIdentity {
  device: number;
  inode: number;
}

interface LeaseRecord {
  version: typeof leaseVersion;
  runtimeId: string;
  pid: number;
  sessionId: string;
  createdAt: string;
  authority?: FileIdentity;
}

interface LeaseAuthority {
  identity: FileIdentity;
  assertBinding(): void;
  close(): void;
}

interface OwnedLease {
  identity: FileIdentity;
  authority: LeaseAuthority;
}

/**
 * session 已经被另一个 surface/process 以 writer 身份持有。
 *
 * 这个错误在 Runtime Host 和本地 SessionLease 两条路径上共用，
 * 让 Desktop/TUI 不需要解析一段不稳定的自然语言错误。
 */
export class SessionWriterConflictError extends Error {
  readonly code = "session_writer_conflict" as const;
  readonly sessionId: string;
  readonly ownerPid?: number;
  readonly ownerSurface?: string;

  constructor(
    sessionId: string,
    ownerPid?: number,
    ownerSurface?: string,
    message = `Session ${sessionId} is already owned by another writer.`
  ) {
    super(message);
    this.sessionId = sessionId;
    this.ownerPid = ownerPid;
    this.ownerSurface = ownerSurface;
    this.name = "SessionWriterConflictError";
  }
}

export class SessionLeaseError extends SessionWriterConflictError {
  readonly pid: number;

  constructor(
    pid: number,
    sessionId: string
  ) {
    super(
      sessionId,
      pid,
      undefined,
      `Session ${sessionId} is already owned by process ${String(pid)}.`
    );
    this.pid = pid;
    this.name = "SessionLeaseError";
  }
}

export function isSessionWriterConflictError(error: unknown): error is SessionWriterConflictError {
  return error instanceof SessionWriterConflictError
    || (error instanceof Error && "code" in error && error.code === "session_writer_conflict");
}

export class SessionLease {
  private closed = false;
  private readonly store: SessionLeaseStore;
  readonly sessionId: string;
  private readonly identity: FileIdentity;
  private readonly runtimeId: string;

  constructor(
    store: SessionLeaseStore,
    sessionId: string,
    identity: FileIdentity,
    runtimeId: string
  ) {
    this.store = store;
    this.sessionId = sessionId;
    this.identity = identity;
    this.runtimeId = runtimeId;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.release(this.sessionId, this.runtimeId, this.identity);
  }
}

export class SessionLeaseStore {
  readonly runtimeId = randomUUID();
  private readonly leases = new Map<string, OwnedLease>();
  private closed = false;
  readonly persistenceRoot: string;
  private readonly directoryPath: string;
  private readonly directoryIdentity: FileIdentity;

  private constructor(
    persistenceRoot: string,
    directoryPath: string,
    directoryIdentity: FileIdentity
  ) {
    this.persistenceRoot = persistenceRoot;
    this.directoryPath = directoryPath;
    this.directoryIdentity = directoryIdentity;
  }

  static async open(persistenceRoot: string): Promise<SessionLeaseStore> {
    await ensureAgentDirs(persistenceRoot);
    const canonicalRoot = realpathSync(path.resolve(persistenceRoot));
    const rootStat = lstatSync(canonicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Session lease root must be a real directory.");
    }
    const directoryPath = path.join(agentDir(canonicalRoot), "runs");
    const canonicalDirectory = realpathSync(directoryPath);
    if (canonicalDirectory !== directoryPath) {
      throw new Error("Session lease directory resolves outside the persistence root.");
    }
    const directoryStat = lstatSync(canonicalDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error("Session lease directory must be a real directory.");
    }
    return new SessionLeaseStore(canonicalRoot, canonicalDirectory, identityOf(directoryStat));
  }

  acquire(sessionId: string): SessionLease {
    this.assertOpen();
    assertSessionId(sessionId);
    if (this.leases.has(sessionId)) throw new Error(`Session ${sessionId} is already leased by this runtime.`);
    const leasePath = this.leasePath(sessionId);
    const authority = this.acquireAuthority(leasePath, sessionId);
    try {
      let identity: FileIdentity | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        authority.assertBinding();
        try {
          identity = this.createLease(leasePath, sessionId, authority.identity);
          authority.assertBinding();
          break;
        } catch (error) {
          if (!isErrorCode(error, "EEXIST")) throw error;
          let existing: LeaseRecord;
          try {
            existing = this.readLease(leasePath, sessionId);
          } catch {
            // Only the elected owner can observe/reclaim a partial publication.
            // A live publisher holds the same gate even before writing its first byte.
            authority.assertBinding();
            this.retireStaleLease(leasePath);
            continue;
          }
          if (!existing.authority && isProcessAlive(existing.pid)) {
            // Legacy writers did not take the kernel gate; preserve their live marker.
            throw new SessionLeaseError(existing.pid, sessionId);
          }
          if (existing.authority && !sameIdentity(existing.authority, authority.identity)) {
            throw new Error("Session lease authority changed; refusing to reclaim the owner marker.");
          }
          // For gated markers, the unchanged kernel gate proves the old owner released or
          // crashed. Its recorded PID may now belong to an unrelated process.
          authority.assertBinding();
          this.retireStaleLease(leasePath);
        }
      }
      if (!identity) throw new Error(`Could not acquire the session lease for ${sessionId}.`);
      this.leases.set(sessionId, { identity, authority });
      return new SessionLease(this, sessionId, identity, this.runtimeId);
    } catch (error) {
      authority.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [sessionId, owned] of this.leases) {
      this.release(sessionId, this.runtimeId, owned.identity);
    }
  }

  release(sessionId: string, runtimeId: string, identity: FileIdentity): void {
    const owned = this.leases.get(sessionId);
    if (!owned || runtimeId !== this.runtimeId || !sameIdentity(owned.identity, identity)) return;
    this.leases.delete(sessionId);
    try {
      owned.authority.assertBinding();
      const leasePath = this.leasePath(sessionId);
      const currentIdentity = this.fileIdentityAtPath(leasePath);
      if (!sameIdentity(currentIdentity, identity)) return;
      if (this.readLease(leasePath, sessionId).runtimeId !== runtimeId) return;
      unlinkSync(leasePath);
    } catch {
      // Never delete an unknown replacement. Always release the kernel gate below,
      // including when the marker or directory has disappeared or been replaced.
    } finally {
      owned.authority.close();
    }
  }

  private acquireAuthority(leasePath: string, sessionId: string): LeaseAuthority {
    const databasePath = `${leasePath}.authority.sqlite`;
    this.assertDirectoryBinding();
    try {
      // The stable authority inode is NEVER renamed, retired, or deleted. A new
      // inode would be a different kernel lock and could elect a second writer.
      const descriptor = openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      closeSync(descriptor);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    const identity = this.authorityIdentityAtPath(databasePath);
    const assertBinding = (): void => {
      if (!sameIdentity(identity, this.authorityIdentityAtPath(databasePath))) {
        throw new Error("Session lease authority changed during runtime.");
      }
    };
    const database = new DatabaseSync(databasePath, { timeout: 0 });
    try {
      assertBinding();
      // One dedicated, empty database per session; never a business/global DB.
      // No writes or journal side files are needed: BEGIN IMMEDIATE itself owns
      // a kernel lock until close/crash. MEMORY also prevents journal creation.
      // timeout=0 is essential: a second store in this process must not wait for
      // its own event loop to close the first lease. Only active leases retain FDs.
      database.exec("PRAGMA journal_mode = MEMORY; BEGIN IMMEDIATE");
      assertBinding();
    } catch (error) {
      database.close();
      if (isSqliteBusy(error)) {
        let existing: LeaseRecord | undefined;
        try { existing = this.readLease(leasePath, sessionId); } catch { /* Publication may not have started. */ }
        if (existing) throw new SessionLeaseError(existing.pid, sessionId);
        throw new SessionWriterConflictError(sessionId);
      }
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

  private authorityIdentityAtPath(databasePath: string): FileIdentity {
    this.assertDirectoryBinding();
    const stat = lstatSync(databasePath);
    assertSafeLeaseFile(stat, path.basename(databasePath));
    const uid = process.getuid?.();
    if (stat.size !== 0 || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      throw new Error("Session lease authority must be an empty, private, owned file.");
    }
    // This gate never writes SQLite data. Any side file is unexpected; fail
    // closed rather than let SQLite inspect a forged journal/WAL outside it.
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { lstatSync(`${databasePath}${suffix}`); } catch (error) {
        if (isErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      throw new Error("Session lease authority has an unexpected SQLite side file.");
    }
    return identityOf(stat);
  }

  private createLease(leasePath: string, sessionId: string, authority: FileIdentity): FileIdentity {
    this.assertDirectoryBinding();
    const content = Buffer.from(JSON.stringify({
      version: leaseVersion,
      runtimeId: this.runtimeId,
      pid: process.pid,
      sessionId,
      createdAt: new Date().toISOString(),
      authority
    } satisfies LeaseRecord));
    let descriptor: number | undefined;
    try {
      descriptor = openSync(leasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      fchmodSync(descriptor, 0o600);
      writeAll(descriptor, content);
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      assertSafeLeaseFile(stat, path.basename(leasePath));
      const identity = identityOf(stat);
      if (!sameIdentity(identity, this.fileIdentityAtPath(leasePath))) {
        throw new Error("Session lease changed during creation.");
      }
      return identity;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private readLease(leasePath: string, expectedSessionId: string): LeaseRecord {
    const bytes = this.readSecureFile(leasePath);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error("Session lease is not valid JSON.");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Session lease is malformed.");
    }
    const record = value as Record<string, unknown>;
    if (
      record.version !== leaseVersion
      || typeof record.runtimeId !== "string"
      || !record.runtimeId
      || typeof record.pid !== "number"
      || !Number.isSafeInteger(record.pid)
      || record.pid <= 0
      || record.sessionId !== expectedSessionId
      || typeof record.createdAt !== "string"
      || !Number.isFinite(Date.parse(record.createdAt))
    ) {
      throw new Error("Session lease is malformed.");
    }
    const authority = parseFileIdentity(record.authority);
    if (record.authority !== undefined && !authority) throw new Error("Session lease authority is malformed.");
    return {
      version: record.version,
      runtimeId: record.runtimeId,
      pid: record.pid,
      sessionId: expectedSessionId,
      createdAt: record.createdAt,
      authority
    };
  }

  private readSecureFile(filePath: string): Buffer {
    this.assertDirectoryBinding();
    let descriptor: number | undefined;
    try {
      descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      assertSafeLeaseFile(stat, path.basename(filePath));
      const identity = identityOf(stat);
      if (!sameIdentity(identity, this.fileIdentityAtPath(filePath))) {
        throw new Error("Session lease changed during read.");
      }
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (read === 0) throw new Error("Session lease ended during read.");
        offset += read;
      }
      if (!sameIdentity(identityOf(fstatSync(descriptor)), this.fileIdentityAtPath(filePath))) {
        throw new Error("Session lease changed during read.");
      }
      return bytes;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private retireStaleLease(leasePath: string): void {
    const identity = this.fileIdentityAtPath(leasePath);
    const stalePath = path.join(
      this.directoryPath,
      `.${path.basename(leasePath)}.stale-${Date.now()}-${randomBytes(8).toString("hex")}.json`
    );
    renameSync(leasePath, stalePath);
    if (!sameIdentity(identity, this.fileIdentityAtPath(stalePath))) {
      throw new Error("Session lease changed while reclaiming a stale lock.");
    }
  }

  private leasePath(sessionId: string): string {
    return path.join(this.directoryPath, `${leasePrefix}${sessionId}${leaseSuffix}`);
  }

  private fileIdentityAtPath(filePath: string): FileIdentity {
    this.assertDirectoryBinding();
    const stat = lstatSync(filePath);
    assertSafeLeaseFile(stat, path.basename(filePath));
    return identityOf(stat);
  }

  private assertDirectoryBinding(): void {
    const stat = lstatSync(this.directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(identityOf(stat), this.directoryIdentity)) {
      throw new Error("Session lease directory changed during runtime.");
    }
    if (realpathSync(this.directoryPath) !== this.directoryPath) {
      throw new Error("Session lease directory resolves outside the persistence root.");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Session lease store is closed.");
  }
}

function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId === "." || sessionId === ".." || sessionId.length > 512 || sessionId.includes("\0") || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

function assertSafeLeaseFile(stat: Stats, name: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > maxLeaseBytes) {
    throw new Error(`Unsafe session lease file: ${name}`);
  }
}

function identityOf(stat: Pick<Stats, "dev" | "ino">): FileIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function parseFileIdentity(value: unknown): FileIdentity | undefined {
  if (typeof value !== "object" || value === null || !("device" in value) || !("inode" in value)) return undefined;
  if (typeof value.device !== "number" || !Number.isSafeInteger(value.device)
    || typeof value.inode !== "number" || !Number.isSafeInteger(value.inode)) return undefined;
  return { device: value.device, inode: value.inode };
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database (?:table )?is locked/u.test(error.message);
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written === 0) throw new Error("Could not write session lease.");
    offset += written;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
