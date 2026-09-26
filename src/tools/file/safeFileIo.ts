/**
 * 安全文件读写。
 *
 * 工具层所有真实的文件读写都走这里，目的是两条：一是有界（读取有字节上限，不会被巨大文件
 * 打爆内存），二是不被中途换掉目标。
 *
 * 「不被换掉」靠 `FileSnapshot`（device/inode/size/mode/链接数/时间戳）实现：打开后、写入
 * 前、提交前反复核对句柄和路径指向的还是同一个 inode，一旦不一致就中止。所有打开操作都带
 * `O_NOFOLLOW`，符号链接一律拒绝，避免被引到工作区之外。
 *
 * 写入是原子的：先写临时文件并 fsync，新建用 `link`（目标已存在即失败，不覆盖），覆盖用
 * `rename`，并先用硬链接把原文件的 inode 钉住，以便提交窗口内被外部改动时能还原回去。
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { FileChangeUncertainError } from "./fileChange.js";

export const maxEditFileBytes = 1024 * 1024;

export interface FileSnapshot {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  links: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

interface CreatedDirectory {
  path: string;
  identity: FileIdentity;
}

export interface BoundedFileRead {
  content: string;
  truncated: boolean;
  snapshot: FileSnapshot;
}

export interface Utf8LineVisitResult {
  snapshot: FileSnapshot;
  completed: boolean;
  linesVisited: number;
}

const maxStreamedLineBytes = 1024 * 1024;

/**
 * 按行流式读取普通文件；不会因为文件总体很大而把全文放进内存。
 * 回调返回 false 时安全停止，但仍会复核路径与已打开句柄是否指向同一版本。
 */
export async function visitBoundUtf8Lines(
  filePath: string,
  visit: (line: string, lineNumber: number) => boolean | void,
  signal?: AbortSignal
): Promise<Utf8LineVisitResult> {
  signal?.throwIfAborted();
  const handle = await openBoundRegularFile(filePath);
  try {
    const initial = await assertFileBinding(filePath, handle);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let position = 0;
    let lineNumber = 0;
    let completed = true;
    while (true) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const result = await handle.read(chunk, 0, chunk.length, position);
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
      pending += decoder.write(chunk.subarray(0, result.bytesRead));
      if (Buffer.byteLength(pending, "utf8") > maxStreamedLineBytes && !pending.includes("\n")) {
        throw new Error(`File contains a line exceeding the ${String(maxStreamedLineBytes)}-byte streamed line limit.`);
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        signal?.throwIfAborted();
        const rawLine = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(rawLine, "utf8") > maxStreamedLineBytes) {
          throw new Error(`File contains a line exceeding the ${String(maxStreamedLineBytes)}-byte streamed line limit.`);
        }
        lineNumber += 1;
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (visit(line, lineNumber) === false) {
          completed = false;
          break;
        }
        newline = pending.indexOf("\n");
      }
      if (!completed) break;
    }
    if (completed) {
      pending += decoder.end();
      if (pending.length > 0) {
        if (Buffer.byteLength(pending, "utf8") > maxStreamedLineBytes) {
          throw new Error(`File contains a line exceeding the ${String(maxStreamedLineBytes)}-byte streamed line limit.`);
        }
        lineNumber += 1;
        visit(pending, lineNumber);
      }
    }
    const current = await assertFileBinding(filePath, handle);
    if (!sameFileSnapshot(initial, current)) throw new Error("File changed while it was being read.");
    return { snapshot: current, completed, linesVisited: lineNumber };
  } finally {
    await handle.close();
  }
}

export class FileReadLimitError extends Error {
  constructor(readonly actualBytes: bigint, readonly maxBytes: number) {
    super(`File is ${String(actualBytes)} bytes, exceeding the ${String(maxBytes)}-byte read limit.`);
    this.name = "FileReadLimitError";
  }
}

export async function readBoundedUtf8File(filePath: string, maxBytes: number, overflow: "reject" | "truncate", signal?: AbortSignal): Promise<BoundedFileRead> {
  const result = await readBoundedFile(filePath, maxBytes, overflow, signal);
  return { ...result, content: result.content.toString("utf8") };
}

export async function readBoundedBinaryFile(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  return (await readBoundedFile(filePath, maxBytes, "reject", signal)).content;
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
  overflow: "reject" | "truncate",
  signal?: AbortSignal
): Promise<{ content: Buffer; truncated: boolean; snapshot: FileSnapshot }> {
  signal?.throwIfAborted();
  const handle = await openBoundRegularFile(filePath);
  try {
    const initial = await assertFileBinding(filePath, handle);
    if (overflow === "reject" && initial.size > BigInt(maxBytes)) {
      throw new FileReadLimitError(initial.size, maxBytes);
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    const readLimit = maxBytes + 1;
    while (bytesRead < readLimit) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      signal?.throwIfAborted();
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }

    const current = await assertFileBinding(filePath, handle);
    if (!sameFileSnapshot(initial, current)) throw new Error("File changed while it was being read.");
    const truncated = bytesRead > maxBytes || current.size > BigInt(maxBytes);
    if (overflow === "reject" && truncated) {
      throw new FileReadLimitError(current.size > BigInt(bytesRead) ? current.size : BigInt(bytesRead), maxBytes);
    }
    return {
      content: Buffer.concat(chunks, bytesRead).subarray(0, maxBytes),
      truncated,
      snapshot: current
    };
  } finally {
    await handle.close();
  }
}

export async function readUtf8FileForEdit(filePath: string, signal?: AbortSignal): Promise<{ content: string; snapshot: FileSnapshot }> {
  const result = await readBoundedUtf8File(filePath, maxEditFileBytes, "reject", signal);
  return { content: result.content, snapshot: result.snapshot };
}

/**
 * 原子写入单个文件，返回写入字节数。
 *
 * `expectedSnapshot` 表示调用方认为写之前文件应有的状态：`null` 意为「文件应当不存在」，
 * 传具体快照意为「必须还是我读到的那一版」，`undefined` 则表示不做版本校验（以当前状态为准）。
 * 对不上就抛错，绝不悄悄覆盖别人的改动。
 */
export async function atomicWriteUtf8File(filePath: string, content: string, expectedSnapshot: FileSnapshot | null | undefined, signal?: AbortSignal, onCommit?: (evidence: string) => void | Promise<void>): Promise<number> {
  return atomicWriteFile(filePath, content, expectedSnapshot, signal, onCommit);
}

/** 二进制产物只允许新建，不覆盖用户已有文件；复用同一 inode 与原子提交边界。 */
export async function atomicWriteBinaryFile(filePath: string, content: Uint8Array, signal?: AbortSignal, onCommit?: (evidence: string) => void | Promise<void>): Promise<number> {
  return atomicWriteFile(filePath, content, null, signal, onCommit);
}

async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  expectedSnapshot: FileSnapshot | null | undefined,
  signal?: AbortSignal,
  onCommit?: (evidence: string) => void | Promise<void>
): Promise<number> {
  signal?.throwIfAborted();
  const directory = path.dirname(filePath);
  let directorySnapshot: FileIdentity;
  try {
    directorySnapshot = await snapshotDirectory(directory);
  } catch (error) {
    if (isNotFound(error)) throw new Error("The target parent directory must already exist.");
    throw error;
  }
  const currentTarget = await snapshotTarget(filePath);
  const targetSnapshot = expectedSnapshot === undefined ? currentTarget : expectedSnapshot;
  if (!sameOptionalFileSnapshot(targetSnapshot, currentTarget)) {
    throw new Error("The target file changed before the atomic write started.");
  }

  const temporaryPath = path.join(
    directory,
    `.biny-write-${String(process.pid)}-${randomBytes(8).toString("hex")}.tmp`
  );
  let backupPath: string | undefined;
  let backupSnapshot: FileSnapshot | undefined;
  let handle: FileHandle | undefined;
  let temporarySnapshot: FileSnapshot | undefined;
  let committed = false;
  try {
    await assertDirectoryBinding(directory, directorySnapshot);
    handle = await fs.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      targetSnapshot ? Number(targetSnapshot.mode & 0o777n) : 0o666
    );
    temporarySnapshot = await assertFileBinding(temporaryPath, handle, true);
    if (targetSnapshot) await handle.chmod(Number(targetSnapshot.mode & 0o777n));
    signal?.throwIfAborted();
    await handle.writeFile(content, { encoding: "utf8", signal });
    signal?.throwIfAborted();
    await handle.sync();
    signal?.throwIfAborted();
    temporarySnapshot = await assertFileBinding(temporaryPath, handle, true);
    await assertDirectoryBinding(directory, directorySnapshot);
    const targetBeforeCommit = await snapshotTarget(filePath);
    if (!sameOptionalFileSnapshot(targetSnapshot, targetBeforeCommit)) {
      throw new Error("The target file changed before the atomic write could be committed.");
    }
    signal?.throwIfAborted();

    if (targetSnapshot === null) {
      // 新建文件用 link 提交：它是「不覆盖」的原子操作，和 rename 不同，
      // 不会把最后一次校验之后刚被别人创建出来的文件冲掉。
      try {
        await fs.link(temporaryPath, filePath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new Error("The target file appeared before the atomic write could be committed.");
        }
        throw error;
      }
      committed = true;
      await fs.unlink(temporaryPath);
      temporarySnapshot = undefined;
    } else {
      // 覆盖已有文件前，用硬链接把「已确认的那一版」inode 钉住，让它在 rename 之后仍可访问。
      // 如果提交窗口内有别的进程通过旧路径写入，靠这个备份既能发现改动，也能把内容还原回去，
      // 而不是直接丢掉。
      backupPath = path.join(
        directory,
        `.biny-backup-${String(process.pid)}-${randomBytes(8).toString("hex")}.tmp`
      );
      await fs.link(filePath, backupPath);
      backupSnapshot = await requiredTargetSnapshot(backupPath);
      if (!sameStableFileVersion(targetSnapshot, backupSnapshot)) {
        throw new Error("The target file changed while its approved version was being pinned.");
      }
      signal?.throwIfAborted();

      // rename 就是覆盖写的提交点。这一行之后即使收到取消信号，也不能把「已完成的替换」
      // 当成未提交去回滚，因此下面立刻置 committed。
      await fs.rename(temporaryPath, filePath);
      temporarySnapshot = undefined;
      committed = true;
      const displacedSnapshot = await requiredTargetSnapshot(backupPath);
      backupSnapshot = displacedSnapshot;
      if (!sameStableFileVersion(targetSnapshot, displacedSnapshot)) {
        // 只有当前可见的目标还是我们刚提交的那个 inode 时才还原。若又被别人替换过，
        // 就两个文件都保留并直接失败，不去覆盖那个更新的外部版本。
        await assertFileBinding(filePath, handle, true);
        await fs.rename(backupPath, filePath);
        backupPath = undefined;
        backupSnapshot = undefined;
        committed = false;
        throw new Error("The target file changed during the atomic commit and the external version was restored.");
      }
      await fs.unlink(backupPath);
      backupPath = undefined;
      backupSnapshot = undefined;
    }
    await assertFileBinding(filePath, handle, true);
    // 走到这里文件已经提交成功。对目录 fsync 只是为了在支持的文件系统上提高断电耐久性，
    // 某些文件系统不允许同步目录，那种失败不能让已完成的写入被报成失败。
    await syncDirectory(directory).catch(() => undefined);
    await reportCommitted(onCommit, `Atomic file commit completed for ${path.basename(filePath)}.`);
    return Buffer.byteLength(content, "utf8");
  } finally {
    if (!committed && handle && temporarySnapshot) {
      try {
        temporarySnapshot = await assertFileBinding(temporaryPath, handle, true);
      } catch {
        temporarySnapshot = undefined;
      }
    }
    await handle?.close().catch(() => undefined);
    if (!committed && temporarySnapshot) {
      await removeBoundTemporaryFile(directory, directorySnapshot, temporaryPath, temporarySnapshot);
    }
    if (backupPath && backupSnapshot) {
      await removeBoundAuxiliaryFile(directory, directorySnapshot, backupPath, backupSnapshot);
    }
  }
}

/**
 * 工作区内的原子写入：只在规范化后的工作区根之下创建缺失的真实目录层级。
 *
 * 写入失败或被取消时会回收本次创建的目录，但只删「仍然为空、且 inode 还是本次创建的那个」
 * 的目录，避免删掉别人同时建出来的同名目录。
 */
export async function atomicWriteWorkspaceUtf8File(
  workspaceRoot: string,
  filePath: string,
  content: string,
  expectedSnapshot: FileSnapshot | null | undefined,
  signal?: AbortSignal,
  onCommit?: (evidence: string) => void | Promise<void>
): Promise<number> {
  signal?.throwIfAborted();
  const createdDirectories = await createMissingWorkspaceDirectories(workspaceRoot, path.dirname(filePath), signal);
  let committed = false;
  try {
    signal?.throwIfAborted();
    const bytes = await atomicWriteUtf8File(filePath, content, expectedSnapshot, signal, onCommit);
    committed = true;
    return bytes;
  } finally {
    if (!committed) await removeCreatedDirectories(createdDirectories);
  }
}

export async function snapshotRegularFile(filePath: string, signal?: AbortSignal): Promise<FileSnapshot> {
  signal?.throwIfAborted();
  const handle = await openBoundRegularFile(filePath);
  try {
    signal?.throwIfAborted();
    return await assertFileBinding(filePath, handle);
  } finally {
    await handle.close();
  }
}

/**
 * 删除一个已绑定的普通文件：先把确认过的 inode 移到同目录下的私有隔离路径，再真正删除。
 *
 * 这样做是为了「删错了还能还原」——如果在这一步发现文件已被替换，会把隔离出来的版本移回去，
 * 而不是把别人的新文件默默删掉。
 */
export async function deleteBoundRegularFile(
  filePath: string,
  expectedSnapshot: FileSnapshot,
  signal?: AbortSignal,
  onCommit?: (evidence: string) => void | Promise<void>
): Promise<void> {
  signal?.throwIfAborted();
  const directory = path.dirname(filePath);
  const directoryIdentity = await snapshotDirectory(directory);
  const handle = await openBoundRegularFile(filePath);
  const quarantinePath = path.join(
    directory,
    `.biny-delete-${String(process.pid)}-${randomBytes(8).toString("hex")}.tmp`
  );
  let quarantined = false;
  try {
    const initial = await assertFileBinding(filePath, handle);
    if (!sameFileSnapshot(initial, expectedSnapshot)) {
      throw new Error("The delete target changed after the tool call was prepared.");
    }
    await assertDirectoryBinding(directory, directoryIdentity);
    signal?.throwIfAborted();
    const beforeCommit = await assertFileBinding(filePath, handle);
    if (!sameFileSnapshot(beforeCommit, expectedSnapshot)) {
      throw new Error("The delete target changed before it could be removed.");
    }

    // 从这次 rename 开始，剩下的小事务一路做完、不再检查取消信号，
    // 否则中途取消会留下一个「删了一半」的状态。
    await fs.rename(filePath, quarantinePath);
    quarantined = true;
    const moved = await assertFileBinding(quarantinePath, handle);
    if (!sameStableFileVersion(moved, expectedSnapshot)) {
      throw new Error("The delete target changed during the atomic removal.");
    }
    await fs.unlink(quarantinePath);
    quarantined = false;
    await reportCommitted(onCommit, `Atomic file deletion completed for ${path.basename(filePath)}.`);
    await syncDirectory(directory).catch(() => undefined);
  } catch (error) {
    if (quarantined) {
      try {
        await assertDirectoryBinding(directory, directoryIdentity);
        await assertFileBinding(quarantinePath, handle);
        if (await snapshotTarget(filePath) === null) {
          await fs.rename(quarantinePath, filePath);
          quarantined = false;
        }
      } catch {
        // 目录或目标位置变了就保留隔离文件不动：覆盖掉一个更新的外部文件，
        // 比在目录里留下一个可追查的隔离文件更糟。
      }
    }
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 移动一个已准备好的普通文件，且不覆盖「授权之后才出现」的目标路径。
 *
 * 用 link + unlink 而不是 rename：在支持硬链接的文件系统上，link 遇到已存在的目标会失败，
 * 天然是「不覆盖」的提交方式。跨设备移动直接报错，不降级成未经校验的复制。
 */
export async function moveBoundRegularFile(
  sourcePath: string,
  destinationPath: string,
  expectedSnapshot: FileSnapshot,
  signal?: AbortSignal,
  onCommit?: (evidence: string) => void | Promise<void>
): Promise<void> {
  signal?.throwIfAborted();
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) throw new Error("The move source and destination must differ.");

  const sourceDirectory = path.dirname(source);
  const destinationDirectory = path.dirname(destination);
  const sourceDirectorySnapshot = await snapshotDirectory(sourceDirectory);
  const destinationDirectorySnapshot = await snapshotDirectory(destinationDirectory);
  const handle = await openBoundRegularFile(source);
  let linked = false;
  let sourceRemoved = false;
  try {
    const initial = await assertFileBinding(source, handle, true);
    if (!sameFileSnapshot(initial, expectedSnapshot)) {
      throw new Error("The move source changed after the tool call was prepared.");
    }
    if (await snapshotTarget(destination) !== null) {
      throw new Error("The move destination already exists.");
    }
    await assertDirectoryBinding(sourceDirectory, sourceDirectorySnapshot);
    await assertDirectoryBinding(destinationDirectory, destinationDirectorySnapshot);
    signal?.throwIfAborted();

    const beforeCommit = await assertFileBinding(source, handle, true);
    if (!sameFileSnapshot(beforeCommit, expectedSnapshot)) {
      throw new Error("The move source changed before it could be moved.");
    }
    if (await snapshotTarget(destination) !== null) {
      throw new Error("The move destination appeared before it could be moved.");
    }

    try {
      await fs.link(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        throw new Error("The move source and destination must be on the same filesystem.");
      }
      if (isAlreadyExists(error)) throw new Error("The move destination appeared before it could be moved.");
      throw error;
    }
    linked = true;

    // link 成功即为「不覆盖」的提交点。此后不再响应取消：要么把 unlink 做完，
    // 要么留下一份可核对的副本供人工恢复，不能停在中间态。
    const moved = await assertFileBinding(destination, handle);
    if (!sameStableFileVersion(moved, expectedSnapshot)) {
      throw new Error("The move destination does not contain the prepared source inode.");
    }
    const sourceBeforeUnlink = await assertFileBinding(source, handle);
    if (!sameStableFileVersion(sourceBeforeUnlink, expectedSnapshot)) {
      throw new Error("The move source changed during the move commit.");
    }
    await fs.unlink(source);
    sourceRemoved = true;
    linked = false;
    await reportCommitted(onCommit, `Atomic file move committed from ${path.basename(source)} to ${path.basename(destination)}.`);
    await syncDirectory(sourceDirectory).catch(() => undefined);
    if (destinationDirectory !== sourceDirectory) await syncDirectory(destinationDirectory).catch(() => undefined);
  } catch (error) {
    if (linked && !sourceRemoved) {
      try {
        await assertFileBinding(destination, handle);
        if (await snapshotTarget(source) === null) sourceRemoved = true;
        if (!sourceRemoved) await fs.unlink(destination);
      } catch {
        // 目标状态不确定时宁可留着，也不要误删掉一个替换进来的新文件。
      }
    }
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function reportCommitted(onCommit: ((evidence: string) => void | Promise<void>) | undefined, evidence: string): Promise<void> {
  // 调用时文件副作用已经提交，回调失败只能向上报告，不能触发文件回滚。
  try {
    await onCommit?.(evidence);
  } catch (error) {
    throw new FileChangeUncertainError(`File side effect committed, but its evidence callback failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * 逐层创建缺失目录，并记录「哪几层是本次创建的」以便回滚。
 *
 * 从规范化的工作区根开始一段一段往下走，每建一层都核对父目录还是原来那个 inode，
 * 这样即使路径中某一段在中途被替换成软链接，也不会顺着它跑到工作区外面去。
 */
async function createMissingWorkspaceDirectories(
  workspaceRoot: string,
  targetDirectory: string,
  signal?: AbortSignal
): Promise<CreatedDirectory[]> {
  const canonicalRoot = await fs.realpath(path.resolve(workspaceRoot));
  const absoluteTarget = path.resolve(targetDirectory);
  const relative = path.relative(canonicalRoot, absoluteTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The target parent directory escapes the workspace.");
  }

  const created: CreatedDirectory[] = [];
  let current = canonicalRoot;
  try {
    await snapshotDirectory(current);
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      signal?.throwIfAborted();
      const parentIdentity = await snapshotDirectory(current);
      const candidate = path.join(current, segment);
      let madeDirectory = false;
      try {
        await fs.mkdir(candidate);
        madeDirectory = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      await assertDirectoryBinding(current, parentIdentity);
      const identity = await snapshotDirectory(candidate);
      if (madeDirectory) created.push({ path: candidate, identity });
      current = candidate;
    }
    signal?.throwIfAborted();
    return created;
  } catch (error) {
    await removeCreatedDirectories(created);
    throw error;
  }
}

/** 回滚本次创建的目录：从最深一层往外删，且只删 inode 未变的空目录。 */
async function removeCreatedDirectories(created: readonly CreatedDirectory[]): Promise<void> {
  for (const directory of [...created].reverse()) {
    try {
      const current = await snapshotDirectory(directory.path);
      if (sameIdentity(current, directory.identity)) await fs.rmdir(directory.path);
    } catch {
      // 回滚过程绝不删被替换过的目录，也不删非空目录（rmdir 会自己失败）。
    }
  }
}

async function openBoundRegularFile(filePath: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw new Error("File changed to a symbolic link before it could be opened.");
    throw error;
  }
  try {
    await assertFileBinding(filePath, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * 核对「已打开的句柄」和「路径当前指向的文件」仍是同一个 inode，并返回最新快照。
 * `requireSingleLink` 用于临时文件和提交场景：要求硬链接数为 1，确保没有第二条路径指向它。
 */
async function assertFileBinding(filePath: string, handle: FileHandle, requireSingleLink = false): Promise<FileSnapshot> {
  const descriptorStat = await handle.stat({ bigint: true });
  const pathStat = await fs.lstat(filePath, { bigint: true });
  if (
    !descriptorStat.isFile()
    || !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || (requireSingleLink && (descriptorStat.nlink !== 1n || pathStat.nlink !== 1n))
    || await fs.realpath(filePath) !== path.resolve(filePath)
  ) {
    throw new Error("File path changed during access.");
  }
  return fileSnapshot(descriptorStat);
}

/** 取目标文件快照；文件不存在返回 null（这是合法状态），是软链接或非普通文件则报错。 */
async function snapshotTarget(filePath: string): Promise<FileSnapshot | null> {
  try {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(filePath) !== path.resolve(filePath)) {
      throw new Error("Atomic write target must remain a regular file at its canonical path.");
    }
    return fileSnapshot(stat);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function requiredTargetSnapshot(filePath: string): Promise<FileSnapshot> {
  const snapshot = await snapshotTarget(filePath);
  if (!snapshot) throw new Error("Atomic write auxiliary file disappeared during access.");
  return snapshot;
}

async function snapshotDirectory(directory: string): Promise<FileIdentity> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) {
    throw new Error("Atomic write parent must remain a real canonical directory.");
  }
  return { device: stat.dev, inode: stat.ino };
}

async function assertDirectoryBinding(directory: string, expected: FileIdentity): Promise<void> {
  const current = await snapshotDirectory(directory);
  if (!sameIdentity(expected, current)) throw new Error("Atomic write parent directory changed during access.");
}

async function removeBoundTemporaryFile(
  directory: string,
  directorySnapshot: FileIdentity,
  temporaryPath: string,
  temporarySnapshot: FileSnapshot
): Promise<void> {
  try {
    await assertDirectoryBinding(directory, directorySnapshot);
    const stat = await fs.lstat(temporaryPath, { bigint: true });
    const current = fileSnapshot(stat);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n && sameFileSnapshot(current, temporarySnapshot)) {
      await fs.unlink(temporaryPath);
    }
  } catch {
    // 临时文件已消失、被改名、被加了硬链接或被替换时都不删，避免误删别人的文件。
  }
}

async function removeBoundAuxiliaryFile(
  directory: string,
  directorySnapshot: FileIdentity,
  auxiliaryPath: string,
  auxiliarySnapshot: FileSnapshot
): Promise<void> {
  try {
    await assertDirectoryBinding(directory, directorySnapshot);
    const current = await requiredTargetSnapshot(auxiliaryPath);
    if (sameFileSnapshot(current, auxiliarySnapshot)) await fs.unlink(auxiliaryPath);
  } catch {
    // 所在目录或 inode 变过的辅助文件一律不删。
  }
}

/** 目录 fsync 让改名/创建也落盘；Windows 不支持以目录方式打开，直接跳过。 */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function fileSnapshot(stat: BigIntStats): FileSnapshot {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    links: stat.nlink,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs
  };
}

export function sameOptionalFileSnapshot(left: FileSnapshot | null, right: FileSnapshot | null): boolean {
  if (left === null || right === null) return left === right;
  return sameFileSnapshot(left, right);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.links === right.links
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt;
}

/**
 * 比 `sameFileSnapshot` 宽松一档：不比较硬链接数。
 * 提交过程中会临时给文件加/去硬链接（备份、隔离），此时 nlink 必然变化，但内容版本没变。
 */
function sameStableFileVersion(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.modifiedAt === right.modifiedAt;
}

/** 平台不提供 O_NOFOLLOW 时退化为 0（不加该标志），此时依赖 lstat 校验兜底。 */
function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}
