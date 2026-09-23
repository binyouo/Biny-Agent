/** 原生输入框的补全范围与替换规则，始终保留光标两侧的正文。 */
import type { DesktopComposerItem } from "./desktopSlashCommands.js";

export interface PromptCompletion { start: number; end: number; query: string }

export function findPromptCompletion(value: string, start: number, end = start): PromptCompletion | undefined {
  if (start !== end || start < 0 || start > value.length) return undefined;
  const match = /(?:^|\s)\/([^\s/]*)$/u.exec(value.slice(0, start));
  if (!match) return undefined;
  // 光标回到命令中间时仍替换完整词，不能把旧命令尾巴拼到新命令后面。
  const tail = /^\S*/u.exec(value.slice(start))?.[0] ?? "";
  if (tail.includes("/")) return undefined;
  return { start: start - (match[1]?.length ?? 0) - 1, end: start + tail.length, query: match[1] ?? "" };
}

export function filterPromptCompletions(items: readonly DesktopComposerItem[], query: string): DesktopComposerItem[] {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return items.filter((item) => terms.every((term) => [item.label, ...item.auxiliaryData.keywords].join(" ").toLocaleLowerCase().includes(term)));
}

export function replacePromptCompletion(value: string, range: PromptCompletion, item: DesktopComposerItem): { value: string; cursor: number } {
  const insertion = `${item.id} `;
  const suffix = value.slice(range.end + (value[range.end] === " " ? 1 : 0));
  return { value: value.slice(0, range.start) + insertion + suffix, cursor: range.start + insertion.length };
}

/** 输入法确认优先于补全，补全优先于提交；Shift+Enter 始终保留原生换行。 */
export function promptKeyAction(
  event: Pick<KeyboardEvent, "key" | "keyCode" | "isComposing" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  composing: boolean,
  menuOpen: boolean,
  optionCount: number
): "native" | "dismiss" | "previous" | "next" | "choose" | "submit" {
  if (composing || event.isComposing || event.keyCode === 229) return "native";
  if (menuOpen && event.key === "Escape") return "dismiss";
  if (menuOpen && optionCount > 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowDown") return "next";
    if (event.key === "ArrowUp") return "previous";
    if (event.key === "Enter" || event.key === "Tab") return "choose";
  }
  return event.key === "Enter" && !event.shiftKey ? "submit" : "native";
}
