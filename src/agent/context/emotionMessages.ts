import type { SessionEvent } from "../../session/recorder.js";
import { activeSessionMessageIds, sessionMessageTree } from "../../session/messageTree.js";
import { redactSecrets } from "../../utils/redaction.js";
import { messageText } from "../modelMessages.js";
import type { EmotionAnalysisMessage } from "./emotionAnalysis.js";

/** Project the last ten nonblank active messages without transforming the older prefix. */
export function recentEmotionMessagesFromEvents(events: readonly SessionEvent[]): EmotionAnalysisMessage[] {
  const nodes = sessionMessageTree(events);
  const activeIds = activeSessionMessageIds(events, nodes);
  const messages: EmotionAnalysisMessage[] = [];
  for (let index = nodes.length - 1; index >= 0 && messages.length < 10; index -= 1) {
    const node = nodes[index]!;
    if (!activeIds.has(node.id) || (node.message.role !== "user" && node.message.role !== "assistant")) continue;
    // Redact the entire text before checking emptiness; truncation remains downstream.
    const text = redactSecrets(messageText(node.message));
    if (!text.trim()) continue;
    messages.push({ role: node.message.role, text });
  }
  return messages.reverse();
}
