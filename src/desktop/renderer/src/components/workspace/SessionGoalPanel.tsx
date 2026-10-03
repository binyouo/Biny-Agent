import type { DesktopPlanProjection, DesktopRuntimeMutation } from "../../../../protocol.js";
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon.js";
import { changeSessionGoal, type SessionGoalControl } from "./sessionGoalControl.js";

export function SessionGoalPanel({ sessionId, projection, onMutation, onError }: {
  sessionId: string;
  projection?: DesktopPlanProjection;
  onMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onError(error: unknown): void;
}): React.JSX.Element | null {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const lifecycle = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, []);
  const goal = projection?.sessionId === sessionId && projection.goal?.sessionId === sessionId ? projection.goal : undefined;
  if (!goal) return null;
  const labels = { active: "持续执行中", paused: "已暂停", blocked: "等待处理", budget_limited: "预算已用尽", completed: "已完成" };
  const change = async (operation: SessionGoalControl): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await changeSessionGoal(goal, operation, onMutation, { pending: setPending, error: setError, report: onError }, lifecycle.current.signal);
    } finally {
      inFlight.current = false;
    }
  };
  return <section className="biny-session-goal" aria-label="当前目标" aria-busy={pending}>
    <details>
      <summary aria-label={`目标，${labels[goal.status]}`} title={`目标：${labels[goal.status]}`}><Icon name="target" size={18} /><span>目标</span></summary>
      <div className="biny-session-goal-details">
        <span role="status">{labels[goal.status]}</span>
        <p className="biny-session-goal-objective">{goal.objective}</p>
        {goal.evidence?.summary ? <p className="biny-session-goal-evidence">{goal.evidence.summary}</p> : null}
        <div className="biny-session-goal-usage">{goal.usageKnown ? `${goal.tokensUsed.toLocaleString("en-US")}${goal.tokenBudget === undefined ? " tokens" : ` / ${goal.tokenBudget.toLocaleString("en-US")} tokens`}` : "用量不完整"}</div>
        <div className="biny-session-goal-actions">
          {goal.status === "active" ? <button type="button" disabled={pending} onClick={() => void change("session.goal.pause")}>暂停</button> : null}
          {goal.status === "paused" || goal.status === "blocked" ? <button type="button" disabled={pending} onClick={() => void change("session.goal.resume")}>恢复</button> : null}
          <button type="button" disabled={pending} onClick={() => void change("session.goal.clear")}>清除</button>
        </div>
      </div>
    </details>
    {error ? <p className="biny-session-goal-error" role="alert">{error}</p> : null}
  </section>;
}
