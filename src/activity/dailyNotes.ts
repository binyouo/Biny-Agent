import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { globalConfigDir } from "../config/paths.js";

/**
 * 每日记忆笔记：给人和 agent 看的可读叙事，不属于 durable memory entries。
 * 文件是按日期共享的派生结果；聊天摘要和 Activity 摘要各自维护自己的 Markdown section，
 * 避免一个来源刷新时覆盖另一个来源。
 */
const dailyMarkdownParser = unified().use(remarkParse).freeze();
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

export class DailyMemorySectionConflictError extends Error {
  readonly name = "DailyMemorySectionConflictError";

  constructor() {
    super("Daily memory section changed while the refresh was running.");
  }
}

/** 替换指定 section；提供快照时在文件锁内比较，避免覆盖其他刷新已提交的正文。 */
export async function upsertDailyMemorySection(
  dateKey: string,
  sectionTitle: string,
  content: string,
  options: DailyNoteWriteOptions & { expectedSectionContent?: string } = {}
): Promise<string> {
  assertDailyDate(dateKey);
  const heading = normalizeSectionHeading(sectionTitle);
  return await mutateDailyMemoryNote(dateKey, options, (existing) => {
    if (options.expectedSectionContent !== undefined && readDailySection(existing, heading) !== options.expectedSectionContent) {
      throw new DailyMemorySectionConflictError();
    }
    return replaceDailySection(existing, dateKey, heading, content.trim() || "（暂无可写入内容。）");
  });
}

/** writer 和补写预筛共享同一 marker，保持既有条目的去重身份不变。 */
export function dailyMemoryEntryMarker(entryKey: string): string {
  return `<!-- biny-daily-entry:${createHash("sha256").update(entryKey).digest("hex").slice(0, 24)} -->`;
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
  const marker = dailyMemoryEntryMarker(entryKey);
  return await mutateDailyMemoryNote(dateKey, options, (existing) => {
    const alreadyPresent = existing.includes(marker);
    return replaceDailySection(existing, dateKey, heading, (section) => {
      if (alreadyPresent) return section;
      const entry = [marker, content.trim() || "（空摘要。）"].join("\n");
      return section ? `${section}\n\n${entry}` : entry;
    }, alreadyPresent ? "missing" : "any");
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

function replaceDailySection(
  existing: string, dateKey: string, heading: string, content: string | ((section: string) => string),
  rejectUnclosedFence: "missing" | "any" = "missing"
): string {
  const root = existing.trim() || `# ${dateKey} 每日摘要`;
  const lines = root.split("\n");
  const sectionHeadings = heading === "## 活动记录"
    ? [heading, `## ${dateKey} 工作日记`]
    : [heading];
  const range = dailySectionRange(lines, sectionHeadings, rejectUnclosedFence);
  const section = range ? lines.slice(range.start + 1, range.end).join("\n").trim() : "";
  const next = (typeof content === "function" ? content(section) : content).trim();
  if (!range) return `${root}\n\n${heading}\n\n${next}`;
  const { start, end } = range;
  return [
    ...lines.slice(0, start),
    heading,
    "",
    next,
    ...lines.slice(end)
  ].join("\n").trim();
}

function readDailySection(existing: string, heading: string): string {
  const lines = existing.trim().split("\n");
  const range = dailySectionRange(lines, [heading]);
  if (!range) return "";
  const { start, end } = range;
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Only document-level headings own notebook sections; nested Markdown stays content. */
function dailySectionRange(lines: string[], headings: string[], rejectUnclosedFence?: "missing" | "any"): { start: number; end: number } | undefined {
  const blocks = dailyMarkdownParser.parse(lines.join("\n")).children;
  let start: number | undefined;
  for (const block of blocks) {
    if (block.type !== "heading" || block.depth > 2 || !block.position) continue;
    const index = block.position.start.line - 1;
    const line = lines[index] ?? "";
    if (start !== undefined && /^#{1,2} /u.test(line)) return { start, end: index };
    if (start === undefined && headings.includes(line.trim())) start = index;
  }
  const last = blocks.at(-1);
  if (last?.type === "code" && last.position && (rejectUnclosedFence === "any" || (start === undefined && rejectUnclosedFence === "missing"))) {
    const firstLine = last.position.start.line - 1;
    const lastLine = last.position.end.line - 1;
    const opener = (lines[firstLine] ?? "").match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    const closer = (lines[lastLine] ?? "").replace(/\r$/u, "").match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
    if (opener && !(lastLine > firstLine && closer && closer[0] === opener[0] && closer.length >= opener.length)) {
      throw new Error("Cannot append daily memory content while a code fence is unclosed.");
    }
  }
  return start === undefined ? undefined : { start, end: lines.length };
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
