/**
 * 一次性 run 命令模块。
 *
 * `biny run <task>` 会创建标准命令运行时，执行单轮 agent 任务，然后打印 assistant 输出和
 * session 文件位置。它适合脚本化调用或不需要持续对话的任务。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentTurnOutcome } from "../../agent/types.js";
import type { TaskClosureResult } from "../../runtime/TaskClosure.js";
import {
  pendingTaskVerificationApproval,
  readTaskVerificationContract,
  type TaskVerificationContract,
  type TaskVerificationEvidence
} from "../../runtime/taskVerification.js";
import { withAttachmentReferences } from "../../attachments/references.js";
import { saveAttachment, type AgentAttachment } from "../../attachments/store.js";
import { createFileConfigStore, type AgentConfigStore } from "../../config/store.js";
import type { AgentConfig } from "../../config/schema.js";
import type { PermissionMode } from "../../permission/PermissionManager.js";
import { createCommandRuntime, type CommandRuntime } from "../../runtime/CommandRuntime.js";
import { ExecutionService } from "../../runtime/ExecutionService.js";
import { SessionLeaseStore, type SessionLease } from "../../runtime/SessionLease.js";
import { connectOrSpawnRuntimeHost, connectRuntimeHost, RuntimeHostClient } from "../../runtime/RuntimeHost.js";
import type { UsageSummary } from "../../session/metadata.js";
import type { ModelRequestSummary } from "../../observability/modelRequests.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { withCliAbortSignal } from "../sigint.js";

const maxRunAttachments = 8;
const maxRunAttachmentBytes = 20 * 1024 * 1024;
const maxRunAttachmentTotalBytes = 40 * 1024 * 1024;
const imageMimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

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

export async function runCommand(workspaceRoot: string, input: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
  validateRunOptions(options);
  const verification = parseRunVerification(options.verification);
  const attached = options.isolated
    ? await connectOrSpawnRuntimeHost(workspaceRoot, {
      workspaceRoot,
      resumeInterrupted: false,
      surface: "cli",
      clientId: `run-${process.pid}`
    })
    : canAttachRun(options)
      ? await connectRuntimeHost(workspaceRoot, { surface: "cli", clientId: `run-${process.pid}` })
      : undefined;
  if (options.isolated && !attached) {
    throw new Error("--isolated requires a Unix Runtime Host; no Host could be attached or started.");
  }
  if (attached) {
    const config = await createRunConfigStore(workspaceRoot, options).load(workspaceRoot);
    const attachments = await loadRunAttachments(
      workspaceRoot,
      attached.persistenceRoot,
      config.workspace.ignore,
      options.attachment
    );
    return await runAttachedCommand(attached, input, options, attachments);
  }
  let runtime: CommandRuntime | undefined;
  let leases: SessionLeaseStore | undefined;
  let lease: SessionLease | undefined;
  let machineResult: RunCommandResult | undefined;
  const deadlineBudget = options.deadlineAtMs === undefined
    ? undefined
    : resolveRunDeadlineBudget(options.deadlineAtMs, options.finalizationReserveMs ?? 0);
  const deadlineControl = deadlineBudget === undefined
    ? undefined
    : createRunDeadlineSignal(deadlineBudget.deadlineAtMs);
  const workDeadlineControl = deadlineBudget === undefined || deadlineBudget.finalizationReserveMs === 0
    ? undefined
    : createRunDeadlineSignal(deadlineBudget.workDeadlineAtMs, 0);
  try {
    runtime = await createCommandRuntime(workspaceRoot, {
      configStore: createRunConfigStore(workspaceRoot, options),
      processLifetime: options.json
        && process.env.BINY_MANAGED_PROCESS_LIFETIME === "execution-environment"
        ? "execution-environment"
        : "runtime"
    });
    const attachments = await loadRunAttachments(
      workspaceRoot,
      runtime.persistenceRoot,
      runtime.config.workspace.ignore,
      options.attachment
    );
    leases = await SessionLeaseStore.open(runtime.persistenceRoot);
    lease = leases.acquire(runtime.agent.getInfo().sessionId);
    const runPrompt = withRunTaskGuidance(
      input,
      options.deadlineAtMs,
      options.finalizationReserveMs ?? 0,
      verification ?? false
    );
    const confirmPermission = options.headless
      ? async () => ({ approved: true, scope: "session" as const })
      : undefined;
    if (verification) {
      const verified = await withCliAbortSignal(async (cliSignal) => {
        const runSignal = combineRunSignals(cliSignal, deadlineControl?.signal);
        const attemptSignal = combineRunSignals(runSignal, workDeadlineControl?.signal);
        return await runtime!.runTaskWithVerification({
          prompt: withAttachmentReferences(runPrompt, attachments),
          verification,
          signal: runSignal,
          attemptSignal,
          confirmPermission
        });
      });
      const info = runtime.agent.getInfo();
      const turn = verified.turnOutcome;
      const approval = runVerificationApproval(verified.closure.evidence, verification);
      machineResult = {
        status: turn?.status ?? (verified.closure.status === "cancelled" ? "cancelled" : "incomplete"),
        stopReason: turn?.stopReason ?? closureStopReason(verified.closure.status),
        steps: turn?.steps ?? 0,
        error: turn?.error,
        verificationReason: verified.closure.reason,
        sessionId: info.sessionId,
        sessionFile: info.sessionFile,
        modelAlias: info.modelAlias,
        provider: info.provider,
        model: info.modelLabel,
        usage: runtime.agent.usageSummary(),
        modelRequests: runtime.agent.modelRequestSummary(),
        verificationStatus: verified.closure.status,
        deliveryStatus: verified.closure.status === "completed" ? "verified" : verified.closure.status,
        verification: verified.closure.evidence,
        approval,
        taskRunId: verified.taskRunId
      };
      if (!options.json) {
        if (turn?.output ?? verified.closure.output) console.log(turn?.output ?? verified.closure.output);
        console.log(`\nVerification: ${verified.closure.status}`);
        console.log(`TaskRun: ${verified.taskRunId}`);
        if (approval) {
          console.log(`Verification command needs approval: ${approval.command} (cwd: ${approval.cwd})`);
          console.log(`Approve this exact check with: biny task approve ${verified.taskRunId} --approval-id '${approval.approvalId}'`);
        }
        if (verified.closure.status !== "completed") {
          throw new Error(verified.closure.reason ?? `Task delivery verification ended with ${verified.closure.status}.`);
        }
      }
    } else {
      const execution = await ExecutionService.create(runtime);
      const result = await withCliAbortSignal(async (cliSignal) => await execution.execute({
        input: withAttachmentReferences(runPrompt, attachments),
        signal: combineRunSignals(
          combineRunSignals(cliSignal, deadlineControl?.signal),
          workDeadlineControl?.signal
        ),
        attachments,
        confirmPermission
      }));
      const info = result.session;
      machineResult = {
        status: result.turn.status,
        stopReason: result.turn.stopReason,
        steps: result.turn.steps,
        error: result.turn.error,
        sessionId: info.sessionId,
        sessionFile: info.sessionFile,
        modelAlias: info.modelAlias,
        provider: info.provider,
        model: info.modelLabel,
        usage: runtime.agent.usageSummary(),
        modelRequests: runtime.agent.modelRequestSummary(),
        verificationStatus: "not_run",
        deliveryStatus: "unverified"
      };
      if (!options.json) {
        if (result.turn.output) console.log(result.turn.output);
        console.log(`\nSession: ${result.session.sessionFile}`);
        console.log("Verification: not run (no deterministic verification contract supplied).");
        assertCompletedCliRun(result.turn);
      }
    }
  } catch (error) {
    runtime?.agent.recordError(error);
    throw error;
  } finally {
    try {
      await runtime?.close();
    } finally {
      deadlineControl?.dispose();
      workDeadlineControl?.dispose();
      lease?.close();
      leases?.close();
    }
  }
  if (!machineResult) throw new Error("Biny run ended without a structured result.");
  if (options.json) console.log(JSON.stringify(machineResult));
  return machineResult;
}

async function runAttachedCommand(
  runtime: RuntimeHostClient,
  input: string,
  options: RunCommandOptions,
  attachments: AgentAttachment[]
): Promise<RunCommandResult> {
  try {
    // 一次性命令总是独立任务，不能因 Host 恰好空闲而复用别人的会话。
    const { sessionId } = await runtime.ensureSession({
      isolation: options.isolated ? "worktree" : "shared",
      writeIntent: true
    });
    const submitted = runtime.submitPromptForSession(
      sessionId,
      withAttachmentReferences(input, attachments),
      attachments
    );
    const turn = await withCliAbortSignal(async (signal) => {
      const onAbort = (): void => {
        void runtime.cancelRunRequest(submitted.runId, "interrupted", sessionId);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await submitted.completion;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
    const info = runtime.getSnapshot().info;
    const usageReport = await runtime.usage();
    const usage = usageReport.summary as UsageSummary;
    const result: RunCommandResult = {
      status: turn.status,
      stopReason: turn.stopReason,
      steps: turn.steps,
      error: turn.error,
      sessionId: info.sessionId,
      sessionFile: info.sessionFile,
      modelAlias: info.modelAlias,
      provider: info.provider,
      model: info.modelLabel,
      usage,
      modelRequests: usageReport.modelRequests as ModelRequestSummary ?? {
        calls: 0,
        succeeded: 0,
        failed: 0,
        totalAttempts: 0,
        retries: 0,
        totalDurationMs: 0
      },
      verificationStatus: "not_run",
      deliveryStatus: "unverified"
    };
    if (!options.json) {
      if (turn.output) console.log(turn.output);
      console.log(`\nSession: ${info.sessionFile}`);
      assertCompletedCliRun(turn);
    }
    if (options.json) console.log(JSON.stringify(result));
    return result;
  } finally {
    await runtime.close();
  }
}

function canAttachRun(options: RunCommandOptions): boolean {
  return options.model === undefined
    && options.maxSteps === undefined
    && options.softSteps === undefined
    && options.permissionMode === undefined
    && options.headless !== true
    && options.verification === undefined
    && options.deadlineAtMs === undefined
    && process.env.BINY_MANAGED_PROCESS_LIFETIME !== "execution-environment";
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
  validateStepLimit("maxSteps", options.maxSteps);
  validateStepLimit("softSteps", options.softSteps);
  if (options.softSteps !== undefined && options.maxSteps !== undefined && options.softSteps > options.maxSteps) {
    throw new Error("softSteps cannot be greater than maxSteps.");
  }
  if (options.permissionMode !== undefined && !["ask", "read-only", "auto", "full-access"].includes(options.permissionMode)) {
    throw new Error("permissionMode must be one of ask, read-only, auto, full-access.");
  }
  if (options.attachment?.some((value) => !value.trim())) {
    throw new Error("attachment paths must not be empty.");
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
  if (options.isolated && (
    options.model !== undefined
    || options.maxSteps !== undefined
    || options.softSteps !== undefined
    || options.permissionMode !== undefined
    || options.headless === true
    || options.verification !== undefined
    || options.deadlineAtMs !== undefined
    || options.finalizationReserveMs !== undefined
  )) {
    throw new Error("--isolated uses the Runtime Host configuration and cannot be combined with --model, --max-steps, --soft-steps, --permission-mode, --headless, --verification, or deadline options.");
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

function createRunDeadlineSignal(deadlineAtMs: number, safetyMarginMs = 1_000): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const stopAtMs = Math.max(Date.now(), deadlineAtMs - safetyMarginMs);
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Run stopped at the external deadline boundary.", "TimeoutError"));
  }, Math.max(0, stopAtMs - Date.now()));
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function combineRunSignals(signal: AbortSignal, deadlineSignal?: AbortSignal): AbortSignal {
  return deadlineSignal === undefined ? signal : AbortSignal.any([signal, deadlineSignal]);
}

function closureStopReason(status: TaskClosureResult["status"]): AgentTurnOutcome["stopReason"] {
  if (status === "cancelled") return "cancelled";
  if (status === "blocked" || status === "needs_approval") return "blocked";
  return "provider_error";
}

/** 把工作区图片复制到项目附件目录，并为当前请求保留一份 base64 模型输入。 */
export async function loadRunAttachments(
  workspaceRoot: string,
  persistenceRoot: string,
  ignore: string[],
  requestedPaths: readonly string[] = []
): Promise<AgentAttachment[]> {
  const uniquePaths = [...new Set(requestedPaths.map((value) => value.trim()).filter(Boolean))];
  if (uniquePaths.length > maxRunAttachments) {
    throw new Error(`biny run accepts at most ${String(maxRunAttachments)} image attachments.`);
  }

  const loaded: Array<{ bytes: Buffer; mimeType: string; resolvedPath: string }> = [];
  let totalBytes = 0;
  for (const requestedPath of uniquePaths) {
    const mimeType = imageMimeTypes.get(path.extname(requestedPath).toLowerCase());
    if (!mimeType) throw new Error(`Unsupported image attachment type: ${requestedPath}`);
    const resolvedPath = resolveWorkspacePath(workspaceRoot, requestedPath, ignore);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) throw new Error(`Attachment is not a regular file: ${requestedPath}`);
    const bytes = await fs.readFile(resolvedPath);
    if (bytes.byteLength < 1) throw new Error(`Attachment is empty: ${requestedPath}`);
    if (bytes.byteLength > maxRunAttachmentBytes) {
      throw new Error(`Attachment exceeds 20 MiB: ${requestedPath}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > maxRunAttachmentTotalBytes) {
      throw new Error("Image attachments exceed the 40 MiB total limit.");
    }

    if (!matchesImageSignature(bytes, mimeType)) {
      throw new Error(`Attachment content does not match ${mimeType}: ${requestedPath}`);
    }
    loaded.push({ bytes, mimeType, resolvedPath });
  }
  return await Promise.all(loaded.map(async ({ bytes, mimeType, resolvedPath }) => {
    const reference = await saveAttachment(persistenceRoot, path.basename(resolvedPath), mimeType, bytes);
    return { ...reference, data: bytes.toString("base64") };
  }));
}

function matchesImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mimeType === "image/jpeg") return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/gif") {
    const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  return mimeType === "image/webp"
    && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
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
