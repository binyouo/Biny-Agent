import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";

/**
 * 每日记忆笔记：给人和 agent 看的可读叙事，不属于 durable memory entries。
 * 文件是按日期共享的派生结果；聊天摘要和 Activity 摘要各自维护自己的 Markdown section，
 * 避免一个来源刷新时覆盖另一个来源。
 */
const dailyNoteQueues = new Map<string, Promise<void>>();
const dailyNoteLockTimeoutMs = 5_000;
const dailyNoteLockPollMs = 25;

interface DailyNoteWriteOptions {
  configDir?: string;
  checkpoint?: () => Promise<void>;
}

export async function writeDailyMemoryNote(
  dateKey: string,
  content: string,
  options: { configDir?: string } = {}
): Promise<string> {
  return await mutateDailyMemoryNote(dateKey, options, () => {
    const trimmed = content.trim();
    return trimmed ? trimmed : `# ${dateKey}\n\n（这一天没有可写入的记录。）`;
  });
}

export interface DailyMemoryNote {
  dateKey: string;
  content: string;
}

/** 读取今天和昨天的文件记忆；读取不创建目录，也不触碰 SQLite durable memory。 */
export async function readDailyMemoryNotes(
  now = new Date(),
  options: { configDir?: string } = {}
): Promise<DailyMemoryNote[]> {
  // 昨日末尾的小时可能被夏令时跳过；按日历构造，不继承当前时刻。
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const dateKeys = [formatLocalDate(now), formatLocalDate(yesterday)];
  const notes = await Promise.all(dateKeys.map(async (dateKey) => {
    const content = await readDailyMemoryNote(dateKey, options);
    return content === undefined ? undefined : { dateKey, content };
  }));
  return notes.filter((note): note is DailyMemoryNote => note !== undefined);
}

/** 读取任意一天的 Markdown；只读路径不会创建文件或目录。 */
export async function readDailyMemoryNote(
  dateKey: string,
  options: { configDir?: string } = {}
): Promise<string | undefined> {
  assertDailyDate(dateKey);
  try {
    const content = (await readFile(dailyMemoryPath(dateKey, options), "utf8")).trim();
    return content || undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** 从一份日报中读取指定二级 section；用于汇总时隔离聊天与 Activity 来源。 */
export function readDailyMemorySection(content: string, sectionTitle: string): string | undefined {
  const heading = normalizeSectionHeading(sectionTitle);
  const section = readDailySection(content, heading);
  return section || undefined;
}

/** 替换指定 section，供 Activity 这类可整体重建的派生来源使用。 */
export async function upsertDailyMemorySection(
  dateKey: string,
  sectionTitle: string,
  content: string,
  options: DailyNoteWriteOptions = {}
): Promise<string> {
  assertDailyDate(dateKey);
  const heading = normalizeSectionHeading(sectionTitle);
  return await mutateDailyMemoryNote(dateKey, options, (existing) => replaceDailySection(
    existing,
    dateKey,
    heading,
    content.trim() || "（暂无可写入内容。）"
  ));
}

/** 追加一个可幂等识别的聊天摘要条目；同一 turn 重试不会重复污染日报。 */
export async function appendDailyMemoryEntry(
  dateKey: string,
  sectionTitle: string,
  entryKey: string,
  content: string,
  options: { configDir?: string } = {}
): Promise<string> {
  assertDailyDate(dateKey);
  const heading = normalizeSectionHeading(sectionTitle);
  const marker = `<!-- biny-daily-entry:${createHash("sha256").update(entryKey).digest("hex").slice(0, 24)} -->`;
  return await mutateDailyMemoryNote(dateKey, options, (existing) => {
    const withSection = replaceDailySection(existing, dateKey, heading, readDailySection(existing, heading));
    if (withSection.includes(marker)) return withSection;
    const section = readDailySection(withSection, heading);
    const entry = [marker, content.trim() || "（空摘要。）"].join("\n");
    const next = section.trim() ? `${section.trim()}\n\n${entry}` : entry;
    return replaceDailySection(withSection, dateKey, heading, next);
  });
}

/** Activity 日报只更新「活动记录」section，不覆盖聊天摘要。 */
export async function writeDailyActivityNote(
  dateKey: string,
  content: string,
  options: DailyNoteWriteOptions = {}
): Promise<string> {
  assertDailyDate(dateKey);
  let body = content.trim();
  const rootHeading = `# ${dateKey} 每日摘要`;
  const legacyHeading = `## ${dateKey} 工作日记`;
  if (body.startsWith(rootHeading)) body = body.slice(rootHeading.length).trimStart();
  if (body.startsWith(legacyHeading)) body = body.slice(legacyHeading.length).trimStart();
  return await upsertDailyMemorySection(dateKey, "活动记录", body, options);
}

async function mutateDailyMemoryNote(
  dateKey: string,
  options: DailyNoteWriteOptions,
  mutate: (existing: string) => string
): Promise<string> {
  assertDailyDate(dateKey);
  const target = dailyMemoryPath(dateKey, options);
  const previous = dailyNoteQueues.get(target) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => turn, () => turn);
  dailyNoteQueues.set(target, queued);
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    await options.checkpoint?.();
    await previous;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    releaseFileLock = await acquireDailyNoteLock(target);
    const existing = await readDailyNote(target, dateKey);
    const next = `${mutate(existing).trim()}\n`;
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await options.checkpoint?.();
      await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
      await options.checkpoint?.();
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return target;
  } finally {
    await releaseFileLock?.();
    release();
    if (dailyNoteQueues.get(target) === queued) dailyNoteQueues.delete(target);
  }
}

async function readDailyNote(target: string, dateKey: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return `# ${dateKey} 每日摘要`;
  }
}

function dailyMemoryPath(dateKey: string, options: { configDir?: string }): string {
  const root = path.resolve(options.configDir ?? globalConfigDir());
  return path.join(root, "memory", `${dateKey}.md`);
}

function replaceDailySection(existing: string, dateKey: string, heading: string, content: string): string {
  const root = existing.trim() || `# ${dateKey} 每日摘要`;
  const lines = root.split("\n");
  const sectionHeadings = heading === "## 活动记录"
    ? [heading, `## ${dateKey} 工作日记`]
    : [heading];
  const start = lines.findIndex((line) => sectionHeadings.includes(line.trim()));
  if (start < 0) return `${root}\n\n${heading}\n\n${content.trim()}`;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2} /u.test(lines[end] ?? "")) end += 1;
  return [
    ...lines.slice(0, start),
    heading,
    "",
    content.trim(),
    ...lines.slice(end)
  ].join("\n").trim();
}

function readDailySection(existing: string, heading: string): string {
  const lines = existing.trim().split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^#{1,2} /u.test(lines[end] ?? "")) end += 1;
  return lines.slice(start + 1, end).join("\n").trim();
}

async function acquireDailyNoteLock(target: string): Promise<() => Promise<void>> {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + dailyNoteLockTimeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      return async () => {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > dailyNoteLockTimeoutMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (isNotFound(statError)) continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for daily memory note lock: ${path.basename(target)}`);
      await new Promise((resolve) => setTimeout(resolve, dailyNoteLockPollMs));
    }
  }
}

function normalizeSectionHeading(value: string): string {
  const title = value.trim();
  if (!title || title.includes("\n") || title.includes("\r")) throw new Error("Daily memory section title must be a single non-empty line.");
  return title.startsWith("## ") ? title : `## ${title}`;
}

function assertDailyDate(dateKey: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) throw new Error(`Invalid daily memory date: ${dateKey}`);
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
