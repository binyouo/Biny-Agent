import React, { useEffect, useRef, useState } from "react";
import type { TaskInspection, WorkerActivity } from "../../../../../runtime/TaskCommunication.js";

export function TaskInspector({ projectId, sessionId, taskRunId: originalTaskRunId, readOnly = false, onStatus }: {
  projectId: string; sessionId: string; taskRunId: string; readOnly?: boolean;
  onStatus?(status: string): void;
}): React.JSX.Element {
  const [taskRunId, setTaskRunId] = useState(originalTaskRunId);
  const [inspection, setInspection] = useState<TaskInspection>();
  const [activity, setActivity] = useState<WorkerActivity[]>([]);
  const [attemptId, setAttemptId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const onStatusRef = useRef(onStatus);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);
  const cursorRef = useRef(0);
  const generation = useRef(0);
  const requestIdentity = useRef<{ text: string; id: string; operation: string } | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [pageStarts, setPageStarts] = useState<number[]>([0]);
  const pageStart = pageStarts.at(-1) ?? 0;
  useEffect(() => { setTaskRunId(originalTaskRunId); setAttemptId(undefined); setPageStarts([0]); }, [originalTaskRunId]);
  useEffect(() => {
    const current = ++generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    cursorRef.current = 0;
    setInspection(undefined); setActivity([]); setError(undefined); setBusy(false);
    const load = async (): Promise<void> => {
      try {
        const next = await window.biny.taskInspection(projectId, sessionId, taskRunId, { attemptId, afterSequence: pageStart, limit: 100 });
        if (stopped) return;
        // A retry creates a new Worker Session; its cursor cannot reuse the old attempt.
        if (inspectionAttempt !== undefined && inspectionAttempt !== next.attemptId) { cursorRef.current = 0; setActivity([]); inspectionAttempt = next.attemptId; if (pageStart !== 0) { setPageStarts([0]); return; } }
        inspectionAttempt = next.attemptId;
        cursorRef.current = next.cursor;
        setInspection(next); setHasMore(next.hasMore); setError(undefined);
        setActivity(next.activity);
        if (taskRunId === originalTaskRunId) onStatusRef.current?.(next.status);
        if (["created", "queued", "running", "verifying", "needs_approval", "blocked"].includes(next.status)) timer = setTimeout(() => void load(), 1000);
      } catch (failure) { if (!stopped) setError(failure instanceof Error ? failure.message : "任务详情读取失败。"); }
    };
    let inspectionAttempt: string | undefined;
    void load();
    return () => { stopped = true; if (timer) clearTimeout(timer); if (generation.current === current) generation.current += 1; };
  }, [projectId, sessionId, taskRunId, originalTaskRunId, attemptId, refresh, pageStart]);
  const act = async (operation: "task.message" | "task.continue" | "task.cancel" | "task.resume" | "task.approve"): Promise<void> => {
    if (busy) return;
    const current = generation.current;
    const text = message.trim();
    if (!requestIdentity.current || requestIdentity.current.text !== text || requestIdentity.current.operation !== operation) requestIdentity.current = { text, operation, id: crypto.randomUUID() };
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await window.biny.runtimeMutation(projectId, operation, { sessionId, taskRunId, message: text, messageId: requestIdentity.current.id, approvalId: inspection?.approval?.approvalId });
      if (generation.current !== current) return;
      setMessage(""); requestIdentity.current = undefined;
      setNotice(operation === "task.message" ? "消息已持久化，子代理会在下一步接收。" : operation === "task.continue" ? `已创建后续任务：${(result as { taskRunId?: string })?.taskRunId ?? "请在后台任务中查看"}` : operation === "task.cancel" ? "已请求取消，正在释放执行资源。" : "已提交恢复请求。");
      if (operation === "task.continue" && typeof (result as { taskRunId?: unknown })?.taskRunId === "string") {
        setAttemptId(undefined); setPageStarts([0]); setTaskRunId((result as { taskRunId: string }).taskRunId);
      } else setRefresh((value) => value + 1);
    } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : "操作失败，可重试。"); }
    finally { if (generation.current === current) setBusy(false); }
  };
  return <div className="chat-task-inspector">
    {taskRunId !== originalTaskRunId ? <button type="button" disabled={busy} onClick={() => { setAttemptId(undefined); setPageStarts([0]); setTaskRunId(originalTaskRunId); }}>返回原任务</button> : null}
    <button type="button" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>刷新记录</button>
    {error ? <p role="alert">{error} <button type="button" onClick={() => setRefresh((value) => value + 1)}>重新读取</button></p> : null}
    {!inspection && !error ? <p role="status">正在读取子代理记录…</p> : null}
    {inspection ? <>
      <label>执行记录 <select aria-label="选择子代理执行记录" value={attemptId ?? "current"} onChange={(event) => { setPageStarts([0]); setAttemptId(event.target.value === "current" ? undefined : event.target.value); }}>
        <option value="current">当前执行</option>{inspection.attempts.map((attempt, index) => <option key={attempt.attemptId} value={attempt.attemptId}>第 {index + 1} 次 · {attempt.status}</option>)}
      </select></label>
      <TaskInspectionView inspection={inspection} activity={activity} />
      {pageStarts.length > 1 ? <button type="button" onClick={() => setPageStarts((pages) => pages.slice(0, -1))}>上一页活动</button> : null}
      {hasMore ? <button type="button" onClick={() => setPageStarts((pages) => [...pages, cursorRef.current])}>下一页活动</button> : null}
      {!readOnly && attemptId === undefined ? <div className="chat-task-controls">
        {inspection.inputOpen || inspection.status === "completed" ? <>
          <label>给子代理的消息<textarea aria-label="给子代理的消息" value={message} maxLength={8000} disabled={busy} onChange={(event) => setMessage(event.target.value)} placeholder={inspection.inputOpen ? "补充上下文或纠正任务方向" : "描述新的有限任务"} /></label>
          <button type="button" disabled={busy || !message.trim()} onClick={() => void act(inspection.inputOpen ? "task.message" : "task.continue")}>{inspection.inputOpen ? "发送消息" : "创建后续任务"}</button>
        </> : <p>当前执行不接收新消息。中断任务请从后台任务恢复；已有副作用不会自动重放。</p>}
        {inspection.resumable ? <button type="button" disabled={busy} onClick={() => void act("task.resume")}>恢复执行</button> : null}
        {inspection.approval ? <div><p>验收命令需要批准：{inspection.approval.cwd ?? "."}</p><pre>{inspection.approval.command}</pre><p>{inspection.approval.reason}</p><button type="button" disabled={busy} onClick={() => void act("task.approve")}>批准并继续验收</button></div> : null}
        {["created", "queued", "running", "verifying"].includes(inspection.status) ? <button type="button" disabled={busy} onClick={() => void act("task.cancel")}>取消任务</button> : null}
      </div> : null}
    </> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}

export function TaskInspectionView({ inspection, activity }: { inspection: TaskInspection; activity: WorkerActivity[] }): React.JSX.Element {
  return <>
    <p>{inspection.title}</p>
    <p role="status">任务状态：{inspection.status}</p>
    {inspection.reason ? <p>{inspection.reason}</p> : null}
    {inspection.messages.length ? <ol aria-label="父子代理消息">{inspection.messages.map((message) => <li key={message.id}>
      <strong>{message.direction === "parent" ? "父代理 → 子代理" : "子代理 → 父代理"}</strong>
      <span> · {message.delivered ? "已接收" : "已持久化"}</span><p>{message.content}</p>
    </li>)}</ol> : <p>暂无父子代理消息。</p>}
    {activity.length ? <ol className="chat-subagent-trail" aria-label="子代理活动">{activity.map((entry) => <li key={entry.id}>
      <details><summary>{entry.tool ?? ({ assistant: "回答", reasoning: "思考", completion: "执行结束" }[entry.kind as "assistant" | "reasoning" | "completion"] ?? "执行事件")} {entry.status}</summary>
        {entry.toolCallId ? <small>调用 {entry.toolCallId}</small> : null}
        {entry.content ? <p>{entry.content}</p> : null}
        {entry.args !== undefined ? <pre>{JSON.stringify(entry.args, null, 2)}</pre> : null}
        {entry.result !== undefined ? <pre>{JSON.stringify(entry.result, null, 2)}</pre> : null}
      </details>
    </li>)}</ol> : <p>暂无执行活动。</p>}
    {inspection.output ? <details open><summary>子代理报告</summary><pre>{inspection.output}</pre>{inspection.outputTruncated ? <p>报告过长，当前显示前 16000 个字符。</p> : null}</details> : null}
    {inspection.verification !== undefined ? <details><summary>验收证据</summary><pre>{JSON.stringify(inspection.verification, null, 2)}</pre></details> : null}
  </>;
}
