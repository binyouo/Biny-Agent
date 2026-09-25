/** Composer 的 @ 范围识别与替换；只操作光标当前词，不接触消息存储。 */
import type { LocalReferenceKind } from "../../../../../session/localReferences.js";

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
  技能: "skill", skill: "skill", mcp: "mcp", 模型: "model", model: "model", 服务商: "provider", provider: "provider",
  工具: "tool", tool: "tool", 任务: "task", task: "task", 定时任务: "cron", cron: "cron",
  结晶: "crystal", crystal: "crystal", 结晶包: "bundle", bundle: "bundle", 目标: "mission", mission: "mission", 计划: "plan", plan: "plan"
};

export function findReferenceCompletion(value: string, start: number, end = start): ReferenceCompletion | undefined {
  if (start !== end || start < 0 || start > value.length) return undefined;
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(value.slice(0, start));
  if (!match || match[1]?.startsWith("[")) return undefined;
  const tail = /^\S*/u.exec(value.slice(start))?.[0] ?? "";
  if (tail.includes("@") || tail.includes("(")) return undefined;
  const token = `${match[1] ?? ""}${tail}`;
  const colon = token.indexOf(":");
  const prefix = colon < 0 ? undefined : token.slice(0, colon);
  return {
    start: start - (match[1]?.length ?? 0) - 1,
    end: start + tail.length,
    query: colon < 0 ? token : token.slice(colon + 1),
    kind: prefix === undefined ? undefined : kinds[prefix.toLocaleLowerCase()],
    unknownPrefix: prefix !== undefined && kinds[prefix.toLocaleLowerCase()] === undefined ? prefix : undefined
  };
}

export function replaceReferenceCompletion(value: string, completion: ReferenceCompletion, label: string, uri: string): { value: string; cursor: number } {
  // 候选 URI 由主进程的引用库产生；渲染进程只负责把它放在当前光标位置。
  if (!label.trim() || label.length > 80 || /[\]\n\r]/u.test(label) || !/^biny:\/\/[^\s()]+$/u.test(uri)) {
    throw new Error("Invalid reference completion.");
  }
  const inserted = `@[${label}](${uri})`;
  const next = value.slice(0, completion.start) + inserted + value.slice(completion.end);
  return { value: next, cursor: completion.start + inserted.length };
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
