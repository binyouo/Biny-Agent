/**
 * 轻量 diff 生成模块。
 *
 * 这里生成的 unified diff 主要用于写入或编辑前的权限确认展示。它不追求完整 git diff hunk
 * 元数据，只需要让用户清楚看到旧内容和新内容的逐行差异。
 */
export function createUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  if (oldContent === newContent) return `(no changes in ${filePath})`;

  // 这里生成的是给确认提示用的轻量 diff，不追求完整 git diff hunk 元数据。
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const oldHeader = oldContent ? `a/${filePath}` : "/dev/null";
  const lines = [`--- ${oldHeader}`, `+++ b/${filePath}`, "@@"];
  const max = Math.max(oldLines.length, newLines.length);

  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (
      oldLine !== undefined &&
      newLine !== undefined &&
      oldLine.text === newLine.text &&
      oldLine.hasNewline === newLine.hasNewline
    ) {
      lines.push(` ${oldLine.text}`);
      if (!oldLine.hasNewline) lines.push(noNewlineAtEof);
      continue;
    }
    if (oldLine !== undefined) {
      lines.push(`-${oldLine.text}`);
      if (!oldLine.hasNewline) lines.push(noNewlineAtEof);
    }
    if (newLine !== undefined) {
      lines.push(`+${newLine.text}`);
      if (!newLine.hasNewline) lines.push(noNewlineAtEof);
    }
  }

  return lines.join("\n");
}

interface DiffLine {
  text: string;
  /** Whether this logical line is terminated by LF; the final line's bit distinguishes EOF newline state. */
  hasNewline: boolean;
}

const noNewlineAtEof = "\\ No newline at end of file";

function splitLines(content: string): DiffLine[] {
  if (!content) return [];
  const lines = content.split("\n");
  const hasTrailingNewline = content.endsWith("\n");
  if (hasTrailingNewline) lines.pop();
  return lines.map((text, index) => ({
    text,
    hasNewline: hasTrailingNewline || index < lines.length - 1
  }));
}
