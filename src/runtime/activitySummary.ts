/**
 * 为终端的紧凑工具记录生成单行公开说明；正文先清理内部协议和敏感信息，再限制长度。
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
