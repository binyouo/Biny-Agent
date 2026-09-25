/** Host 权威快照的安全引用投影；不带 task payload、验证材料或工具参数。 */
import type { LocalReferenceResult } from "./localReferences.js";

export type RuntimeReferenceEntry = Pick<LocalReferenceResult, "kind" | "label" | "content"> & { id: string };

function records(value: unknown, nested?: string): Record<string, unknown>[] {
  const candidate = nested && typeof value === "object" && value !== null ? (value as Record<string, unknown>)[nested] : value;
  return Array.isArray(candidate) ? candidate.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

function field(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

export function runtimeReferenceEntries(projection: { tasks?: unknown; automations?: unknown; goals?: unknown; graphs?: unknown },
  tools: unknown): RuntimeReferenceEntry[] {
  const result: RuntimeReferenceEntry[] = [];
  for (const task of records(projection.tasks, "tasks")) {
    const id = field(task, "taskRunId");
    if (id) result.push({ kind: "task", id, label: id, content: `Task ${id} · ${field(task, "status") ?? "unknown"}` });
  }
  for (const automation of records(projection.automations)) {
    const id = field(automation, "automationId");
    if (id) result.push({ kind: "cron", id, label: field(automation, "name") ?? id,
      content: `${field(automation, "name") ?? id} · ${field(automation, "status") ?? "unknown"}` });
  }
  for (const goal of records(projection.goals)) {
    const id = field(goal, "goalId");
    if (id) result.push({ kind: "mission", id, label: field(goal, "title") ?? id,
      content: `${field(goal, "title") ?? id} · ${field(goal, "status") ?? "unknown"}` });
  }
  for (const graph of records(projection.graphs)) {
    const id = field(graph, "graphId");
    if (id) result.push({ kind: "plan", id, label: id, content: `Plan ${id} · ${field(graph, "status") ?? "unknown"}` });
  }
  for (const tool of records(tools)) {
    const id = field(tool, "name");
    if (id) result.push({ kind: "tool", id, label: id, content: field(tool, "description") ?? id });
  }
  return result;
}
