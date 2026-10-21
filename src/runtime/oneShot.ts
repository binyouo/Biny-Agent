import type { AgentTurnOutcome } from "../agent/types.js";
import type { TaskClosureResult } from "./TaskClosure.js";
import { pendingTaskVerificationApproval, readTaskVerificationContract, type TaskVerificationContract, type TaskVerificationEvidence } from "./taskVerification.js";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import type { AgentConfig } from "../config/schema.js";
import type { PermissionMode } from "../permission/PermissionManager.js";
import type { UsageSummary } from "../session/metadata.js";
import type { ModelRequestSummary } from "../observability/modelRequests.js";
export interface RunCommandOptions {
  /** 已在 Biny 配置中的模型 alias；不接受裸 provider model ID。 */
  model?: string;
  /** 覆盖本次运行的 hard step limit。 */
  maxSteps?: number;
  /** 覆盖本次运行的 soft step limit。 */
  softSteps?: number;
  /** 覆盖本次运行的权限模式。 */
  permissionMode?: PermissionMode;
  /** 无交互运行；会关闭 critical confirmation，并自动批准权限请求。 */
  headless?: boolean;
  /** 只输出一行 JSON，并允许非 completed 的 agent 终态交给外部 verifier 判定。 */
  json?: boolean;
  /** 在 Runtime Host 中创建独立 worktree session。 */
  isolated?: boolean;
  /** 随首条用户消息发送给模型的工作区图片路径。 */
  attachment?: string[];
  /** 确定性产物验收契约 JSON；省略时显式报告未验收。 */
  verification?: string;
  /** 外部执行环境提供的 Unix 毫秒绝对截止时间。 */
  deadlineAtMs?: number;
  /** 为检查、落盘和回报保留的时间预算。 */
  finalizationReserveMs?: number;
}

export interface RunCommandResult {
  status: AgentTurnOutcome["status"];
  stopReason: AgentTurnOutcome["stopReason"];
  steps: number;
  error?: string;
  verificationReason?: string;
  sessionId: string;
  sessionFile: string;
  modelAlias: string;
  provider: string;
  model: string;
  usage: UsageSummary;
  modelRequests: ModelRequestSummary;
  verificationStatus: TaskClosureResult["status"] | "not_run";
  deliveryStatus: "verified" | "unverified" | Exclude<TaskClosureResult["status"], "completed">;
  verification?: TaskVerificationEvidence;
  approval?: RunVerificationApproval;
  taskRunId?: string;
}

export interface RunVerificationApproval {
  approvalId: string;
  checkId: string;
  command: string;
  cwd: string;
}

export function createRunConfigStore(
  workspaceRoot: string,
  options: RunCommandOptions,
  base: AgentConfigStore = createFileConfigStore(workspaceRoot)
): AgentConfigStore {
  if (base.loadVersioned === undefined || base.saveVersioned === undefined) {
    throw new Error("Run configuration requires a versioned config store.");
  }
  const revision = base.revision;
  return {
    load: async (requestedWorkspaceRoot) => {
      const config = await base.load(requestedWorkspaceRoot);
      return applyRunConfig(config, options);
    },
    // --model/--permission-mode/--headless 只覆盖本次运行；持久化写入必须走下面的
    // versioned 接口，才能在保存 OAuth 等真实配置更新时剥离这些临时覆盖。
    save: async () => {
      throw new Error("Run configuration overrides must be saved with a versioned update.");
    },
    revision: revision ? () => revision() : undefined,
    loadVersioned: async (requestedWorkspaceRoot) => {
      const snapshot = await base.loadVersioned!(requestedWorkspaceRoot);
      return { ...snapshot, config: applyRunConfig(snapshot.config, options) };
    },
    saveVersioned: async (candidate, expectedRevision, requestedWorkspaceRoot) => {
      const persisted = await base.loadVersioned!(requestedWorkspaceRoot);
      const saved = await base.saveVersioned!(
        removeRunOverrides(candidate, persisted.config, options),
        expectedRevision,
        requestedWorkspaceRoot
      );
      return { ...saved, config: applyRunConfig(saved.config, options) };
    }
  };
}

export function applyRunConfig(config: AgentConfig, options: RunCommandOptions): AgentConfig {
  const next = structuredClone(config);
  if (options.model !== undefined) {
    if (!next.models[options.model]) throw new Error(`Unknown model alias: ${options.model}`);
    next.defaultModel = options.model;
  }
  if (options.maxSteps !== undefined) next.agent.hardStepLimit = options.maxSteps;
  if (options.softSteps !== undefined) next.agent.softStepLimit = options.softSteps;
  if (options.permissionMode !== undefined) next.permission.mode = options.permissionMode;
  if (options.headless) {
    next.permission.mode = options.permissionMode ?? "full-access";
    next.permission.criticalAlwaysAsk = false;
  }
  return next;
}

function removeRunOverrides(
  candidate: AgentConfig,
  persisted: AgentConfig,
  options: RunCommandOptions
): AgentConfig {
  const next = structuredClone(candidate);
  if (options.model !== undefined) next.defaultModel = persisted.defaultModel;
  if (options.maxSteps !== undefined) next.agent.hardStepLimit = persisted.agent.hardStepLimit;
  if (options.softSteps !== undefined) next.agent.softStepLimit = persisted.agent.softStepLimit;
  if (options.permissionMode !== undefined || options.headless) next.permission.mode = persisted.permission.mode;
  if (options.headless) next.permission.criticalAlwaysAsk = persisted.permission.criticalAlwaysAsk;
  return next;
}

export function validateRunOptions(options: RunCommandOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Run options must be an object.");
  const keys = new Set(["model", "maxSteps", "softSteps", "permissionMode", "headless", "json", "isolated", "attachment", "verification", "deadlineAtMs", "finalizationReserveMs"]);
  for (const key of Object.keys(options)) if (!keys.has(key)) throw new Error(`Unknown run option: ${key}`);
  for (const key of ["headless", "json", "isolated"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  }
  for (const key of ["model", "verification"] as const) {
    if (options[key] !== undefined && (typeof options[key] !== "string" || !options[key].trim())) throw new Error(`${key} must be a non-empty string.`);
  }
  if (options.attachment !== undefined && (!Array.isArray(options.attachment) || options.attachment.some(value => typeof value !== "string" || !value.trim()))) {
    throw new Error("attachment must be an array of non-empty paths.");
  }
  validateStepLimit("maxSteps", options.maxSteps);
  validateStepLimit("softSteps", options.softSteps);
  if (options.softSteps !== undefined && options.maxSteps !== undefined && options.softSteps > options.maxSteps) {
    throw new Error("softSteps cannot be greater than maxSteps.");
  }
  if (options.permissionMode !== undefined && !["ask", "read-only", "auto", "full-access"].includes(options.permissionMode)) {
    throw new Error("permissionMode must be one of ask, read-only, auto, full-access.");
  }
  parseRunVerification(options.verification);
  if (options.deadlineAtMs !== undefined && (!Number.isSafeInteger(options.deadlineAtMs) || options.deadlineAtMs <= 0)) {
    throw new Error("deadlineAtMs must be a positive Unix timestamp in milliseconds.");
  }
  if (options.finalizationReserveMs !== undefined && (
    !Number.isSafeInteger(options.finalizationReserveMs) || options.finalizationReserveMs < 0
  )) {
    throw new Error("finalizationReserveMs must be a non-negative integer.");
  }
  if (options.finalizationReserveMs !== undefined && options.deadlineAtMs === undefined) {
    throw new Error("finalizationReserveMs requires deadlineAtMs.");
  }
  if (options.deadlineAtMs !== undefined && options.deadlineAtMs <= (options.finalizationReserveMs ?? 0)) {
    throw new Error("deadlineAtMs must be greater than finalization reserve.");
  }

}

export function parseRunVerification(value: string | undefined): TaskVerificationContract | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`verification must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return readTaskVerificationContract(parsed);
  } catch (error) {
    throw new Error(`verification contract is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function runVerificationApproval(
  evidence: TaskVerificationEvidence | undefined,
  contract: TaskVerificationContract
): RunVerificationApproval | undefined {
  const pending = pendingTaskVerificationApproval(evidence);
  if (!pending) return undefined;
  const check = contract.checks.find((candidate) => candidate.id === pending.checkId);
  if (!check) return undefined;
  return {
    approvalId: pending.approvalId,
    checkId: check.id,
    command: check.command,
    cwd: check.cwd ?? "."
  };
}

export function resolveRunDeadlineBudget(
  deadlineAtMs: number,
  finalizationReserveMs = 0,
  nowMs = Date.now()
): { deadlineAtMs: number; finalizationReserveMs: number; workDeadlineAtMs: number; remainingMs: number; workRemainingMs: number } {
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) {
    throw new Error("deadlineAtMs must be a positive Unix timestamp in milliseconds.");
  }
  if (!Number.isSafeInteger(finalizationReserveMs) || finalizationReserveMs < 0 || deadlineAtMs <= finalizationReserveMs) {
    throw new Error("deadlineAtMs must be greater than finalization reserve.");
  }
  const workDeadlineAtMs = deadlineAtMs - finalizationReserveMs;
  return {
    deadlineAtMs,
    finalizationReserveMs,
    workDeadlineAtMs,
    remainingMs: Math.max(0, deadlineAtMs - nowMs),
    workRemainingMs: Math.max(0, workDeadlineAtMs - nowMs)
  };
}

export function withRunTaskGuidance(
  prompt: string,
  deadlineAtMs?: number,
  finalizationReserveMs = 0,
  verification: boolean | TaskVerificationContract = false,
  nowMs = Date.now()
): string {
  const contract = typeof verification === "object" ? verification : undefined;
  const verificationRequired = contract !== undefined || verification;
  if (deadlineAtMs === undefined && !verificationRequired) return prompt;
  const guidance = [
    "交付检查要求：从任务说明中列出明确的交付条件，检查实际产物和要求的文件、stdout 或服务入口；最终简要列出每项为通过、失败或未运行，并给出对应产物或命令证据。不要声称未实际运行的检查通过，也不要把模型回合结束当作验收通过。",
    verificationRequired
      ? "本次提供了确定性验收契约。不要削弱或绕过这些检查；根据实际失败证据修复，并只在全部检查通过后报告已验证。"
      : "没有提供确定性验收契约。仅运行任务说明和公开接口允许的检查；对未验证的条件明确标为未运行。"
  ];
  if (contract) {
    guidance.push(
      [
        `验收目标：${contract.objective}`,
        contract.context ? `验收上下文：${contract.context}` : undefined,
        `必须保留的检查项：${contract.checks.map((check) => `- ${check.id}: ${check.command} (cwd: ${check.cwd ?? "."})`).join("\n")}`,
        `需交付的产物：${contract.artifactPaths.join(", ")}`,
        `允许修复的路径：${contract.allowedRepairPaths.join(", ")}`,
        `最多尝试次数：${String(contract.maxAttempts)}`
      ].filter((line): line is string => line !== undefined).join("\n")
    );
  }
  if (deadlineAtMs !== undefined) {
    const budget = resolveRunDeadlineBudget(deadlineAtMs, finalizationReserveMs, nowMs);
    guidance.push(
      `时间预算：硬截止时间为 ${new Date(deadlineAtMs).toISOString()}，当前剩余约 ${Math.ceil(budget.remainingMs / 1_000)} 秒；为保存最佳产物、检查交付并回报结果，预留最后 ${Math.ceil(finalizationReserveMs / 1_000)} 秒。每次启动耗时操作前重新查看当前时间和剩余预算，尽早保存可运行产物，避免让未完成的长任务占用收尾时间。`
    );
  }
  return `${prompt}\n\n${guidance.join("\n")}`;
}

export function closureStopReason(status: TaskClosureResult["status"]): AgentTurnOutcome["stopReason"] {
  if (status === "cancelled") return "cancelled";
  if (status === "blocked" || status === "needs_approval") return "blocked";
  return "provider_error";
}

function validateStepLimit(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 1_024) {
    throw new Error(`${name} must be an integer between 1 and 1024.`);
  }
}

/** Throwing here lets the CLI composition root set a non-zero exit status. */
export function assertCompletedCliRun(outcome: AgentTurnOutcome): void {
  if (outcome.status === "completed") return;
  const detail = outcome.error ?? `Agent task stopped with ${outcome.stopReason} after ${String(outcome.steps)} steps.`;
  throw new Error(`Agent task ${outcome.status}: ${detail}`);
}
