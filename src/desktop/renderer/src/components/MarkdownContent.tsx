/**
 * 消息正文的 Markdown 渲染。
 *
 * 助手回复、思考内容和用户消息共用这一套：链接按本地路径 / 外链分流，代码块带语言标签和高亮，
 * 图片和 `@attachments/` 附件走主进程转 data URL 内联显示；公式走 KaTeX，mermaid 围栏
 * 交给懒加载的 MermaidBlock。
 *
 * 渲染的是模型输出，一切外部内容都当不可信处理：只有经高亮库转义过的高亮结果会用
 * `dangerouslySetInnerHTML`，其余节点都交给 React 转义。
 */
import React, { isValidElement, memo, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import { useInlineImage } from "../inlineImage.js";
import { MermaidBlock } from "./MermaidBlock.js";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";
import { FileLinkCard } from "./FileLinkCard.js";
import { Icon } from "./Icon.js";

interface MarkdownContentProps {
  content: string;
  projectId: string;
  /** 附加到根节点的修饰类，例如思考内容用的 `is-compact`。 */
  variant?: string;
  /** 用户消息传 true：单换行渲染成换行（聊天里手敲的换行不应被 Markdown 吞掉）。 */
  breaks?: boolean;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  projectId,
  variant,
  breaks,
  onPreviewFile,
  onOpenExternal
}: MarkdownContentProps): React.JSX.Element {
  const remarkPlugins = useMemo(
    () => (breaks ? [remarkGfm, remarkBreaks, remarkMath] : [remarkGfm, remarkMath]),
    [breaks]
  );
  // components 里的函数会被 react-markdown 直接当作 React 元素类型；
  // 每次渲染内联重建会让表格/代码块/链接整棵子树在流式期间每帧卸载重建，
  // 配合入场动画表现为持续闪烁（.markdown-table 横向滚动位置也会被不断重置），
  // 因此必须用 useMemo 稳定组件身份，让 React 原地更新 DOM。
  const components = useMemo<Components>(() => ({
    a({ node: _node, children, ...props }) {
      const href = props.href;
      const path = localPathFromHref(href);
      // 本地路径收成文件卡片（资源卡样式），不再渲染普通 <a>；
      // 外链必须显式走 openExternal（主进程 deny 了所有新窗口导航）；
      // 页内锚点（如脚注）保留默认跳转，不能带 target=_blank 否则点击被吞。
      if (path) return <FileLinkCard onPreviewFile={onPreviewFile} path={path} />;
      const externalUrl = href && /^https?:\/\//i.test(href) ? href : undefined;
      const isAnchor = !externalUrl && Boolean(href?.startsWith("#"));
      const onClick = externalUrl
        ? (event: React.MouseEvent) => { event.preventDefault(); onOpenExternal(externalUrl); }
        : undefined;
      return <a {...props} onClick={onClick} rel="noreferrer" target={isAnchor ? undefined : "_blank"} title={externalUrl ? "在浏览器中打开" : undefined}>{children}</a>;
    },
    code({ className, children }) {
      // 围栏代码块由下面的 pre 接管，这里只剩行内代码。
      if (className) return <code className={className}>{children}</code>;
      // 行内代码样式的路径只是灰色代码标记；不根据文本外观暗中添加文件跳转。
      return <code>{children}</code>;
    },
    img({ alt, src, title }) {
      const source = typeof src === "string" ? src : undefined;
      const path = localPathFromHref(source);
      if (path) return <InlineImage alt={alt ?? ""} path={path} projectId={projectId} />;
      if (!source) return null;
      return <img alt={alt ?? ""} className="markdown-image" src={source} title={title} />;
    },
    pre({ children }) {
      const block = fencedCode(children);
      // 图表单独渲染；解析失败时 MermaidBlock 自己回退成普通代码块
      if (block.language?.toLowerCase() === "mermaid") return <MermaidBlock code={block.code} />;
      return <MarkdownCodeBlock code={block.code} language={block.language} />;
    },
    table({ children }) {
      // 宽表格自己横向滚动，不能把整条消息撑宽。
      return <div className="markdown-table"><table>{children}</table></div>;
    }
  }), [onOpenExternal, onPreviewFile, projectId]);
  return (
    <div className={variant ? `markdown-body ${variant}` : "markdown-body"}>
      <Markdown
        // singleDollarTextMath 关闭：$ 是常见计价符号，只认 $$...$$ 行内/块级公式
        components={components}
        remarkPlugins={remarkPlugins}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, errorColor: "var(--biny-danger)" }]]}
      >
        {content}
      </Markdown>
    </div>
  );
});

/** 图片没读到（不是图片、太大、路径不存在）时退回成一行文件名，不留一块空白。 */
function InlineImage({ alt, path, projectId }: { alt: string; path: string; projectId: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const source = useInlineImage(projectId, path);
  if (!source) return <span className="markdown-image-fallback"><Icon name="file" size={12} /><span>{alt || path}</span></span>;
  return (
    <img
      alt={alt}
      className={expanded ? "markdown-image is-expanded" : "markdown-image"}
      onClick={() => setExpanded(!expanded)}
      src={source}
      title={expanded ? "点击收起" : "点击放大"}
    />
  );
}

/** 从 `pre` 的子节点里取回围栏代码块的原文和语言标注。 */
function fencedCode(children: React.ReactNode): { code: string; language?: string } {
  const element = (Array.isArray(children) ? children : [children])
    .find((child): child is React.ReactElement<{ className?: string; children?: React.ReactNode }> => isValidElement(child));
  const language = /language-([\w+#.-]+)/.exec(element?.props.className ?? "")?.[1];
  return { code: extractText(element ? element.props.children : children).replace(/\n$/, ""), language };
}

function localPathFromHref(href?: string): string | undefined {
  if (!href || href.startsWith("#") || (/^[A-Za-z][A-Za-z\d+.-]*:/.test(href) && !href.startsWith("file://"))) return undefined;
  const isFileUrl = href.startsWith("file://");
  const encoded = isFileUrl ? href.slice("file://".length) : href;
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // Keep malformed local paths usable instead of breaking the whole message.
  }
  // file:// 已明确表达本地路径意图；路径可以含空格，不再套 looksLikePath 启发式。
  if (isFileUrl) return stripLineSuffix(decoded);
  return looksLikePath(decoded) ? stripLineSuffix(decoded) : undefined;
}

function stripLineSuffix(path: string): string {
  return path.replace(/(?::\d+){1,2}$/, "");
}

function looksLikePath(value: string): boolean {
  return !value.includes(" ") && (/^(?:\.\/|\.\.\/|\/|[\w.-]+\/)/.test(value) || /\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(value));
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}
