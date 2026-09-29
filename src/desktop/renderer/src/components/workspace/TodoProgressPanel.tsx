import React from "react";
import type { DesktopPlanProjection } from "../../../../protocol.js";
import { Icon } from "../Icon.js";

/** 普通任务的 TodoWrite 清单投影；条目只反映 Agent 当前报告的状态。 */
export function TodoProgressPanel({ sessionId, projection, running = false }: {
  sessionId: string;
  projection?: DesktopPlanProjection;
  running?: boolean;
}): React.JSX.Element | null {
  const todos = projection?.sessionId === sessionId ? projection.todos ?? [] : [];
  if (todos.length === 0) return null;

  const completed = todos.filter((todo) => todo.status === "completed").length;
  const allCompleted = completed === todos.length;
  const current = todos.find((todo) => todo.status === "in_progress");
  // 原生展开状态不随同一清单的流式更新重置；清单替换或全部完成才采用新的默认值。
  return <details key={`${sessionId}:${JSON.stringify(todos.map((todo) => todo.content))}`} className="biny-todo-progress" aria-label="任务进度" open={!allCompleted}>
    <summary className="biny-todo-progress-heading">
      <Icon name="chevron" size={14} />
      <span className="biny-todo-progress-summary">{allCompleted ? "任务已完成" : current?.content ?? "任务进度"}</span>
      <span className="biny-todo-progress-count" role="status" aria-label={`已完成 ${completed} 项，共 ${todos.length} 项`}>
        {completed}/{todos.length}
      </span>
    </summary>
    <ol className="biny-todo-progress-list">
      {todos.map((todo, index) => <li className={`biny-todo-progress-item is-${todo.status}`} key={`${index}:${todo.content}`}
        aria-label={`${todo.status === "completed" ? "已完成" : todo.status === "in_progress" ? "进行中" : "待处理"}：${todo.content}`}>
        <span className="biny-todo-progress-marker" aria-hidden="true">
          {todo.status === "completed" ? <Icon name="check" size={14} />
            : todo.status === "in_progress" && running ? <Icon className="biny-todo-progress-spinner" name="loader" size={14} />
              : <span />}
        </span>
        <span className="biny-todo-progress-text">{todo.content}</span>
      </li>)}
    </ol>
  </details>;
}
