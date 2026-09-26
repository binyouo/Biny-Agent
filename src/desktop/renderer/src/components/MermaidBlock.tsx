/**
 * Markdown 里的 mermaid 图表块。
 *
 * mermaid 体积大，走 dynamic import 懒加载：第一条图表出现才拉取，未用到不进主包。
 * 渲染结果跟随明暗主题重出；流式期间语法经常是半截的，解析失败不报错，
 * 回退成普通代码块展示原文，成功过的 SVG 保留到最后一份有效结果。
 *
 * 图表内容是模型输出，mermaid 保持默认 securityLevel=strict（净化 HTML 标签、禁事件回调）。
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { CopyButton } from "./CopyButton.js";
import { DownloadButton } from "./MarkdownDownload.js";
import { Icon } from "./Icon.js";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";

/** 流式增量到达频繁，debounce 掉中间态，只在停顿后尝试渲染。 */
const MERMAID_DEBOUNCE_MS = 300;

interface MermaidState {
  code: string;
  svg: string;
}

export function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const dark = useIsDarkTheme();
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<MermaidState | undefined>();

  useEffect(() => {
    const source = code.trim();
    if (!source) return;
    let active = true;
    const timer = setTimeout(() => {
      renderMermaid(source, dark)
        .then((svg) => {
          if (active) setState({ code: source, svg });
        })
        .catch(() => {});
    }, MERMAID_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [code, dark]);

  // 成功过就保留最后一份有效 SVG（即使源码又变了）；从没成功过（含解析失败）回退代码块
  if (state) {
    const diagram = <div className="markdown-diagram-viewport" tabIndex={0} role="region" aria-label="图表"><div className="markdown-mermaid" style={{ zoom }} dangerouslySetInnerHTML={{ __html: state.svg }} /></div>;
    const controls = <div className="markdown-block-actions">
      <CopyButton label="复制图表源码" value={state.code} />
      <details className="markdown-action-menu"><summary aria-label="下载图表" title="下载图表"><Icon name="download" size={14} /></summary><div>
        <DownloadButton label="SVG" showLabel filename="diagram.svg" getContent={() => new Blob([state.svg], { type: "image/svg+xml" })} />
        <DownloadButton label="MMD" showLabel filename="diagram.mmd" getContent={() => new Blob([state.code], { type: "text/plain" })} />
        <DownloadButton label="PNG" showLabel filename="diagram.png" getContent={() => diagramPng(state.svg)} />
      </div></details>
      <button type="button" aria-label="缩小图表" title="缩小图表" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Icon name="minus" size={14} /></button>
      <button type="button" aria-label="重置图表缩放" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="放大图表" title="放大图表" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))}><Icon name="add" size={14} /></button>
      <button type="button" aria-label="全屏查看图表" title="全屏查看图表" onClick={() => setExpanded(true)}><Icon name="display" size={14} /></button>
    </div>;
    return <div className="markdown-diagram">{controls}{diagram}{expanded ? <Dialog isOpen onOpenChange={setExpanded} width="min(1100px, calc(100vw - 48px))"><DialogHeader title="图表" onOpenChange={setExpanded} />{controls}{diagram}</Dialog> : null}</div>;
  }
  return <MarkdownCodeBlock code={code} language="mermaid" />;
}

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidApi> | undefined;
let initializedTheme: "dark" | "default" | undefined;
let renderSequence = 0;

async function renderMermaid(source: string, dark: boolean): Promise<string> {
  const mermaid = await (mermaidPromise ??= import("mermaid").then((module) => module.default));
  const theme = dark ? "dark" : "default";
  if (initializedTheme !== theme) {
    // startOnLoad=false + suppressErrorRendering：手动控制渲染，不往页面注入错误 SVG
    mermaid.initialize({ startOnLoad: false, theme, suppressErrorRendering: true });
    initializedTheme = theme;
  }
  const id = `biny-mermaid-${++renderSequence}`;
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-99999px";
  document.body.appendChild(container);
  try {
    const { svg } = await mermaid.render(id, source, container);
    return svg;
  } finally {
    container.remove();
    // mermaid 渲染出错时可能把临时节点遗留在 body 上，按本次 id 清扫兜底
    document.querySelectorAll(`svg[id^="${id}"], #d${id}`).forEach((element) => element.remove());
  }
}

/** 明暗判断：读 data-theme（light/dark/system），system 跟随系统偏好。 */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(currentIsDark);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(currentIsDark());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return dark;
}

function currentIsDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** PNG 只从已净化 SVG 导出；限制像素尺寸并释放临时 URL。 */
async function diagramPng(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("图表导出超时")), 10000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("图表无法导出")); };
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    const scale = Math.min(2, 4096 / Math.max(image.width, image.height, 1));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建画布");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图表导出失败")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
