/**
 * Markdown 围栏代码块卡片：语言标签 + 复制按钮 + 高亮正文。
 *
 * 高亮走异步 hook，结果没跟上时先展示转义纯文本；MermaidBlock 解析失败时的
 * 回退展示也复用这一块。`dashed` 是命令执行详情里的命令卡变体（
 * 虚线边框 + 更弱底色 + terminal 角标），与普通围栏共用一套卡壳。
 */
import React from "react";
import { useHighlightedCode } from "../useHighlightedCode.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";

export function MarkdownCodeBlock({ code, language, dashed }: { code: string; language?: string; dashed?: boolean }): React.JSX.Element {
  const highlighted = useHighlightedCode(code, language);
  return (
    <div className={`markdown-code-block${dashed ? " is-dashed" : ""}`} data-language={language}>
      <div className="markdown-code-header">
        <span className="markdown-code-language">
          <Icon name={dashed ? "terminal" : "code"} size={12} />
          {language ?? "代码"}
        </span>
        <CopyButton className="copy-button markdown-code-copy" label="复制代码" value={code} />
      </div>
      <pre><code className="shiki" dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
    </div>
  );
}
