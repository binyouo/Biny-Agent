import React, { memo, useId, useRef, useState } from "react";
import type { PermissionResult } from "../../../../../permission/PermissionManager.js";
import { activityToolRow, formatDuration } from "../../chatModel.js";
import type { TimelineTool } from "../../sessionTimeline.js";
import { Collapse } from "../Collapse.js";
import { Icon } from "../Icon.js";
import { ToolActivityDetail, ToolPermission } from "../ToolActivity.js";
import { ToolExecutionStatus } from "./ToolExecutionStatus.js";

export interface ToolCallCardProps {
  tool: TimelineTool;
  open?: boolean;
  onToggle?(): void;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission?(requestId: string, result: PermissionResult): Promise<void>;
}

export const ToolCallCard = memo(function ToolCallCard({ tool, open: controlledOpen, onToggle, projectId, onPreviewFile, onOpenExternal, onResolvePermission }: ToolCallCardProps): React.JSX.Element {
  const row = activityToolRow(tool);
  const script = tool.tool === "run_script" || tool.tool === "exec";
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const toggle = (): void => { if (onToggle) onToggle(); else setLocalOpen(current => !current); };
  const detailId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  return <div data-activity-anchor="" data-tool-call-id={tool.id} className={`chat-tool-row-wrap${tool.permission ? " has-permission" : ""}`} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.stopPropagation(); toggle(); buttonRef.current?.focus(); }
  }}>
    <button type="button" className={`chat-tool-row${open ? " is-open" : ""}`} data-activity-toggle="" ref={buttonRef} aria-expanded={open} aria-controls={detailId} onClick={toggle} title={`${tool.tool} · ${tool.id}`}>
      <span className="chat-tool-icon"><Icon name={script || tool.tool === "Bash" ? "terminal" : ["Read", "Write", "Edit", "apply_patch"].includes(tool.tool) ? "file" : "wrench"} size={16} /></span>
      <span className="chat-tool-row-verb">{script ? "执行" : row.verb}</span>
      <span className="chat-tool-row-object" title={script ? row.verb : row.object}>{script ? row.verb : row.object}</span>
      {row.plus !== undefined && row.plus > 0 ? <span className="chat-tool-row-diff is-add">+{row.plus}</span> : null}
      {row.minus !== undefined && row.minus > 0 ? <span className="chat-tool-row-diff is-del">-{row.minus}</span> : null}
      <ToolExecutionStatus status={tool.status} compact />
      {tool.durationMs !== undefined ? <span className="chat-tool-row-duration" title="耗时"><Icon name="timer" size={12} />{tool.durationMs < 1000 ? `${tool.durationMs}ms` : formatDuration(tool.durationMs)}</span> : null}
      <span className="chat-tool-row-chevron"><Icon name="chevron" size={14} /></span>
    </button>
    <Collapse className="chat-tool-row-collapse" open={open}>
      <div className="chat-tool-row-detail" id={detailId}>{open ? <ToolActivityDetail tool={tool} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} /> : null}</div>
    </Collapse>
    {onResolvePermission ? <>
      <ToolPermission tool={tool} onResolvePermission={onResolvePermission} />
      {tool.children?.map(child => <ToolPermission key={child.id} tool={child} onResolvePermission={onResolvePermission} />)}
    </> : null}
  </div>;
});
