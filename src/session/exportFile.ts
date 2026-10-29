/** POSIX explicit exports publish complete content without truncating the previous backup.
 * Windows deliberately retains its legacy direct-write behavior and limitations.
 * Path checks are best effort, not a security boundary in a hostile writable directory.
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export interface SessionExportReceipt {
  file: string;
  committed: true;
  warnings: string[];
}

export class SessionExportWriteError extends Error {
  readonly committed = false;
  readonly code: string | undefined;
  constructor(cause: unknown, readonly warnings: string[]) {
    super(`Session export was not committed: ${message(cause)}${warnings.length ? `\n${warnings.join("\n")}` : ""}`, { cause });
    this.name = "SessionExportWriteError";
    this.code = errorCode(cause);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameVersion(a: BigIntStats | undefined, b: BigIntStats | undefined): boolean {
  return a === undefined || b === undefined ? a === b : sameIdentity(a, b)
    && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function statIfPresent(file: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
}
function assertRegularTarget(stat: BigIntStats | undefined): void {
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)) {
    throw new Error("Session export requires a regular, single-link output file. Choose a new output path instead of a symbolic link, hard link, directory or special file.");
  }
}
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const nonBlocking = process.platform !== "win32" && typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

/** Check actual write authorization without truncation or an additional read requirement. */
async function authorizeReplacement(file: string, expected: BigIntStats): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | noFollow | nonBlocking);
  let primary: unknown;
  let failed = false;
  try {
    const current = await handle.stat({ bigint: true });
    assertRegularTarget(current);
    if (!sameVersion(expected, current)) throw new Error("Export target changed before write authorization.");
  } catch (error) { primary = error; failed = true; }
  const warnings: string[] = [];
  try { await handle.close(); }
  catch (error) {
    if (!failed) throw error;
    warnings.push(`Could not close export authorization handle: ${message(error)}`);
  }
  if (failed) throw new SessionExportWriteError(primary, warnings);
}

/** Only explicit destinations use this helper. Default CLI wx naming remains separate. */
export async function writeSessionExportFile(destination: string, content: string): Promise<SessionExportReceipt> {
  const requested = path.resolve(destination);
  // Windows deliberately retains its existing direct writer. POSIX staging does
  // not establish Windows ACL privacy; do not introduce an unproven ACL transition.
  if (process.platform === "win32") {
    await fs.writeFile(requested, content, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(requested, 0o600);
    return { file: requested, committed: true, warnings: [] };
  }
  const requestedParent = path.dirname(requested);
  const directory = await fs.realpath(requestedParent);
  const parent = await fs.lstat(directory, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Export parent must be an existing directory.");
  const target = path.join(directory, path.basename(requested));
  const original = await statIfPresent(target);
  assertRegularTarget(original);
  if (original) await authorizeReplacement(target, original);
  const temporary = path.join(directory, `.biny-export-${String(process.pid)}-${randomBytes(16).toString("hex")}.tmp`);
  let handle: FileHandle | undefined;
  let owned: BigIntStats | undefined;
  let opened = false;
  let committed = false;
  let moved = false;
  let primary: unknown;
  let failed = false;
  const warnings: string[] = [];
  const checkParent = async () => {
    const current = await fs.lstat(directory, { bigint: true });
    if (await fs.realpath(requestedParent) !== directory || !current.isDirectory() || !sameIdentity(parent, current)) {
      throw new Error("Export parent directory changed before publication.");
    }
  };
  const checkTemporary = async () => {
    const current = await fs.lstat(temporary, { bigint: true });
    if (!owned || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameIdentity(owned, current)) {
      throw new Error("Export staging file changed before publication.");
    }
  };
  try {
    await checkParent();
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    opened = true;
    owned = await handle.stat({ bigint: true });
    await checkTemporary();
    await handle.chmod(0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await checkParent();
    const current = await statIfPresent(target);
    assertRegularTarget(current);
    if (!sameVersion(original, current)) throw new Error("Export target changed before publication; the newer file was not replaced.");
    if (current) await authorizeReplacement(target, current);
    await checkTemporary();
    if (original) {
      // Never unlink/copy as a fallback if replacement is refused (including Windows sharing failures).
      await fs.rename(temporary, target);
      committed = true;
      moved = true;
    } else {
      // Unlike rename, link cannot overwrite a destination created after our check.
      await fs.link(temporary, target);
      committed = true;
    }
  } catch (error) { primary = error; failed = true; }
  if (handle) {
    try { await handle.close(); }
    catch (error) { warnings.push(`Could not close export staging file ${JSON.stringify(temporary)}: ${message(error)}`); }
  }
  if (!moved && opened) {
    try {
      const current = await statIfPresent(temporary);
      if (current) {
        if (!owned || !current.isFile() || current.isSymbolicLink() || !sameIdentity(owned, current)) throw new Error("staging path ownership changed; not removed");
        await fs.unlink(temporary);
      }
    } catch (error) { warnings.push(`Could not clean export staging path ${JSON.stringify(temporary)}: ${message(error)}`); }
    // Diagnostics may fail too; they must never hide the original I/O failure or a commit.
    try {
      const remaining = await statIfPresent(temporary);
      if (remaining) warnings.push(`Export staging path remains: ${JSON.stringify(temporary)}. Verify its ownership before manual removal; do not blindly delete it.`);
    } catch (error) { warnings.push(`Export staging cleanup could not be verified for ${JSON.stringify(temporary)}: ${message(error)}`); }
  }
  if (!committed) throw new SessionExportWriteError(failed ? primary : new Error("Export was not published."), warnings);
  return { file: requested, committed: true, warnings };
}
