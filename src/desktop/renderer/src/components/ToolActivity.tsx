/**
 * 工具调用详情体（headless）。
 *
 * 活动段里工具动宾行内嵌的完整详情：权限询问、命令日志、文件变更、diff、网页搜索、
 * 通用 IN/OUT 卡与错误输出。折叠行/标题由活动段的活动行承载，这里只渲染正文。
 */
import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { permissionPresentation } from "../../../../permission/presentation.js";
import { isFullYesConfirmation } from "../../../../permission/confirmation.js";
import type { PermissionAction, PermissionResult } from "../../../../permission/PermissionManager.js";
import { permissionScopeForAlways } from "../../../../permission/permissionScope.js";
import type { TimelineCommand, TimelineTool } from "../sessionTimeline.js";
import { projectWebSearchView, type WebSearchResultView, type WebSearchView } from "../webSearchPresentation.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";
import { CodeView } from "./chat/CodeView.js";
import { IoCard } from "./chat/IoCard.js";

interface ToolActivityDetailProps {
  projectId: string;
  tool: TimelineTool;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
}

export const ToolActivityDetail = memo(function ToolActivityDetail({ projectId, tool, onPreviewFile, onOpenExternal }: ToolActivityDetailProps): React.JSX.Element {
  const command = useMemo(() => commandDetails(tool), [tool]);
  const committedDiff = tool.fileChange?.diff;
  const diff = useMemo(() => committedDiff ? analyzeDiff(committedDiff) : undefined, [committedDiff]);
  const webSearch = useMemo(() => tool.tool === "WebSearch" ? projectWebSearchView(tool.args, tool.result) : undefined, [tool.args, tool.result, tool.tool]);
  const errorText = meaningfulError(tool, command);

  return (
    <div className="tool-details" data-project-id={projectId}>
      {command ? <CommandLog command={command} running={tool.status === "running" && (!tool.permission || tool.permission.resolved)} /> : null}
      {tool.fileChange ? <section className="tool-section">
        <h4 className="tool-section-label">{tool.fileChange.server ? `远端变更 · ${tool.fileChange.server}` : "已提交变更"}</h4>
        <pre><code>{tool.fileChange.operation} {tool.fileChange.path}{tool.fileChange.destinationPath ? ` → ${tool.fileChange.destinationPath}` : ""}</code></pre>
        {tool.fileChange.server && tool.fileChange.diff ? <pre><code>{tool.fileChange.diff}</code></pre> : null}
      </section> : null}
      {diff && committedDiff && !tool.fileChange?.server && tool.fileChange?.operation !== "delete" ? <DiffView diff={committedDiff} info={diff} onPreviewFile={onPreviewFile} /> : null}
      {tool.fileChange?.operation === "delete" && !tool.fileChange.server ? <pre><code>{tool.fileChange.diff}</code></pre> : null}
      {webSearch ? <WebSearchLog onOpenExternal={onOpenExternal} tool={tool} view={webSearch} /> : null}
      {(tool.tool === "Skill" || tool.tool === "skill_call") && tool.display?.kind === "generic" && typeof tool.display.detail === "string" ? (
        <section className="tool-section">
          <h4 className="tool-section-label">技能介绍</h4>
          <pre><code>{tool.display.detail}</code></pre>
        </section>
      ) : null}
      {!command && !diff && !webSearch && !tool.fileChange ? <ToolPayload onPreviewFile={onPreviewFile} tool={tool} /> : null}
      {errorText ? (
        <section className="tool-section">
          <h4 className="tool-section-label">错误</h4>
          <div className="copyable-code-block is-error">
            <CopyButton className="copy-button" label="复制错误" value={errorText} />
            <pre className="tool-error-output"><code>{errorText}</code></pre>
          </div>
        </section>
      ) : null}
    </div>
  );
});

/** 授权与工具详情并列，折叠日志时仍可操作授权。请求切换时重置提交状态。 */
export function ToolPermission({ tool, onResolvePermission }: {
  tool: TimelineTool;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element | null {
  return tool.permission ? <PermissionRequest key={tool.permission.requestId} tool={tool} onResolvePermission={onResolvePermission} /> : null;
}

function PermissionRequest({ tool, onResolvePermission }: {
  tool: TimelineTool;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const [resolving, setResolving] = useState(false);
  const [resolutionError, setResolutionError] = useState<string>();
  const [optimisticResult, setOptimisticResult] = useState<PermissionResult>();
  const resolve = async (result: PermissionResult): Promise<void> => {
    if (!tool.permission || resolving) return;
    setResolving(true);
    setResolutionError(undefined);
    setOptimisticResult(result);
    try {
      await onResolvePermission(tool.permission.requestId, result);
    } catch (error) {
      setOptimisticResult(undefined);
      setResolutionError(error instanceof Error ? error.message : "授权提交失败，请重试。");
    } finally {
      setResolving(false);
    }
  };

  return <PermissionCard error={resolutionError} disabled={resolving} permission={optimisticResult ? { ...tool.permission!, ...optimisticResult, resolved: true } : tool.permission!} onResolve={resolve} />;
}

// 「Command exited with code N.」只是退出码徽标的复读，不单独成段。
function meaningfulError(tool: TimelineTool, command: TimelineCommand | undefined): string | undefined {
  if (!tool.error) return undefined;
  if (command?.exitCode !== undefined && /^Command exited with code \d+\.$/.test(tool.error)) return undefined;
  return tool.error;
}

function PermissionCard({
  permission,
  disabled,
  error,
  onResolve
}: {
  permission: NonNullable<TimelineTool["permission"]>;
  disabled: boolean;
  error?: string;
  onResolve(result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const request = permission.request;
  const [confirmationState, setConfirmationState] = useState({ requestId: permission.requestId, value: "" });
  const [denialState, setDenialState] = useState({ requestId: permission.requestId, open: false, value: "" });
  const confirmation = confirmationState.requestId === permission.requestId ? confirmationState.value : "";
  const denialReason = denialState.requestId === permission.requestId ? denialState.value : "";
  const showDenialReason = denialState.requestId === permission.requestId && denialState.open;
  const fullYesProvided = isFullYesConfirmation(confirmation);
  const { title, details, reason } = permissionPresentation(request);

  if (permission.resolved) {
    return (
      <div className={`permission-card is-resolved${permission.approved ? " is-approved" : " is-denied"}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={permission.approved ? "M20 6 9 17 4 12" : "M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11"} />{!permission.approved ? <path d="M12 8v4m0 4h.01" /> : null}</svg>
        <span>{resolvedPermissionLabel(permission.action, permission.approved === true)}</span>
        {permission.message ? <span className="permission-resolved-reason">· {permission.message}</span> : null}
      </div>
    );
  }
  return (
    <section className={`permission-card${["high", "critical"].includes(request.riskLevel) ? " is-critical" : ""}`} aria-label="工具授权" aria-busy={disabled}>
      <span className="permission-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11" /><path d="M12 8v4m0 4h.01" /></svg></span>
      <div className="permission-body">
        <span className="permission-strip-title">需要你的确认</span>
        <h4 className="permission-headline">{title}</h4>
        <pre className="permission-preview">{[
          request.command,
          !request.secondaryTargetPath ? request.targetPath : undefined,
          details,
          !request.command ? request.diff ?? request.preview : undefined,
          reason
        ].filter(Boolean).join("\n")}</pre>
        {error ? <p role="alert" className="tool-error-output">{error}</p> : null}
        {showDenialReason ? (
          <label className="permission-confirmation">

            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => setDenialState({ requestId: permission.requestId, open: true, value: event.target.value.slice(0, 240) })}
              aria-label="拒绝理由"
              placeholder="说明拒绝原因…"
              spellCheck={false}
              type="text"
              value={denialReason}
            />
          </label>
        ) : null}
        {request.requireFullYes && !showDenialReason ? (
          <label className="permission-confirmation">
            <span>输入 <strong>yes</strong> 确认此操作</span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => setConfirmationState({ requestId: permission.requestId, value: event.target.value.slice(0, 16) })}
              spellCheck={false}
              type="text"
              placeholder="yes"
              value={confirmation}
            />
          </label>
        ) : null}
        {request.canRemember === false ? <p className="permission-reason">此操作按设置需要逐次确认。</p> : null}
        <div className="permission-actions">
          <button className="is-danger" disabled={disabled} onClick={() => void onResolve({ approved: false, action: "deny", scope: "once", message: undefined, confirmation: undefined })} type="button">拒绝</button>
          <button
            className={showDenialReason ? "is-reason-active" : undefined}
            disabled={disabled || (showDenialReason && !denialReason.trim())}
            onClick={() => {
              if (!showDenialReason) {
                setDenialState({ requestId: permission.requestId, open: true, value: "" });
                return;
              }
              const reason = denialReason.trim();
              if (!reason) return;
              void onResolve({ approved: false, action: "deny_with_reason", scope: "once", message: reason, confirmation: undefined });
            }}
            type="button"
          >{showDenialReason ? "提交拒绝理由" : "拒绝并说明理由"}</button>
          <button className="is-primary" disabled={disabled || (request.requireFullYes && !fullYesProvided)} onClick={() => void onResolve({ approved: true, action: "allow_once", scope: "once", confirmation: request.requireFullYes ? confirmation : undefined })} type="button">{disabled ? "正在提交…" : "允许一次"}</button>
          {request.canRemember !== false ? <button className="is-session" disabled={disabled || (request.requireFullYes && !fullYesProvided)} onClick={() => void onResolve({ approved: true, action: "allow_always", scope: permissionScopeForAlways(request), confirmation: request.requireFullYes ? confirmation : undefined })} type="button" title="仅记住当前会话中相同命令、路径或工具的授权">本会话允许</button> : null}
        </div>
      </div>
    </section>
  );
}

function resolvedPermissionLabel(action: PermissionAction | undefined, approved: boolean): string {
  if (action === "allow_always") return "已在本会话允许";
  if (action === "allow_once") return "已允许一次";
  if (action === "deny_with_reason") return "已拒绝并说明理由";
  if (action === "deny") return "已拒绝";
  return approved ? "已允许" : "已拒绝";
}

/** 输出折叠态展示的行数（流式输出折叠上限）。 */
const OUTPUT_COLLAPSED_LINES = 10;

interface OutputLine {
  text: string;
  stderr: boolean;
}

/** stdout / stderr 拼成逐行数组：折叠按行切片，stderr 行保留染色。 */
function commandOutputLines(command: TimelineCommand): OutputLine[] {
  const lines: OutputLine[] = [];
  for (const line of command.stdout.split("\n")) lines.push({ text: line, stderr: false });
  // stdout 以换行收尾时 split 出的末尾空行不是真实空行，接 stderr 前去掉
  if (command.stderr && lines.length > 0 && lines.at(-1)?.text === "") lines.pop();
  if (command.stderr) for (const line of command.stderr.split("\n")) lines.push({ text: line, stderr: true });
  if (lines.length > 0 && lines.at(-1)?.text === "") lines.pop();
  return lines;
}

/**
 * 命令执行详情（命令卡结构）：
 * 「命令」小节 = 虚线边框 bash 代码卡；「输出」小节 = 边框终端盒 + 运行徽标。
 * 输出按行折叠：运行中跟随尾部（长命令的实时日志在末尾），落定后从头部折叠，
 * 展开后限高滚动，不再用测高展开的老方案。
 */
function CommandLog({ command, running }: { command: TimelineCommand; running: boolean }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = commandOutputLines(command);
  const output = lines.map((line) => line.text).join("\n");
  const hasOutput = lines.length > 0;
  const hiddenCount = Math.max(0, lines.length - OUTPUT_COLLAPSED_LINES);
  const visibleLines = expanded ? lines : running ? lines.slice(-OUTPUT_COLLAPSED_LINES) : lines.slice(0, OUTPUT_COLLAPSED_LINES);
  const failed = command.exitCode !== undefined && command.exitCode !== 0;
  useEffect(() => {
    if (!running || !expanded || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [output, running, expanded]);

  return (
    <>
      {command.command ? (
        <section className="tool-section">
          <h4 className="tool-section-label">命令</h4>
          <MarkdownCodeBlock code={command.command} dashed language="bash" />
        </section>
      ) : null}
      {hasOutput || running ? (
        <section className="tool-section">
          <h4 className="tool-section-label">
            输出
            {running && hasOutput ? <span className="command-log-live"><span className="command-log-live-dot" />运行中</span> : null}
          </h4>
          {hasOutput ? (
            <div className={`command-log-output${failed ? " is-error" : ""}${expanded ? " is-expanded" : ""}`}>
              <div className="command-log-output-scroll" ref={scrollRef}>
                <pre><code>{visibleLines.map((line, index) => (
                  <span className={line.stderr ? "stderr-output" : undefined} key={index}>{line.text}{"\n"}</span>
                ))}</code></pre>
                <CopyButton className="command-log-output-copy" label="复制输出" value={output} />
              </div>
              {hiddenCount > 0 ? (
                <button className="command-log-expand" onClick={() => setExpanded(!expanded)} type="button">
                  {expanded ? "收起输出" : `展开全部输出（还有 ${String(hiddenCount)} 行）`}
                </button>
              ) : null}
              {failed ? <p className="command-log-exit">退出码 {String(command.exitCode)}</p> : null}
            </div>
          ) : (
            <div className="command-log-empty"><span className="command-log-live-dot" />等待输出…</div>
          )}
        </section>
      ) : null}
    </>
  );
}

function WebSearchLog({ view, tool, onOpenExternal }: { view: WebSearchView; tool: TimelineTool; onOpenExternal(url: string): void }): React.JSX.Element {
  const running = tool.status === "running" || tool.status === "waiting";
  const statusText = [...tool.updates].reverse().find((update) => update.text)?.text;
  return (
    <section className="web-search-log">
      <header className="web-search-meta">
        <span className="web-search-query" title={view.query}><Icon name="search" size={12} /><span>{view.query}</span></span>
        {view.providerLabel ? <span className="web-search-provider">{view.providerLabel}</span> : null}
        {running ? (
          <span className="running-label"><span className="mini-spinner" />{statusText ?? "正在搜索网页…"}</span>
        ) : tool.status === "success" ? (
          <span className="web-search-count">{String(view.results.length)} 条结果</span>
        ) : null}
      </header>
      {view.results.length ? (
        <ol className="web-search-results">
          {view.results.map((result) => (
            <li key={result.url}>
              <button className="web-search-result" onClick={() => onOpenExternal(result.url)} title={`在浏览器中打开 ${result.url}`} type="button">
                <ResultFavicon key={result.url} result={result} />
                <span className="web-search-result-main">
                  <span className="web-search-result-heading">
                    <span className="web-search-result-title">{result.title}</span>
                    <span className="web-search-result-domain">{result.domain}</span>
                  </span>
                  {result.snippet ? <span className="web-search-result-snippet">{result.snippet}</span> : null}
                </span>
                <span className="web-search-result-open"><Icon name="external" size={13} /></span>
              </button>
            </li>
          ))}
        </ol>
      ) : tool.status === "success" ? (
        <div className="empty-output">没有找到搜索结果</div>
      ) : null}
    </section>
  );
}

function ResultFavicon({ result }: { result: WebSearchResultView }): React.JSX.Element {
  const [candidateIndex, setCandidateIndex] = useState(0);
  const src = result.faviconCandidates[candidateIndex];
  if (!src) return <span aria-hidden="true" className="web-search-favicon is-fallback">{result.fallbackLetter}</span>;
  return <img alt="" className="web-search-favicon" loading="lazy" onError={() => setCandidateIndex(candidateIndex + 1)} src={src} />;
}

interface DiffInfo {
  files: Array<{ path: string; status: "added" | "deleted" | "modified" | "renamed" }>;
  additions: number;
  deletions: number;
}

function DiffView({ diff, info, onPreviewFile }: { diff: string; info: DiffInfo; onPreviewFile(path: string): void }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const lines = diffLines(diff);
  const visibleLines = showAll ? lines : lines.slice(0, 500);
  return (
    <section className="tool-output-surface diff-surface">
      <header className="tool-output-header diff-header">
        <div className="diff-paths" title={info.files.map((file) => file.path).join(", ")}>
          {info.files.length ? info.files.map((file, index) => (
            <span className="diff-path" key={`${file.status}-${file.path}`}>
              <button onClick={() => onPreviewFile(file.path)} title="在右侧预览" type="button">{file.path}</button>
              {index < info.files.length - 1 ? "," : null}
            </span>
          )) : <span>Diff</span>}
        </div>
        <span className="diff-stats"><span className="diff-add">+{info.additions}</span><span className="diff-delete">-{info.deletions}</span></span>
        <CopyButton label="复制 Diff" value={diff} />
      </header>
      <pre className="diff-code"><code>{visibleLines.map((line, index) => <DiffLine key={`${String(index)}-${line.text.slice(0, 20)}`} line={line} />)}</code></pre>
      {lines.length > visibleLines.length ? <button className="expand-output" onClick={() => setShowAll(true)} type="button">展开全部 {lines.length} 行</button> : null}
    </section>
  );
}

interface DiffLineData {
  text: string;
}

function DiffLine({ line }: { line: DiffLineData }): React.JSX.Element {
  return <span className="diff-line" data-line={diffLineKind(line.text)}>{line.text}{"\n"}</span>;
}

function ToolPayload({ tool, onPreviewFile }: { tool: TimelineTool; onPreviewFile(path: string): void }): React.JSX.Element {
  const progress = tool.updates.filter((update) => update.text).map((update) => update.text).join("\n");
  const display = tool.display;
  if (display?.kind === "file_io") {
    // 操作和路径在折叠行的名称与摘要里已经表达过，这里只补充结果本身；
    // 读文件的内容按扩展名做语法高亮（带行号）。
    const resultPreview = fileToolResult(tool.result);
    if (!resultPreview?.text && resultPreview?.count === undefined) return <></>;
    const path = display.path ?? tool.path;
    return (
      <section className="tool-section">
        {resultPreview.count !== undefined ? (
          <h4 className="tool-section-label">结果<span className="tool-section-meta">{resultPreview.count}</span></h4>
        ) : null}
        {resultPreview.text ? (
          <CodeView code={resultPreview.text} filePath={path} onPreviewFile={path ? onPreviewFile : undefined} />
        ) : null}
      </section>
    );
  }
  // 通用工具按 DSH 的 IN/OUT 卡片展示：IN = pretty 参数、OUT = 结果（或运行中的进度）。
  const input = friendlyResult(tool.args);
  const output = friendlyResult(tool.result) ?? (progress || undefined);
  if (input === undefined && output === undefined) return <></>;
  return (
    <IoCard
      input={input ?? null}
      output={output ?? null}
      outputError={tool.status === "failed" || tool.status === "denied" || tool.status === "unknown" || tool.status === "cancelled"}
    />
  );
}

function commandDetails(tool: TimelineTool): TimelineCommand | undefined {
  if (tool.command) return tool.command;
  const args = typeof tool.args === "object" && tool.args !== null ? tool.args as Record<string, unknown> : undefined;
  const inferredCommand = tool.tool === "Bash" ? stringField(args, "command") : undefined;
  if (tool.display?.kind !== "command" && !inferredCommand) return undefined;
  const result = typeof tool.result === "object" && tool.result !== null ? tool.result as Record<string, unknown> : undefined;
  const processResult = result?.background === true && typeof result.process === "object" && result.process !== null
    ? result.process as Record<string, unknown>
    : undefined;
  const backgroundOutput = processResult
    ? `Background process ${stringField(processResult, "processId") ?? "unknown"} ${stringField(processResult, "state") ?? "started"}`
    : undefined;
  return {
    command: tool.display?.kind === "command" ? tool.display.command : inferredCommand ?? "",
    cwd: tool.display?.kind === "command" ? tool.display.cwd : stringField(args, "cwd"),
    stdout: backgroundOutput ?? stringField(result, "stdout") ?? stringField(result, "output") ?? "",
    stderr: stringField(result, "stderr") ?? "",
    exitCode: numberField(result, "exitCode")
  };
}

function analyzeDiff(diff: string): DiffInfo {
  const files: DiffInfo["files"] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match?.[2]) continue;
    const renamed = match[1] !== match[2];
    files.push({ path: match[2], status: renamed ? "renamed" : "modified" });
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    const blockStart = diff.indexOf(`diff --git a/${file.path}`);
    const nextStart = diff.indexOf("diff --git ", blockStart + 1);
    const block = diff.slice(blockStart, nextStart < 0 ? undefined : nextStart);
    if (block.includes("new file mode")) file.status = "added";
    if (block.includes("deleted file mode")) file.status = "deleted";
  }
  return { files, additions, deletions };
}

function diffLines(diff: string): DiffLineData[] {
  return diff.split("\n").map((text) => ({ text }));
}

function diffLineKind(text: string): "add" | "del" | "hunk" | "meta" | "ctx" {
  if (text.startsWith("+") && !text.startsWith("+++")) return "add";
  if (text.startsWith("-") && !text.startsWith("---")) return "del";
  if (text.startsWith("@@")) return "hunk";
  if (text.startsWith("diff ") || text.startsWith("index ") || text.startsWith("---") || text.startsWith("+++")) return "meta";
  return "ctx";
}

function fileToolResult(value: unknown): { count?: string; text?: string } | undefined {
  if (typeof value !== "object" || value === null) return typeof value === "string" ? { text: value } : undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.matches)) {
    const matches = record.matches;
    const text = matches.slice(0, 200).map((match) => {
      if (typeof match !== "object" || match === null) return String(match);
      const item = match as Record<string, unknown>;
      return [item.path, item.line].filter((part) => typeof part === "string" || typeof part === "number").join(":") + (typeof item.text === "string" ? `  ${item.text}` : "");
    }).join("\n");
    return { count: `${String(matches.length)} 个命中`, text };
  }
  if (Array.isArray(record.files)) {
    return { count: `${String(record.files.length)} 个文件`, text: record.files.slice(0, 300).map(String).join("\n") };
  }
  for (const key of ["content", "output", "message", "summary"]) {
    if (typeof record[key] === "string") return { text: record[key] };
  }
  return undefined;
}

function friendlyResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ["output", "content", "message", "summary", "results"]) {
    const field = record[key];
    if (typeof field === "string") return field;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "无法展示工具结果";
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}
