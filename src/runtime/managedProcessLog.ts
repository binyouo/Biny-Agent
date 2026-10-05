/** A managed log keeps its creation-time inode identity while allowing normal appends. */
import { isUtf8 } from "node:buffer";
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
  let output: Omit<ManagedProcessOutput, "processId">;
  try {
    const metadata = await assertLogBinding(binding, file);
    signal?.throwIfAborted();
    const totalBytes = Number(metadata.size);
    if (!Number.isSafeInteger(totalBytes)) throw new Error("Managed process log is too large to paginate safely.");
    const startOffset = options.fromEnd === true ? Math.max(0, totalBytes - maxBytes) : Math.min(requestedOffset, totalBytes);
    const buffer = Buffer.alloc(Math.min(maxBytes, totalBytes - startOffset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, startOffset);
    signal?.throwIfAborted();
    const page = buffer.subarray(0, bytesRead);
    const consumedBytes = await completeUtf8PageBytes(binding, file, page, startOffset, totalBytes, signal);
    await assertLogBinding(binding, file);
    const nextOffset = startOffset + consumedBytes;
    output = { logPath: binding.path, content: page.subarray(0, consumedBytes).toString("utf8"), startOffset, nextOffset,
      totalBytes, omittedBefore: startOffset > 0, hasMore: nextOffset < totalBytes };
  } finally {
    await file.close();
  }
  // Validation and handle release can yield after the last read-time check.
  signal?.throwIfAborted();
  return output;
}

/**
 * maxBytes bounds consumed source bytes. Inspect at most three extra bytes,
 * without advancing the cursor, to prove a valid code point crosses this page.
 * Malformed bytes, explicit starting offsets, and actual EOF retain decoding.
 */
async function completeUtf8PageBytes(
  binding: ManagedProcessLogBinding,
  file: FileHandle,
  page: Buffer,
  startOffset: number,
  totalBytes: number,
  signal?: AbortSignal
): Promise<number> {
  const pageEnd = startOffset + page.length;
  if (page.length === 0 || pageEnd >= totalBytes) return page.length;
  let characterStart = page.length - 1;
  while (characterStart > Math.max(0, page.length - 3) && (page[characterStart]! & 0xc0) === 0x80) characterStart--;
  const first = page[characterStart]!;
  const width = first >= 0xc2 && first <= 0xdf ? 2
    : first >= 0xe0 && first <= 0xef ? 3
    : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
  const prefixBytes = page.length - characterStart;
  if (width === 0 || prefixBytes >= width || pageEnd + width - prefixBytes > totalBytes) return page.length;

  const characterEnd = pageEnd + width - prefixBytes;
  const before = await assertLogBinding(binding, file);
  signal?.throwIfAborted();
  if (before.size < BigInt(characterEnd)) throw new Error("Managed process log changed during boundary inspection; retry the page.");
  const character = Buffer.alloc(width);
  page.copy(character, 0, characterStart);
  let inspected = 0;
  const needed = width - prefixBytes;
  while (inspected < needed) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(character, prefixBytes + inspected, needed - inspected, pageEnd + inspected);
    signal?.throwIfAborted();
    if (bytesRead === 0) throw new Error("Managed process log changed during boundary inspection; retry the page.");
    inspected += bytesRead;
  }
  const after = await assertLogBinding(binding, file);
  signal?.throwIfAborted();
  if (after.size < BigInt(characterEnd)) throw new Error("Managed process log changed during boundary inspection; retry the page.");
  if (!isUtf8(character)) return page.length;
  if (characterStart === 0) throw new RangeError(`maxBytes is too small for the next UTF-8 character; use at least ${String(width)}.`);
  return characterStart;
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
