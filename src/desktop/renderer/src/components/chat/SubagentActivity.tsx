import React, { useEffect, useState } from "react";
import { TaskInspector } from "./TaskInspector.js";
import type { PermissionResult } from "../../../../../permission/PermissionManager.js";
import type { TimelineTool } from "../../sessionTimeline.js";
import { formatDuration } from "../../chatModel.js";
import { Icon } from "../Icon.js";
import { ToolActivityDetail, ToolPermission } from "../ToolActivity.js";

const statusLabels: Record<string, string> = {
  queued: "排队中", running: "执行中", delegated: "已委派", completed: "已返回", success: "已返回", verifying: "验证中",
  needs_approval: "等待确认", blocked: "受阻", incomplete: "未完成", failed: "失败", denied: "已拒绝",
  aborted: "已停止", cancelled: "已停止", timed_out: "已超时", unknown: "状态待确认", waiting: "等待中", skipped: "已跳过"
};

export function SubagentActivity({ tool, projectId, sessionId, readOnly = false, onPreviewFile, onOpenExternal, onResolvePermission }: {
  tool: TimelineTool;
  projectId: string;
  sessionId?: string;
  readOnly?: boolean;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const args = tool.args as { task?: unknown; agent?: unknown; background?: unknown } | undefined;
  const result = tool.result as { status?: unknown } | undefined;
  const latest = tool.updates.findLast((update) => update.customKind === "subagent")?.customData as { status?: unknown } | undefined;
  const progress = latest;
  const [expanded, setExpanded] = useState(false);
  const [liveStatus, setLiveStatus] = useState<string>();
  const taskRunId = (tool.result as { taskRunId?: string } | undefined)?.taskRunId
    ?? (latest as { taskId?: string } | undefined)?.taskId;
  useEffect(() => {
    if (expanded || !sessionId || !taskRunId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const state = await window.biny.taskInspection(projectId, sessionId, taskRunId, { summary: true });
        if (stopped) return;
        setLiveStatus(state.status);
        if (["created", "queued", "running", "verifying", "needs_approval", "blocked"].includes(state.status)) timer = setTimeout(() => void refresh(), 2000);
      } catch { /* 详情展开后显示读取错误并提供重试。 */ }
    };
    void refresh();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [projectId, sessionId, taskRunId, expanded]);
  const backgroundStarted = tool.status === "success" && args?.background === true
    && typeof result?.status === "string" && ["created", "queued", "running", "verifying"].includes(result.status);
  const status = liveStatus ?? (tool.permission && !tool.permission.resolved ? "needs_approval"
    : backgroundStarted ? "delegated"
      : tool.status === "success" ? result?.status ?? "completed"
      : tool.status === "running" ? progress?.status ?? "running" : tool.status);
  const label = typeof status === "string" && Object.hasOwn(statusLabels, status) ? statusLabels[status] : "状态待确认";
  return <section className="chat-subagent" aria-label="子代理任务">
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="chat-subagent-summary">
        <Icon name="person" size={16} />
        <span className="chat-subagent-name">{typeof args?.agent === "string" && args.agent || "子代理"}</span>
        <span className="chat-subagent-task">{typeof args?.task === "string" && args.task || "委派任务"}</span>
        <span className="chat-subagent-status" role="status">{label}</span>
        {tool.durationMs !== undefined ? <span className="chat-subagent-duration">{formatDuration(tool.durationMs)}</span> : null}
        <Icon name="chevron" size={14} />
      </summary>
      {expanded && taskRunId && sessionId ? <TaskInspector projectId={projectId} sessionId={sessionId} taskRunId={taskRunId} readOnly={readOnly} onStatus={setLiveStatus} /> : null}
      <div className="chat-subagent-detail">
        <ToolActivityDetail tool={tool} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
      </div>
    </details>
    <ToolPermission tool={tool} onResolvePermission={onResolvePermission} />
  </section>;
}
