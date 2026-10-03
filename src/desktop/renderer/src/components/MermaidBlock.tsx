/** Markdown 图表保持最后有效结果；美化类型同步绘制，其他类型延迟加载标准渲染器。 */
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";
import { readDiagramColors, renderBeautifulDiagram, renderStandardDiagram, sanitizeDiagramSvg, type DiagramTheme, type RenderedDiagram } from "./diagram/diagramRendering.js";
import { cancelDiagramMorph, updateDiagramSvg } from "./diagram/diagramMorph.js";
import { DIAGRAM_MAX_SCALE, DIAGRAM_MIN_SCALE, useDiagramViewport } from "./diagram/useDiagramViewport.js";
import { RenderingPreviewContext } from "./RenderingPreviewContext.js";

const STREAMING_RENDER_INTERVAL_MS = 260;

export function MermaidBlock({ code, isStreaming = false }: { code: string; isStreaming?: boolean }): React.JSX.Element {
  const previewRendering = useContext(RenderingPreviewContext);
  const id = useId();
  const state = useRenderedDiagram(code, isStreaming);
  if (!state) return <MarkdownCodeBlock code={code} language="mermaid" />;
  return <DiagramView diagram={state} onExpand={previewRendering ? () => previewRendering({ id, title: "图表", source: state.code, language: "mermaid", filename: "diagram.mmd", renderPreview: () => <DiagramPreview diagram={state} /> }) : undefined} />;
}

function DiagramPreview({ diagram }: { diagram: RenderedDiagram }): React.JSX.Element {
  const state = useRenderedDiagram(diagram.code, false, diagram);
  return <DiagramView diagram={state ?? diagram} expanded />;
}

/** 固定源码的详情与内联共享绘制生命周期，主题变化不会冻结打开时的 SVG 色值。 */
function useRenderedDiagram(code: string, isStreaming: boolean, initial?: RenderedDiagram): RenderedDiagram | undefined {
  const theme = useDiagramTheme();
  const [state, setState] = useState<RenderedDiagram | undefined>(() => initial ?? (isStreaming ? undefined : renderBeautifulDiagram(code, theme)));
  const lastRenderAt = useRef(0);

  useEffect(() => {
    const source = code.trim();
    if (!source) { setState(undefined); return; }
    const controller = new AbortController();
    const render = () => {
      lastRenderAt.current = performance.now();
      const beautiful = renderBeautifulDiagram(source, theme, isStreaming);
      if (beautiful) {
        setState(previous => previous?.svg === beautiful.svg && previous.code === beautiful.code ? previous : beautiful);
        return;
      }
      void renderStandardDiagram(source, theme, controller.signal).then(result => {
        if (!controller.signal.aborted) setState(result);
      }).catch(() => { /* 半截图表与渲染失败保留最后有效结果，首次失败展示源码。 */ });
    };
    if (!isStreaming) render();
    const timer = isStreaming ? setTimeout(render, Math.max(0, STREAMING_RENDER_INTERVAL_MS - (performance.now() - lastRenderAt.current))) : undefined;
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [code, isStreaming, theme]);

  return state;
}

function DiagramView({ diagram, onExpand, expanded = false }: { diagram: RenderedDiagram; onExpand?: () => void; expanded?: boolean }): React.JSX.Element {
  const { containerRef, scale, isDragging, isReset, transform, zoomIn, zoomOut, reset } = useDiagramViewport(!expanded);
  const host = useRef<HTMLDivElement>(null);
  const namespace = `biny-diagram-host-${useId().replace(/[^\w-]/gu, "")}`;
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    updateDiagramSvg(element, sanitizeDiagramSvg(diagram.svg, namespace));
    return () => cancelDiagramMorph(element);
  }, [diagram.svg, namespace]);
  return <div className={`markdown-diagram${expanded ? " is-expanded" : ""}`} data-mermaid-inline={!expanded || undefined}>
    <div ref={containerRef} className="markdown-diagram-viewport" tabIndex={0} role="region" aria-label={expanded ? "图表大窗预览" : "图表"} style={{ cursor: isDragging ? "grabbing" : "grab" }}>
      <div ref={host} className={`markdown-mermaid${isDragging ? " is-dragging" : ""}`} style={{ transform: transform }} />
    </div>
    <div className="markdown-diagram-actions" data-zoompan-ignore>
      <button type="button" aria-label="缩小图表" title="缩小图表" disabled={scale <= DIAGRAM_MIN_SCALE} onClick={zoomOut}><Icon name="minus" size={14} /></button>
      <span className="markdown-diagram-scale" aria-live="polite">{Math.round(scale * 100)}%</span>
      <button type="button" aria-label="放大图表" title="放大图表" disabled={scale >= DIAGRAM_MAX_SCALE} onClick={zoomIn}><Icon name="add" size={14} /></button>
      <button type="button" aria-label="重置图表缩放" title="重置图表缩放" disabled={isReset} onClick={reset}><Icon name="refresh" size={14} /></button>
      {!expanded ? <><span className="markdown-diagram-action-divider" aria-hidden="true" /><CopyButton label="复制图表源码" value={diagram.code} size={14} /></> : null}
      {onExpand ? <button type="button" aria-label="展开图表预览" title="展开图表预览" onClick={onExpand}><Icon name="expand" size={14} /></button> : null}
    </div>
  </div>;
}

function currentDiagramTheme(): DiagramTheme {
  const selection = document.documentElement.dataset.theme;
  return { dark: selection === "dark" || (selection !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches), colors: readDiagramColors() };
}

function useDiagramTheme(): DiagramTheme {
  const [theme, setTheme] = useState(currentDiagramTheme);
  useEffect(() => {
    const update = () => setTheme(currentDiagramTheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-base46-theme", "style", "class"] });
    media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, []);
  return theme;
}
