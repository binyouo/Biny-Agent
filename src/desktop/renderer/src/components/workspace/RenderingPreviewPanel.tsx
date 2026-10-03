import { useId, useLayoutEffect, useRef, useState } from "react";
import { CopyButton } from "../CopyButton.js";
import { DownloadButton } from "../MarkdownDownload.js";
import { MarkdownCodeBlock } from "../MarkdownCodeBlock.js";
import { Icon } from "../Icon.js";
import type { RenderingPreview } from "../RenderingPreviewContext.js";

export function RenderingPreviewPanel({ previews, activeId, expanded, active, onSelect, onClosePreview, onToggleExpanded, onClose }: {
  previews: RenderingPreview[];
  activeId: string;
  expanded: boolean;
  active: boolean;
  onSelect(id: string): void;
  onClosePreview(id: string): void;
  onToggleExpanded(): void;
  onClose(): void;
}): React.JSX.Element {
  const [views, setViews] = useState(() => new Map<string, "preview" | "source">());
  const preview = previews.find(preview => preview.id === activeId) ?? previews[0]!;
  const view = views.get(preview.id) ?? "preview";
  const setView = (view: "preview" | "source") => setViews(previous => new Map(previous).set(preview.id, view));
  const panelId = useId().replace(/[^\w-]/gu, "");
  const contentId = (id: string) => `rendering-preview-${panelId}-${encodeURIComponent(id)}`;
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (active) panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [active]);
  return <section ref={panel} className="rendering-preview-panel" aria-label="渲染预览" role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} onKeyDown={event => {
    if (!expanded) return;
    if (event.key === "Escape") { event.preventDefault(); onToggleExpanded(); }
    if (event.key !== "Tab") return;
    const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"], a[href]') ?? [])].filter(element => !element.closest("[hidden]"));
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header className="rendering-preview-header">
      <span className="rendering-preview-title">{preview.title}</span>
      <div className="rendering-preview-actions">
        <div className="rendering-preview-toggle" role="group" aria-label="预览显示方式">
          <button type="button" aria-label="查看预览" title="查看预览" aria-pressed={view === "preview"} onClick={() => setView("preview")}><Icon name="eye" size={14} /></button>
          <button type="button" aria-label="查看源码" title="查看源码" aria-pressed={view === "source"} onClick={() => setView("source")}><Icon name="code" size={14} /></button>
        </div>
        <CopyButton label="复制源码" value={preview.source} size={14} />
        <DownloadButton label="下载源码" filename={preview.filename} getContent={() => new Blob([preview.source], { type: "text/plain" })} />
        <button type="button" aria-label={expanded ? "退出预览全屏" : "展开预览全屏"} title={expanded ? "退出全屏" : "全屏预览"} onClick={onToggleExpanded}><Icon name={expanded ? "collapse" : "expand"} size={14} /></button>
        <button type="button" aria-label="关闭预览" title="关闭预览" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
    </header>
    {previews.length > 1 ? <nav className="rendering-preview-tabs" role="tablist" aria-label="图表标签" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const index = previews.findIndex(item => item.id === preview.id);
      const next = event.key === "Home" ? 0 : event.key === "End" ? previews.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + previews.length) % previews.length;
      event.preventDefault(); onSelect(previews[next]!.id);
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{previews.map(item => <div key={item.id} className="rendering-preview-tab" data-active={item.id === preview.id}>
      <button type="button" role="tab" aria-selected={item.id === preview.id} aria-controls={contentId(item.id)} id={`${contentId(item.id)}-tab`} tabIndex={item.id === preview.id ? 0 : -1} onClick={() => onSelect(item.id)}><Icon name="chart" size={12} /><span>{item.title}</span></button>
      <button type="button" className="rendering-preview-tab-close" aria-label={`关闭图表 ${item.title}`} title="关闭图表" onClick={() => { setViews(previous => { const next = new Map(previous); next.delete(item.id); return next; }); onClosePreview(item.id); }}><Icon name="close" size={10} /></button>
    </div>)}</nav> : null}
    <div className="rendering-preview-items">{previews.map(item => {
      const itemView = views.get(item.id) ?? "preview";
      const selected = item.id === preview.id;
      return <div key={item.id} className="rendering-preview-item" data-rendering-id={item.id} id={contentId(item.id)} role={previews.length > 1 ? "tabpanel" : undefined} aria-labelledby={previews.length > 1 ? `${contentId(item.id)}-tab` : undefined} hidden={!selected} aria-hidden={!selected} inert={!selected}>
        <div className="rendering-preview-content" hidden={itemView !== "preview"} aria-hidden={itemView !== "preview"} inert={itemView !== "preview"}>{item.renderPreview()}</div>
        <div className="rendering-preview-source" data-rendering-source hidden={itemView !== "source"} aria-hidden={itemView !== "source"} inert={itemView !== "source"}><MarkdownCodeBlock code={item.source} language={item.language} /></div>
      </div>;
    })}</div>
  </section>;
}
