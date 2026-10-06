/** 附件引用允许单文件或一次导入独占的批次目录，不接受任意子目录。 */
export const attachmentPathPrefix = "@attachments/";

export function attachmentRelativePath(virtualPath: string): string | undefined {
  if (!virtualPath.startsWith(attachmentPathPrefix)) return undefined;
  const relativePath = virtualPath.slice(attachmentPathPrefix.length);
  if (!relativePath || relativePath.includes("\\") || relativePath.includes("..") || /[\u0000-\u001f\u007f]/u.test(relativePath)) return undefined;
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === ".")) return undefined;
  if (parts.length === 1) return relativePath;
  return parts.length === 2 && /^import-[a-f0-9]{32}$/u.test(parts[0]!) ? relativePath : undefined;
}
