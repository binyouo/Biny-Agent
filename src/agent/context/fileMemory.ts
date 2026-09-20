/**
 * 面向用户和 Agent 的文件型长期记忆。
 *
 * MEMORY.md 保存跨日期的人工可读内容；每日文件由 dailyNotes 维护。读取路径不创建文件，
 * 写入路径使用临时文件、锁和重命名，确保多个运行时不会互相截断正文。
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dailyNoteForModel } from "../../activity/modelContext.js";
import { globalConfigDir } from "../../config/paths.js";
import { readDailyMemoryNote } from "../../activity/dailyNotes.js";

const longTermFileName = "MEMORY.md";
const lockTimeoutMs = 5_000;
const lockPollMs = 25;
const maxLongTermChars = 32_000;

export interface FileMemoryOptions {
  configDir?: string;
  allowActivity?: boolean;
}

export class FileMemoryStorage {
  readonly configDir: string;
  readonly longTermPath: string;

  constructor(options: FileMemoryOptions = {}) {
    this.configDir = path.resolve(options.configDir ?? globalConfigDir());
    this.longTermPath = path.join(this.configDir, longTermFileName);
  }

  async readLongTerm(): Promise<string | undefined> {
    try {
      const content = (await readFile(this.longTermPath, "utf8")).trim();
      if (!content || isOnlyHeading(content)) return undefined;
      return content.slice(0, maxLongTermChars);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async writeLongTerm(content: string): Promise<string> {
    const normalized = content.replace(/\r\n?/gu, "\n").trim();
    if (!normalized) throw new Error("Long-term memory cannot be empty.");
    await ensureDirectory(this.configDir);
    return await withFileLock(this.longTermPath, async () => {
      await atomicWrite(this.longTermPath, normalized.endsWith("\n") ? normalized : `${normalized}\n`);
      return this.longTermPath;
    });
  }

  async append(content: string, options: { section?: string; entryKey?: string } = {}): Promise<string> {
    const normalized = content.replace(/\r\n?/gu, "\n").trim();
    if (!normalized) throw new Error("Long-term memory entry cannot be empty.");
    await ensureDirectory(this.configDir);
    return await withFileLock(this.longTermPath, async () => {
      const existing = await readOptional(this.longTermPath) ?? "# MEMORY.md\n";
      const marker = options.entryKey === undefined
        ? undefined
        : `<!-- biny-memory-entry:${createHash("sha256").update(options.entryKey).digest("hex").slice(0, 24)} -->`;
      if (marker && existing.includes(marker)) return this.longTermPath;
      const section = options.section?.trim() || "## Learned";
      const heading = section.startsWith("## ") ? section : `## ${section}`;
      const next = upsertAppendSection(existing, heading, [marker, normalized].filter(Boolean).join("\n"));
      await atomicWrite(this.longTermPath, next);
      return this.longTermPath;
    });
  }
}

export async function readFileMemoryPrompt(
  now = new Date(),
  options: FileMemoryOptions = {}
): Promise<string | undefined> {
  const storage = new FileMemoryStorage(options);
  // 长期文件与两份日报互不依赖；活动库暂时不可读时不能把已经存在的 MEMORY.md 一并丢掉。
  const results = await Promise.allSettled([
    storage.readLongTerm(),
    readDailyMemoryNote(formatLocalDate(now), options),
    readDailyMemoryNote(formatLocalDate(new Date(now.getTime() - 86_400_000)), options)
  ]);
  const [longTerm, todayRaw, yesterdayRaw] = results.map((result) => result.status === "fulfilled" ? result.value : undefined);
  const today = todayRaw ? dailyNoteForModel(todayRaw, options.allowActivity === true) : undefined;
  const yesterday = yesterdayRaw ? dailyNoteForModel(yesterdayRaw, options.allowActivity === true) : undefined;
  const sections = [
    longTerm ? `## Long-term Memory (${storage.longTermPath})\n${longTerm}` : undefined,
    today ? `## Today's Notes (${formatLocalDate(now)})\n${today}` : undefined,
    yesterday ? `## Yesterday's Notes (${formatLocalDate(new Date(now.getTime() - 86_400_000))})\n${yesterday}` : undefined
  ].filter((section): section is string => section !== undefined);
  if (!sections.length) return undefined;
  return [
    "FILE-BASED MEMORY — your persistent memory across sessions; read these to remember context.",
    ...sections
  ].join("\n\n").slice(0, maxLongTermChars);
}

function upsertAppendSection(existing: string, heading: string, content: string): string {
  const lines = existing.trim().split("\n");
  const index = lines.findIndex((line) => line.trim() === heading);
  if (index < 0) return `${existing.trim()}\n\n${heading}\n\n${content.trim()}\n`;
  let end = index + 1;
  while (end < lines.length && !/^#{1,2} /u.test(lines[end] ?? "")) end += 1;
  const current = lines.slice(index + 1, end).join("\n").trim();
  const merged = current ? `${current}\n\n${content.trim()}` : content.trim();
  return [...lines.slice(0, index), heading, "", merged, ...lines.slice(end)].join("\n").trim() + "\n";
}

async function withFileLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (true) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > lockTimeoutMs) await rm(lockPath, { force: true });
      } catch (statError) {
        if (!isNotFound(statError)) throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file memory lock: ${path.basename(target)}`);
      await new Promise((resolve) => setTimeout(resolve, lockPollMs));
    }
  }
  try {
    return await work();
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try { return await readFile(filePath, "utf8"); } catch (error) { if (isNotFound(error)) return undefined; throw error; }
}

function isOnlyHeading(content: string): boolean {
  return content === "# MEMORY.md" || content === "# 长期记忆";
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
