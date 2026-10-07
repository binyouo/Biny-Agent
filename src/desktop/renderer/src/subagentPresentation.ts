import type { TimelineTool } from "./sessionTimeline.js";

export function subagentDisplayName(tool: TimelineTool): string {
  const args = tool.args as { name?: unknown; agent?: unknown } | undefined;
  for (const value of [args?.name, args?.agent]) {
    if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0]!.slice(0, 80);
  }
  return "子代理";
}

const subagentStatusLabels: Record<string, string> = {
  created: "待调度", queued: "排队中", running: "执行中", delegated: "已委派", completed: "已返回", success: "已返回", verifying: "验证中",
  needs_approval: "等待确认", blocked: "受阻", incomplete: "未完成", failed: "失败", denied: "已拒绝",
  policy_denied: "策略拒绝", budget_exhausted: "额度用尽",
  succeeded: "执行成功", not_started: "尚未执行", admitted: "已准入", side_effect_committed: "操作已提交", cancel_requested: "正在停止",
  aborted: "已停止", cancelled: "已停止", timed_out: "已超时", unknown: "状态待确认", waiting: "等待中", skipped: "已跳过"
};

export function subagentStatusLabel(status: unknown): string {
  return typeof status === "string" && Object.hasOwn(subagentStatusLabels, status) ? subagentStatusLabels[status]! : "状态待确认";
}

/** 早期失败结果将部分回答拼在错误后面；展示时分开，不能把回答当作失败原因重复输出。 */
export function subagentFailurePresentation(error: string | undefined): { reason?: string; output?: string } {
  if (!error) return {};
  const incomplete = /^Subagent did not complete \(stopReason=([^)]*)\)\.\s*/.exec(error);
  if (!incomplete) return { reason: error };
  const reasons: Record<string, string> = { step_limit: "达到执行步数上限，子代理未完成任务。", inactivity_timeout: "子代理长时间没有模型输出或工具进度，已停止。", permission_denied: "权限策略拒绝了子代理操作，已停止并交回父代理。", approval_required: "子代理操作需要批准，已停止并交回父代理。", aborted: "子代理执行已停止。", cancelled: "子代理执行已取消。" };
  return { reason: reasons[incomplete[1]!] ?? `子代理未完成任务（${incomplete[1]}）。`, output: error.slice(incomplete[0].length) || undefined };
}
export function subagentTaskRunId(tool: TimelineTool, sessionId?: string): string | undefined {
  const result = tool.result as { taskRunId?: unknown } | undefined;
  const progress = tool.updates.findLast((update) => update.customKind === "subagent" && typeof (update.customData as { taskId?: unknown } | undefined)?.taskId === "string")?.customData as { taskId?: string } | undefined;
  if (typeof result?.taskRunId === "string" && result.taskRunId) return result.taskRunId;
  if (progress?.taskId) return progress.taskId;
  if (!sessionId || tool.tool !== "Task" || !tool.id || tool.id.startsWith("history-tool-")) return undefined;
  const prefix = `agent-task:${sessionId}:`;
  // 仅恢复真实调用的确定性查询身份；存在性、会话归属和 Attempt 准入仍由后端验证。
  if (tool.id.startsWith("agent-task:")) return tool.id.startsWith(prefix) ? tool.id : undefined;
  return `${prefix}${tool.id}`;
}

/** 颜色跟随执行身份，重命名、翻页与状态刷新均不重新分配。 */
export function subagentColor(identity: string): string {
  const colors = ["teal", "purple", "amber", "green", "rose", "blue"];
  let hash = 0;
  for (const character of identity) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return colors[hash % colors.length]!;
}
