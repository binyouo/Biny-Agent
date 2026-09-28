import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyToClipboard } from "../copyToClipboard.js";

type LinkOverlay = { kind: "selection" | "context"; left: number; top: number };
type LinkFeedback = { message: string; left: number; top: number };

/** 普通阅读时不显示链接浮层；选中文本或显式右键时才展示链接操作。 */
export function MarkdownWebLink({ href, children, internalByDefault, onOpenExternal }: {
  href: string;
  children: ReactNode;
  internalByDefault: boolean;
  onOpenExternal(url: string): void;
}): React.JSX.Element {
  const anchor = useRef<HTMLAnchorElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const menuItems = useRef<Array<HTMLButtonElement | null>>([]);
  const [overlay, setOverlay] = useState<LinkOverlay>();
  const [feedback, setFeedback] = useState<LinkFeedback>();
  const selected = useCallback((): boolean => {
    const selection = window.getSelection();
    return Boolean(anchor.current && selection && !selection.isCollapsed && selection.toString().trim()
      && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(anchor.current));
  }, []);
  const selectionPosition = useCallback((): LinkOverlay | undefined => {
    if (!selected() || !anchor.current) return undefined;
    const rect = anchor.current.getBoundingClientRect();
    return {
      kind: "selection",
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 148))
    };
  }, [selected]);
  useEffect(() => {
    if (!overlay) return;
    const outside = (event: PointerEvent): void => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOverlay(undefined);
    };
    const close = (): void => setOverlay(undefined);
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOverlay(undefined);
        anchor.current?.focus();
      } else if (overlay.kind === "context" && event.key === "Tab") {
        event.preventDefault();
        setOverlay(undefined);
        anchor.current?.focus();
      }
    };
    const selectionChanged = (): void => {
      if (overlay.kind === "selection" && !selected()) setOverlay(undefined);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    if (overlay.kind === "selection") document.addEventListener("selectionchange", selectionChanged);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      if (overlay.kind === "selection") document.removeEventListener("selectionchange", selectionChanged);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [overlay, selected]);
  useEffect(() => {
    if (overlay?.kind === "context") firstItem.current?.focus();
  }, [overlay]);
  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(undefined), 1_600);
    return () => window.clearTimeout(timeout);
  }, [feedback]);
  const announce = (message: string, position?: Pick<LinkOverlay, "left" | "top">): void => {
    const rect = anchor.current?.getBoundingClientRect();
    setFeedback({
      message,
      left: position?.left ?? Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - 240)),
      top: position?.top ?? Math.max(8, Math.min(rect?.bottom ?? 8, window.innerHeight - 44))
    });
  };
  const open = async (internal: boolean, position?: Pick<LinkOverlay, "left" | "top">): Promise<void> => {
    setOverlay(undefined);
    anchor.current?.focus();
    try {
      if (internal) await window.biny.openBrowser(href);
      else await onOpenExternal(href);
    } catch {
      announce("无法打开链接，请重试。", position);
    }
  };
  const copyLink = async (): Promise<void> => {
    const position = overlay;
    const copied = await copyToClipboard(href);
    setOverlay(undefined);
    anchor.current?.focus();
    announce(copied ? "已复制链接" : "复制链接失败", position);
  };
  const showContextMenu = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    setFeedback(undefined);
    const menuHeight = 148;
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - 264));
    const top = Math.max(8, Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8)));
    setOverlay({ kind: "context", left, top });
  };
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = menuItems.current.filter((item): item is HTMLButtonElement => item !== null);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return <>
    <a href={href} ref={anchor} rel="noreferrer" onMouseUp={() => setOverlay(selectionPosition())}
      onKeyUp={(event) => { if (event.key !== "Escape") setOverlay(selectionPosition()); }}
      onContextMenu={showContextMenu}
      onClick={(event) => {
        event.preventDefault();
        if (!selected()) void open(internalByDefault && !event.metaKey && !event.ctrlKey);
      }}>
      {children}
    </a>
    {overlay ? createPortal(<div ref={panel}
      className={`markdown-link-actions${overlay.kind === "context" ? " is-context-menu" : ""}`}
      role={overlay.kind === "context" ? "menu" : "group"}
      aria-label={overlay.kind === "context" ? "链接操作" : "链接打开方式"}
      style={{ left: overlay.left, top: overlay.top }}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={overlay.kind === "context" ? onMenuKeyDown : undefined}>
      {overlay.kind === "selection" ? <>
        <span className="markdown-link-address">{href}</span>
        <button type="button" onClick={() => void open(false, overlay)}>外部浏览器打开</button>
        <button type="button" onClick={() => void open(true, overlay)}>内置浏览器打开</button>
      </> : <>
        <span className="markdown-link-menu-heading" role="presentation">打开链接</span>
        <button ref={(node) => { firstItem.current = node; menuItems.current[0] = node; }} role="menuitem" tabIndex={-1}
          type="button" onClick={() => void open(false, overlay)}>在外部浏览器中打开</button>
        <button ref={(node) => { menuItems.current[1] = node; }} role="menuitem" tabIndex={-1}
          type="button" onClick={() => void open(true, overlay)}>在内置浏览器中打开</button>
        <span className="markdown-link-menu-separator" aria-hidden="true" />
        <button ref={(node) => { menuItems.current[2] = node; }} role="menuitem" tabIndex={-1}
          type="button" onClick={() => void copyLink()}>复制链接</button>
      </>}
    </div>, document.body) : null}
    {feedback ? createPortal(<span className="markdown-link-feedback" role="status" style={{ left: feedback.left, top: feedback.top }}>{feedback.message}</span>, document.body) : null}
  </>;
}
