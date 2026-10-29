const bodyPattern = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*_)([a-z2-7]{8})(?![A-Za-z0-9_])/giu;

/** 只规范化形状，不猜测哈希；查不到所属映射的文本原样保留。 */
export function restorePlaceholders(text: string, values: ReadonlyMap<string, string>, json = false): string {
  let out = "", last = 0;
  for (const match of text.matchAll(bodyPattern)) {
    const tag = `{{${match[1]!.toUpperCase()}${match[2]!.toLowerCase()}}}`;
    const value = values.get(tag);
    if (value === undefined) continue;
    let start = match.index, end = start + match[0].length;
    const left = /\{{1,2}[ \t]*$/u.exec(text.slice(last, start));
    const right = /^[ \t]*\}{1,2}/u.exec(text.slice(end));
    // 单侧孤立的大括号可能是 JSON/代码结构；成对或双括号才归入占位符。
    if (left && (left[0].startsWith("{{") || right)) start -= left[0].length;
    if (right && (right[0].endsWith("}}") || left)) end += right[0].length;
    out += text.slice(last, start) + (json ? JSON.stringify(value).slice(1, -1) : value);
    last = end;
  }
  return out + text.slice(last);
}
