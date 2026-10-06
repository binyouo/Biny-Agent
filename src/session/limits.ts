/**
 * Session 文件的大小上限与有界读取。
 *
 * session 是本地 JSONL，可能被外部程序写坏或写到极大，直接整体读入会打爆内存，所以
 * 完整读取统一预算；大文件逐行解析，不能按字节裁断消息父链。
 */
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export const maxSessionFileBytes = 128 * 1024 * 1024;
// 单事件保护独立于整个会话的读取预算，避免一个异常事件耗尽内存。
export const maxSessionEventLineBytes = 16 * 1024 * 1024 - 1;
export const maxSessionEvents = 50_000;

const sessionReadChunkBytes = 64 * 1024;

/** 接近上限的比例；越过就该提醒用户分叉，而不是等撞上再说。 */
export const sessionSizeWarningRatio = 0.8;

export function isSessionNearLimit(sizeBytes: number, events: number): boolean {
  return sizeBytes > maxSessionFileBytes * sessionSizeWarningRatio
    || events > maxSessionEvents * sessionSizeWarningRatio;
}

export function assertSessionFileSize(size: number, label: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxSessionFileBytes) {
    throw new Error(`Session exceeds the maximum size of ${String(maxSessionFileBytes)} bytes: ${path.basename(label)}`);
  }
}

/**
 * 分块读完整个 session 文件，并在读前、读中、读后各校验一次大小。
 * 只信任读取前的 stat 是不够的：读的过程中文件仍可能被追加，所以多读一个字节即判超限，
 * 读完后再 stat 一次确认文件没有在期间涨过上限。
 */
export async function readBoundedSessionHandle(handle: FileHandle, label: string): Promise<Buffer> {
  const initialStat = await handle.stat();
  assertSessionFileSize(initialStat.size, label);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxSessionFileBytes) {
    // 故意多留 1 字节的余量：能读到这一字节说明文件已超限，下面的校验会抛错。
    const remaining = maxSessionFileBytes + 1 - totalBytes;
    const buffer = Buffer.allocUnsafe(Math.min(sessionReadChunkBytes, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalBytes);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  assertSessionFileSize(totalBytes, label);
  const finalStat = await handle.stat();
  assertSessionFileSize(finalStat.size, label);
  return Buffer.concat(chunks, totalBytes);
}

/** 固定读取开始时的文件长度，按 JSONL 的 LF 分行；内存只保留一行与一个读取块。 */
export async function* readSessionEventLines(handle: FileHandle, size: number): AsyncGenerator<string> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Session has an unreadable size.");
  let offset = 0;
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let lineNumber = 1;
  while (offset < size) {
    const buffer = Buffer.allocUnsafe(Math.min(sessionReadChunkBytes, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) throw new Error("Session changed while reading history.");
    offset += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      const newline = buffer.indexOf(0x0a, start);
      const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
      const part = buffer.subarray(start, end);
      lineBytes += part.length;
      if (lineBytes > maxSessionEventLineBytes) {
        throw new Error(`Session event line ${String(lineNumber)} exceeds the maximum size of ${String(maxSessionEventLineBytes)} bytes.`);
      }
      parts.push(part);
      if (end === bytesRead) break;
      yield Buffer.concat(parts, lineBytes).toString("utf8") + "\n";
      parts = [];
      lineBytes = 0;
      lineNumber++;
      start = end + 1;
    }
  }
  if (lineBytes) yield Buffer.concat(parts, lineBytes).toString("utf8");
}
