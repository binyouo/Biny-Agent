/**
 * 带语法高亮的代码展示卡片（工具展开体专用）。
 *
 * 头部：文件名/语言标签 + hover 浮现的复制按钮；
 * 正文：Shiki 高亮 + 可选行号槽（等宽行高对齐，长行横向滚动不换行，保证行号不错位）；
 * 超过折叠行数时给「展开全部」按钮。
 */
import React, { memo, useMemo, useState } from "react";
import { useHighlightedCode } from "../../useHighlightedCode.js";
import { CopyButton } from "../CopyButton.js";
import { Icon } from "../Icon.js";

/** 折叠态最多展示的行数。 */
const COLLAPSED_LINES = 12;

export const CodeView = memo(function CodeView({
  code,
  filePath,
  language,
  showLineNumbers = true,
  onPreviewFile,
}: {
  code: string;
  /** 有路径时按扩展名推断语言并展示文件名。 */
  filePath?: string;
  /** 显式语言标注（无路径时用）。 */
  language?: string;
  showLineNumbers?: boolean;
  /** 给文件名加「点击在右侧预览」。 */
  onPreviewFile?(path: string): void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const highlighted = useHighlightedCode(code, language, filePath);
  const lines = useMemo(() => {
    const split = code.split("\n");
    if (split.at(-1) === "") split.pop();
    return split;
  }, [code]);
  const fileName = filePath?.replaceAll("\\", "/").split("/").at(-1);
  const languageLabel = highlighted.language ?? language;
  const collapsible = lines.length > COLLAPSED_LINES;

  return (
    <div className={`chat-codeview${expanded ? " is-expanded" : ""}`}>
      <div className="chat-codeview-header">
        {filePath && onPreviewFile ? (
          <button className="chat-codeview-title is-clickable" onClick={() => onPreviewFile(filePath)} title={`在右侧预览 ${filePath}`} type="button">
            <Icon name="file-text" size={12} />
            {fileName ? <span className="chat-codeview-filename">{fileName}</span> : null}
            {languageLabel ? <span className="chat-codeview-language">{languageLabel}</span> : null}
          </button>
        ) : (
          <span className="chat-codeview-title">
            {filePath ? <Icon name="file-text" size={12} /> : null}
            {fileName ? <span className="chat-codeview-filename">{fileName}</span> : null}
            {languageLabel ? <span className="chat-codeview-language">{languageLabel}</span> : null}
          </span>
        )}
        <CopyButton className="copy-button" label="复制代码" showLabel value={code} />
      </div>
      <div aria-label="文件内容" tabIndex={0} className="chat-codeview-body">
        {showLineNumbers ? (
          <div aria-hidden="true" className="chat-codeview-gutter">
            {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
          </div>
        ) : null}
        <pre className="chat-codeview-pre"><code className="shiki" dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
      </div>
      {collapsible ? (
        <button aria-expanded={expanded} className="expand-output" onClick={() => setExpanded(current => !current)} type="button">
          {expanded ? "收起代码" : `展开 ${String(lines.length)} 行代码`}
        </button>
      ) : null}
    </div>
  );
});
