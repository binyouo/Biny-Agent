/** 搜索替换输入：先精确匹配，再容忍换行和行内空白差异；歧义不静默选第一个位置。 */
export function applyStringEdit(content: string, oldString: string, newString: string, replaceAll = false): { content: string; firstChangedLine: number; replacements: number } {
  if (!oldString) throw new Error("old_string must not be empty. Use Write to create a file.");
  if (oldString === newString) throw new Error("old_string and new_string are identical.");
  const spans: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset <= content.length - oldString.length) {
    const start = content.indexOf(oldString, offset);
    if (start < 0) break;
    spans.push({ start, end: start + oldString.length });
    offset = start + oldString.length;
  }
  // A single non-overlapping match can still hide another valid starting position.
  if (!replaceAll && spans.length === 1 && content.indexOf(oldString, spans[0]!.start + 1) >= 0) {
    throw new Error("old_string matches overlapping locations. Provide more context or set replace_all.");
  }
  if (!spans.length && oldString.trim()) {
    const lines = content.split("\n");
    const starts: number[] = [];
    let position = 0;
    for (const line of lines) { starts.push(position); position += line.length + 1; }
    const needle = oldString.replaceAll("\r\n", "\n").split("\n");
    const trailingNewline = needle.at(-1) === "";
    if (trailingNewline) needle.pop();
    // 只容忍完整行片段的格式漂移，不能靠首尾锚点猜测中间内容。
    const normalizers = [
      (line: string) => line.replace(/\r$/u, ""),
      (line: string) => line.trim(),
      (line: string) => line.trim().replace(/\s+/gu, " ")
    ];
    for (const normalize of normalizers) {
      for (let index = 0; index <= lines.length - needle.length; index += 1) {
        if (!needle.every((line, delta) => normalize(lines[index + delta]!) === normalize(line))) continue;
        const last = index + needle.length - 1;
        if (trailingNewline && last === lines.length - 1) continue;
        spans.push({ start: starts[index]!, end: starts[last]! + (trailingNewline ? lines[last]!.length + 1 : lines[last]!.replace(/\r$/u, "").length) });
      }
      if (spans.length) break;
    }
  }
  if (!spans.length) throw new Error("old_string was not found. Read the file and use the exact text.");
  if (spans.length > 1 && !replaceAll) throw new Error(`old_string matches ${String(spans.length)} locations. Provide more context or set replace_all.`);
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index]!.start < spans[index - 1]!.end) throw new Error("Replacement spans overlap. Provide more exact context.");
  }
  const firstChangedLine = content.slice(0, spans[0]!.start).split("\n").length;
  let result = content;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!;
    result = result.slice(0, span.start) + newString + result.slice(span.end);
  }
  if (result === content) throw new Error("The replacement does not change the file.");
  return { content: result, firstChangedLine, replacements: spans.length };
}
