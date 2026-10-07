import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TaskInspection, WorkerActivity } from "../../../../../runtime/TaskCommunication.js";
import type { TimelineTool } from "../../sessionTimeline.js";
import { buildSubagentTimeline } from "../../subagentTimeline.js";
import { subagentColor, subagentFailurePresentation, subagentStatusLabel } from "../../subagentPresentation.js";
import { ExecutionTimeline } from "../MessageTimeline.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { Icon } from "../Icon.js";

interface Selection { projectId: string; sessionId?: string; taskRunId?: string; name: string; tool?: TimelineTool }
const activeStatuses = new Set(["created", "queued", "running", "verifying", "needs_approval", "blocked", "delegated", "waiting"]);

/** 卡片只读取所属执行记录；展开读取正文，收起仅刷新状态，不向父会话注入内容。 */
export function TaskInspector({ selection, initialStatus = "running", onPreviewFile, onOpenExternal }: {
  selection: Selection; initialStatus?: unknown;
  onPreviewFile(path: string): void; onOpenExternal(url: string): void;
}): React.JSX.Element {
  const { projectId, sessionId, taskRunId, name, tool } = selection;
  const admitted = !tool || (!["running", "waiting"].includes(tool.status) && !(tool.permission && !tool.permission.resolved))
    || tool.updates.some(update => update.customKind === "subagent" && typeof (update.customData as { taskId?: unknown } | undefined)?.taskId === "string")
    || typeof (tool.result as { taskRunId?: unknown } | undefined)?.taskRunId === "string";
  const identity = `${projectId}:${sessionId}:${taskRunId}`;
  const [open, setOpen] = useState(true);
  const [attemptId, setAttemptId] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ identity: string; inspection: TaskInspection; activity: WorkerActivity[] }>();
  const [error, setError] = useState<string>();
  const cache = useRef<{ identity: string; selected?: string; attempt?: string; cursor: number; activity: WorkerActivity[] }>({ identity, cursor: 0, activity: [] });
  const inspection = state?.identity === identity ? state.inspection : undefined;
  const activity = useMemo(() => state?.identity === identity ? state.activity : [], [state, identity]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (cache.current.identity !== identity || cache.current.selected !== attemptId) {
      cache.current = { identity, selected: attemptId, cursor: 0, activity: [] };
      setState(undefined);
    }
    setError(undefined);
    if (!sessionId || !taskRunId || !admitted) return;
    const load = async (): Promise<void> => {
      try {
        const current = cache.current;
        const next = await window.biny.taskInspection(projectId, sessionId, taskRunId, {
          attemptId, afterSequence: open ? current.cursor : 0, limit: 100, summary: !open
        });
        if (stopped) return;
        if (current.attempt !== next.attemptId && current.attempt !== undefined) {
          const hadCursor = current.cursor > 0;
          current.cursor = 0; current.activity = []; current.attempt = next.attemptId;
          setState({ identity, inspection: next, activity: [] });
          if (open && hadCursor) { timer = setTimeout(() => void load(), 16); return; }
        }
        current.attempt = next.attemptId;
        if (open) {
          if (next.hasMore && next.cursor <= current.cursor) throw new Error("执行记录游标未前进，请重试读取。");
          const existing = new Set(current.activity.map(entry => entry.id));
          current.activity = [...current.activity, ...next.activity.filter(entry => !existing.has(entry.id))];
          current.cursor = next.cursor;
        }
        setState({ identity, inspection: next, activity: current.activity });
        setError(undefined);
        const selected = next.attempts.find(attempt => attempt.attemptId === next.attemptId);
        if (open && next.hasMore) timer = setTimeout(() => void load(), 16);
        else if (activeStatuses.has(selected?.status ?? next.status)) timer = setTimeout(() => void load(), open ? 1000 : 2500);
      } catch (failure) { if (!stopped) setError(failure instanceof Error ? failure.message : "子代理记录读取失败。"); }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [identity, projectId, sessionId, taskRunId, attemptId, open, retry, admitted]);

  const selected = inspection?.attempts.find(attempt => attempt.attemptId === inspection.attemptId);
  const status = selected?.status ?? inspection?.status ?? initialStatus;
  const running = typeof status === "string" && activeStatuses.has(status);
  const stoppedLabels: Record<string, string> = { step_limit: "步数用尽", permission_denied: "权限受阻", approval_required: "待父代理处理授权", inactivity_timeout: "无响应" };
  const statusLabel = status === "completed" ? "已完成" : inspection?.stopReason && stoppedLabels[inspection.stopReason]
    ? `已停止 · ${stoppedLabels[inspection.stopReason]}` : subagentStatusLabel(status);
  const model = activity.findLast(entry => entry.model)?.model;
  const workerName = inspection?.name ?? name;
  const rawDescription = inspection?.description ?? (tool?.args as { description?: unknown } | undefined)?.description;
  const description = typeof rawDescription === "string" ? rawDescription.replace(/\s+/gu, " ").trim().slice(0, 120) : "";
  const title = description || (workerName === "子代理" ? workerName : `子代理 · ${workerName}`);
  const recorded = typeof tool?.result === "string" ? tool.result : (tool?.result as { output?: string; error?: string } | undefined)?.output;
  const recordedError = tool?.error ?? (tool?.result as { error?: string } | undefined)?.error;
  const failure = subagentFailurePresentation(inspection?.reason ?? recordedError);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    const body = content.current;
    if (!open || !viewport || !body) return;
    const follow = (): void => { if (following.current) viewport.scrollTop = viewport.scrollHeight; };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(body);
    return () => observer.disconnect();
  }, [open, activity, inspection]);
  const bodyId = useId();
  return <details className="subagent-card" data-agent-color={subagentColor(taskRunId ?? tool?.id ?? name)} open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="subagent-card-header" aria-label={`${title} · ${statusLabel}`} aria-controls={bodyId} aria-expanded={open}>
      <span className="subagent-avatar"><Icon name="person" size={15} /></span>
      <strong title={title}>{title}</strong>
      <Icon name="chevron" size={13} />
      {description && workerName !== "子代理" && workerName !== description ? <span className="subagent-name" title={workerName}>{workerName}</span> : null}
      <span className={`subagent-card-status${running ? " is-running" : ""}`} role="status">{statusLabel}</span>
      <span className="subagent-model" title={model ? `${model.provider} / ${model.id}` : undefined}>{model?.id ?? (inspection?.hasMore || !inspection && !error && sessionId && taskRunId ? "正在读取模型…" : running ? "等待模型信息" : "模型未记录")}</span>
    </summary>
    {open ? <div className="subagent-card-body" id={bodyId}>
      {inspection && inspection.attempts.length > 1 ? <div className="subagent-card-toolbar"><select aria-label="选择子代理执行记录" value={attemptId ?? "current"} onChange={event => { following.current = true; setBehind(false); setAttemptId(event.target.value === "current" ? undefined : event.target.value); }}>
        <option value="current">当前执行</option>{inspection.attempts.map((attempt, index) => <option key={attempt.attemptId} value={attempt.attemptId}>第 {index + 1} 次 · {subagentStatusLabel(attempt.status)}</option>)}
      </select></div> : null}
      {error ? <div className="subagent-card-notice" role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></div> : null}
      {failure.reason ? <div className="subagent-card-outcome">{failure.reason}</div> : null}
      <div className="subagent-card-scroll" ref={scroll} onScroll={event => {
        const viewport = event.currentTarget;
        following.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
        setBehind(!following.current);
      }}><div ref={content}>
        {inspection ? <TaskInspectionView inspection={inspection} activity={activity} projectId={projectId} recordedOutput={recorded} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
          : (recorded ?? failure.output) ? <MarkdownContent content={recorded ?? failure.output ?? ""} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
            : <p className="subagent-card-empty">{error ? "暂时无法读取执行记录。" : !sessionId || !taskRunId ? "此历史记录没有可关联的执行身份。" : !admitted ? "等待子代理启动…" : "正在读取子代理记录…"}</p>}
      </div></div>
      {behind ? <button type="button" className="subagent-card-latest" onClick={() => { following.current = true; setBehind(false); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}><Icon name="arrow-down" size={14} />回到最新</button> : null}
    </div> : null}
  </details>;
}

export function TaskInspectionView({ inspection, activity, projectId = "", recordedOutput, onPreviewFile = () => {}, onOpenExternal = () => {} }: {
  inspection: TaskInspection; activity: WorkerActivity[]; projectId?: string; recordedOutput?: string;
  onPreviewFile?(path: string): void; onOpenExternal?(url: string): void;
}): React.JSX.Element {
  const turns = useMemo(() => buildSubagentTimeline(inspection, activity, recordedOutput), [inspection, activity, recordedOutput]);
  const steps = turns.flatMap(turn => turn.steps).filter(step => step.kind !== "user");
  return <div className="subagent-transcript">
    {steps.length ? <ExecutionTimeline readOnly projectId={projectId} running={activeStatuses.has(inspection.attempts.find(attempt => attempt.attemptId === inspection.attemptId)?.status ?? inspection.status)} keepActivitiesOpen steps={steps}
      onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} onResolvePermission={async () => {}} />
      : <p className="subagent-card-empty">{activeStatuses.has(inspection.status) ? "等待子代理输出…" : "没有执行正文。"}</p>}
    {inspection.messages.length ? <details className="subagent-messages"><summary>父子代理消息 · {inspection.messages.length}</summary><ol>{inspection.messages.map(message => <li key={message.id}>
      <small>{message.direction === "parent" ? "父代理 → 子代理" : "子代理 → 父代理"} · {message.delivered ? "已接收" : "已持久化"}</small><MarkdownContent content={message.content} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
    </li>)}</ol></details> : null}
  </div>;
}
