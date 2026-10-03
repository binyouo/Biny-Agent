import React from "react";
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

export function SubagentActivity({ tool, projectId, onPreviewFile, onOpenExternal, onResolvePermission }: {
  tool: TimelineTool;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const args = tool.args as { task?: unknown; agent?: unknown; background?: unknown } | undefined;
  const result = tool.result as { status?: unknown } | undefined;
  const progress = tool.updates.findLast((update) => update.customKind === "subagent")?.customData as { status?: unknown } | undefined;
  const backgroundStarted = tool.status === "success" && args?.background === true
    && typeof result?.status === "string" && ["created", "queued", "running", "verifying"].includes(result.status);
  const status = tool.permission && !tool.permission.resolved ? "needs_approval"
    : backgroundStarted ? "delegated"
      : tool.status === "success" ? result?.status ?? "completed"
      : tool.status === "running" ? progress?.status ?? "running" : tool.status;
  const label = typeof status === "string" && Object.hasOwn(statusLabels, status) ? statusLabels[status] : "状态待确认";
  return <section className="chat-subagent" aria-label="子代理任务">
    <details>
      <summary className="chat-subagent-summary">
        <Icon name="person" size={16} />
        <span className="chat-subagent-name">{typeof args?.agent === "string" && args.agent || "子代理"}</span>
        <span className="chat-subagent-task">{typeof args?.task === "string" && args.task || "委派任务"}</span>
        <span className="chat-subagent-status" role="status">{label}</span>
        {tool.durationMs !== undefined ? <span className="chat-subagent-duration">{formatDuration(tool.durationMs)}</span> : null}
        <Icon name="chevron" size={14} />
      </summary>
      <div className="chat-subagent-detail">
        <ToolActivityDetail tool={tool} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
      </div>
    </details>
    <ToolPermission tool={tool} onResolvePermission={onResolvePermission} />
  </section>;
}
