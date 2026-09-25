/** 原始消息来源 URI 只承载会话和消息 ID，不触发文件读取。 */
export function parseTemporalSourceUri(uri: string): { sessionId: string; messageId: string } {
  const match = uri.match(/^session:\/\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/u);
  if (!match) throw new Error("Invalid temporal source URI.");
  return { sessionId: match[1]!, messageId: match[2]! };
}
