/**
 * 超出回合预算的工具结果归档模块。
 *
 * 归档引用保持 `.biny/tool-results` 这一稳定格式，但物理文件落在全局按项目隔离的运行目录。
 * 文件名完全由运行期标识派生。模型拿到的是归档引用而不是原文，需要完整内容时通过
 * `read_tool_result` 工具按需取回。
 */
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDir, ensureAgentDirs } from "./store.js";
import { redactSecrets, redactSensitiveValue, type SensitiveValueRedactionOptions } from "../utils/secrets.js";

const archiveVersion = 1;
const previewCharacters = 8_192;
const maxArchiveFileBytes = 64 * 1024 * 1024;
const maxRetainedArchives = 512;
// Do not wait for a FIFO writer before checking that the archive is regular.
const nonBlockingReadFlag = process.platform === "win32" || typeof fsConstants.O_NONBLOCK !== "number" ? 0 : fsConstants.O_NONBLOCK;
const archiveDirectory = path.posix.join(".biny", "tool-results");
const archiveNamePattern = /^tool-result-[0-9a-f]{64}\.json$/;

export interface ArchivedToolResult {
  archivePath: string;
  resultBytes: number;
}

export interface ArchiveToolResultOptions {
  workspaceRoot: string;
  sessionId: string;
  toolCallId: string;
  sequence: number;
  tool: string;
  result: unknown;
  /** Reuse of an already-computed serialization; recomputed when omitted. */
  output?: string;
}

export interface ToolResultArchiveEnvelope {
  version: number;
  archivedAt: string;
  sessionId: string;
  toolCallId: string;
  sequence: number;
  tool: string;
  output: string;
}

/** Returns a redacted, UTF-8 representation suitable for budget accounting. */
export function serializeToolResult(result: unknown, options: SensitiveValueRedactionOptions = {}): string {
  if (typeof result === "string") return options.context === "mcp-result" ? result : redactSecrets(result);
  try {
    return JSON.stringify(redactSensitiveValue(result, options), jsonReplacer) ?? "null";
  } catch {
    return options.context === "mcp-result" ? String(result) : redactSecrets(String(result));
  }
}

/**
 * Preserve an oversized result outside the conversation and session JSONL.
 * The filename is derived only from opaque runtime identifiers, never a
 * model-provided path or tool argument.
 */
export async function archiveToolResult(options: ArchiveToolResultOptions): Promise<ArchivedToolResult> {
  const output = options.output ?? serializeToolResult(options.result);
  const archiveName = `tool-result-${archiveId(options)}.json`;
  const archivePath = path.posix.join(archiveDirectory, archiveName);
  await ensureAgentDirs(options.workspaceRoot);
  const targetPath = path.join(agentDir(options.workspaceRoot), "tool-results", archiveName);
  const payload = `${JSON.stringify({
    version: archiveVersion,
    archivedAt: new Date().toISOString(),
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    sequence: options.sequence,
    tool: options.tool,
    output
  } satisfies ToolResultArchiveEnvelope)}\n`;
  // Match the reader's file limit, including JSON escaping and the final newline.
  // Otherwise a successful write could hand the model an unreadable reference.
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > maxArchiveFileBytes) {
    throw new Error(`Archived tool result is ${String(payloadBytes)} bytes, exceeding the ${String(maxArchiveFileBytes)}-byte read limit.`);
  }
  try {
    await fs.writeFile(targetPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    // Reuse an immutable archive only after verifying the existing bytes. A
    // failed or concurrent write can leave this deterministic name incomplete.
    if (!isExistingPathError(error)) throw error;
    const existing = await readToolResultArchive(options.workspaceRoot, archivePath);
    if (existing.version !== archiveVersion
      || existing.sessionId !== options.sessionId
      || existing.toolCallId !== options.toolCallId
      || existing.sequence !== options.sequence
      || existing.tool !== options.tool
      || existing.output !== output) {
      throw new Error("Existing tool result archive does not match the requested call and output.");
    }
  }
  await pruneToolResultArchives(options.workspaceRoot, maxRetainedArchives, archiveName);
  return { archivePath, resultBytes: Buffer.byteLength(output, "utf8") };
}

/**
 * Bounded head/tail excerpt. `maxCharacters` lets the caller shrink the excerpt
 * as the remaining turn budget runs out.
 */
export function toolResultPreview(value: string, maxCharacters = previewCharacters): string {
  if (maxCharacters <= 0) return "";
  if (value.length <= maxCharacters) return value;
  const headLength = Math.floor(maxCharacters / 2);
  const tailLength = maxCharacters - headLength;
  const head = safePrefix(value, headLength);
  const tail = safeSuffix(value, tailLength);
  const omitted = Buffer.byteLength(value.slice(head.length, value.length - tail.length), "utf8");
  return `${head}\n… [${String(omitted)} bytes omitted] …\n${tail}`;
}

/**
 * Resolve a model-supplied archive reference. The accepted shape is fully
 * constrained, so a tool argument can never address anything outside the
 * archive directory.
 */
export function resolveToolResultArchivePath(workspaceRoot: string, archivePath: string): string {
  const normalized = archivePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const relative = normalized.startsWith(`${archiveDirectory}/`) ? normalized : path.posix.join(archiveDirectory, normalized);
  const archiveName = path.posix.basename(relative);
  if (relative !== path.posix.join(archiveDirectory, archiveName) || !archiveNamePattern.test(archiveName)) {
    throw new Error(`Not an archived tool result reference: ${archivePath}`);
  }
  return path.join(agentDir(workspaceRoot), "tool-results", archiveName);
}

export async function readToolResultArchive(
  workspaceRoot: string,
  archivePath: string,
  signal?: AbortSignal
): Promise<ToolResultArchiveEnvelope> {
  signal?.throwIfAborted();
  const targetPath = resolveToolResultArchivePath(workspaceRoot, archivePath);
  // O_NOFOLLOW + 普通文件校验：即使有人在归档目录里放软链，也读不出目录之外的内容。
  const handle = await fs.open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | nonBlockingReadFlag);
  let content: string;
  try {
    const stats = await handle.stat({ bigint: false });
    if (!stats.isFile()) throw new Error(`Archived tool result is not a regular file: ${archivePath}`);
    assertArchiveFileSize(stats.size);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const readLimit = maxArchiveFileBytes + 1;
    while (totalBytes < readLimit) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, totalBytes);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      assertArchiveFileSize(totalBytes);
      // Short reads must not retain a full unused chunk for every small result.
      chunks.push(bytesRead === chunk.length ? chunk : Buffer.from(chunk.subarray(0, bytesRead)));
    }
    // A file may grow again after EOF; do not decode a now-oversized archive.
    assertArchiveFileSize((await handle.stat()).size);
    signal?.throwIfAborted();
    content = Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await handle.close();
  }
  // Cancellation may arrive while reading or closing the handle. Never turn an
  // interrupted read into a successful page after the file has been released.
  signal?.throwIfAborted();
  const parsed: unknown = JSON.parse(content);
  if (!isArchiveEnvelope(parsed)) throw new Error(`Archived tool result is malformed: ${archivePath}`);
  return parsed;
}

function assertArchiveFileSize(bytes: number): void {
  if (bytes > maxArchiveFileBytes) {
    throw new Error(`Archived tool result is ${String(bytes)} bytes, exceeding the ${String(maxArchiveFileBytes)}-byte read limit.`);
  }
}

/** Keeps the archive directory bounded; the oldest references expire first. */
export async function pruneToolResultArchives(workspaceRoot: string, retain = maxRetainedArchives, protectedArchiveName?: string): Promise<void> {
  const directory = path.join(agentDir(workspaceRoot), "tool-results");
  let entries: string[];
  try {
    entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && archiveNamePattern.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  if (entries.length <= retain) return;
  const aged = (await Promise.all(entries.map(async (name) => {
    try {
      return { name, modifiedMs: (await fs.stat(path.join(directory, name))).mtimeMs };
    } catch {
      return undefined;
    }
  }))).filter((entry): entry is { name: string; modifiedMs: number } => entry !== undefined);
  aged.sort((left, right) => right.modifiedMs - left.modifiedMs);
  // The current call must not prune the reference it is about to return. Keep
  // its existing share of the budget without changing any archive timestamps.
  const candidates = aged.filter((entry) => entry.name !== protectedArchiveName);
  const retainCandidates = candidates.length === aged.length ? retain : Math.max(0, retain - 1);
  await Promise.all(candidates.slice(retainCandidates).map(async (entry) => {
    await fs.rm(path.join(directory, entry.name), { force: true });
  }));
}

function archiveId(options: ArchiveToolResultOptions): string {
  return createHash("sha256")
    .update(options.sessionId)
    .update("\0")
    .update(options.toolCallId)
    .update("\0")
    .update(String(options.sequence))
    .digest("hex");
}

function isArchiveEnvelope(value: unknown): value is ToolResultArchiveEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ToolResultArchiveEnvelope>;
  return typeof candidate.output === "string" && typeof candidate.tool === "string" && typeof candidate.archivedAt === "string";
}

function isExistingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function safePrefix(value: string, length: number): string {
  let end = Math.min(value.length, Math.max(0, length));
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

function safeSuffix(value: string, length: number): string {
  let start = Math.max(0, value.length - Math.max(0, length));
  if (start < value.length && isLowSurrogate(value.charCodeAt(start))) start += 1;
  return value.slice(start);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
