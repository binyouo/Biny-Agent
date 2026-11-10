import type { DesktopRuntimeMutation, DesktopRuntimeProjection } from "../../../protocol.js";

type RuntimeControlOperation = Extract<DesktopRuntimeMutation, "task.cancel" | "graph.pause" | "graph.resume">;
interface RuntimeControlReceipt {
  kind: "task" | "graph";
  row: Record<string, unknown> & { revision: number };
}

export function readRuntimeControlReceipt(operation: RuntimeControlOperation, payload: Record<string, unknown>, value: unknown): RuntimeControlReceipt {
  const kind = operation === "task.cancel" ? "task" : "graph";
  const idKey = kind === "task" ? "taskRunId" : "graphId";
  const validStatuses = kind === "task"
    ? ["completed", "failed", "incomplete", "blocked", "policy_denied", "budget_exhausted", "aborted", "cancelled"]
    : [operation === "graph.pause" ? "paused" : "running"];
  if (typeof payload[idKey] !== "string" || payload[idKey].length === 0 || !isRecord(value)
    || value[idKey] !== payload[idKey] || typeof value.status !== "string" || !validStatuses.includes(value.status)
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value[kind === "task" ? "attempts" : "nodes"])) {
    throw new Error("后台运行操作回执无效，请刷新状态后重试。");
  }
  return { kind, row: value as RuntimeControlReceipt["row"] };
}

export function applyRuntimeControlReceipt(projection: DesktopRuntimeProjection | undefined, receipt: RuntimeControlReceipt): DesktopRuntimeProjection | undefined {
  if (!projection) return projection;
  const taskPage = isRecord(projection.tasks) ? projection.tasks : undefined;
  const rows = receipt.kind === "task" ? taskPage?.tasks : projection.graphs;
  if (!Array.isArray(rows)) return projection;
  const idKey = receipt.kind === "task" ? "taskRunId" : "graphId";
  const index = rows.findIndex(row => isRecord(row) && row[idKey] === receipt.row[idKey]);
  const current: unknown = rows[index];
  if (!isRecord(current) || typeof current.revision !== "number" || current.revision >= receipt.row.revision) return projection;
  const nextRows = rows.slice();
  // 回执是完整记录；不合并旧行，以免保留 authority 已移除的字段。
  nextRows[index] = receipt.row;
  return receipt.kind === "task"
    ? { ...projection, tasks: { ...taskPage, tasks: nextRows } }
    : { ...projection, graphs: nextRows };
}

export function taskCancellationNeedsGraphRefresh(projection: DesktopRuntimeProjection | undefined, taskRunId: unknown): boolean {
  // GraphSupervisor 为新派发任务使用 graph:<graphId>:<nodeId>；旧快照可能尚无节点关联。
  if (typeof taskRunId !== "string" || taskRunId.startsWith("graph:") || !Array.isArray(projection?.graphs)) return true;
  return projection.graphs.some(graph => !isRecord(graph) || !Array.isArray(graph.nodes)
    || graph.nodes.some(node => !isRecord(node) || node.taskRunId === taskRunId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
