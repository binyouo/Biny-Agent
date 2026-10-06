/** Host 权威快照的安全引用投影；保留工具定义，不带任务 payload、验证材料或执行参数。 */
import type { LocalReferenceResult } from "./localReferences.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";

export type RuntimeReferenceEntry = Pick<LocalReferenceResult, "kind" | "label" | "content"> & { id: string };

function records(value: unknown, nested?: string): Record<string, unknown>[] {
  const candidate = nested && typeof value === "object" && value !== null ? (value as Record<string, unknown>)[nested] : value;
  return Array.isArray(candidate) ? candidate.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

function field(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function schemaDefinition(value: unknown, propertyName?: string, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => schemaDefinition(entry, propertyName, ancestors));
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (["properties", "patternProperties", "$defs", "definitions"].includes(key) && typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        return [key, Object.fromEntries(Object.entries(entry).map(([name, definition]) => [name, schemaDefinition(definition, name, ancestors)]))];
      }
      if (["default", "examples", "example", "enum", "const"].includes(key)) {
        const redact = (data: unknown): unknown => propertyName
          ? (redactSensitiveValue({ [propertyName]: data }) as Record<string, unknown>)[propertyName]
          : redactSensitiveValue(data);
        return [key, (key === "examples" || key === "enum") && Array.isArray(entry) ? entry.map(redact) : redact(entry)];
      }
      return [key, schemaDefinition(entry, propertyName, ancestors)];
    }));
  } finally { ancestors.delete(value); }
}

export function runtimeReferenceEntries(projection: { tasks?: unknown; automations?: unknown; graphs?: unknown },
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
  for (const graph of records(projection.graphs)) {
    const id = field(graph, "graphId");
    if (id) result.push({ kind: "plan", id, label: id, content: `Plan ${id} · ${field(graph, "status") ?? "unknown"}` });
  }
  for (const tool of records(tools)) {
    const id = field(tool, "name");
    if (!id || tool.exposure === "hidden") continue;
    const namespace = records([tool.namespace])[0];
    const namespaceName = namespace ? field(namespace, "name") : undefined;
    const metadata = redactSensitiveValue({
      name: id,
      description: typeof tool.description === "string" ? tool.description.slice(0, 4_096) : id,
      source: field(tool, "source"),
      risk: field(tool, "risk"),
      exposure: field(tool, "exposure") ?? "direct",
      namespace: namespaceName ? { name: namespaceName, description: field(namespace!, "description") } : undefined,
    }) as Record<string, unknown>;
    const definition = { ...metadata, inputSchema: schemaDefinition(tool.parameters), outputSchema: schemaDefinition(tool.outputSchema) };
    result.push({ kind: "tool", id, label: id, content: JSON.stringify(definition, null, 2) });
  }
  return result;
}
