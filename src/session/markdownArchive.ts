/** 会话 Markdown 是可重建导出，不替代 JSONL，也不改变事实记忆的归档状态。 */
import { lstat, open, readFile, readdir, rename, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { globalAgentDir } from "../config/paths.js";
import { parseSessionEvents } from "./events.js";
import { listAllSessionFiles, sessionIdFromFile } from "./store.js";
import { withLocalFileWriteLock } from "../utils/localFileLock.js";
import { maxSessionFileBytes } from "./limits.js";

const generatedMarker = "<!-- biny:conversation-markdown -->\n";
export const conversationMirrorIntervalMs = 30 * 60 * 1_000;

export interface MarkdownArchiveResult {
  directory: string;
  exported: number;
  removed: number;
  failed: Array<{ sessionId: string; error: string }>;
}

export async function archiveConversationMarkdown(agentDir = globalAgentDir()): Promise<MarkdownArchiveResult> {
  const directory = path.join(agentDir, "threads");
  // 手动导出和多个工作区宿主共享同一把已有的文件锁，避免旧快照覆盖较新的快照。
  return await withLocalFileWriteLock(directory, ".mirror.lock", async () => {
    const result: MarkdownArchiveResult = { directory, exported: 0, removed: 0, failed: [] };
    const files = await listAllSessionFiles(agentDir);
    const ids = new Set(files.map(sessionIdFromFile));
    const duplicates = new Set(files.map(sessionIdFromFile).filter((id, i, all) => all.indexOf(id) !== i));
    for (const file of files) {
      const id = sessionIdFromFile(file);
      try {
        if (duplicates.has(id)) throw new Error("Duplicate session id; refusing to overwrite another conversation.");
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let text: string;
        try {
          const source = await handle.stat();
          if (!source.isFile() || source.nlink !== 1 || source.size > maxSessionFileBytes) throw new Error("Unsafe or oversized session file.");
          // 固定读取已观察到的长度，追加写入留到下一轮，避免追着活跃会话无限读取。
          const bytes = Buffer.alloc(source.size);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          text = bytes.subarray(0, offset).toString("utf8");
        } finally { await handle.close(); }
        // 正在追加的最后半行不是完整事件，留待下次导出。
        const events = parseSessionEvents(text.slice(0, text.lastIndexOf("\n") + 1));
        const messages = events.filter((event) => event.type === "user_message" || event.type === "assistant_message");
        const target = path.join(directory, `${id}.md`);
        if (!messages.length) {
          if (await removeGeneratedFile(target)) result.removed += 1;
          continue;
        }
        const content = generatedMarker + [`# Conversation ${id}`, ...messages.map((event) => `## ${event.type === "user_message" ? "User" : "Assistant"} · ${event.time}\n\n${event.content}`)].join("\n\n") + "\n";
        if (await readExistingFile(target) === content) continue;
        await writeSnapshot(target, content);
        result.exported += 1;
      } catch (error) {
        result.failed.push({ sessionId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // 只回收带生成标记的孤立快照，用户自建 Markdown 和旧的无标记导出不动。
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".md") || ids.has(name.slice(0, -3))) continue;
      try {
        if (await removeGeneratedFile(path.join(directory, name))) result.removed += 1;
      } catch (error) {
        result.failed.push({ sessionId: name.slice(0, -3), error: error instanceof Error ? error.message : String(error) });
      }
    }
    await writeSnapshot(path.join(directory, ".mirror-status.json"), JSON.stringify({ ...result, updatedAt: new Date().toISOString() }) + "\n");
    return result;
  });
}

/** 宿主拥有定时器；关闭先排空当前批次，再读取最后一次落盘的原文。 */
export class ConversationMarkdownMirror {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<MarkdownArchiveResult> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly agentDir = globalAgentDir()) {}

  async start(): Promise<void> {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, conversationMirrorIntervalMs);
    this.timer.unref();
    await this.refresh();
  }

  refresh(): Promise<MarkdownArchiveResult> {
    if (this.pending) return this.pending;
    const pending = archiveConversationMarkdown(this.agentDir).finally(() => { this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const started = this.timer !== undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    this.closing = (async () => {
      await this.pending?.catch(() => undefined);
      if (started) await this.refresh();
    })();
    return this.closing;
  }
}

async function readExistingFile(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Markdown target must be a single-link regular file.");
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeGeneratedFile(file: string): Promise<boolean> {
  if (!(await readExistingFile(file))?.startsWith(generatedMarker)) return false;
  await rm(file);
  return true;
}

async function writeSnapshot(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
