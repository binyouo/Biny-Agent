/** 从 Host 节点推导当前任务分组，不保存另一份计划状态或覆盖历史证据。 */
import type { DesktopPlanProjection } from "../../../../protocol.js";

export type Plan = DesktopPlanProjection["plans"][number];
export type PlanNode = Plan["nodes"][number];
export type PlanDisplayStatus = "done" | "in_progress" | "blocked" | "ready" | "pending";

export function presentPlan(plan: Plan) {
  const replacements = new Map(plan.nodes.filter((node) => node.replacesNodeId).map((node) => [node.replacesNodeId!, node]));
  const current = plan.nodes.filter((node) => !replacements.has(node.nodeId));
  const byKey = new Map(plan.nodes.map((node) => [node.key, node]));
  const dependency = (key: string): PlanNode | undefined => {
    let node = byKey.get(key);
    for (let depth = 0; node && replacements.has(node.nodeId) && depth < plan.nodes.length; depth++) node = replacements.get(node.nodeId);
    return node;
  };
  const groups = new Map<string, { key: string; title: string; nodes: PlanNode[] }>();
  for (const node of current) {
    const key = node.block?.taskKey ?? node.key;
    const group = groups.get(key) ?? { key, title: node.block?.title ?? node.key, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }
  const nodeStatus = (node: PlanNode): PlanDisplayStatus => {
    if (node.status === "completed") return "done";
    if (node.approval || node.taskStatus === "needs_approval" || ["blocked", "failed", "cancelled"].includes(node.status)) return "blocked";
    if (node.status === "running") return "in_progress";
    return node.dependencies.every((key) => dependency(key)?.status === "completed") ? "ready" : "pending";
  };
  const tasks = [...groups.values()].map((group) => {
    const blocks = group.nodes.map((node) => ({ node, status: nodeStatus(node) }));
    const status: PlanDisplayStatus = blocks.every((block) => block.status === "done") ? "done"
      : blocks.some((block) => block.status === "in_progress") ? "in_progress"
      : blocks.some((block) => block.status === "blocked") ? "blocked"
      : blocks.some((block) => block.status === "ready") ? "ready" : "pending";
    const dependencies = [...new Set(group.nodes.flatMap((node) => node.dependencies).map((key) => {
      const upstream = dependency(key);
      return upstream?.block?.taskKey ?? key;
    }).filter((key) => key !== group.key))];
    return { ...group, blocks, status, dependencies };
  });
  const feedback = plan.nodes.findLast((node) => {
    if ((node.report as { review?: { verdict?: string } } | undefined)?.review?.verdict !== "needs_changes") return false;
    if (!replacements.has(node.nodeId)) return true;
    const review = dependency(node.key);
    return review?.dependencies.some((key) => {
      const repair = dependency(key);
      return repair?.block?.rework && repair.status !== "completed";
    });
  });
  const active = current.find((node) => nodeStatus(node) === "in_progress");
  const done = current.filter((node) => node.status === "completed").length;
  return { tasks, feedback, active, done, total: current.length, allDone: current.length > 0 && done === current.length };
}
