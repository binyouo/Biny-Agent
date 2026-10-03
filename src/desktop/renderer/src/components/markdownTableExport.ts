/** 按当前表头和正文单元格生成表格导出，不包含资源控件。 */
export function serializeMarkdownTable(table: HTMLTableElement, format: "csv" | "tsv" | "markdown"): string {
  const headers = Array.from(table.querySelectorAll("thead th"), cell => (cell.textContent ?? "").trim());
  const rows = Array.from(table.querySelectorAll("tbody tr"), row => Array.from(row.querySelectorAll("td"), cell => (cell.textContent ?? "").trim()));
  if (format === "markdown") {
    if (!headers.length) return "";
    const escape = (cell: string) => cell.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
    const line = (cells: string[]) => `| ${cells.map(escape).join(" | ")} |`;
    return [line(headers), line(headers.map(() => "---")), ...rows.map(row => line(row.length < headers.length ? [...row, ...Array<string>(headers.length - row.length).fill("")] : row))].join("\n");
  }
  const allRows = headers.length ? [headers, ...rows] : rows;
  if (format === "csv") return allRows.map(row => row.map(cell => /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(",")).join("\n");
  return allRows.map(row => row.map(cell => cell.replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n")).join("\t")).join("\n");
}
