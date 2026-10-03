/**
 * Markdown 围栏代码块；没有语言时复制按钮只在悬停或聚焦出现。
 *
 * 高亮走异步 hook，结果没跟上时先展示转义纯文本；MermaidBlock 解析失败时的
 * 回退展示也复用这一块。`dashed` 是命令执行详情里的命令卡变体（
 * 虚线边框 + 更弱底色 + terminal 角标），与普通围栏共用一套卡壳。
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useHighlightedCode } from "../useHighlightedCode.js";
import { copyToClipboard } from "../copyToClipboard.js";
import { Icon } from "./Icon.js";

export function MarkdownCodeBlock({ code, language, dashed, isStreaming = false }: { code: string; language?: string; dashed?: boolean; isStreaming?: boolean }): React.JSX.Element {
  const highlighted = useHighlightedCode(code, language, undefined, isStreaming);
  const container = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [sticky, setSticky] = useState<{ top: number; right: number; unit: string }>();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  useEffect(() => {
    const block = container.current;
    const scroll = block?.closest(".biny-chat-scroll, .inspector-result-scroll, .rendering-preview-source");
    if (!block || !scroll) return;
    let frame: number | undefined;
    let isSticky = false;
    const update = (): void => {
      frame = undefined;
      const rect = block.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      const delta = rect.top - viewport.top;
      const next = rect.height > viewport.height && delta < (isSticky ? 4 : -12) && rect.bottom > viewport.top + 50;
      isSticky = next;
      const copyRect = toolbar.current?.querySelector("button")?.getBoundingClientRect();
      setSticky(previous => {
        if (!next || !copyRect) return undefined;
        const position = { top: Math.round(viewport.top + 12), right: Math.round(window.innerWidth - copyRect.right), unit: `${copyRect.width / 1.5}px` };
        return previous?.top === position.top && previous.right === position.right && previous.unit === position.unit ? previous : position;
      });
    };
    const schedule = (): void => { frame ??= window.requestAnimationFrame(update); };
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    schedule();
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); scroll.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, []);
  const copy = <button className={`copy-button markdown-code-copy${copied ? " is-copied" : ""}`} type="button" aria-label={copied ? "已复制" : "复制代码"} title={copied ? "已复制" : "复制代码"} onClick={async () => {
    if (!await copyToClipboard(code)) return;
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 2_000);
  }}><Icon name={copied ? "check" : "copy"} size={14} /></button>;
  return (
    <div ref={container} className={`markdown-code-block${dashed ? " is-dashed" : ""}${!language && !dashed ? " is-plain" : ""}`} data-language={language}>
      <div ref={toolbar} className={language || dashed ? "markdown-code-header" : "markdown-code-corner"}>
        {language || dashed ? <span className="markdown-code-language">
          <Icon name={dashed ? "terminal" : "code"} size={12} />
          {language ?? "代码"}
        </span> : null}
        <span className="markdown-code-copy-slot" style={{ visibility: sticky ? "hidden" : undefined }}>{copy}</span>
      </div>
      {sticky ? createPortal(<div className="markdown-code-sticky" style={{ top: sticky.top, right: sticky.right, "--markdown-code-unit": sticky.unit } as React.CSSProperties}>{copy}</div>, document.body) : null}
      <pre><code className="shiki" dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
    </div>
  );
}
