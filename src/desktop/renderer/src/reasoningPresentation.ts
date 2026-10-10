/**
 * 思考步骤的展示文本。
 *
 * 部分模型只上报开始事件而不回传内容；此时返回空串，结束后不留下空的思考行。
 */
import type { TimelineReasoningStep } from "./sessionTimeline.js";

export function reasoningDetailText(step: Pick<TimelineReasoningStep, "content">): string {
  return step.content.trim();
}

/** 一句话思考的字符上限：不超过则摘要即全文，不给展开入口（按常见导轨宽度估算）。 */
const ONE_LINE_CHARS = 30;

function nonEmptyLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * chip 的一行摘要：落定取首行，运行中取最新行。
 * 去掉 Markdown 行首标记和行内强调符，避免 `##`、`**` 原样出现在一行里。
 */
export function reasoningSummaryLine(text: string, mode: "settled" | "live"): string {
  const lines = nonEmptyLines(text);
  const line = mode === "live" ? lines.at(-1) : lines[0];
  if (!line) return "";
  return line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/u, "").replace(/\*\*|__|`/gu, "").trim();
}

/** 多行思考或超过一行宽度的思考才提供展开入口；一句话说完时展开只会重复摘要。 */
export function reasoningExpandable(text: string): boolean {
  const lines = nonEmptyLines(text);
  return lines.length > 1 || (lines[0]?.length ?? 0) > ONE_LINE_CHARS;
}
