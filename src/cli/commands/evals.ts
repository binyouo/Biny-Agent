/**
 * Eval 命令模块。
 *
 * `biny eval run` 跑一遍内置评测集并落一份报告；`biny eval compare` 对照两份报告。
 * 报告是 JSON，因为它的用途是被对照而不是被阅读。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { compareReports, formatComparison, runEvalSuite } from "../../evals/runner.js";
import { builtinEvalTasks, runTaskWithAgent } from "../../evals/suite.js";
import type { EvalReport } from "../../evals/types.js";
import { agentDir } from "../../session/store.js";

export interface EvalRunOptions {
  label?: string;
  out?: string;
  tasks?: string[];
}

export async function evalRunCommand(workspaceRoot: string, options: EvalRunOptions): Promise<void> {
  const selected = options.tasks?.length
    ? builtinEvalTasks.filter((task) => options.tasks?.includes(task.id))
    : builtinEvalTasks;
  if (!selected.length) {
    throw new Error(`No matching eval tasks. Available: ${builtinEvalTasks.map((task) => task.id).join(", ")}`);
  }

  const knownIds = new Set(builtinEvalTasks.map((task) => task.id));
  const unknownIds = [...new Set(options.tasks?.filter((id) => !knownIds.has(id)) ?? [])];
  if (unknownIds.length) throw new Error(`Unknown eval task IDs: ${unknownIds.join(", ")}. Available: ${[...knownIds].join(", ")}`);

  const { createFileConfigStore } = await import("../../config/store.js");
  const config = await createFileConfigStore(workspaceRoot).load();
  const report = await runEvalSuite({
    suite: "builtin",
    label: options.label ?? new Date().toISOString(),
    model: config.defaultModel,
    tasks: selected,
    run: runTaskWithAgent,
    onTaskComplete: (result) => {
      const status = result.passed ? "PASS" : "FAIL";
      console.log(`${status}  ${result.taskId}  ${String(result.metrics.steps)} steps  ${String(Math.round(result.durationMs / 1000))}s${result.failure ? `  ${result.failure}` : ""}`);
    }
  });

  console.log("");
  console.log(`${String(report.summary.passed)}/${String(report.summary.tasks)} passed (${(report.summary.passRate * 100).toFixed(1)}%), ${String(report.summary.totalSteps)} steps total`);
  if (report.summary.totalTokens !== undefined) console.log(`${String(report.summary.totalTokens)} tokens`);
  if (report.summary.totalCostUsd !== undefined) console.log(`$${report.summary.totalCostUsd.toFixed(4)}`);
  else console.log("cost unavailable: configure model pricing to compare spend across runs");

  const target = options.out ?? path.join(agentDir(workspaceRoot), "evals", `${sanitizeLabel(report.label)}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report: ${target}`);
}

export async function evalCompareCommand(baselinePath: string, candidatePath: string): Promise<void> {
  const [baseline, candidate] = await Promise.all([readReport(baselinePath), readReport(candidatePath)]);
  console.log(formatComparison(compareReports(baseline, candidate)));
}

async function readReport(filePath: string): Promise<EvalReport> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as EvalReport).results)) {
    throw new Error(`Not an eval report: ${filePath}`);
  }
  return parsed as EvalReport;
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^\w.-]+/g, "-").slice(0, 80) || "report";
}
