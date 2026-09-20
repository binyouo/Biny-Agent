/**
 * 一次性 run 命令模块。
 *
 * `biny run <task>` 会创建标准命令运行时，执行单轮 agent 任务，然后打印 assistant 输出和
 * session 文件位置。它适合脚本化调用或不需要持续对话的任务。
 */
import type { AgentTurnOutcome } from "../../agent/types.js";
import { createFileConfigStore, type AgentConfigStore } from "../../config/store.js";
import type { AgentConfig } from "../../config/schema.js";
import type { PermissionMode } from "../../permission/PermissionManager.js";
import { createCommandRuntime, type CommandRuntime } from "../../runtime/CommandRuntime.js";
import { ExecutionService } from "../../runtime/ExecutionService.js";
import { SessionLeaseStore, type SessionLease } from "../../runtime/SessionLease.js";
import { connectOrSpawnRuntimeHost, connectRuntimeHost, RuntimeHostClient } from "../../runtime/RuntimeHost.js";
import type { UsageSummary } from "../../session/metadata.js";
import type { ModelRequestSummary } from "../../observability/modelRequests.js";
import { withCliAbortSignal } from "../sigint.js";

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
}

export interface RunCommandResult {
  status: AgentTurnOutcome["status"];
  stopReason: AgentTurnOutcome["stopReason"];
  steps: number;
  error?: string;
  sessionId: string;
  sessionFile: string;
  modelAlias: string;
  provider: string;
  model: string;
  usage: UsageSummary;
  modelRequests: ModelRequestSummary;
}

export async function runCommand(workspaceRoot: string, input: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
  validateRunOptions(options);
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
  if (attached) return await runAttachedCommand(attached, input, options);
  let runtime: CommandRuntime | undefined;
  let leases: SessionLeaseStore | undefined;
  let lease: SessionLease | undefined;
  let machineResult: RunCommandResult | undefined;
  try {
    runtime = await createCommandRuntime(workspaceRoot, {
      configStore: createRunConfigStore(workspaceRoot, options)
    });
    leases = await SessionLeaseStore.open(runtime.persistenceRoot);
    lease = leases.acquire(runtime.agent.getInfo().sessionId);
    const execution = await ExecutionService.create(runtime);
    const result = await withCliAbortSignal(async (signal) => await execution.execute({
      input,
      signal,
      confirmPermission: options.headless
        ? async () => ({ approved: true, scope: "session" as const })
        : undefined
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
      modelRequests: runtime.agent.modelRequestSummary()
    };
    if (!options.json) {
      if (result.turn.output) console.log(result.turn.output);
      console.log(`\nSession: ${result.session.sessionFile}`);
      assertCompletedCliRun(result.turn);
    }
  } catch (error) {
    runtime?.agent.recordError(error);
    throw error;
  } finally {
    try {
      await runtime?.close();
    } finally {
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
  options: RunCommandOptions
): Promise<RunCommandResult> {
  try {
    // 一次性命令总是独立任务，不能因 Host 恰好空闲而复用别人的会话。
    const { sessionId } = await runtime.ensureSession({
      isolation: options.isolated ? "worktree" : "shared",
      writeIntent: true
    });
    const submitted = runtime.submitPromptForSession(sessionId, input);
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
      }
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
    && options.headless !== true;
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
  if (options.isolated && (
    options.model !== undefined
    || options.maxSteps !== undefined
    || options.softSteps !== undefined
    || options.permissionMode !== undefined
    || options.headless === true
  )) {
    throw new Error("--isolated uses the Runtime Host configuration and cannot be combined with --model, --max-steps, --soft-steps, --permission-mode, or --headless.");
  }
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
