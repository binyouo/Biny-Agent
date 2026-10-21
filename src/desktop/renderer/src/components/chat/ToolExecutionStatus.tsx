import React from "react";
import type { TimelineToolStatus } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";

const labels: Record<TimelineToolStatus, string> = {
  success: "Success", running: "运行中", waiting: "等待中", failed: "失败", denied: "已拒绝",
  aborted: "已中止", cancelled: "已取消", skipped: "已跳过", unknown: "结果未知"
};

export function ToolExecutionStatus({ status, compact = false }: { status: TimelineToolStatus; compact?: boolean }): React.JSX.Element {
  return <span className={`tool-execution-status${compact ? " is-compact" : ""}`} data-status={status} aria-label={labels[status]} title={labels[status]}>
    <Icon name={status === "success" ? "circle-check" : status === "running" || status === "waiting" ? "timer" : "circle-close"} size={12} />
    {!compact ? labels[status] : null}
  </span>;
}
