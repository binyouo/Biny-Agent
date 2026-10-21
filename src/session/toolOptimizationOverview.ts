import { summarizeToolOptimizations, type ToolOptimizationEntry, type ToolOptimizationSummary } from "./toolOptimization.js";

export interface ToolOptimizationOverview {
  ptc: ToolOptimizationSummary;
  rtk: ToolOptimizationSummary;
  toolCalls: number;
  average: number;
  durationCount: number;
  totalDurationMs: number;
  daily: Array<ToolOptimizationSummary & { date: string }>;
  commands: Array<ToolOptimizationSummary & { command: string }>;
  recent: ToolOptimizationEntry[];
}

export function buildToolOptimizationOverview(records: readonly ToolOptimizationEntry[], now = new Date()): ToolOptimizationOverview {
  const entries = [...new Map(records.map(entry => [entry.optimization.id, entry])).values()];
  const ptc = entries.filter(entry => entry.optimization.kind === "ptc");
  const rtk = entries.filter(entry => entry.optimization.kind === "rtk");
  const days = new Map<string, ToolOptimizationEntry[]>();
  const commands = new Map<string, ToolOptimizationEntry[]>();
  const dateKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  for (let offset = 29; offset >= 0; offset--) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    days.set(dateKey(date), []);
  }
  let totalDurationMs = 0;
  let durationCount = 0;
  let percentageSum = 0;
  for (const entry of rtk) {
    days.get(dateKey(new Date(entry.time)))?.push(entry);
    const command = entry.optimization.command ?? "未知命令";
    let items = commands.get(command);
    if (!items) { items = []; commands.set(command, items); }
    items.push(entry);
    const { beforeTokens, savedTokens, durationMs } = entry.optimization;
    percentageSum += beforeTokens ? savedTokens / beforeTokens * 100 : 0;
    if (durationMs !== undefined) { durationCount++; totalDurationMs += durationMs; }
  }
  return {
    ptc: summarizeToolOptimizations(ptc),
    rtk: summarizeToolOptimizations(rtk),
    toolCalls: ptc.reduce((sum, entry) => sum + entry.optimization.toolCalls, 0),
    average: rtk.length ? percentageSum / rtk.length : 0,
    durationCount,
    totalDurationMs,
    daily: [...days].map(([date, items]) => ({ date, ...summarizeToolOptimizations(items) })),
    commands: [...commands].map(([command, items]) => ({ command, ...summarizeToolOptimizations(items) }))
      .sort((a, b) => b.savedTokens - a.savedTokens).slice(0, 10),
    recent: rtk.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 20)
  };
}
