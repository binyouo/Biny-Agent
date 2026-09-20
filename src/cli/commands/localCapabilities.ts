/**
 * 记忆、日报、Heartbeat 和当前 session Todo 的 CLI 入口。
 *
 * 这里不复制领域存储：SQLite 记忆与 Heartbeat/反思通过 Runtime Host，日报直接复用
 * daily-notes，Todo 直接复用当前 session 的 TodoStore。
 */
import { connectOrSpawnRuntimeHost, connectRuntimeHost, type RuntimeHostClient } from "../../runtime/RuntimeHost.js";
import { archiveConversationMarkdown } from "../../session/markdownArchive.js";
import { startMemoryHttpServer } from "../../runtime/host/memory-http.js";
import { SessionSearchIndex } from "../../session/searchIndex.js";
import { globalConfigDir } from "../../config/paths.js";
import { readDailyMemoryNote, readDailyMemorySection } from "../../activity/dailyNotes.js";
import { HeartbeatFileStore } from "../../agent/context/heartbeat.js";
import { TodoStore, type TodoItem } from "../../session/todoStore.js";
import { resolveSessionFile, sessionIdFromFile } from "../../session/store.js";

export interface LocalCapabilityOutputOptions {
  json?: boolean;
  noSpawn?: boolean;
}

export async function memoryExportCommand(): Promise<void> {
  console.log(JSON.stringify(await archiveConversationMarkdown()));
}

export async function memoryServeCommand(workspaceRoot: string, port: number): Promise<void> {
  const token = process.env.BINY_MEMORY_API_TOKEN;
  if (!token?.trim()) throw new Error("请先设置 BINY_MEMORY_API_TOKEN；不会自动开放无认证的记忆接口。");
  await withHost(workspaceRoot, {}, async (client) => {
    const api = await startMemoryHttpServer(client, { token, port });
    console.log(`Memory API: http://127.0.0.1:${String(api.port)} (Bearer token required)`);
    try {
      await new Promise<void>((resolve) => {
        const stop = (): void => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    } finally { await api.close(); }
  });
}

export async function memoryListCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory<{ entries: unknown[]; storeRevision: number }>("list", {
      limit: 200,
      includeArchived: false
    });
    printResult(result, options.json, (value) => {
      const record = asRecord(value);
      const entries = Array.isArray(record.entries) ? record.entries : [];
      return entries.length
        ? entries.map((entry) => { const item = asRecord(entry); return `[${String(item.id)}] ${String(item.content)}`; }).join("\n")
        : "没有记忆条目。";
    });
  });
}

export async function memorySearchCommand(
  workspaceRoot: string,
  query: string,
  options: LocalCapabilityOutputOptions & { tag?: string[] } = {}
): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("search", { query, tags: options.tag, limit: 20 });
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

/** 记忆库统计：总量、来源分布与维护状态来自宿主只读快照。 */
export async function memoryStatsCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("overview", {});
    printResult(result, options.json, (value) => {
      const record = asRecord(value);
      const overview = asRecord(record.overview);
      const snapshot = asRecord(record.allEntries);
      const allEntries = Array.isArray(snapshot.entries) ? snapshot.entries as Array<Record<string, unknown>> : [];
      const countBy = (key: string): string => {
        const counts = new Map<string, number>();
        for (const entry of allEntries) {
          const label = typeof entry[key] === "string" ? entry[key] as string : "unknown";
          counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([label, count]) => `${label}=${String(count)}`).join(", ");
      };
      return [
        `记忆总条数：${String(overview.entryCount ?? allEntries.length)}（storeRevision=${String(overview.storeRevision ?? "?")}）`,
        `按 source：${countBy("source") || "无"}`,
        `维护状态：${JSON.stringify(record.maintenance ?? {})}`
      ].join("\n");
    });
  });
}

export async function memoryAddCommand(workspaceRoot: string, content: string | undefined, options: LocalCapabilityOutputOptions & { entry?: string } = {}): Promise<void> {
  if (Boolean(content) === Boolean(options.entry)) throw new Error("请提供正文或 --entry JSON，不能同时提供。");
  const entry = options.entry ? JSON.parse(options.entry) as Record<string, unknown> : { content };
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("write", {
      entry: {
        content: entry.content,
        tags: Array.isArray(entry.tags) ? entry.tags : undefined,
        importance: typeof entry.importance === "number" ? entry.importance : undefined,
        durability: entry.durability === "temporary" ? "temporary" : "permanent",
        rationale: typeof entry.rationale === "string" ? entry.rationale : undefined
      }
    });
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function memoryArchiveCommand(workspaceRoot: string, id: string, options: LocalCapabilityOutputOptions & { yes?: boolean } = {}): Promise<void> {
  requireConfirmation(options.yes, "归档记忆会改变召回结果");
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("archive", { id, archived: true });
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function memoryClearCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions & { yes?: boolean } = {}): Promise<void> {
  requireConfirmation(options.yes, "清理记忆会删除当前和归档条目");
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("clear");
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function memorySleepCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions & { run?: boolean; preview?: boolean; runs?: boolean; cancel?: boolean; yes?: boolean } = {}): Promise<void> {
  if ([options.run, options.preview, options.runs, options.cancel].filter(Boolean).length > 1) throw new Error("Sleep 只能选择一种操作。");
  if (options.preview || options.runs || options.cancel) {
    await withHost(workspaceRoot, options, async (client) => {
      const result = options.cancel ? await client.cancelMemorySleep() : await client.memory(options.preview ? "sleep-preview" : "sleep-runs");
      printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
    });
    return;
  }
  if (options.run) {
    requireConfirmation(options.yes, "Sleep 可能归档重复或过期记忆");
    await withHost(workspaceRoot, options, async (client) => {
      const result = await client.runMemorySleep();
      printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
    });
    return;
  }
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memorySleepStatus();
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function memoryManageCommand(
  workspaceRoot: string,
  action: "get" | "delete" | "restore" | "archived" | "update",
  id: string | undefined,
  options: LocalCapabilityOutputOptions & { yes?: boolean; entry?: string } = {}
): Promise<void> {
  if (action === "delete") requireConfirmation(options.yes, "删除记忆不可恢复");
  await withHost(workspaceRoot, options, async (client) => {
    const operation = action === "restore" ? "archive" : action === "archived" ? "archive-list" : action;
    const result = await client.memory(operation, {
      id,
      archived: action === "restore" ? false : undefined,
      patch: options.entry === undefined ? undefined : JSON.parse(options.entry)
    });
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function diaryShowCommand(_workspaceRoot: string, dateInput: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const dateKey = resolveDateKey(dateInput);
  const content = await readDailyMemoryNote(dateKey, { configDir: globalConfigDir() });
  const result = { dateKey, content };
  printResult(result, options.json, (value) => {
    const record = asRecord(value);
    return typeof record.content === "string" ? record.content : `没有 ${String(record.dateKey)} 的日报记录。`;
  });
}

export async function diaryRefreshCommand(workspaceRoot: string, dateInput: string, options: LocalCapabilityOutputOptions & { force?: boolean } = {}): Promise<void> {
  const dateKey = resolveDateKey(dateInput);
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.refreshDailyDiary(dateKey, options.force === true);
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function reflectionStatusCommand(_workspaceRoot: string, dateInput: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const dateKey = resolveDateKey(dateInput);
  const note = await readDailyMemoryNote(dateKey, { configDir: globalConfigDir() });
  const reflection = note === undefined ? undefined : readDailyMemorySection(note, "自我反思");
  printResult({ dateKey, exists: reflection !== undefined, reflection }, options.json, (value) => {
    const record = asRecord(value);
    return record.exists === true
      ? typeof record.reflection === "string" ? record.reflection : "已有反思记录。"
      : "还没有反思记录。";
  });
}

export async function reflectionRunCommand(workspaceRoot: string, dateInput: string, options: LocalCapabilityOutputOptions & { force?: boolean } = {}): Promise<void> {
  const dateKey = resolveDateKey(dateInput);
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.reflectionRun(dateKey, options.force === true);
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function heartbeatStatusCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.heartbeatStatus();
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function heartbeatRunCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.heartbeatRun();
    printResult(result, options.json, (value) => JSON.stringify(value, null, 2));
  });
}

export async function heartbeatShowCommand(_workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const content = await new HeartbeatFileStore(globalConfigDir()).read();
  printResult({ content }, options.json, (value) => {
    const record = asRecord(value);
    return typeof record.content === "string" ? record.content : "还没有 HEARTBEAT.md。运行 `biny heartbeat run` 会使用内置清单。";
  });
}

export async function todoShowCommand(workspaceRoot: string, sessionInput: string | undefined, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const store = await openTodoStore(workspaceRoot, sessionInput);
  const result = { sessionId: sessionInput ?? "latest", todos: store.list() };
  printResult(result, options.json, (value) => {
    const todos = asRecord(value).todos;
    return Array.isArray(todos) && todos.length ? JSON.stringify(todos, null, 2) : "当前 session 没有 Todo。";
  });
}

export async function todoReplaceCommand(workspaceRoot: string, sessionInput: string | undefined, todosJson: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const store = await openTodoStore(workspaceRoot, sessionInput);
  const parsed = JSON.parse(todosJson) as unknown;
  const todos = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { todos?: unknown }).todos) ? (parsed as { todos: unknown[] }).todos : [];
  const result = await store.replace(todos as TodoItem[]);
  printResult({ todos: result }, options.json, (value) => JSON.stringify(asRecord(value).todos, null, 2));
}

export async function todoClearCommand(workspaceRoot: string, sessionInput: string | undefined, options: LocalCapabilityOutputOptions & { yes?: boolean } = {}): Promise<void> {
  requireConfirmation(options.yes, "清空当前 session Todo");
  const store = await openTodoStore(workspaceRoot, sessionInput);
  const result = await store.replace([]);
  printResult({ todos: result }, options.json, () => "当前 session Todo 已清空。");
}

async function openTodoStore(workspaceRoot: string, sessionInput: string | undefined): Promise<TodoStore> {
  const file = await resolveSessionFile(workspaceRoot, sessionInput ?? "latest");
  const store = new TodoStore(workspaceRoot, sessionIdFromFile(file));
  await store.initialize();
  return store;
}

async function withHost<T>(workspaceRoot: string, options: LocalCapabilityOutputOptions, action: (client: RuntimeHostClient) => Promise<T>): Promise<void> {
  const client = options.noSpawn
    ? await connectRuntimeHost(workspaceRoot, { surface: "cli", clientId: `cli-${process.pid}` })
    : await connectOrSpawnRuntimeHost(workspaceRoot, {
      workspaceRoot,
      surface: "cli",
      clientId: `cli-${process.pid}`,
      resumeInterrupted: false
    });
  if (!client) throw new Error("Runtime Host is not running. Start it with `biny daemon run` or omit --no-spawn.");
  try {
    const value = await action(client);
    if (isRejected(value)) throw new Error(value.reason ?? "Runtime operation was rejected.");
  } finally {
    await client.close();
  }
}

function printResult(value: unknown, json: boolean | undefined, plain: (value: unknown) => string): void {
  if (isRejected(value)) throw new Error(value.reason ?? "Runtime operation was rejected.");
  console.log(json ? JSON.stringify(value) : plain(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function isRejected(value: unknown): value is { accepted: false; reason?: string } {
  return typeof value === "object" && value !== null && (value as { accepted?: unknown }).accepted === false;
}

function requireConfirmation(yes: boolean | undefined, action: string): void {
  if (!yes) throw new Error(`${action}；请加 --yes 确认。`);
}

/**
 * 会话原文检索：先增量索引所有会话 JSONL 的新增部分，再对派生 FTS5 索引做全文检索。
 * 全程不经过 Runtime Host；索引是可重建派生数据，直接读全局 agent 目录。
 */
export async function historySearchCommand(query: string, options: LocalCapabilityOutputOptions & { limit?: number; literal?: boolean } = {}): Promise<void> {
  const index = new SessionSearchIndex();
  try {
    await index.refreshAll();
    const hits = options.literal ? index.grep(query, options.limit) : index.search(query, { limit: options.limit ?? 8 });
    if (options.json) {
      printResult({ query, hits }, true, (value) => JSON.stringify(value, null, 2));
      return;
    }
    if (!hits.length) {
      console.log(`No conversation history matches: ${query}`);
      return;
    }
    for (const hit of hits) {
      const when = hit.time ?? "";
      console.log(`[${hit.sessionId}${when ? ` · ${when}` : ""}] ${hit.role}: ${hit.excerpt}`);
    }
  } finally {
    index.close();
  }
}

function resolveDateKey(value: string): string {
  const now = new Date();
  if (value === "today") return formatDate(now);
  if (value === "yesterday") return formatDate(new Date(now.getTime() - 86_400_000));
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`日期必须是 today、yesterday 或 YYYY-MM-DD：${value}`);
  return value;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
