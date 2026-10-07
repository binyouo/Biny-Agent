import React from "react";
import type { PermissionResult } from "../../../../../permission/PermissionManager.js";
import type { TimelineTool } from "../../sessionTimeline.js";
import { ToolPermission } from "../ToolActivity.js";
import { subagentTaskRunId, subagentDisplayName } from "../../subagentPresentation.js";
import { TaskInspector } from "./TaskInspector.js";

export function SubagentActivity({ tool, projectId, sessionId, readOnly = false, onResolvePermission, onPreviewFile, onOpenExternal }: {
  tool: TimelineTool; projectId: string; sessionId?: string; readOnly?: boolean;
  onPreviewFile(path: string): void; onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const taskRunId = subagentTaskRunId(tool, sessionId);
  const result = tool.result as { status?: unknown } | undefined;
  const progress = tool.updates.findLast(update => update.customKind === "subagent")?.customData as { status?: unknown } | undefined;
  const background = (tool.args as { background?: unknown } | undefined)?.background === true;
  const status = tool.permission && !tool.permission.resolved ? "needs_approval"
    : progress?.status ?? (background && tool.status === "success" ? "delegated" : result?.status ?? tool.status);
  return <div className="subagent-entry"><TaskInspector key={`${projectId}:${sessionId}:${taskRunId ?? tool.id}`} selection={{ projectId, sessionId, taskRunId, name: subagentDisplayName(tool), tool }}
    initialStatus={status} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
    {!readOnly && tool.permission && !tool.permission.resolved ? <ToolPermission tool={tool} onResolvePermission={onResolvePermission} /> : null}
  </div>;
}
