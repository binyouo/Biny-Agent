/**
 * 记忆、日报、Heartbeat 和当前 session Todo 的 CLI 入口。
 *
 * 这里不复制领域存储：SQLite 记忆与 Heartbeat/反思通过 Runtime Host，日报直接复用
 * daily-notes，Todo 写入复用所属 Runtime 的 TodoStore，空闲读取可直接加载持久文件。
 */
import { executeSessionCommand } from "./sessionManagement.js";
import { readConversationDay, searchConversationHistory } from "../../session/searchHistory.js";
import { hasReflectionDate, readReflectionDiary } from "../../agent/context/reflectionDates.js";
import { connectOrSpawnRuntimeHost, connectRuntimeHost, type RuntimeHostClient } from "../../runtime/RuntimeHost.js";
import { archiveConversationMarkdown } from "../../session/markdownArchive.js";
import { SessionSearchIndex } from "../../session/searchIndex.js";
import { TemporalMemoryIndex, type TemporalQuery } from "../../session/temporalMemory.js";
import { createDateReference, type DateReferenceRange } from "../../session/dateReference.js";
import { readNativeCalendar } from "../../session/nativeCalendar.js";
import { createTemporalModelExtractor } from "../../session/temporalModelExtractor.js";
import { listAllSessionFiles } from "../../session/store.js";
import { createFileConfigStore } from "../../config/store.js";
import { resolveToolModel } from "../../llm/toolModel.js";
import path from "node:path";
import { globalConfigDir } from "../../config/paths.js";
import { readDailyMemoryNote, readDailyMemorySection } from "../../activity/dailyNotes.js";
import { HeartbeatFileStore } from "../../agent/context/heartbeat.js";
import { TodoStore, validateTodoItems } from "../../session/todoStore.js";
import { resolveSessionFile, sessionIdFromFile } from "../../session/store.js";

import { resolveDateKey } from "../dateKey.js";

export interface LocalCapabilityOutputOptions {
  json?: boolean;
  noSpawn?: boolean;
}

export async function memoryExportCommand(): Promise<void> {
  console.log(JSON.stringify(await archiveConversationMarkdown()));
}

export async function memoryListCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory<{ entries: unknown[]; storeRevision: number }>("list", {
      limit: 100,
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
  options: LocalCapabilityOutputOptions & { limit?: number; threshold?: number; tag?: string[]; threadId?: string; userId?: string; userIds?: string[] } = {}
): Promise<void> {
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("search", {
      query,
      tags: options.tag,
      threadId: options.threadId,
      userId: options.userId,
      userIds: options.userIds,
      limit: options.limit ?? 20,
      threshold: options.threshold
    });
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
  const entry: unknown = options.entry ? JSON.parse(options.entry) : { content };
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("--entry 必须是 JSON 对象。");
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("write", {
      // CLI 保留结构化字段，由 Host 的统一校验边界拒绝非法类型和值。
      entry: { ...entry, source: "manual" }
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

export async function memoryClearCommand(workspaceRoot: string, options: LocalCapabilityOutputOptions & { yes?: boolean; threadId?: string } = {}): Promise<void> {
  if (options.threadId !== undefined && !options.threadId.trim()) throw new Error("threadId 不能为空。");
  requireConfirmation(options.yes, options.threadId === undefined
    ? "清理记忆会删除当前和归档条目"
    : "清理指定 thread 的活动记忆会改变召回结果");
  await withHost(workspaceRoot, options, async (client) => {
    const result = await client.memory("clear", { threadId: options.threadId });
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
  const diary = await readReflectionDiary(dateKey);
  const note = await readDailyMemoryNote(dateKey, { configDir: globalConfigDir() });
  const reflection = diary ?? (note === undefined ? undefined : readDailyMemorySection(note, "自我反思"));
  const exists = await hasReflectionDate(dateKey) || diary !== undefined || reflection !== undefined;
  printResult({ dateKey, exists, reflection }, options.json, (value) => {
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
  const result = process.env.BINY_AGENT_CONTEXT
    ? await executeSessionCommand(workspaceRoot, "TodoShow", {}, sessionInput)
    : { sessionId: sessionInput ?? "latest", todos: (await openTodoStore(workspaceRoot, sessionInput)).list() };
  printResult(result, options.json, (value) => {
    const todos = asRecord(value).todos;
    return Array.isArray(todos) && todos.length ? JSON.stringify(todos, null, 2) : "当前 session 没有 Todo。";
  });
}

export async function todoReplaceCommand(workspaceRoot: string, sessionInput: string | undefined, todosJson: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const parsed = JSON.parse(todosJson) as unknown;
  const todos = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { todos?: unknown }).todos) ? (parsed as { todos: unknown[] }).todos : undefined;
  if (!todos) throw new Error("Todo replacement must be an array or an object with a todos array.");
  const result = await executeSessionCommand(workspaceRoot, "TodoWrite", { todos: validateTodoItems(todos) }, sessionInput);
  printResult({ todos: asRecord(result).todos }, options.json, (value) => JSON.stringify(asRecord(value).todos, null, 2));
}

export async function todoClearCommand(workspaceRoot: string, sessionInput: string | undefined, options: LocalCapabilityOutputOptions & { yes?: boolean } = {}): Promise<void> {
  requireConfirmation(options.yes, "清空当前 session Todo");
  const result = await executeSessionCommand(workspaceRoot, "TodoWrite", { todos: [] }, sessionInput);
  printResult({ todos: asRecord(result).todos }, options.json, () => "当前 session Todo 已清空。");
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
    const { hits } = await searchConversationHistory(index, query, options);
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
      console.log(`[${hit.sessionId}${when ? ` · ${when}` : ""}] ${hit.role}: ${hit.excerpt}\n  ${hit.sourcePath}`);
    }
  } finally {
    await index.close();
  }
}

export async function historyDayCommand(dateInput: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const result = await readConversationDay(resolveDateKey(dateInput));
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else for (const conversation of result.conversations) {
    console.log(`# Conversation ${conversation.sessionId}\nSource: ${conversation.sourcePath}\n` +
      conversation.messages.map(message => `\n## ${message.time} ${message.role}\n\n${message.content}`).join("\n"));
  }
}

/** 日期检索直接读可重建的本地 Session 投影，公开文本与 JSON 使用同一份结果。 */
export async function temporalMemoryCommand(
  kind: "timeline" | "facts",
  options: LocalCapabilityOutputOptions & { from: string; to: string; sessionId?: string; limit?: string; offset?: string }
): Promise<void> {
  const index = new TemporalMemoryIndex();
  try {
    await index.refreshAll();
    const query: TemporalQuery = {
      startDate: options.from, endDate: options.to, sessionId: options.sessionId,
      limit: options.limit === undefined ? undefined : Number(options.limit),
      offset: options.offset === undefined ? undefined : Number(options.offset),
      today: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
    };
    const result = kind === "timeline" ? index.queryClues(query) : index.queryFacts(query);
    printResult(result, options.json, () => {
      if ("clues" in result) return result.clues.length
        ? result.clues.map((row) => `[${String(row.date ?? "日期未定")}] ${row.expression} · ${row.sourceUri} · ${row.quote}`).join("\n")
        : "没有匹配的原始用户消息。";
      return result.facts.length
        ? result.facts.map((row) => `[${row.state}] ${row.title} · ${row.sourceUri} · ${row.quote}`).join("\n")
        : "没有匹配的原始用户消息。";
    });
  } finally { index.close(); }
}

export async function temporalDateReferenceCommand(options: LocalCapabilityOutputOptions & { from: string; to: string; timeZone: string; label?: string }): Promise<void> {
  const range: DateReferenceRange = { startDate: options.from, endDate: options.to, timeZone: options.timeZone };
  const reference = createDateReference(range, options.label);
  printResult({ reference, range }, options.json, () => reference);
}

export async function temporalCalendarCommand(options: LocalCapabilityOutputOptions & { from: string; to: string; timeZone: string; allowCalendar?: boolean }): Promise<void> {
  const result = await readNativeCalendar({ startDate: options.from, endDate: options.to, timeZone: options.timeZone }, { authorized: options.allowCalendar === true });
  printResult(result, options.json, () => result.events.length
    ? result.events.map((event) => `${event.startDate} · ${event.title}${event.calendar ? ` · ${event.calendar}` : ""}`).join("\n")
    : "此日期范围没有日历事件。");
}

export async function temporalClueActionCommand(kind: "ignore" | "seen", id: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const index = new TemporalMemoryIndex();
  try {
    const result = kind === "ignore"
      ? { ignored: index.ignoreClue(id) }
      : { seen: index.markSeen([id], new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), Intl.DateTimeFormat().resolvedOptions().timeZone) };
    printResult(result, options.json, (value) => JSON.stringify(value));
  } finally { index.close(); }
}

/** 显式按一条本机会话建立带引文的工作事实；请求模型前必须已选定原始 Session。 */
export async function temporalIndexFactsCommand(workspaceRoot: string, sessionId: string, options: LocalCapabilityOutputOptions = {}): Promise<void> {
  const matches = (await listAllSessionFiles()).filter((file) => path.basename(file) === `${sessionId}.jsonl`);
  if (matches.length !== 1) throw new Error(matches.length ? "Session ID is ambiguous." : "Session not found.");
  const model = resolveToolModel(await createFileConfigStore(workspaceRoot).load());
  if (!model) throw new Error("No configured tool model is available for dated work facts.");
  const index = new TemporalMemoryIndex(undefined, createTemporalModelExtractor(model));
  try {
    const indexed = await index.indexSessionFile(sessionId, matches[0]!);
    printResult({ sessionId, indexedMessages: indexed.length }, options.json, (value) => JSON.stringify(value));
  } finally { index.close(); }
}
