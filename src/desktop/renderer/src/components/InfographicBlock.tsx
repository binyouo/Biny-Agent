/** 信息图懒载实际 DSL 渲染器，流式错误保留最后有效图形与对应导出。 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "./Icon.js";
import { DownloadButton } from "./MarkdownDownload.js";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";
import { readThemeColors } from "../themeColors.js";
import { infographicPng, renderInfographic, type InfographicTheme, type RenderedInfographic } from "./infographicRendering.js";

export function InfographicBlock({ code, isStreaming = false }: { code: string; isStreaming?: boolean }): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null);
  const lastRender = useRef(0);
  const [width, setWidth] = useState(600);
  const [state, setState] = useState<RenderedInfographic>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const theme = useInfographicTheme();

  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const resize = () => setWidth(Math.max(400, Math.round(element.clientWidth || 600)));
    resize();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const render = () => {
      lastRender.current = performance.now();
      void renderInfographic(code, width, theme, controller.signal).then(result => {
        if (!controller.signal.aborted) { setState(result); setError(undefined); }
      }).catch(() => {
        if (!controller.signal.aborted && !isStreaming) setError("信息图未能渲染，请检查源码或重试");
      });
    };
    const timer = isStreaming ? setTimeout(render, Math.max(0, 260 - (performance.now() - lastRender.current))) : undefined;
    if (!isStreaming) render();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [code, isStreaming, width, theme, attempt]);

  return <>
    <InfographicView diagram={state} code={code} bodyRef={body} onExpand={() => setExpanded(true)}>
      {error ? <div className="markdown-infographic-error" role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div> : null}
      {state?.resourceErrors ? <div className="markdown-infographic-error" role="status">部分图标或图片未能加载<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div> : null}
    </InfographicView>
    {expanded && state ? <Dialog isOpen onOpenChange={setExpanded} width="calc(100vw - 48px)" className="markdown-infographic-dialog">
      <DialogHeader title="信息图" onOpenChange={setExpanded} />
      <InfographicView diagram={state} code={state.code} expanded />
    </Dialog> : null}
  </>;
}

function InfographicView({ diagram, code, expanded = false, onExpand, bodyRef, children }: {
  diagram?: RenderedInfographic; code: string; expanded?: boolean; onExpand?: () => void;
  bodyRef?: React.RefObject<HTMLDivElement | null>; children?: React.ReactNode;
}): React.JSX.Element {
  const viewport = useInfographicViewport(expanded);
  const [copied, setCopied] = useState<"source" | "png">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const copyTimeout = useRef(0);
  const mounted = useRef(false);
  const copyController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; copyController.current?.abort(); window.clearTimeout(copyTimeout.current); };
  }, []);
  const copy = async (format: "source" | "png") => {
    if (busy) return;
    const controller = new AbortController();
    copyController.current = controller;
    setBusy(true); setError(undefined);
    try {
      if (format === "source") {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(diagram?.code ?? code);
      } else {
        if (!diagram || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Image clipboard unavailable");
        const blob = await infographicPng(diagram, controller.signal);
        if (!mounted.current) return;
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      }
      if (!mounted.current) return;
      setCopied(format);
      window.clearTimeout(copyTimeout.current);
      copyTimeout.current = window.setTimeout(() => setCopied(undefined), 2_000);
    } catch {
      if (mounted.current) setError("复制失败，请重试");
    } finally { if (copyController.current === controller) copyController.current = undefined; if (mounted.current) setBusy(false); }
  };
  const viewportContainerRef = viewport.containerRef;
  const setBody = useCallback((node: HTMLDivElement | null) => {
    viewportContainerRef(node);
    if (bodyRef) bodyRef.current = node;
  }, [bodyRef, viewportContainerRef]);
  const canCopyPng = typeof navigator !== "undefined" && !!navigator.clipboard?.write && typeof ClipboardItem !== "undefined";
  return <div className={`markdown-infographic${expanded ? " is-expanded" : ""}`}>
    <div className="markdown-infographic-header">
      <span className="markdown-infographic-language">infographic</span>
      <div className="markdown-infographic-actions">
        <button type="button" aria-label="缩小信息图" title="缩小信息图" disabled={!diagram || viewport.scale <= .2} onClick={viewport.zoomOut}><Icon name="minus" size={14} /></button>
        <button type="button" aria-label="放大信息图" title="放大信息图" disabled={!diagram || viewport.scale >= 5} onClick={viewport.zoomIn}><Icon name="add" size={14} /></button>
        {!viewport.isReset && <button type="button" aria-label="重置信息图缩放" title="重置信息图缩放" onClick={viewport.reset}><Icon name="refresh" size={14} /></button>}
        <span className="markdown-infographic-divider" aria-hidden="true" />
        <button type="button" aria-label="复制信息图源码" title={copied === "source" ? "已复制" : "复制信息图源码"} disabled={busy} onClick={() => void copy("source")}><Icon name={copied === "source" ? "check" : "copy"} size={14} /></button>
        {diagram ? <DownloadButton label="下载信息图" filename="infographic.svg" getContent={() => new Blob([diagram.svg], { type: "image/svg+xml" })} /> : <button type="button" aria-label="下载信息图" title="下载信息图" disabled><Icon name="download" size={14} /></button>}
        {canCopyPng ? <button type="button" aria-label="复制信息图 PNG" title={copied === "png" ? "已复制" : "复制信息图 PNG"} disabled={!diagram || busy} onClick={() => void copy("png")}><Icon name={copied === "png" ? "check" : "chart"} size={14} /></button> : null}
        {onExpand ? <><span className="markdown-infographic-divider" aria-hidden="true" /><button type="button" aria-label="全屏查看信息图" title="全屏查看信息图" disabled={!diagram} onClick={onExpand}><Icon name="expand" size={14} /></button></> : null}
        {expanded ? <span className="markdown-infographic-scale">{Math.round(viewport.scale * 100)}%</span> : null}
      </div>
    </div>
    <div ref={setBody} className="markdown-infographic-body" role="region" tabIndex={0} aria-label={expanded ? "信息图大窗预览" : "信息图"} style={{ cursor: diagram ? viewport.isDragging ? "grabbing" : "grab" : undefined }} {...viewport.dragHandlers}>
      {diagram ? <div className={`markdown-infographic-canvas${viewport.isDragging ? " is-dragging" : ""}`} style={{ transform: viewport.transform }} dangerouslySetInnerHTML={{ __html: diagram.svg }} /> : <MarkdownCodeBlock code={code} language="infographic" />}
    </div>
    {error ? <span role="alert" className="markdown-infographic-error">{error}</span> : null}
    {children}
  </div>;
}

function useInfographicViewport(expanded: boolean) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => setContainer(node), []);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | undefined>(undefined);
  const clamp = (value: number) => Math.min(5, Math.max(.2, value));
  useEffect(() => {
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (!expanded && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setScale(value => clamp(value * (event.deltaY > 0 ? expanded ? .95 : .9 : expanded ? 1.05 : 1.1)));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [container, expanded]);
  const endDrag = () => { drag.current = undefined; setIsDragging(false); };
  return {
    containerRef, scale, isDragging, isReset: scale === 1 && position.x === 0 && position.y === 0,
    transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
    zoomIn: () => setScale(value => clamp(value * 1.2)), zoomOut: () => setScale(value => clamp(value / 1.2)),
    reset: () => { setScale(1); setPosition({ x: 0, y: 0 }); },
    dragHandlers: {
      onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => { if (event.button !== 0) return; drag.current = { x: event.clientX, y: event.clientY, offsetX: position.x, offsetY: position.y }; setIsDragging(true); },
      onMouseMove: (event: React.MouseEvent<HTMLDivElement>) => { if (drag.current) setPosition({ x: drag.current.offsetX + event.clientX - drag.current.x, y: drag.current.offsetY + event.clientY - drag.current.y }); },
      onMouseUp: endDrag, onMouseLeave: endDrag
    }
  };
}

function useInfographicTheme(): InfographicTheme {
  const [theme, setTheme] = useState(readInfographicTheme);
  useEffect(() => {
    const update = () => setTheme(readInfographicTheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-base46-theme", "style", "class"] });
    media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, []);
  return theme;
}

function readInfographicTheme(): InfographicTheme {
  if (typeof window === "undefined") return { dark: false, background: "", primary: "", palette: [], font: "sans-serif" };
  const selection = document.documentElement.dataset.theme;
  const dark = selection === "dark" || (selection !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const colors = readThemeColors(document.body, { background: dark ? "--bg" : "--surface-raised", primary: "--accent", green: "--green", purple: "--file-purple", red: "--red", yellow: "--amber" });
  return { dark, background: colors.background, primary: colors.primary, palette: [colors.primary, colors.green, colors.purple, colors.red, colors.yellow], font: window.getComputedStyle(document.body).fontFamily || "sans-serif" };
}
