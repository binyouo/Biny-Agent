import type { DesktopPlanProjection, DesktopRuntimeMutation } from "../../../../protocol.js";
import type { SessionGoalRecord } from "../../../../../runtime/SessionGoalStore.js";
import React, { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../Icon.js";
import { changeSessionGoal, type SessionGoalControl } from "./sessionGoalControl.js";

export function SessionGoalPanel({ sessionId, projection, onMutation, onError }: {
  sessionId: string;
  projection?: DesktopPlanProjection;
  onMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onError(error: unknown): void;
}): React.JSX.Element | null {
  const detailsId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editedGoal = useRef<SessionGoalRecord>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const lifecycle = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const goal = projection?.sessionId === sessionId && projection.goal?.sessionId === sessionId ? projection.goal : undefined;
  if (!goal || goal.status === "completed") return null;
  const labels = { active: "进行中的目标", paused: "已暂停的目标", blocked: "等待处理的目标", budget_limited: "预算已用尽的目标" };
  const change = async (operation: SessionGoalControl): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    try {
      return await changeSessionGoal(goal, operation, onMutation, { pending: setPending, error: setError, report: onError }, lifecycle.current.signal);
    } finally {
      inFlight.current = false;
    }
  };
  const cancelEdit = (): void => {
    editedGoal.current = undefined;
    setEditing(false);
  };
  const saveEdit = async (): Promise<void> => {
    const original = editedGoal.current;
    if (!original || inFlight.current) return;
    // 用量会更新 revision；正文冲突由控制入口核对，写入仍带最新版本。
    if (await change({ operation: "session.goal.set", objective: draft, previousObjective: original.objective })) cancelEdit();
  };
  return <section className="biny-session-goal" aria-label="当前目标" aria-busy={pending}>
    <div className="biny-session-goal-row">
      <Icon name="target-circle" size={15} className={`biny-session-goal-icon${goal.status === "active" ? " is-active" : ""}`} />
      <span className="biny-session-goal-label" role="status">{labels[goal.status]}</span>
      {editing ? <textarea ref={input} className="biny-session-goal-editor" aria-label="编辑目标正文" value={draft} rows={1} maxLength={20_000} disabled={pending}
        onChange={(event) => setDraft(event.target.value)} onBlur={() => void saveEdit()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void saveEdit(); }
        }} /> : <button type="button" className="biny-session-goal-preview" title={goal.evidence?.summary ? `${goal.objective}\n${goal.evidence.summary}` : goal.objective}
        aria-label="查看完整目标" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>{goal.objective}</button>}
      <div className="biny-session-goal-actions">
        {goal.status === "active" ? <button type="button" title="暂停" aria-label="暂停目标" disabled={pending} onMouseDown={(event) => { if (editing) event.preventDefault(); }} onClick={() => void change("session.goal.pause")}><Icon name="pause-outline" size={15} /></button> : null}
        {goal.status === "paused" || goal.status === "blocked" ? <button type="button" title="继续" aria-label="继续目标" disabled={pending} onMouseDown={(event) => { if (editing) event.preventDefault(); }} onClick={() => void change("session.goal.resume")}><Icon name="play-outline" size={15} /></button> : null}
        <button type="button" title={editing ? "取消编辑" : "编辑"} aria-label={editing ? "取消编辑目标" : "编辑目标"} disabled={pending} onMouseDown={(event) => { if (editing) event.preventDefault(); }} onClick={() => {
          if (editing) { cancelEdit(); return; }
          editedGoal.current = goal;
          setDraft(goal.objective);
          setError(undefined);
          setEditing(true);
        }}><Icon name={editing ? "close" : "edit"} size={15} /></button>
        <button type="button" title="删除" aria-label="删除目标" disabled={pending} onMouseDown={(event) => { if (editing) event.preventDefault(); }} onClick={() => void change("session.goal.clear")}><Icon name="trash" size={15} /></button>
      </div>
    </div>
    <div id={detailsId} className="biny-session-goal-details" hidden={!expanded}>
      <p className="biny-session-goal-objective">{goal.objective}</p>
      {goal.evidence?.summary ? <p className="biny-session-goal-evidence">{goal.evidence.summary}</p> : null}
      <div className="biny-session-goal-usage">{goal.usageKnown ? `${goal.tokensUsed.toLocaleString("en-US")}${goal.tokenBudget === undefined ? " tokens" : ` / ${goal.tokenBudget.toLocaleString("en-US")} tokens`}` : "用量不完整"}</div>
    </div>
    {error ? <p className="biny-session-goal-error" role="alert">{error}</p> : null}
  </section>;
}
