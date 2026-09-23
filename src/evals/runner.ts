/**
 * Eval 执行与对照模块。
 *
 * 每个任务在自己的临时工作区里跑，跑完用可执行判据验证，再汇总成可对照的报告。
 * 真正跑 agent 的部分通过 `EvalAgentRunner` 注入，这样评测逻辑本身可以被测试，
 * 而不需要真的连模型。
 */
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runShellCommand } from "../tools/shell/runCommand.js";
import type {
  EvalAttemptMetrics,
  EvalComparison,
  EvalReport,
  EvalSummary,
  EvalTask,
  EvalTaskResult
} from "./types.js";

/** 在给定工作区里跑一次任务。实现方负责创建 runtime、发 prompt、收集用量。 */
export type EvalAgentRunner = (
  workspaceRoot: string,
  task: EvalTask,
  signal?: AbortSignal
) => Promise<EvalAttemptMetrics>;

export interface RunEvalSuiteOptions {
  suite: string;
  label: string;
  model: string;
  tasks: readonly EvalTask[];
  run: EvalAgentRunner;
  verifyTimeoutMs?: number;
  onTaskComplete?: (result: EvalTaskResult) => void;
  now?: () => number;
  signal?: AbortSignal;
}

export async function runEvalSuite(options: RunEvalSuiteOptions): Promise<EvalReport> {
  const now = options.now ?? (() => Date.now());
  const startedAt = new Date().toISOString();
  const results: EvalTaskResult[] = [];

  for (const task of options.tasks) {
    options.signal?.throwIfAborted();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), `biny-eval-${task.id}-`));
    const startedMs = now();
    let metrics: EvalAttemptMetrics = { steps: 0, pricingKnown: false };
    try {
      await writeFixture(workspaceRoot, task);
      metrics = await options.run(workspaceRoot, structuredClone(task), options.signal);
      await verifyProtectedFixtures(workspaceRoot, task);
      const verification = await runShellCommand(workspaceRoot, task.verify, {
        timeoutMs: options.verifyTimeoutMs ?? 120_000,
        signal: options.signal
      });
      await verifyProtectedFixtures(workspaceRoot, task);
      const passed = verification.status === "completed" && verification.exitCode === 0;
      results.push({
        taskId: task.id,
        passed,
        ...(passed ? {} : { failure: verificationFailure(verification) }),
        durationMs: now() - startedMs,
        metrics
      });
    } catch (error) {
      // 运行期异常算未通过，但要留下原因 —— 把崩溃和"做错了"混为一谈会掩盖真正的回归。
      results.push({
        taskId: task.id,
        passed: false,
        failure: error instanceof Error ? error.message : String(error),
        durationMs: now() - startedMs,
        metrics
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    const last = results[results.length - 1];
    if (last) options.onTaskComplete?.(last);
  }

  return {
    suite: options.suite,
    label: options.label,
    startedAt,
    model: options.model,
    results,
    summary: summarize(results)
  };
}

export function summarize(results: readonly EvalTaskResult[]): EvalSummary {
  const passed = results.filter((result) => result.passed).length;
  const pricingKnown = results.length > 0 && results.every((result) => result.metrics.pricingKnown);
  const tokenValues = results.map((result) => result.metrics.totalTokens).filter((value): value is number => value !== undefined);
  return {
    tasks: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    totalSteps: results.reduce((total, result) => total + result.metrics.steps, 0),
    ...(tokenValues.length ? { totalTokens: tokenValues.reduce((total, value) => total + value, 0) } : {}),
    // 任一任务缺价格就不给总成本：一个偏低的假数字比没有数字更容易误导决策。
    ...(pricingKnown
      ? { totalCostUsd: results.reduce((total, result) => total + (result.metrics.costUsd ?? 0), 0) }
      : {}),
    pricingKnown,
    totalDurationMs: results.reduce((total, result) => total + result.durationMs, 0)
  };
}

export function compareReports(baseline: EvalReport, candidate: EvalReport): EvalComparison {
  const baselinePassed = new Set(baseline.results.filter((result) => result.passed).map((result) => result.taskId));
  const candidatePassed = new Set(candidate.results.filter((result) => result.passed).map((result) => result.taskId));
  const baselineTasks = new Set(baseline.results.map((result) => result.taskId));
  const candidateTasks = new Set(candidate.results.map((result) => result.taskId));
  if (baselineTasks.size !== baseline.results.length || candidateTasks.size !== candidate.results.length) {
    throw new Error("Cannot compare reports with duplicate task IDs.");
  }
  if (baseline.suite !== candidate.suite) throw new Error("Cannot compare reports from different suites.");
  if (baselineTasks.size !== candidateTasks.size || [...baselineTasks].some((id) => !candidateTasks.has(id))) {
    throw new Error("Cannot compare reports: task sets differ.");
  }
  // 汇总值从逐任务证据重算，避免读取过期或手动修改过的 summary。
  const baselineSummary = summarize(baseline.results);
  const candidateSummary = summarize(candidate.results);

  return {
    baseline: baseline.label,
    candidate: candidate.label,
    passRateDelta: candidateSummary.passRate - baselineSummary.passRate,
    stepsDelta: candidateSummary.totalSteps - baselineSummary.totalSteps,
    tokensDelta: candidateSummary.totalTokens !== undefined && baselineSummary.totalTokens !== undefined
      ? candidateSummary.totalTokens - baselineSummary.totalTokens : undefined,
    costUsdDelta: candidateSummary.totalCostUsd !== undefined && baselineSummary.totalCostUsd !== undefined
      ? candidateSummary.totalCostUsd - baselineSummary.totalCostUsd : undefined,
    newlyPassing: [...candidatePassed].filter((id) => !baselinePassed.has(id)).sort(),
    newlyFailing: [...baselinePassed].filter((id) => !candidatePassed.has(id)).sort()
  };
}

export function formatComparison(comparison: EvalComparison): string {
  const lines = [
    `${comparison.baseline} → ${comparison.candidate}`,
    `pass rate  ${formatSignedPercent(comparison.passRateDelta)}`,
    `steps      ${formatSigned(comparison.stepsDelta)}`,
    ...(comparison.tokensDelta === undefined ? [] : [`tokens     ${formatSigned(comparison.tokensDelta)}`]),
    ...(comparison.costUsdDelta === undefined ? [] : [`cost       ${formatSigned(Number(comparison.costUsdDelta.toFixed(6)))} USD`])
  ];
  if (comparison.newlyPassing.length) lines.push(`newly passing: ${comparison.newlyPassing.join(", ")}`);
  if (comparison.newlyFailing.length) lines.push(`newly failing: ${comparison.newlyFailing.join(", ")}`);
  if (!comparison.newlyPassing.length && !comparison.newlyFailing.length) lines.push("no task changed outcome");
  return lines.join("\n");
}

async function writeFixture(workspaceRoot: string, task: EvalTask): Promise<void> {
  for (const file of task.fixture) {
    const target = path.resolve(workspaceRoot, file.path);
    // fixture 来自评测定义而不是模型，但仍然校验一次：一个写到工作区外的 fixture
    // 会污染跑评测的机器，而且很难排查。
    if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error(`Fixture path escapes the eval workspace: ${file.path}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

/** 禁止修改的 fixture 必须仍是原位置的普通文件，不能用软链或删除绕过校验。 */
async function verifyProtectedFixtures(workspaceRoot: string, task: EvalTask): Promise<void> {
  const root = await realpath(workspaceRoot);
  for (const file of task.fixture.filter((entry) => entry.protected)) {
    const target = path.resolve(root, file.path);
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.nlink !== 1 || await realpath(target) !== target
        || await readFile(target, "utf8") !== file.content) throw new Error("changed");
    } catch {
      throw new Error(`Protected fixture was changed or removed: ${file.path}`);
    }
  }
}

function verificationFailure(verification: { status: string; exitCode: number; stdout: string; stderr: string }): string {
  const output = [verification.stdout, verification.stderr].filter((part) => part.trim()).join("\n").trim();
  const detail = output.slice(0, 2_000);
  return verification.status === "timed_out"
    ? "Verification command timed out."
    : `Verification failed (exit ${String(verification.exitCode)})${detail ? `: ${detail}` : "."}`;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${String(value)}` : String(value);
}

function formatSignedPercent(value: number): string {
  const percent = (value * 100).toFixed(1);
  return value > 0 ? `+${percent}%` : `${percent}%`;
}
