/**
 * 上下文压缩分隔条（时间线里的普通一行，居中药丸样式）。
 *
 * 折叠态：fold 图标 + 「上下文已压缩 · N 条消息已摘要 · 节省约 X tokens」，
 * 有摘要正文时可点开，复用聊天正文的 Markdown 与链接处理。
 * 计数/节省缺失的段自动省略；无正文时整条不可展开。
 */
import React, { memo, useId, useState } from "react";
import { Icon } from "../Icon.js";
import { MarkdownContent } from "../MarkdownContent.js";

const ignoreAction = (): void => {};

export const CompactionDivider = memo(function CompactionDivider({ count, savedTokens, summary, projectId = "", onPreviewFile = ignoreAction, onOpenExternal = ignoreAction }: {
  /** 被摘要掉的消息条数；缺失时省略该段。 */
  count?: number;
  /** 估算节省的 token 数；缺失或 ≤0 时省略该段。 */
  savedTokens?: number;
  /** 可选的压缩摘要正文；存在才可展开。 */
  summary?: string;
  projectId?: string;
  onPreviewFile?(path: string): void;
  onOpenExternal?(url: string): void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  const hasSummary = (summary ?? "").trim().length > 0;
  return (
    <div className="chat-compaction" data-activity-anchor="">
      <button
        aria-controls={hasSummary ? summaryId : undefined}
        aria-expanded={hasSummary ? expanded : undefined}
        className={`chat-compaction-pill${hasSummary ? " is-expandable" : ""}`}
        data-activity-toggle=""
        disabled={!hasSummary}
        onClick={hasSummary ? () => setExpanded((current) => !current) : undefined}
        type="button"
      >
        <span className="chat-compaction-segment">
          <Icon name="fold" size={12} />
          <span>上下文已压缩</span>
        </span>
        {count !== undefined ? (
          <>
            <span aria-hidden="true" className="chat-compaction-dot">•</span>
            <span>{String(count)} 条消息已摘要</span>
          </>
        ) : null}
        {savedTokens !== undefined && savedTokens > 0 ? (
          <>
            <span aria-hidden="true" className="chat-compaction-dot">•</span>
            <span>节省约 {savedTokens.toLocaleString("en-US")} tokens</span>
          </>
        ) : null}
        {hasSummary ? <span className={`chat-compaction-chevron${expanded ? " is-open" : ""}`}><Icon name="chevron" size={12} /></span> : null}
      </button>
      {expanded && hasSummary ? <div className="chat-compaction-body" id={summaryId}>
        <MarkdownContent content={summary ?? ""} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
      </div> : null}
    </div>
  );
});
