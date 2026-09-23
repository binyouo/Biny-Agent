/**
 * 把工具调用前的公开 assistant 前置说明投影成受限的活动摘要。
 *
 * 这不是 reasoning 的替代品：原始思考仍按原事件写入 Session，但 UI 只接收
 * 有界、单行的公开说明，避免长文本流式增量触发全文重排，也避免把内部推理当作答复展示。
 */
import { redactSecrets } from "../utils/redaction.js";
import { publicAssistantMessage } from "../session/publicMessage.js";

const maxActivitySummaryLength = 240;

export function activitySummaryText(content: string): string {
  const normalized = redactSecrets(publicAssistantMessage(content)).replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxActivitySummaryLength) return normalized;
  return `${normalized.slice(0, maxActivitySummaryLength - 1)}…`;
}
