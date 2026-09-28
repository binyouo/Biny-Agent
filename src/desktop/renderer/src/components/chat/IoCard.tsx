/**
 * 通用工具展开体的 IN/OUT 卡片：
 * IN 与 OUT 各占一个标签段，独立滚动（max-height 受限），中间发丝线分隔。
 */
import React, { memo } from "react";
import { CopyButton } from "../CopyButton.js";

export const IoCard = memo(function IoCard({ input, output, outputError = false }: {
  /** 输入文本（pretty 参数）；null 不渲染 IN 段。 */
  input: string | null;
  /** 输出文本（结果）；null 不渲染 OUT 段。 */
  output: string | null;
  /** 输出段是否按错误色渲染。 */
  outputError?: boolean;
}): React.JSX.Element | null {
  if (input === null && output === null) return null;
  return (
    <div className="chat-io-card">
      {input !== null ? (
        <div className="chat-io-section">
          <span className="chat-io-label">参数</span>
          <pre aria-label="工具参数" tabIndex={0} className="chat-io-text">{input}</pre>
          <CopyButton label="复制参数" value={input} />
        </div>
      ) : null}
      {input !== null && output !== null ? <span aria-hidden="true" className="chat-io-divider" /> : null}
      {output !== null ? (
        <div className="chat-io-section">
          <span className="chat-io-label" data-error={outputError || undefined}>{outputError ? "错误" : "结果"}</span>
          <pre aria-label="工具结果" tabIndex={0} className="chat-io-text">{output}</pre>
          <CopyButton label="复制结果" value={output} />
        </div>
      ) : null}
    </div>
  );
});
