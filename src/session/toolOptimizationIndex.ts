import type { FileHandle } from "node:fs/promises";
import { parseSessionEvents } from "./events.js";
import { assertSessionFileSize, maxSessionEvents, readSessionEventLines } from "./limits.js";
import type { ToolOptimizationEntry } from "./toolOptimization.js";

export type IndexedOptimizationEntry = Omit<ToolOptimizationEntry, "origin"> & { toolCallId?: string };

export async function readToolOptimizationEntries(handle: FileHandle, file: string, stat: { size: number }): Promise<IndexedOptimizationEntry[]> {
  assertSessionFileSize(stat.size, file);
  const entries: IndexedOptimizationEntry[] = [];
  let count = 0;
  const commands = new Map<string, string>();
  for await (const line of readSessionEventLines(handle, stat.size)) {
    for (const event of parseSessionEvents(line)) {
      if (++count > maxSessionEvents) throw new Error("Session event limit exceeded.");
      if (event.type === "tool_call" && event.tool === "Bash" && event.toolCallId && typeof (event.args as { command?: unknown } | undefined)?.command === "string") {
        commands.set(event.toolCallId, (event.args as { command: string }).command);
      }
      if (event.type !== "tool_result" || !event.optimization || !event.time) continue;
      if (!Number.isFinite(Date.parse(event.time))) throw new Error("Invalid optimization timestamp.");
      const optimization = event.optimization.kind === "rtk" && !event.optimization.originalCommand
        ? { ...event.optimization, originalCommand: commands.get(event.toolCallId ?? "") } : event.optimization;
      entries.push({ optimization, time: event.time, toolCallId: event.toolCallId });
    }
  }
  return entries;
}
