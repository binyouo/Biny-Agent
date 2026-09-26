/** 表格控件从当前 DOM 读取可见单元格，流式更新不保存第二份表格数据。 */
import React, { useEffect, useRef } from "react";
import { Icon } from "./Icon.js";
import { CopyButton } from "./CopyButton.js";
import { DownloadButton } from "./MarkdownDownload.js";

export function MarkdownTable({ children }: { children: React.ReactNode }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type === "pointerdown" && root.current?.contains(event.target as Node)) return;
      root.current?.querySelectorAll("details[open]").forEach(details => details.removeAttribute("open"));
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);
  const table = useRef<HTMLTableElement>(null);
  const serialize = (format: "csv" | "tsv" | "markdown"): string => {
    const rows = Array.from(table.current?.rows ?? [], row => Array.from(row.cells, cell => cell.textContent ?? ""));
    if (format === "csv") return rows.map(row => row.map(cell => /[",\r\n]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell).join(",")).join("\r\n");
    if (format === "tsv") return rows.map(row => row.map(cell => cell.replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n")).join("\t")).join("\n");
    const lines = rows.map(row => "| " + row.map(cell => cell.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ") + " |");
    if (rows.length) lines.splice(1, 0, "| " + rows[0]!.map(() => "---").join(" | ") + " |");
    return lines.join("\n");
  };
  return <div className="markdown-table-block" ref={root}>
    <div className="markdown-block-actions">
      <details className="markdown-action-menu"><summary aria-label="复制表格" title="复制表格"><Icon name="copy" size={14} /></summary>
        <div>{(["csv", "tsv"] as const).map(format => <CopyButton key={format} value="" resolveValue={() => serialize(format)} label={format.toUpperCase()} showLabel />)}</div>
      </details>
      <details className="markdown-action-menu"><summary aria-label="下载表格" title="下载表格"><Icon name="download" size={14} /></summary>
        <div>{(["csv", "markdown"] as const).map(format => <DownloadButton key={format} label={format === "csv" ? "CSV" : "Markdown"} showLabel filename={format === "csv" ? "table.csv" : "table.md"} getContent={() => new Blob([serialize(format)], { type: format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8" })} />)}</div>
      </details>
    </div>
    <div className="markdown-table" tabIndex={0} role="region" aria-label="表格"><table ref={table}>{children}</table></div>
  </div>;
}
