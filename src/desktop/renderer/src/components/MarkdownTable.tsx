/** 表格控件从当前 DOM 读取可见单元格，流式更新不保存第二份表格数据。 */
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { serializeMarkdownTable } from "./markdownTableExport.js";

export function MarkdownTable({ children, streaming = false }: { children: React.ReactNode; streaming?: boolean }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const copiedTimeout = useRef(0);
  const mounted = useRef(false);
  const [menu, setMenu] = useState<"copy" | "download" | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    mounted.current = true;
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type === "pointerdown" && root.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      mounted.current = false;
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      window.clearTimeout(copiedTimeout.current);
    };
  }, []);

  const copy = async (format: "csv" | "tsv") => {
    if (streaming || busy || !table.current) return;
    setBusy(true);
    setError(undefined);
    try {
      const text = serializeMarkdownTable(table.current, format);
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([table.current.outerHTML], { type: "text/html" })
        })]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      if (!mounted.current) return;
      setCopied(true);
      setMenu(null);
      window.clearTimeout(copiedTimeout.current);
      copiedTimeout.current = window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      if (mounted.current) setError("复制失败，请重试");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const download = (format: "csv" | "markdown") => {
    if (streaming || busy || !table.current) return;
    setError(undefined);
    let url: string | undefined;
    try {
      const blob = new Blob([serializeMarkdownTable(table.current, format)], {
        type: format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8"
      });
      url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = format === "csv" ? "table.csv" : "table.md";
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      setMenu(null);
    } catch {
      setError("下载失败，请重试");
    } finally {
      // 下载导航先消费 URL，再释放对应 Blob；即使控件卸载也会回收。
      if (url) {
        const downloadUrl = url;
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
      }
    }
  };

  return <div className="markdown-table-block" ref={root}>
    <div className="markdown-block-actions markdown-table-actions">
      <div className="markdown-table-action">
        <button type="button" className="markdown-table-trigger" aria-label="复制表格" aria-expanded={menu === "copy"} disabled={streaming || busy} title={copied ? "已复制" : "复制表格"} onClick={() => setMenu(menu === "copy" ? null : "copy")}>
          <Icon name={copied ? "check" : "copy"} size={14} />
        </button>
        {menu === "copy" && <div className="markdown-table-menu">{(["csv", "tsv"] as const).map(format => <button type="button" key={format} aria-label={format.toUpperCase()} title={`复制表格为 ${format.toUpperCase()}`} disabled={streaming || busy} onClick={() => void copy(format)}>{format.toUpperCase()}</button>)}</div>}
      </div>
      <div className="markdown-table-action">
        <button type="button" className="markdown-table-trigger" aria-label="下载表格" aria-expanded={menu === "download"} disabled={streaming || busy} title="下载表格" onClick={() => setMenu(menu === "download" ? null : "download")}>
          <Icon name="download" size={14} />
        </button>
        {menu === "download" && <div className="markdown-table-menu">{(["csv", "markdown"] as const).map(format => <button type="button" key={format} aria-label={format === "csv" ? "CSV" : "Markdown"} title={`下载表格为 ${format === "csv" ? "CSV" : "Markdown"}`} disabled={streaming || busy} onClick={() => download(format)}>{format === "csv" ? "CSV" : "Markdown"}</button>)}</div>}
      </div>
    </div>
    <div className="markdown-table" tabIndex={0} role="region" aria-label="表格"><table ref={table}>{children}</table></div>
    {error && <span role="alert" className="markdown-resource-error">{error}</span>}
  </div>;
}
