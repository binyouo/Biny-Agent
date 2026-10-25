/**
 * 「发送消息 → 首个模型输出」链路的耗时打点（纯诊断用）。
 *
 * 设置环境变量 BINY_PERF_TIMING=1 后，各阶段耗时以 JSONL 追加到全局按项目隔离的运行目录；
 * 未开启时每个打点只是一次环境变量读取，开销可忽略。写入失败一律吞掉——诊断不能影响被测路径。
 *
 * 分析方式：按 runId 分组、按 t 排序，相邻阶段的 t 差就是无打点区间（如模型请求建连）的耗时。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { workspaceAgentDir } from "../config/paths.js";

let ensuredDir: string | undefined;

export function perfTimingEnabled(): boolean {
  const value = process.env.BINY_PERF_TIMING;
  return value !== undefined && value !== "" && value !== "0";
}

/** 阶段起点。统一走 performance.now()，避免 Date 精度在短阶段上失真。 */
export function perfNow(): number {
  return performance.now();
}

export function recordPerfPhase(
  phase: string,
  startedAtMs: number,
  detail?: Record<string, string | number | boolean | undefined>,
  workspaceRoot?: string
): void {
  if (!perfTimingEnabled()) return;
  // A Host can retain sessions from different worktrees; never borrow another session's root.
  if (!workspaceRoot) return;
  try {
    const dir = workspaceAgentDir(workspaceRoot);
    if (ensuredDir !== dir) {
      mkdirSync(dir, { recursive: true });
      ensuredDir = dir;
    }
    const line = JSON.stringify({
      t: new Date().toISOString(),
      phase,
      ms: Math.round((performance.now() - startedAtMs) * 10) / 10,
      ...detail
    });
    appendFileSync(path.join(dir, "perf.jsonl"), `${line}\n`);
  } catch {
    // 诊断写入失败不影响主路径。
  }
}
