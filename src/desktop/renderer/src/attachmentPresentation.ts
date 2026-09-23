/** 附件列表与消息卡片共用的大小文案。 */
export function attachmentSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
