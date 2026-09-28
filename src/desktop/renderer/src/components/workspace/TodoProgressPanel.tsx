import React from "react";
import type { DesktopPlanProjection } from "../../../../protocol.js";
import { Icon } from "../Icon.js";

/** 普通任务的 TodoWrite 清单投影；条目只反映 Agent 当前报告的状态。 */
export function TodoProgressPanel({ sessionId, projection }: {
  sessionId: string;
  projection?: DesktopPlanProjection;
}): React.JSX.Element | null {
  const todos = projection?.sessionId === sessionId ? projection.todos ?? [] : [];
  if (todos.length === 0) return null;

  const completed = todos.filter((todo) => todo.status === "completed").length;
  return <section className="biny-todo-progress" aria-label="任务进度">
    <header className="biny-todo-progress-heading">
      <span>进度</span>
      <span className="biny-todo-progress-count" role="status" aria-label={`已完成 ${completed} 项，共 ${todos.length} 项`}>
        {completed}/{todos.length}
      </span>
    </header>
    <ol className="biny-todo-progress-list">
      {todos.map((todo, index) => <li className={`biny-todo-progress-item is-${todo.status}`} key={`${index}:${todo.content}`}
        aria-label={`${todo.status === "completed" ? "已完成" : todo.status === "in_progress" ? "进行中" : "待处理"}：${todo.content}`}>
        <span className="biny-todo-progress-marker" aria-hidden="true">
          {todo.status === "completed" ? <Icon name="check" size={14} />
            : todo.status === "in_progress" ? <Icon className="biny-todo-progress-spinner" name="loader" size={14} />
              : <span />}
        </span>
        <span className="biny-todo-progress-text">{todo.content}</span>
      </li>)}
    </ol>
  </section>;
}
