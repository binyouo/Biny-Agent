import type { AgentMessage, AgentUserMessage } from "../core/types.js";

/** 保存这一轮的心境事实，不把情绪命令和当前行为指引重复带入历史。 */
export function emotionSnapshotFromPrompt(prompt: string): string | undefined {
  return prompt.match(/Current state:\n([\s\S]*?)\n+HOW TO USE/u)?.[1]?.trim();
}

export function withEmotionHistory(message: AgentUserMessage, snapshot: string): AgentUserMessage {
  const originalContent = message.originalContent ?? message.content;
  const prefix = `<biny_emotion_history>\nYour emotional state during this past exchange:\n${snapshot}\n</biny_emotion_history>`;
  const content = typeof originalContent === "string"
    ? `${prefix}\n\n${originalContent}`
    : [{ type: "text" as const, text: prefix }, ...originalContent];
  return { ...message, content, originalContent, emotionSnapshot: snapshot };
}

export function retainEmotionHistory(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(message => {
    if (message.role !== "user") return message;
    if (message.emotionSnapshot) return withEmotionHistory(message, message.emotionSnapshot);
    if (message.originalContent === undefined) return message;
    const { originalContent, ...canonical } = message;
    return { ...canonical, content: originalContent };
  });
}
