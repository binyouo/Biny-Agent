/** A managed log keeps its creation-time inode identity while allowing normal appends. */
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ManagedProcessOutput, ReadManagedProcessOutputOptions } from "./ManagedProcessService.js";

export interface ManagedProcessLogBinding {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

/** Bind the descriptor used for creation, before it is handed to the child process. */
export async function bindManagedProcessLog(logPath: string, handle: FileHandle): Promise<ManagedProcessLogBinding> {
  const metadata = await handle.stat({ bigint: true });
  const binding = Object.freeze({ path: path.resolve(logPath), device: metadata.dev, inode: metadata.ino });
  await assertLogBinding(binding, handle);
  return binding;
}

export async function readManagedProcessLog(
  binding: ManagedProcessLogBinding,
  options: ReadManagedProcessOutputOptions = {},
  signal?: AbortSignal
): Promise<Omit<ManagedProcessOutput, "processId">> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const requestedOffset = options.offset ?? 0;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) {
    throw new RangeError("maxBytes must be an integer between 1 and 262144.");
  }
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) {
    throw new RangeError("offset must be a non-negative integer.");
  }
  signal?.throwIfAborted();
  // Validate before opening, and use nonblocking open so a raced-in FIFO cannot stall the host.
  await assertLogPath(binding);
  const file = await fs.open(binding.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await assertLogBinding(binding, file);
    signal?.throwIfAborted();
    const totalBytes = Number(metadata.size);
    if (!Number.isSafeInteger(totalBytes)) throw new Error("Managed process log is too large to paginate safely.");
    const startOffset = options.fromEnd === true ? Math.max(0, totalBytes - maxBytes) : Math.min(requestedOffset, totalBytes);
    const buffer = Buffer.alloc(Math.min(maxBytes, totalBytes - startOffset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, startOffset);
    signal?.throwIfAborted();
    await assertLogBinding(binding, file);
    const nextOffset = startOffset + bytesRead;
    return { logPath: binding.path, content: buffer.subarray(0, bytesRead).toString("utf8"), startOffset, nextOffset,
      totalBytes, omittedBefore: startOffset > 0, hasMore: nextOffset < totalBytes };
  } finally {
    await file.close();
  }
}

async function assertLogPath(binding: ManagedProcessLogBinding): Promise<BigIntStats> {
  const metadata = await fs.lstat(binding.path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n
    || metadata.dev !== binding.device || metadata.ino !== binding.inode
    || await fs.realpath(binding.path) !== binding.path) {
    throw new Error("Managed process log path no longer names its original single-link regular file.");
  }
  return metadata;
}

async function assertLogBinding(binding: ManagedProcessLogBinding, file: FileHandle): Promise<BigIntStats> {
  const descriptor = await file.stat({ bigint: true });
  await assertLogPath(binding);
  if (!descriptor.isFile() || descriptor.nlink !== 1n || descriptor.dev !== binding.device || descriptor.ino !== binding.inode) {
    throw new Error("Managed process log descriptor no longer names its original regular file.");
  }
  return descriptor;
}
