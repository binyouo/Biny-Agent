/**
 * 右侧 dock 的「产物」视图：当前会话里 Agent 改过的文件。
 *
 * 按文件聚合，列表突出名称与路径，展开后展示编辑记录和文件预览入口。
 * 数据由 App 从时间线注入，这里只负责展示与本地展开状态。
 */
import { useMemo, useState } from "react";
import { parseDiffHunks, sessionChangeTotals, type DiffHunk, type DiffHunkLine, type SessionFileChange } from "../../sessionChanges.js";
import { Icon } from "../Icon.js";

const diffPageLines = 500;

export function SessionChangesPanel({ changes, onPreviewFile }: {
  changes: SessionFileChange[];
  onPreviewFile(path: string): void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const visibleChanges = changes.filter((change) => change.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const totals = useMemo(() => sessionChangeTotals(changes), [changes]);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const togglePath = (path: string): void => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="biny-session-changes">
      <header className="biny-session-changes-summary">
        <div className="biny-session-changes-heading">
          <h2>更改的文件 <span>{totals.files}</span></h2>
          <p>本次对话</p>
        </div>
        {totals.add + totals.del > 0 ? (
          <span className="diff-stats biny-session-changes-diffstat">
            <span className="diff-add">+{totals.add}</span>
            <span className="diff-delete">-{totals.del}</span>
          </span>
        ) : null}
      </header>
      {changes.length > 0 ? <div className="inspector-subtoolbar"><input aria-label="筛选产物" placeholder="按文件路径筛选…" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" onClick={() => setExpandedPaths(new Set(visibleChanges.map((change) => change.path)))}>展开</button><button type="button" onClick={() => setExpandedPaths(new Set())}>折叠</button></div> : null}
      {changes.length === 0 ? (
        <div className="biny-session-changes-empty">
          <Icon name="file-diff" size={28} />
          <p className="biny-session-changes-empty-title">还没有文件更改</p>
          <p className="biny-session-changes-empty-hint">对话中写入或编辑的文件会显示在这里</p>
        </div>
      ) : <div className="biny-session-changes-list">
        {visibleChanges.length === 0 ? <div className="inspector-empty">没有匹配的文件</div> : null}
        {visibleChanges.map((change) => (
          <ChangeRow
            change={change}
            expanded={expandedPaths.has(change.path)}
            key={change.path}
            onPreviewFile={onPreviewFile}
            onToggle={() => togglePath(change.path)}
          />
        ))}
      </div>}
    </div>
  );
}

function ChangeRow({ change, expanded, onToggle, onPreviewFile }: {
  change: SessionFileChange;
  expanded: boolean;
  onToggle(): void;
  onPreviewFile(path: string): void;
}): React.JSX.Element {
  const operationClass = change.operation === "create" ? "write" : "edit";
  const operationLabel = change.operation === "create" ? "写入"
    : change.operation === "delete" ? "删除"
      : change.operation === "move" ? "移动" : "编辑";
  const name = change.path.slice(change.path.lastIndexOf("/") + 1);
  const dir = name === change.path ? "" : change.path.slice(0, change.path.lastIndexOf("/"));
  return (
    <div className={`biny-session-change${expanded ? " is-open" : ""}`}>
      <button
        aria-expanded={expanded}
        className="biny-session-change-row"
        onClick={onToggle}
        title={change.path}
        type="button"
      >
        <span aria-hidden="true" className={`biny-session-change-chevron${expanded ? " is-open" : ""}`}>
          <Icon name="chevron" size={12} />
        </span>
        <span className={`biny-session-change-icon is-${operationClass}`}>
          <Icon name={change.operation === "create" ? "file-text" : "file-pen"} size={16} />
        </span>
        <span className="biny-session-change-label">
          <span className="biny-session-change-name">{change.sourcePath ? `${change.sourcePath} → ${change.path}` : name}</span>
          {dir !== "" ? <span className="biny-session-change-dir">{dir}</span> : null}
        </span>
        <span className={`biny-session-change-chip${change.status === "writing" ? " is-active" : ""} is-${operationClass}`}>
          {change.status === "writing" ? "处理中" : operationLabel}
        </span>
        {change.add + change.del > 0 ? (
          <span className="diff-stats biny-session-change-stats">
            <span className="diff-add">+{change.add}</span>
            <span className="diff-delete">-{change.del}</span>
          </span>
        ) : null}
      </button>
      {expanded ? <ChangeDetails change={change} onPreviewFile={onPreviewFile} /> : null}
    </div>
  );
}

interface DiffSection {
  lines: DiffHunkLine[];
  gapBefore: boolean;
  gapAfter: boolean;
}

function changeSections(hunks: DiffHunk[]): DiffSection[] {
  return hunks.flatMap((hunk, hunkIndex) => {
    const ranges: { start: number; end: number }[] = [];
    for (let index = 0; index < hunk.lines.length; index += 1) {
      if (hunk.lines[index]!.kind === "ctx") continue;
      const start = Math.max(0, index - 3);
      const end = Math.min(hunk.lines.length, index + 4);
      const previous = ranges.at(-1);
      if (previous && start <= previous.end) previous.end = end;
      else ranges.push({ start, end });
    }
    if (!ranges.length) ranges.push({ start: 0, end: hunk.lines.length });
    return ranges.map(({ start, end }, index) => ({
      lines: hunk.lines.slice(start, end),
      gapBefore: hunkIndex > 0 || start > 0,
      gapAfter: index === ranges.length - 1 && end < hunk.lines.length
    }));
  });
}

/** 收起时卸载详情，避免为文件摘要解析全文，并在下次展开时恢复默认展示规模。 */
function ChangeDetails({ change, onPreviewFile }: { change: SessionFileChange; onPreviewFile(path: string): void }): React.JSX.Element {
  const hunks = useMemo(() => parseDiffHunks(change.diff), [change.diff]);
  const compactSections = useMemo(() => changeSections(hunks), [hunks]);
  const [showContext, setShowContext] = useState(false);
  const [lineLimit, setLineLimit] = useState(diffPageLines);
  const totalLines = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const compactLines = compactSections.reduce((sum, section) => sum + section.lines.length, 0);
  const sections = showContext ? hunks.map((hunk, index) => ({ lines: hunk.lines, gapBefore: index > 0, gapAfter: false })) : compactSections;
  let remaining = lineLimit;
  const renderedSections: DiffSection[] = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const lines = section.lines.slice(0, remaining);
    remaining -= lines.length;
    renderedSections.push({ ...section, lines, gapAfter: section.gapAfter && lines.length === section.lines.length });
  }
  const hiddenLines = Math.max(0, (showContext ? totalLines : compactLines) - lineLimit);
  return (
    <div className="biny-session-change-body">
      <div className="biny-session-change-detail-header">
        <span>{change.changeCount > 1 ? `${change.changeCount} 次操作记录` : "操作记录"}</span>
        {change.operation !== "delete" ? <button onClick={() => onPreviewFile(change.path)} type="button">
          <Icon name="eye" size={13} />
          预览文件
        </button> : null}
      </div>
      {hunks.length > 0 ? (
        <pre className="merged-edit-diff biny-session-change-diff"><code>
          {renderedSections.map((section, sectionIndex) => (
            <span key={sectionIndex}>
              {section.gapBefore ? <DiffGap /> : null}
              {section.lines.map((line, lineIndex) => (
                <span className="merged-diff-line" data-line={line.kind} key={lineIndex}>
                  <span className="merged-diff-ln">{line.lineNo ?? ""}</span>
                  <span className="merged-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}</span>
                  <span className="merged-diff-text">{line.text}</span>{"\n"}
                </span>
              ))}
              {section.gapAfter ? <DiffGap /> : null}
            </span>
          ))}
        </code></pre>
      ) : (
        <p className="biny-session-change-no-diff">没有差异记录，可预览文件当前内容。</p>
      )}
      {hiddenLines > 0 ? <button
        className="expand-output"
        onClick={() => setLineLimit((current) => current + diffPageLines)}
        type="button"
      >继续显示 {String(Math.min(diffPageLines, hiddenLines))} 行（还有 {String(hiddenLines)} 行）</button> : null}
      {compactLines < totalLines ? <button
        aria-pressed={showContext}
        className="expand-output"
        onClick={() => { setShowContext((current) => !current); setLineLimit(diffPageLines); }}
        type="button"
      >{showContext ? "仅显示变更附近" : "显示完整上下文"}</button> : null}
    </div>
  );
}

function DiffGap(): React.JSX.Element {
  return <span className="merged-diff-line merged-diff-gap"><span className="merged-diff-ln">⋮</span><span className="merged-diff-sign" /><span className="merged-diff-text" />{"\n"}</span>;
}
