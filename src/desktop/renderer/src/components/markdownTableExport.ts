/** 按当前表头和正文单元格生成表格导出，不包含资源控件。 */
export function serializeMarkdownTable(table: HTMLTableElement, format: "csv" | "tsv" | "markdown"): string {
  const headers = Array.from(table.querySelectorAll("thead th"), cell => cellText(cell));
  const rows = Array.from(table.querySelectorAll("tbody tr"), row => Array.from(row.querySelectorAll("td"), cell => cellText(cell)));
  if (format === "markdown") {
    if (!headers.length) return "";
    const escape = (cell: string) => cell.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r\n?|\n/gu, "<br>");
    const line = (cells: string[]) => `| ${cells.map(escape).join(" | ")} |`;
    return [line(headers), line(headers.map(() => "---")), ...rows.map(row => line(row.length < headers.length ? [...row, ...Array<string>(headers.length - row.length).fill("")] : row))].join("\n");
  }
  const allRows = headers.length ? [headers, ...rows] : rows;
  if (format === "csv") return allRows.map(row => row.map(cell => /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(",")).join("\n");
  return allRows.map(row => row.map(cell => cell.replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n")).join("\t")).join("\n");
}

/** `textContent` joins the text on both sides of a visible HTML line break. */
function cellText(cell: Element): string {
  const parts: Array<string | null> = [""];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const last = parts.length - 1;
      const value = node.nodeValue ?? "";
      if (parts[last] === null) parts.push(value);
      else parts[last] = `${parts[last] ?? ""}${value}`;
    } else if (node.nodeType === 1 && (node as Element).tagName === "BR") {
      parts.push(null);
    } else {
      for (const child of Array.from(node.childNodes)) visit(child);
    }
  };
  visit(cell);
  // Match textContent.trim() across every text node while retaining BR markers.
  let trimming = true;
  for (let index = 0; index < parts.length && trimming; index++) {
    const part = parts[index];
    if (part == null) continue;
    parts[index] = part.trimStart();
    if (parts[index]) trimming = false;
  }
  trimming = true;
  for (let index = parts.length - 1; index >= 0 && trimming; index--) {
    const part = parts[index];
    if (part == null) continue;
    parts[index] = part.trimEnd();
    if (parts[index]) trimming = false;
  }
  return parts.map(part => part === null ? "\n" : part).join("");
}
