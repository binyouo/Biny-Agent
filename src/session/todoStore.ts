/**
 * 回合间的计划清单。
 *
 * 长任务里模型会漂：做到第 12 步时，第 3 步说好要回头改的东西已经不在上下文里了。历史
 * 压缩会让这种遗忘更早发生 —— 被摘要掉的正是那些"待会儿要做"的细节。
 *
 * 这份清单是模型自己维护的锚：每回合注入 system prompt，所以它永远看得见；落盘到
 * 全局按项目隔离的 `todos` 目录，所以恢复会话后还在。Agent Loop 会把它作为模型上下文使用，
 * 陈旧 Todo 不会独自驱动自动验收或无限 continuation。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDir, ensureAgentDirs } from "./store.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export const maxTodoItems = 50;
export const maxTodoContentLength = 500;

export class TodoStore {
  private items: TodoItem[] = [];
  private loaded = false;
  private commitQueue: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string, private sessionId: string) {}

  async initialize(): Promise<void> {
    if (this.loaded) return;
    await this.loadCurrentSession();
  }

  /** Session resume 后切换真值源，避免继续读写创建 runtime 时的旧 session 清单。 */
  async useSession(sessionId: string): Promise<void> {
    if (this.loaded && this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.loaded = false;
    this.items = [];
    await this.loadCurrentSession();
  }

  private async loadCurrentSession(): Promise<void> {
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath(), "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.items = normalizeItems(parsed);
    } catch {
      // 没有清单、清单损坏或读不出来，都从空清单开始 —— 它是工作记忆，不是事实来源。
      this.items = [];
    }
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /**
   * 整份替换而不是增量改。模型每次给出完整清单，就不会出现"改第 3 条"却数错序号的
   * 情况，也省掉一套 id 分配和对账逻辑。
   */
  async replace(items: readonly unknown[]): Promise<TodoItem[]> {
    if (!Array.isArray(items)) throw new TypeError("A plan must be an array of items.");
    if (items.length > maxTodoItems) {
      throw new RangeError(`A plan may hold at most ${String(maxTodoItems)} items; received ${String(items.length)}.`);
    }
    const nextItems = Array.from(items, (item: unknown): TodoItem => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new TypeError("Plan items must be objects with content and status.");
      }
      const { content, status } = item as { content?: unknown; status?: unknown };
      if (typeof content !== "string" || !content.trim()) throw new RangeError("Plan items must have non-empty content.");
      if (content.length > maxTodoContentLength) {
        throw new RangeError(`Plan item content must be at most ${String(maxTodoContentLength)} characters.`);
      }
      if (status !== "pending" && status !== "in_progress" && status !== "completed") {
        throw new RangeError("Plan item status must be pending, in_progress, or completed.");
      }
      return { content: content.trim(), status };
    });
    const inProgress = nextItems.filter((item) => item.status === "in_progress");
    if (inProgress.length > 1) {
      throw new RangeError("At most one plan item may be in_progress at a time; finish or re-queue the others.");
    }
    await this.persist(nextItems);
    return nextItems.map((item) => ({ ...item }));
  }

  /** 注入 system prompt 的段落；清单为空时不占位。 */
  promptSection(): string | undefined {
    if (!this.items.length) return undefined;
    const lines = this.items.map((item, index) => `${String(index + 1)}. [${statusMark(item.status)}] ${item.content}`);
    return [
      "## Current plan",
      "",
      "You maintain this list with `TodoWrite`. Keep it current: mark an item in_progress when you start it and completed when it is actually done, and add items you discover along the way. Never report work as finished while items remain pending.",
      "",
      ...lines
    ].join("\n");
  }

  private filePath(): string {
    return path.join(agentDir(this.workspaceRoot), "todos", `${this.sessionId}.json`);
  }

  private async persist(items: TodoItem[]): Promise<void> {
    await ensureAgentDirs(this.workspaceRoot);
    const target = this.filePath();
    // 临时名带随机成分：并发 persist 共用固定名会互相截断对方的临时文件。
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, items })}\n`, { encoding: "utf8", mode: 0o600 });
      // 并发 rename 的磁盘完成顺序未必等于 Promise 恢复顺序；串行提交才能让内存与磁盘一致。
      const commit = this.commitQueue.then(async () => {
        await fs.rename(temporary, target);
        this.items = items;
      });
      // 单次失败不能阻断后续提交；清理留在队列外，也不能重新发布旧版本。
      this.commitQueue = commit.catch(() => undefined);
      await commit;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function statusMark(status: TodoStatus): string {
  if (status === "completed") return "x";
  return status === "in_progress" ? ">" : " ";
}

function normalizeItems(value: unknown): TodoItem[] {
  if (typeof value !== "object" || value === null) return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as { content?: unknown; status?: unknown };
    if (typeof candidate.content !== "string" || !candidate.content.trim()) return [];
    const status: unknown = candidate.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return [];
    const item: TodoItem = { content: candidate.content.slice(0, maxTodoContentLength), status };
    return [item];
  }).slice(0, maxTodoItems);
}
