import { z } from "zod";

/** 工具结果文本的局部估算，不包含脚本生成费用或 provider 缓存收益。 */
export const toolOptimizationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["ptc", "rtk"]),
  estimator: z.enum(["utf8/3", "rtk"]),
  beforeTokens: z.number().int().nonnegative(),
  afterTokens: z.number().int().nonnegative(),
  savedTokens: z.number().int(),
  toolCalls: z.number().int().nonnegative(),
  command: z.string().optional(),
  originalCommand: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional()
}).refine(value => value.savedTokens === value.beforeTokens - value.afterTokens);
export type ToolOptimization = z.infer<typeof toolOptimizationSchema>;

export interface ToolOptimizationEntry {
  optimization: ToolOptimization;
  time: string;
  origin?: { projectId: string; sessionId: string; toolCallId: string };
}
export interface ToolOptimizationSummary {
  runs: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  ptcTokens: number;
  rtkTokens: number;
}

export function summarizeToolOptimizations(records: readonly { optimization?: ToolOptimization }[]): ToolOptimizationSummary {
  const seen = new Set<string>();
  const summary: ToolOptimizationSummary = { runs: 0, beforeTokens: 0, afterTokens: 0, savedTokens: 0, ptcTokens: 0, rtkTokens: 0 };
  for (const record of records) {
    const parsed = toolOptimizationSchema.safeParse(record.optimization);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const value = parsed.data;
    seen.add(value.id);
    summary.runs++;
    summary.beforeTokens += value.beforeTokens;
    summary.afterTokens += value.afterTokens;
    summary.savedTokens += value.savedTokens;
    summary[value.kind === "ptc" ? "ptcTokens" : "rtkTokens"] += value.savedTokens;
  }
  return summary;
}
