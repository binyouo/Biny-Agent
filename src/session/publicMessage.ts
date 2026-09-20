/**
 * 用户消息的展示文本提取。
 *
 * 早期 Durable Task 写进 session 的 user_message 可能包了一层验收脚手架。当前普通 Loop
 * 不再生成这种消息，但回放旧 session 时仍要只展示用户真正输入的部分。
 */
const verifierAttemptMarker = "\n\nThis is a verifier-driven task.";
const continuationPrefix = "Continue the same project-level task autonomously.";
const originalObjectivePrefix = "\n\nOriginal objective: ";
const previousFeedbackPrefix = "\n\nPrevious attempt feedback:";
const skillWrapperPattern = /^<skill\b[^>]*\bname="([^"]+)"[^>]*>/u;
const skillWrapperEnd = "</skill>";
const notificationOpenTag = "<biny_notification>";
const notificationBlockPattern = /<biny_notification>[\s\S]*?<\/biny_notification>\s*$/u;

/** 取出消息中面向用户的那一段；识别不出脚手架时原样返回。 */
export function publicUserMessage(content: string): string {
  const skillMatch = content.match(skillWrapperPattern);
  if (skillMatch?.[1]) {
    const wrapperEnd = content.indexOf(skillWrapperEnd, skillMatch[0].length);
    const task = wrapperEnd === -1 ? "" : content.slice(wrapperEnd + skillWrapperEnd.length).trim();
    return task ? `Skill: ${skillMatch[1]}\n\n${task}` : `Skill: ${skillMatch[1]}`;
  }

  // 首次尝试：脚手架追加在用户输入之后，截到标记为止。
  const firstAttemptMarker = content.indexOf(verifierAttemptMarker);
  if (firstAttemptMarker > 0) return content.slice(0, firstAttemptMarker).trimEnd();
  if (!content.startsWith(continuationPrefix)) return content;

  // 续跑尝试：用户输入被夹在「原始目标」和「上次反馈」之间，取中间那段。
  const objectiveStart = content.indexOf(originalObjectivePrefix);
  const feedbackStart = content.indexOf(previousFeedbackPrefix, objectiveStart + originalObjectivePrefix.length);
  if (objectiveStart === -1 || feedbackStart === -1 || feedbackStart <= objectiveStart) return content;
  return content.slice(objectiveStart + originalObjectivePrefix.length, feedbackStart).trim();
}

/**
 * 隐藏后台通知协议，只返回可以进入聊天界面的 assistant 正文。
 *
 * 完整块用于清理旧 session；流式输出还可能只到达起始标签的一部分，因此也要扣住与
 * 起始标签匹配的末尾前缀，避免 XML 在下一帧补全前短暂闪到界面上。
 */
export function publicAssistantMessage(content: string): string {
  const completeBlock = notificationBlockPattern.exec(content);
  if (completeBlock) return content.slice(0, completeBlock.index).trimEnd();

  const openTagIndex = content.lastIndexOf(notificationOpenTag);
  if (openTagIndex >= 0) return content.slice(0, openTagIndex);

  for (let length = Math.min(content.length, notificationOpenTag.length - 1); length > 0; length -= 1) {
    if (content.endsWith(notificationOpenTag.slice(0, length))) {
      return content.slice(0, -length);
    }
  }
  return content;
}
