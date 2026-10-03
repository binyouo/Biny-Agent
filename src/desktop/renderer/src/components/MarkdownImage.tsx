/** 图片按原比例展示，原图预览与下载始终使用原始来源，保留动画。 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DownloadButton } from "./MarkdownDownload.js";
import { Icon } from "./Icon.js";

type Dimensions = { width: number; height: number };
const dimensionCache = new Map<string, Dimensions>();
const dimensionCacheLimit = 512;

export function MarkdownImage({ src, alt, title, local = false }: {
  src: string; alt: string; title?: string; local?: boolean;
}): React.JSX.Element {
  const [state, setState] = useState<{ source: string; status: "loading" | "ready" | "error"; dimensions?: Dimensions }>({ source: src, status: "loading" });
  const [revision, setRevision] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const image = useRef<HTMLImageElement>(null);
  const menuPanel = useRef<HTMLDivElement>(null);
  const status = state.source === src ? state.status : "loading";
  const dimensions = state.source === src ? state.dimensions ?? dimensionCache.get(src) : dimensionCache.get(src);
  const previewable = status === "ready" && (local || Boolean(dimensions && dimensions.width >= 100 && dimensions.height >= 100));
  const filename = imageFilename(src, alt);
  const download = async (): Promise<Blob> => {
    const response = await fetch(src);
    if (!response.ok) throw new Error("Image download failed");
    return response.blob();
  };
  const closeLightbox = useCallback(() => setLightbox(false), []);
  const closeMenu = useCallback(() => { setMenu(undefined); image.current?.focus(); }, []);
  const openImage = (): void => { setMenu(undefined); setLightbox(true); };
  useEffect(() => {
    setState({ source: src, status: "loading" });
    setMenu(undefined);
    setLightbox(false);
  }, [src]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent): void => {
      if (!menuPanel.current?.contains(event.target as Node)) closeMenu();
    };
    const close = (): void => closeMenu();
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
    };
    menuPanel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, closeMenu]);
  const showMenu = (event: React.MouseEvent<HTMLImageElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const unit = 13 * ((parseFloat(window.getComputedStyle(document.body).fontSize) || 14) / 14);
    const height = Math.max(120, unit * (status === "ready" ? 5 : 2.75) + 2);
    const top = event.clientY + height + 20 > window.innerHeight ? event.clientY - height - 8 : event.clientY + 8;
    setMenu({
      left: Math.max(12, Math.min(event.clientX, window.innerWidth - 232)),
      top: Math.max(12, Math.min(top, window.innerHeight - height - 12))
    });
  };
  const menuKeys = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Tab") { event.preventDefault(); closeMenu(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <>
    <span className={`markdown-image-frame is-${status}`}>
      {status === "error" ? <span role="alert" className="markdown-image-error">{alt || "图片"}加载失败 <button type="button" onClick={() => {
        setState({ source: src, status: "loading" }); setRevision(value => value + 1);
      }}>重试</button></span> : <>
        {status === "loading" ? <span role="status" aria-label="正在加载图片" className="markdown-image-skeleton" style={dimensions ? {
          aspectRatio: `${dimensions.width} / ${dimensions.height}`,
          width: `min(100%, ${dimensions.width}px, calc(60vh * ${(dimensions.width / dimensions.height).toFixed(5)}))`
        } : { width: 200, height: 150 }} /> : null}
        <img key={`${src}:${revision}`} ref={image} alt={alt} src={src} title={title}
          className={`markdown-image${local ? " is-local" : ""}${previewable ? " is-previewable" : ""}`}
          role={previewable ? "button" : undefined} tabIndex={previewable ? 0 : undefined}
          aria-label={previewable ? `打开图片 ${alt || filename}` : undefined}
          loading="lazy" decoding="async"
          onClick={previewable ? (event) => { event.preventDefault(); event.stopPropagation(); openImage(); } : undefined}
          onKeyDown={previewable ? (event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); openImage(); }
          } : undefined}
          onContextMenu={showMenu}
          onLoad={(event) => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            const measured = width > 0 && height > 0 ? { width, height } : undefined;
            if (measured) {
              if (dimensionCache.size >= dimensionCacheLimit) dimensionCache.delete(dimensionCache.keys().next().value ?? "");
              dimensionCache.set(src, measured);
            }
            setState({ source: src, status: "ready", dimensions: measured });
          }}
          onError={() => { setMenu(undefined); setState({ source: src, status: "error" }); }} />
      </>}
      {status !== "error" ? <span className="markdown-image-actions"><DownloadButton label="下载图片" filename={filename} getContent={download} /></span> : null}
    </span>
    {menu ? createPortal(<div ref={menuPanel} role="menu" aria-label="图片操作" className="markdown-image-menu"
      style={{ left: menu.left, top: menu.top }} onKeyDown={menuKeys} onContextMenu={(event) => event.preventDefault()}>
      {status === "ready" ? <button type="button" role="menuitem" onClick={openImage}><Icon name="external" size={14} />打开图片</button> : null}
      <DownloadButton label="下载图片" filename={filename} getContent={download} showLabel />
    </div>, document.body) : null}
    {lightbox ? createPortal(<ImageLightbox src={src} alt={alt} filename={filename} getContent={download} onClose={closeLightbox} />, document.body) : null}
  </>;
}

function ImageLightbox({ src, alt, filename, getContent, onClose }: {
  src: string; alt: string; filename: string; getContent(): Promise<Blob>; onClose(): void;
}): React.JSX.Element {
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ clientX: number; clientY: number; x: number; y: number } | undefined>(undefined);
  const zoom = useCallback((factor: number) => setTransform(previous => ({ ...previous, scale: Math.min(5, Math.max(.5, previous.scale * factor)) })), []);
  const reset = (): void => setTransform({ scale: 1, x: 0, y: 0 });
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const app = document.getElementById("root");
    const previousInert = app?.inert;
    if (app) app.inert = true;
    panel.current?.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []];
      if (!controls.length) return;
      const current = controls.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0 || (event.shiftKey && current === 0) || (!event.shiftKey && current === controls.length - 1)) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (app) app.inert = previousInert ?? false;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent): void => { event.preventDefault(); zoom(event.deltaY > 0 ? .9 : 1.1); };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoom]);
  const stopDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = undefined; setDragging(false);
  };
  return <div ref={panel} className="markdown-image-lightbox" role="dialog" aria-modal="true" aria-label={`预览 ${alt || filename}`}>
    <header className="markdown-image-lightbox-toolbar">
      <span className="markdown-image-lightbox-name">{filename}</span>
      <div className="markdown-image-lightbox-controls">
        <button type="button" aria-label="缩小图片" disabled={transform.scale <= .5} onClick={() => zoom(.9)}><Icon name="minus" size={16} /></button>
        <span aria-live="polite">{Math.round(transform.scale * 100)}%</span>
        <button type="button" aria-label="放大图片" disabled={transform.scale >= 5} onClick={() => zoom(1.1)}><Icon name="add" size={16} /></button>
        <button type="button" aria-label="适应窗口" onClick={reset}><Icon name="expand" size={16} /></button>
        <DownloadButton label="下载图片" filename={filename} getContent={getContent} />
        <button type="button" aria-label="关闭图片预览" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
    </header>
    <div ref={viewport} className={`markdown-image-lightbox-viewport${dragging ? " is-dragging" : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { clientX: event.clientX, clientY: event.clientY, x: transform.x, y: transform.y }; setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const { clientX, clientY, x, y } = drag.current;
        setTransform(previous => ({ ...previous, x: x + event.clientX - clientX, y: y + event.clientY - clientY }));
      }}
      onPointerUp={stopDrag} onPointerCancel={stopDrag}
      onDoubleClick={() => setTransform(previous => previous.scale > 1 ? { scale: 1, x: 0, y: 0 } : { ...previous, scale: 2 })}>
      <img src={src} alt={alt} draggable={false} style={{ transform: `scale(${transform.scale}) translate(${transform.x / transform.scale}px, ${transform.y / transform.scale}px)` }} />
    </div>
  </div>;
}

function imageFilename(src: string, alt: string): string {
  let pathname = "";
  try { pathname = decodeURIComponent(new URL(src, "https://localhost/").pathname.split("/").pop() ?? ""); } catch { /* 使用替代名称。 */ }
  if (/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(pathname)) return pathname.replace(/[/\\:*?"<>|]/g, "_");
  const mime = /^data:image\/([\w+.-]+)/i.exec(src)?.[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg");
  return `${(alt || "image").replace(/[/\\:*?"<>|]/g, "_").slice(0, 80)}.${mime ?? "png"}`;
}
