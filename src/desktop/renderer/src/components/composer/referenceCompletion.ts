/** Composer 的 @ 补全、短标签草稿与发送前物化；URI 身份不从显示文字猜测。 */
import type { LocalReferenceKind, LocalReferenceResult } from "../../../../../session/localReferences.js";

export interface ReferenceCompletion {
  start: number;
  end: number;
  query: string;
  kind?: LocalReferenceKind;
  unknownPrefix?: string;
}

const kinds: Record<string, LocalReferenceKind> = {
  日期: "date", date: "date", 项目: "project", project: "project", 文件: "file", file: "file",
  会话: "thread", thread: "thread", 消息: "message", message: "message", 记忆: "memory", memory: "memory",
  片段: "snippet", snippet: "snippet", 临时引用: "scratch", scratch: "scratch",
  技能: "skill", skill: "skill", 子代理: "agent", 智能体: "agent", agent: "agent", mcp: "mcp", 模型: "model", model: "model", 服务商: "provider", provider: "provider",
  工具: "tool", tool: "tool", 工具调用: "tool-call", "tool-call": "tool-call", call: "tool-call", 任务: "task", task: "task", 定时任务: "cron", cron: "cron",
  结晶: "crystal", crystal: "crystal", 结晶包: "bundle", bundle: "bundle", 目标: "mission", mission: "mission", 计划: "plan", plan: "plan"
};

const kindLabels: Record<LocalReferenceKind, string> = {
  date: "日期", project: "项目", file: "文件", thread: "会话", message: "消息", memory: "记忆",
  snippet: "片段", scratch: "临时引用", skill: "技能", agent: "子代理", mcp: "MCP",
  model: "模型", provider: "服务商", tool: "工具", "tool-call": "工具调用", task: "任务", cron: "定时任务",
  crystal: "结晶", bundle: "结晶包", mission: "目标", plan: "计划"
};

export function referenceKindLabel(kind: LocalReferenceKind): string { return kindLabels[kind]; }

export function referenceResultSubtitle(result: Pick<LocalReferenceResult, "kind" | "content">): string {
  if (result.kind !== "date") return referenceKindLabel(result.kind);
  try {
    const range = JSON.parse(result.content) as Record<string, unknown>;
    if (typeof range.startDate === "string" && typeof range.endDate === "string" && typeof range.timeZone === "string") {
      return `${range.startDate} → ${range.endDate}（结束日不含） · ${range.timeZone}`;
    }
  } catch { /* 损坏的投影仍按种类显示，不在界面猜测日期。 */ }
  return referenceKindLabel(result.kind);
}

export function findReferenceCompletion(value: string, start: number, end = start,
  tokens: readonly DraftReferenceToken[] = []): ReferenceCompletion | undefined {
  if (start !== end || start < 0 || start > value.length) return undefined;
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(value.slice(0, start));
  if (!match || match[1]?.startsWith("[")) return undefined;
  const tail = /^\S*/u.exec(value.slice(start))?.[0] ?? "";
  if (tail.includes("@") || tail.includes("(")) return undefined;
  const token = `${match[1] ?? ""}${tail}`;
  const colon = token.indexOf(":");
  const prefix = colon < 0 ? undefined : token.slice(0, colon);
  const completionStart = start - (match[1]?.length ?? 0) - 1;
  if (tokens.some((item) => item.start === completionStart && item.end >= start && validToken(value, item))) return undefined;
  return {
    start: completionStart,
    end: start + tail.length,
    query: colon < 0 ? token : token.slice(colon + 1),
    kind: prefix === undefined ? undefined : kinds[prefix.toLocaleLowerCase()],
    unknownPrefix: prefix !== undefined && kinds[prefix.toLocaleLowerCase()] === undefined ? prefix : undefined
  };
}

export interface DraftReferenceToken { start: number; end: number; label: string; uri: string; kind: LocalReferenceKind }
export interface ReferenceDraft { value: string; tokens: DraftReferenceToken[] }
export interface ReferenceDraftTransition { before: ReferenceDraft; after: ReferenceDraft }

function validToken(value: string, token: DraftReferenceToken): boolean {
  return value.slice(token.start, token.end) === `@${token.label}`;
}

function uniqueLabel(label: string, uri: string, tokens: readonly DraftReferenceToken[]): string {
  if (!tokens.some((token) => token.label === label && token.uri !== uri)) return label;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${label} ${String(suffix)}`;
    if (!tokens.some((token) => token.label === candidate)) return candidate;
  }
  return `${label} ${uri.slice(-6)}`;
}

/** 草稿只保留短标签和独立身份；发送正文由 materializeDraftReferences 生成。 */
export function insertDraftReference(value: string, completion: ReferenceCompletion, result: Pick<LocalReferenceResult, "kind" | "label" | "uri">,
  tokens: readonly DraftReferenceToken[]): { value: string; cursor: number; tokens: DraftReferenceToken[] } {
  if (!result.label.trim() || result.label.length > 80 || /[\]\n\r]/u.test(result.label)
    || !/^biny:\/\/[^\s()]+$/u.test(result.uri)) throw new Error("Invalid reference completion.");
  const active = tokens.filter((token) => validToken(value, token));
  const label = uniqueLabel(result.label, result.uri, active);
  const suffix = value.slice(completion.end);
  const text = `@${label}`;
  const spacer = suffix && /^\s/u.test(suffix) ? "" : " ";
  const next = value.slice(0, completion.start) + text + spacer + suffix;
  const retained = reconcileDraftReferenceChange(value, next, active);
  const start = completion.start;
  return { value: next, cursor: start + text.length + spacer.length,
    tokens: [...retained, { start, end: start + text.length, label, uri: result.uri, kind: result.kind }]
      .sort((left, right) => left.start - right.start) };
}

/** 原生编辑只移动未触及的 token；改动标签内部立即撤销其 URI 身份。 */
export function reconcileDraftReferenceChange(before: string, after: string,
  tokens: readonly DraftReferenceToken[]): DraftReferenceToken[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const changedEnd = before.length - suffix;
  const delta = after.length - before.length;
  return tokens.filter((token) => validToken(before, token)).flatMap((token) => {
    if (token.end <= prefix) return [token];
    if (token.start >= changedEnd) return [{ ...token, start: token.start + delta, end: token.end + delta }];
    return [];
  }).filter((token) => validToken(after, token));
}

/** 原生撤销/重做只沿已记录的相邻草稿变化恢复身份，不能按同名文字猜 URI。 */
export function referenceDraftHistoryStep(current: ReferenceDraft, nextValue: string, direction: "undo" | "redo",
  history: readonly ReferenceDraftTransition[]): ReferenceDraft | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const transition = history[index]!;
    if (direction === "undo" && transition.after.value === current.value && transition.before.value === nextValue)
      return transition.before;
    if (direction === "redo" && transition.before.value === current.value && transition.after.value === nextValue)
      return transition.after;
  }
  return undefined;
}

export function materializeDraftReferences(value: string, tokens: readonly DraftReferenceToken[]): string {
  let result = "";
  let offset = 0;
  for (const token of [...tokens].sort((left, right) => left.start - right.start)) {
    if (token.start < offset || !validToken(value, token)) continue;
    result += value.slice(offset, token.start) + `@[${token.label}](${token.uri})`;
    offset = token.end;
  }
  return result + value.slice(offset);
}

function kindFromUri(uri: string): LocalReferenceKind | undefined {
  const match = /^biny:\/\/([^/]+)\//u.exec(uri);
  const raw = match?.[1];
  if (raw === "thread" && /\/message\/[^/]+$/u.test(uri)) return "message";
  if (raw === "thread" && /\/tool\/[^/]+$/u.test(uri)) return "tool-call";
  return raw && Object.values(kinds).includes(raw as LocalReferenceKind) ? raw as LocalReferenceKind : undefined;
}

/** 粘贴、历史编辑回填和侧栏插入的已物化引用恢复成可编辑短标签。 */
export function normalizeDraftReferences(value: string, tokens: readonly DraftReferenceToken[]): { value: string; tokens: DraftReferenceToken[] } {
  let current = value;
  let active = [...tokens];
  const references = [...value.matchAll(/@\[([^\]\n]{1,80})\]\((biny:\/\/[^\s)]+)\)/gu)];
  for (const match of references.reverse()) {
    const kind = kindFromUri(match[2]!);
    if (!kind) continue;
    const start = match.index;
    const end = start + match[0].length;
    const label = uniqueLabel(match[1]!, match[2]!, active);
    const text = `@${label}`;
    const next = current.slice(0, start) + text + current.slice(end);
    active = reconcileDraftReferenceChange(current, next, active);
    active.push({ start, end: start + text.length, label, uri: match[2]!, kind });
    current = next;
  }
  return { value: current, tokens: active.sort((left, right) => left.start - right.start) };
}

export function referenceDraftDeletion(value: string, start: number, end: number, key: string,
  tokens: readonly DraftReferenceToken[]): { start: number; end: number } | undefined {
  if (start !== end) return undefined;
  for (const token of tokens) {
    if (!validToken(value, token)) continue;
    if (key === "Backspace" && (start === token.end || (start === token.end + 1 && value[token.end] === " ")))
      return { start: token.start, end: start };
    if (key === "Delete" && start === token.start) return { start, end: token.end + (value[token.end] === " " ? 1 : 0) };
  }
  return undefined;
}

export function referenceKeyAction(
  event: Pick<KeyboardEvent, "key" | "keyCode" | "isComposing" | "shiftKey">,
  composing: boolean, open: boolean, count: number
): "native" | "dismiss" | "previous" | "next" | "choose" {
  if (composing || event.isComposing || event.keyCode === 229 || !open) return "native";
  if (event.key === "Escape") return "dismiss";
  if (count > 0 && event.key === "ArrowDown") return "next";
  if (count > 0 && event.key === "ArrowUp") return "previous";
  if (count > 0 && !event.shiftKey && (event.key === "Enter" || event.key === "Tab")) return "choose";
  return "native";
}
