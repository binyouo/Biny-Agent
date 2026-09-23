/**
 * 聊天每日工作日志。
 *
 * Markdown 日志是给人和 agent 看的文件型记忆，不是 durable memory 的导出格式。
 * 显式刷新时从已完成 session 回合补齐证据，再生成按天回顾；普通聊天完成不触发写入。
 */
import { activityDerivedMarker } from "../../activity/modelContext.js";
import type { SelfReflectionResult } from "./selfReflection.js";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import { generateNativeText, nativeJsonMessages } from "../../llm/nativeJson.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  appendDailyMemoryEntry,
  readDailyMemoryNote,
  readDailyMemorySection,
  upsertDailyMemorySection
} from "../../activity/dailyNotes.js";
import { readSessionEvents } from "../../session/events.js";
import { listAllSessionFiles, sessionIdFromFile } from "../../session/store.js";

const dailyDiaryMaxSourceChars = 24_000;
const dailyDiaryMaxBackfillTurns = 500;
const dailyDiaryModelTimeoutMs = 30_000;
const dailyDiaryMaxOutputTokens = 800;

export interface CompletedChatDiaryEntry {
  sessionId: string;
  turnId: string;
  workspaceRoot: string;
  /** 补写历史 session 时可直接提供显示名，避免把全局 session 分区名当作路径。 */
  projectName?: string;
  userMessage: string;
  assistantMessage: string;
  occurredAt?: Date;
}

export interface ChatDiaryRefreshOptions {
  allowActivity?: boolean;
  configDir?: string;
  agentDir?: string;
  model?: AgentModel;
  signal?: AbortSignal;
  force?: boolean;
  onUsage?: ModelUsageObserver;
  onModelRequest?: ModelRequestObserver;
  requestContext?: ModelRequestContext;
}

export interface ChatDiaryRefreshResult {
  reflection?: SelfReflectionResult;
  dateKey: string;
  written: boolean;
  backfilled: number;
  model?: string;
  reason?: "empty" | "up_to_date";
}

/** 显式日记刷新时补入单轮事实，以 session 和 turn 标识去重。 */
export async function appendCompletedChatDiaryEntry(
  entry: CompletedChatDiaryEntry,
  options: { configDir?: string } = {}
): Promise<string> {
  const occurredAt = entry.occurredAt ?? new Date();
  const dateKey = formatLocalDate(occurredAt);
  const project = entry.projectName?.trim() || path.basename(path.resolve(entry.workspaceRoot)) || "workspace";
  const content = [
    `### ${formatLocalTime(occurredAt)} · ${project}`,
    `- 请求：${compact(entry.userMessage, 280) || "（无文本请求）"}`,
    `- 结果：${compact(entry.assistantMessage, 560) || "（无文本输出）"}`
  ].join("\n");
  return await appendDailyMemoryEntry(
    dateKey,
    "聊天摘要",
    `${entry.sessionId}\0${entry.turnId}`,
    content,
    { configDir: options.configDir }
  );
}

/**
 * 从全局 session JSONL 补写指定日期缺失的聊天回合。marker 由 writer 做幂等去重，因此
 * 每次日结都可以安全扫描，不需要另建一张“日报已处理”状态表。
 */
export async function backfillDailyChatDiaryEntries(
  dateKey: string,
  options: { configDir?: string; agentDir?: string } = {}
): Promise<number> {
  const files = await listAllSessionFiles(options.agentDir);
  let backfilled = 0;
  for (const filePath of files) {
    if (backfilled >= dailyDiaryMaxBackfillTurns) break;
    let events;
    try {
      events = await readSessionEvents(filePath);
    } catch {
      continue;
    }
    const sessionId = sessionIdFromFile(filePath);
    const projectName = sessionProjectName(filePath);
    for (const turn of completedChatTurns(events, dateKey)) {
      if (backfilled >= dailyDiaryMaxBackfillTurns) break;
      await appendCompletedChatDiaryEntry({
        sessionId,
        turnId: turn.turnId,
        workspaceRoot: filePath,
        projectName,
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage,
        occurredAt: turn.occurredAt
      }, { configDir: options.configDir });
      backfilled += 1;
    }
  }
  return backfilled;
}

/**
 * 生成指定日期的整体聊天日报。输入只来自 Markdown 的聊天/Activity section，不读取
 * durable memory；同一 source fingerprint 已生成过时直接跳过，避免日结重复调用模型。
 */
export async function refreshChatDailyDiary(
  dateKey: string,
  options: ChatDiaryRefreshOptions = {}
): Promise<ChatDiaryRefreshResult> {
  const backfilled = await backfillDailyChatDiaryEntries(dateKey, { agentDir: options.agentDir, configDir: options.configDir });
  const note = await readDailyMemoryNote(dateKey, { configDir: options.configDir });
  if (!note) return { dateKey, written: false, backfilled, reason: "empty" };

  const source = [
    readDailyMemorySection(note, "聊天摘要"),
    options.allowActivity === true ? readDailyMemorySection(note, "活动记录") : undefined
  ].filter((value): value is string => value !== undefined).join("\n\n").trim();
  if (!source) return { dateKey, written: false, backfilled, reason: "empty" };

  const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 24);
  const marker = `<!-- biny-daily-source:${sourceHash} -->`;
  const existingSummary = readDailyMemorySection(note, "每日总结");
  const modelKey = options.model
    ? createHash("sha256").update(`${options.model.provider}\0${options.model.modelId}`).digest("hex").slice(0, 16)
    : "fallback";
  const existingModelMarker = existingSummary?.match(/<!-- biny-daily-model:([^ ]+) -->/u)?.[1];
  if (!options.force && existingSummary?.includes(marker) && (!options.model || existingModelMarker === modelKey)) {
    return { dateKey, written: false, backfilled, reason: "up_to_date" };
  }

  let summary: string | undefined;
  let modelId: string | undefined;
  if (options.model) {
    try {
      const result = await generateNativeText(
        options.model,
        nativeJsonMessages(
          "You write a personal first-person daily diary, with concrete events, honest reactions and observations from local chat and activity notes. Use the same language as the source notes, defaulting to Chinese. Return plain text only, with 3-6 short sentences. Do not invent facts, do not mention durable memory, and do not include Markdown headings or code fences.",
          [
            `Date: ${dateKey}`,
            "Source notes:",
            truncateForPrompt(source, dailyDiaryMaxSourceChars)
          ].join("\n\n")
        ),
        {
          signal: options.signal,
          maxOutputTokens: dailyDiaryMaxOutputTokens,
          reasoning: "off",
          timeoutMs: dailyDiaryModelTimeoutMs,
          onRequestMetrics: options.onModelRequest,
          requestContext: { ...options.requestContext, operation: "memory" }
        }
      );
      summary = redactSecrets(result.text).trim() || undefined;
      if (summary) modelId = options.model.modelId;
      if (result.usage) await options.onUsage?.(result.usage, "memory");
    } catch {
      options.signal?.throwIfAborted();
      // 日报是派生文件；模型不可用时落确定性摘要，下一次 source 变化或 force 再重试。
    }
  }
  summary ??= renderDeterministicDailySummary(dateKey, source);
  await upsertDailyMemorySection(
    dateKey,
    "每日总结",
    [marker, options.allowActivity && readDailyMemorySection(note, "活动记录") ? activityDerivedMarker : "", `<!-- biny-daily-model:${modelId ? modelKey : "fallback"} -->`, summary].join("\n"),
    { configDir: options.configDir }
  );
  return { dateKey, written: true, backfilled, model: modelId };
}

interface CompletedChatTurn {
  turnId: string;
  userMessage: string;
  assistantMessage: string;
  occurredAt: Date;
}

function completedChatTurns(
  events: readonly import("../../session/recorder.js").SessionEvent[],
  dateKey: string
): CompletedChatTurn[] {
  const drafts = new Map<string, { user?: string; assistant?: string; assistantAt?: string; order: number }>();
  const completed: CompletedChatTurn[] = [];
  let legacyKey: string | undefined;
  let order = 0;
  for (const event of events) {
    const runtimeTurnId = event.runtime?.turnId;
    if (event.type === "user_message" && !event.auditOnly) {
      const key = runtimeTurnId ?? `legacy-${order}`;
      order += 1;
      drafts.set(key, { user: event.content, order });
      legacyKey = runtimeTurnId === undefined ? key : legacyKey;
      continue;
    }
    if (event.type === "assistant_message" && !event.auditOnly && event.content.trim()) {
      const key = runtimeTurnId ?? legacyKey ?? `legacy-${order}`;
      const draft = drafts.get(key) ?? { order };
      draft.assistant = event.content;
      draft.assistantAt = event.time;
      drafts.set(key, draft);
      continue;
    }
    if (event.type !== "turn_status" || event.status !== "completed") continue;
    const key = runtimeTurnId ?? legacyKey;
    if (!key) continue;
    const draft = drafts.get(key);
    if (!draft?.user?.trim() || !draft.assistant?.trim()) continue;
    const occurredAt = parseDate(event.time ?? draft.assistantAt);
    if (!occurredAt || formatLocalDate(occurredAt) !== dateKey) continue;
    completed.push({
      turnId: runtimeTurnId ?? key,
      userMessage: draft.user,
      assistantMessage: draft.assistant,
      occurredAt
    });
    drafts.delete(key);
    if (legacyKey === key) legacyKey = undefined;
  }
  return completed;
}

function renderDeterministicDailySummary(dateKey: string, source: string): string {
  const chatCount = source.match(/^### .* · .*$/gmu)?.length ?? 0;
  const activityPresent = source.includes("活动日报") || source.includes("活动记录");
  const details = chatCount > 0 ? `完成了 ${String(chatCount)} 个聊天回合` : "记录了聊天与工作活动";
  return `${dateKey} ${details}${activityPresent ? "，并保留了活动记录" : ""}。`;
}

function sessionProjectName(filePath: string): string {
  const directory = path.basename(path.dirname(filePath));
  return directory.replace(/-[0-9a-f]{8}$/u, "") || directory;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function compact(value: string, maxChars: number): string {
  const normalized = redactSecrets(value).replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…\n${value.slice(-maxChars)}`;
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatLocalTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
