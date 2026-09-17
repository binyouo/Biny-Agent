/**
 * 设置事务处于 recovery_required 时仍允许取消、暂停和失败收尾，但拒绝任何会创建、恢复或
 * 推进工作的 Runtime mutation。集中维护这份分类，避免新增 operation 时只在某个 UI 入口补门禁。
 */
import type { DesktopRuntimeMutation } from "../../protocol.js";

const startsWork: Record<DesktopRuntimeMutation, boolean> = {
  "plan.mode": false,
  "plan.start": true,
  "task.create": true,
  "task.start": true,
  "task.run": true,
  "task.cancel": false,
  "task.approve": true,
  "task.resume": true,
  "task.retry": true,
  "automation.create": true,
  "automation.pause": false,
  "automation.resume": true,
  "automation.run": true,
  "automation.delete": false,
  "goal.create": true,
  "goal.pause": false,
  "goal.resume": true,
  "goal.cancel": false,
  "graph.create": true,
  "graph.start": true,
  "graph.pause": false,
  "graph.resume": true,
  "graph.cancel": false,
  "capability.register": false,
  "capability.replace": false,
  "capability.admit": false,
  "capability.reject": false,
  "capability.release": false,
  "capability.invoke": true,
  "capability.accept": true,
  "capability.start": true,
  "capability.result": true,
  "capability.chunk": true,
  "capability.fail": false,
  "capability.cancel": false,
  "worktree.merge": false,
  "worktree.remove": false
};

export function runtimeMutationStartsWork(operation: DesktopRuntimeMutation): boolean {
  return startsWork[operation];
}
