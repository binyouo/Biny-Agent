/** 只读规划的执行边界：扩展自报 read 不足以授予权限，内部草稿更新单独列出。 */
import type { Tool, ToolSource } from "../tools/types.js";

export function planningToolAllowed(tool: Tool, source: ToolSource): boolean {
  if (source === "subagent") return tool.name === "PlanDraft" || tool.name === "PlanStatus" || tool.name === "TaskStatus";
  return source === "builtin" && (tool.risk === "read" || tool.name === "TodoWrite");
}

/** Host 与 Desktop fallback 使用同一执行入口门禁；查询、取消和用户设置不受影响。 */
export function assertPlanningOperationAllowed(planning: boolean | undefined, operation: string): void {
  if (planning && ["task.start", "task.run", "task.retry", "task.approve", "graph.start", "graph.resume", "automation.create", "automation.resume", "automation.run", "goal.resume", "capability.invoke", "capability.start", "capability.admit"].includes(operation)) {
    throw new Error("Planning mode forbids execution. Start the reviewed draft or leave planning mode first.");
  }
}
