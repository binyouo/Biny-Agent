/**
 * Native tool execution coordinator.
 *
 * The model loop owns parsing and turn control. This coordinator wraps each
 * tool with Biny's permission, scheduling, progress and JSONL policies.
 */
import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { planningToolAllowed } from "./planningPolicy.js";
import { routeEditingTools, type EditingMode } from "../tools/file/editingMode.js";
import { confirmPermissionRequest } from "../permission/confirm.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { analyzePermissionRequest } from "../permission/policy.js";
import { createToolPermissionRequest } from "../tools/display/ToolDisplay.js";
import { ToolAccesses } from "../tools/access.js";
import { assertMatchingFileChange, FileChangeUncertainError, parseFileChange, type CommittedFileChange } from "../tools/file/fileChange.js";
import {
  maxEditFileBytes,
  readBoundedUtf8File,
  sameOptionalFileSnapshot,
  type FileSnapshot
} from "../tools/file/safeFileIo.js";
import { readToolResultToolName } from "../tools/file/readToolResult.js";
import { DiagnosticsRunner, formatDiagnostics } from "../tools/diagnostics.js";
import { HookRunner } from "../tools/hooks.js";
import { validateJsonSchema } from "../tools/schema.js";
import { ToolScheduler } from "../tools/scheduler.js";
import type {
  ApprovedFileSnapshot,
  Tool,
  ToolExecution,
  ToolExecutionResultStatus,
  ToolExecutionState,
  ToolRetrySafety,
  ToolInputDisplay,
  RunnableToolExecution,
  ToolRisk,
  ToolSource
} from "../tools/types.js";
import { createToolOperationId } from "../tools/types.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "../workspace/resolvePath.js";
import type { ReasoningBlock, SessionEvent } from "../session/recorder.js";
import { archiveToolResult, serializeToolResult, toolResultPreview } from "../session/toolResultArchive.js";
import { projectSingleToolResultForModel } from "./toolResultProjection.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResult,
  AgentRuntimeContext,
  AgentSessionEvent,
  AgentToolEvent
} from "./types.js";
import type { AgentTool, AgentToolResult } from "./core/types.js";

interface ToolExecutionOutcome {
  result: unknown;
  errorMessage?: string;
  permissionRequest?: AgentPermissionRequest;
  executionStatus?: ToolExecutionResultStatus;
  evidence?: string;
}

interface FilePermissionBaseline {
  exists: boolean;
  content: string;
  snapshot: FileSnapshot | null;
}

interface PermissionSnapshot {
  request: AgentPermissionRequest;
  baseline?: FilePermissionBaseline;
  targetPath?: string;
}

interface PreparedToolCall {
  ok: true;
  args: unknown;
  execution: RunnableToolExecution;
}

interface FailedPreparedToolCall {
  ok: false;
  result: unknown;
  errorMessage: string;
  executionStatus?: ToolExecutionResultStatus;
  evidence?: string;
}

const externalToolAbortDrainMs = 500;
const maxArchivedPreviewCharacters = 8_192;
/** 落盘 JSONL 的行内结果上限：超过就把全文外置到 .biny/tool-results，事件里只留归档引用。 */
const inlineResultPersistMaxBytes = 32 * 1024;

export interface AgentStepContext {
  assistantContent?: string;
  reasoningContent?: string;
  reasoningProviderOptions?: Record<string, unknown>;
  /** Individually signed reasoning blocks for this step, in provider order. */
  reasoningBlocks?: ReasoningBlock[];
}

interface ToolCallExecutionOptions {
  toolCallId: string;
  abortSignal?: AbortSignal;
}

/**
 * 工具副作用的 admission 预算。
 *
 * 额度必须在 ToolScheduler 和权限请求之前原子占用；否则一个 provider 批次可以先执行完所有
 * 并行调用，再由上层在步结束后发现超限。
 */
export interface ToolExecutionBudget {
  maxToolCalls: number;
  maxRepeatedActions: number;
  /** 进程内断点续跑时，已占用的调用额度。显式新预算窗口应传 0。 */
  initialToolCallCount?: number;
  /**
   * 旧断点只持久化了最大重复次数，没有逐动作计数。恢复时保守继承这个上界，避免重启绕过
   * 重复动作限制；显式新预算窗口应传 0。
   */
  initialMaxRepeatedActionCount?: number;
}

export interface ToolExecutionBudgetSnapshot {
  accountedToolCalls: number;
  maxRepeatedActionCount: number;
}

type ToolBudgetReason = "tool_call_limit" | "repeated_action_limit";

interface ToolBudgetRejection {
  status: "budget_rejected";
  reason: ToolBudgetReason;
  resumable: true;
  limit: number;
  attemptedToolCallCount: number;
  attemptedActionCount: number;
  error: string;
}

export class ToolExecutionCoordinator {
  private readonly admissionScheduler: ToolScheduler<unknown>;
  private readonly scheduler: ToolScheduler<ToolExecutionOutcome>;
  private readonly pendingExecutions = new Set<Promise<unknown>>();
  private readonly observedToolCallCounts = new Map<string, number>();
  private readonly duplicateToolCallIds = new Set<string>();
  private readonly duplicateExecutionCounts = new Map<string, number>();
  private permissionTail: Promise<void> = Promise.resolve();
  /** 并行工具结果也必须按顺序占用同一份回合预算，归档 I/O 期间不能让其他结果绕过预留。 */
  private toolResultBudgetTail: Promise<void> = Promise.resolve();
  /** Bytes actually handed back to the model this turn; drives the budget. */
  private inlineToolResultBytes = 0;
  /** Bytes tools produced this turn, archived or not; reported for diagnostics. */
  private producedToolResultBytes = 0;
  private readonly diagnostics: DiagnosticsRunner | undefined;
  private readonly hooks: HookRunner;
  /** 本回合是否已建过快照；每回合只建一个，建在第一次真正改动之前。 */
  private checkpointTaken = false;
  private accountedToolCallCount = 0;
  private restoredMaxRepeatedActionCount = 0;
  private readonly accountedActionCounts = new Map<string, number>();
  private readonly uncertainExecutions = new Map<string, string>();

  constructor(
    private readonly context: AgentRuntimeContext,
    private readonly permissionManager: PermissionManager,
    private readonly emit: (event: AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>) => void,
    private readonly getStepContext: () => AgentStepContext = () => ({}),
    allowedToolNames?: ReadonlySet<string>,
    private readonly executionBudget?: ToolExecutionBudget,
    private readonly onToolResultPersisted?: () => Promise<void>
  ) {
    this.allowedToolNames = allowedToolNames ? new Set(allowedToolNames) : undefined;
    if (executionBudget) {
      assertPositiveSafeInteger(executionBudget.maxToolCalls, "maxToolCalls");
      assertPositiveSafeInteger(executionBudget.maxRepeatedActions, "maxRepeatedActions");
      assertNonNegativeSafeInteger(executionBudget.initialToolCallCount ?? 0, "initialToolCallCount");
      assertNonNegativeSafeInteger(
        executionBudget.initialMaxRepeatedActionCount ?? 0,
        "initialMaxRepeatedActionCount"
      );
      this.accountedToolCallCount = executionBudget.initialToolCallCount ?? 0;
      this.restoredMaxRepeatedActionCount = executionBudget.initialMaxRepeatedActionCount ?? 0;
    }
    this.diagnostics = context.config.diagnostics.enabled
      ? new DiagnosticsRunner(context.workspaceRoot, context.config.diagnostics)
      : undefined;
    this.hooks = new HookRunner(context.workspaceRoot, context.config.hooks);
    this.admissionScheduler = new ToolScheduler({
      maxConcurrency: context.config.agent.maxConcurrentTools,
      maxQueuedTasks: context.config.agent.maxQueuedToolCalls
    });
    this.scheduler = new ToolScheduler({
      maxConcurrency: context.config.agent.maxConcurrentTools,
      // The admission scheduler already bounds the entire pipeline. At most
      // maxConcurrentTools admitted calls can reach this resource scheduler,
      // so this internal queue only needs room for those active pipelines.
      maxQueuedTasks: context.config.agent.maxConcurrentTools
    });
  }

  private readonly allowedToolNames?: Set<string>;

  /** 只扩展到当前注册表中真实存在的工具；权限、预算和审计不会随 schema 扩展而放宽。 */
  allowTools(names: readonly string[]): string[] {
    if (!this.allowedToolNames) return [];
    const registered = new Set(this.context.toolRegistry.list().map((tool) => tool.name));
    const added: string[] = [];
    for (const name of names) {
      if (!registered.has(name) || this.allowedToolNames.has(name)) continue;
      this.allowedToolNames.add(name);
      added.push(name);
    }
    return added;
  }

  /** Model-facing tool envelope. */
  createAgentTools(editing?: { mode: EditingMode; attachmentRoot?: string }): AgentTool[] {
    let entries = this.context.toolRegistry.listEntries()
      .filter(({ tool, source }) => !this.context.planning || planningToolAllowed(tool, source))
      .filter(({ tool: registered }) => !this.allowedToolNames || this.allowedToolNames.has(registered.name));
    if (editing) {
      entries = routeEditingTools(entries, { workspaceRoot: this.context.workspaceRoot, ignore: this.context.config.workspace.ignore, attachmentRoot: editing.attachmentRoot }, editing.mode);
    }
    return entries
      .map(({ tool: registered, source }) => ({
        name: registered.name,
        providerTool: registered.providerTool,
        promptSnippet: registered.promptSnippet,
        promptGuidelines: registered.promptGuidelines,
        description: registered.description,
        parameters: registered.parameters,
        // 写入工具的准备、权限确认和实际执行必须保持同一顺序，避免并发预览互相失效。
        executionMode: registered.risk === "write" ? "sequential" as const : "parallel" as const,
        execute: async (toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> => {
          const result = await this.trackExecution(this.execute(
            registered,
            args,
            { toolCallId, abortSignal: signal },
            source
          ));
          const error = failedToolResultMessage(result);
          return {
            content: [{ type: "text", text: serializeToolResult(result) }],
            details: result,
            isError: Boolean(error)
          };
        }
      }));
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingExecutions.size > 0) {
      await Promise.allSettled([...this.pendingExecutions]);
    }
  }

  private recordAndFlush(event: SessionEvent): Promise<SessionEvent> {
    const runtimeContext = this.context.runId !== undefined && this.context.turnId !== undefined
      ? { runId: this.context.runId, turnId: this.context.turnId }
      : this.context.recorder.runtimeContextSnapshot();
    return this.context.recorder.recordAndFlush(event, runtimeContext);
  }

  getExecutionBudgetSnapshot(): ToolExecutionBudgetSnapshot {
    return {
      accountedToolCalls: this.accountedToolCallCount,
      maxRepeatedActionCount: Math.max(
        this.restoredMaxRepeatedActionCount,
        0,
        ...this.accountedActionCounts.values()
      )
    };
  }

  assertCanContinue(): void {
    const unknown = this.uncertainExecutions.entries().next().value;
    if (!unknown) return;
    const [operationId, tool] = unknown;
    throw new Error(`Cannot continue: tool ${tool} (${operationId}) has an unknown side effect. Inspect its outcome before retrying.`);
  }

  observeToolCall(toolCallId: string): string | undefined {
    const count = (this.observedToolCallCounts.get(toolCallId) ?? 0) + 1;
    this.observedToolCallCounts.set(toolCallId, count);
    if (count < 2) return undefined;
    this.duplicateToolCallIds.add(toolCallId);
    return `Duplicate tool call id received from the model: ${toolCallId}. The turn was stopped before tool execution.`;
  }

  async handleInvalidToolCall(toolName: string, toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.allowedToolNames && !this.allowedToolNames.has(toolName)) {
      const call = { id: toolCallId, name: toolName, args: input };
      const sequence = this.nextSequence();
      const operationId = createToolOperationId(this.context.recorder.sessionId, toolCallId);
      const errorMessage = `Tool ${toolName} is not available in the current mode.`;
      const stepContext = this.getStepContext();
      await this.recordAndFlush({
        type: "tool_call",
        tool: toolName,
        args: input,
        toolCallId,
        sequence,
        assistantContent: stepContext.assistantContent,
        reasoningContent: stepContext.reasoningContent,
        reasoningProviderOptions: stepContext.reasoningProviderOptions,
        reasoningBlocks: stepContext.reasoningBlocks
      });
      await this.recordAndFlush({ type: "tool_execution", tool: toolName, toolCallId, sequence, operationId, state: "not_started", retrySafety: "unknown" });
      await this.recordAndFlush({ type: "tool_execution", tool: toolName, toolCallId, sequence, operationId, state: "failed", evidence: errorMessage, retrySafety: "unknown" });
      this.emit({ type: "tool.started", toolCallId, tool: toolName, args: input, operationId });
      return await this.finishSyntheticCall(call, sequence, { error: errorMessage }, errorMessage, { executionStatus: "failed", operationId });
    }
    let registered: Tool;
    try {
      registered = this.context.toolRegistry.get(toolName);
    } catch {
      const result = { error: `Unknown tool: ${toolName}` };
      const sequence = this.nextSequence();
      const operationId = createToolOperationId(this.context.recorder.sessionId, toolCallId);
      await this.recordAndFlush({
        type: "tool_call",
        tool: toolName,
        args: input,
        toolCallId,
        sequence,
        assistantContent: this.getStepContext().assistantContent,
        reasoningContent: this.getStepContext().reasoningContent,
        reasoningProviderOptions: this.getStepContext().reasoningProviderOptions,
        reasoningBlocks: this.getStepContext().reasoningBlocks
      });
      await this.recordAndFlush({ type: "tool_execution", tool: toolName, toolCallId, sequence, operationId, state: "not_started", retrySafety: "unknown" });
      await this.recordAndFlush({ type: "tool_execution", tool: toolName, toolCallId, sequence, operationId, state: "failed", evidence: result.error, retrySafety: "unknown" });
      this.emit({ type: "tool.started", toolCallId, tool: toolName, args: input, operationId });
      return await this.finishSyntheticCall(
        { id: toolCallId, name: toolName, args: input },
        sequence,
        result,
        result.error,
        { executionStatus: "failed", operationId }
      );
    }
    const source = this.context.toolRegistry.listEntries().find((entry) => entry.tool.name === toolName)?.source ?? registered.source ?? "builtin";
    return await this.execute(registered, input, { toolCallId, abortSignal: signal }, source);
  }

  private async execute(toolDefinition: Tool, input: unknown, options: ToolCallExecutionOptions, source: ToolSource): Promise<unknown> {
    // Tool calls are observed from fullStream before model-call-end starts the
    // batch. Yield once so every id in the batch can be classified before any
    // side effect is admitted.
    await Promise.resolve();
    const duplicate = this.duplicateToolCallIds.has(options.toolCallId);
    const sequence = this.nextSequence();
    const call = {
      id: duplicate ? this.duplicateAuditId(options.toolCallId, sequence) : options.toolCallId,
      name: toolDefinition.name,
      args: input
    };
    const signal = options.abortSignal;
    const stepContext = this.getStepContext();
    const operationId = createToolOperationId(this.context.recorder.sessionId, call.id);
    await this.recordAndFlush({
      type: "tool_call",
      tool: call.name,
      args: call.args,
      toolCallId: call.id,
      sequence,
      assistantContent: stepContext.assistantContent,
      reasoningContent: stepContext.reasoningContent,
      reasoningProviderOptions: stepContext.reasoningProviderOptions,
      reasoningBlocks: stepContext.reasoningBlocks
    });
    let latestState: ToolExecutionState = "not_started";
    let latestEvidence: string | undefined;
    let retrySafety: ToolRetrySafety = "unknown";
    let executionStarted = false;
    let finishPromise: Promise<unknown> | undefined;
    let committedChange: CommittedFileChange | undefined;
    const updateState = (state: ToolExecutionState, evidence?: string): void => {
      latestState = state;
      latestEvidence = evidence ?? latestEvidence;
      if (state === "unknown") this.uncertainExecutions.set(operationId, call.name);
      else this.uncertainExecutions.delete(operationId);
    };
    const persistState = async (state: ToolExecutionState, evidence?: string): Promise<void> => {
      updateState(state, evidence);
      await this.recordAndFlush({
        type: "tool_execution",
        tool: call.name,
        toolCallId: call.id,
        sequence,
        operationId,
        state,
        evidence: latestEvidence,
        retrySafety
      });
    };
    const recordState = (state: ToolExecutionState, evidence?: string): void => {
      updateState(state, evidence);
      void this.recordAndFlush({
        type: "tool_execution",
        tool: call.name,
        toolCallId: call.id,
        sequence,
        operationId,
        state,
        evidence: latestEvidence,
        retrySafety
      }).catch(() => undefined);
    };
    await persistState("not_started");
    const onAbort = (): void => {
      if (latestState === "running" || latestState === "admitted" || latestState === "side_effect_committed") recordState("cancel_requested", "Cancellation was requested while the tool was executing.");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (
      result: unknown,
      errorMessage?: string,
      executionStatus?: ToolExecutionResultStatus,
      auditOnly = false
    ): Promise<unknown> => {
      if (finishPromise) return finishPromise;
      if (committedChange && typeof result === "object" && result !== null && !Array.isArray(result)) {
        result = { ...result, change: committedChange };
      }
      const status = executionStatus ?? terminalResultStatus(latestState, result);
      finishPromise = (async () => {
        const neverStarted = latestState === "not_started";
        const terminalState = executionStateForResultStatus(status);
        if (latestState !== terminalState) await persistState(terminalState, latestEvidence);
        return await this.finishSyntheticCall(
          call,
          sequence,
          exposeExecutionMetadata(result, status, operationId, latestEvidence),
          errorMessage,
          {
            executionStatus: status,
            operationId,
            evidence: latestEvidence,
            auditOnly: auditOnly || neverStarted && status === "cancelled"
          }
        );
      })();
      return finishPromise;
    };

    try {
      if (duplicate) {
        this.emit({ type: "tool.started", toolCallId: call.id, tool: call.name, args: call.args, operationId });
        const message = `Duplicate tool call id was rejected before execution: ${options.toolCallId}.`;
        // The turn already emitted one fatal protocol error. Keep each rejected
        // call auditable through its tool_result without duplicating UI errors.
        return await finish({ error: message, duplicateToolCallId: true }, message, "failed");
      }
      if (this.context.planning && !planningToolAllowed(toolDefinition, source)) {
        const message = "Planning mode forbids execution and workspace mutation. Ask the user to start the plan.";
        return await finish({ error: message }, message, "failed");
      }
      if (signal?.aborted) {
        this.emit({ type: "tool.started", toolCallId: call.id, tool: call.name, args: call.args, operationId });
        const message = abortedToolMessage(call.name, signal.reason);
        return await finish({ status: "skipped", error: message }, message, "cancelled");
      }
      const budgetRejection = this.admitToolCall(call);
      if (budgetRejection) {
        this.emit({ type: "tool.started", toolCallId: call.id, tool: call.name, args: call.args, operationId });
        return await finish(budgetRejection, budgetRejection.error, "failed");
      }

      return await this.admissionScheduler.schedule({
        accesses: ToolAccesses.none(),
        signal,
        start: async () => {
          signal?.throwIfAborted();
          await persistState("running");
          const prepared = await this.prepareToolCall(toolDefinition, call, source, signal);
          if (!prepared.ok) {
            this.emit({ type: "tool.started", toolCallId: call.id, tool: call.name, args: call.args, operationId });
            return await finish(prepared.result, prepared.errorMessage, prepared.executionStatus ?? "failed");
          }
          retrySafety = prepared.execution.retrySafety ?? (toolDefinition.risk === "read" ? "safe" : "unknown");
          updateState(latestState, latestEvidence);

          this.emit({
            type: "tool.started",
            toolCallId: call.id,
            tool: call.name,
            args: call.args,
            description: prepared.execution.description,
            display: prepared.execution.display,
            operationId
          });

          signal?.throwIfAborted();
          const permissionSnapshot = await this.buildPermissionSnapshot(call, prepared.args, prepared.execution, toolDefinition.risk, signal);
          const permissionRequest = permissionSnapshot.request;
          signal?.throwIfAborted();
          const evaluation = this.permissionManager.evaluate(permissionRequest);
          let grantedPermission: AgentPermissionResult | undefined;
          if (evaluation.decision === "deny") {
            this.permissionManager.applyResult(permissionRequest, { approved: false, message: evaluation.reason });
            return await finish(deniedToolResult(permissionRequest, evaluation.reason), undefined, "failed");
          }

          if (evaluation.decision === "ask") {
            const permissionResult: AgentPermissionResult = await this.withPermissionGate(async () => {
              signal?.throwIfAborted();
              const gatedEvaluation = this.permissionManager.evaluate(permissionRequest);
              if (gatedEvaluation.decision === "deny") {
                const result = { approved: false as const, message: gatedEvaluation.reason };
                this.permissionManager.applyResult(permissionRequest, result);
                return result;
              }
              if (gatedEvaluation.decision === "allow") return { approved: true as const, scope: "once" as const };
              permissionRequest.canRemember = gatedEvaluation.canRemember;
              const result = this.context.confirmPermission
                ? await this.context.confirmPermission(permissionRequest)
                : await confirmPermissionRequest(permissionRequest, signal);
              signal?.throwIfAborted();
              const validatedResult = validateStrongConfirmation(permissionRequest, result);
              this.permissionManager.applyResult(permissionRequest, validatedResult);
              if (validatedResult.approved) grantedPermission = validatedResult;
              return validatedResult;
            }, signal);
            if (!permissionResult.approved) {
              return await finish(deniedToolResult(permissionRequest, permissionResult.message ?? "Denied by user."), undefined, "failed");
            }
          } else {
            this.permissionManager.applyResult(permissionRequest, { approved: true, scope: "once" });
          }

          const outcome = await this.scheduler.schedule({
            accesses: prepared.execution.accesses ?? ToolAccesses.all(),
            signal,
            start: async () => {
              signal?.throwIfAborted();
              this.assertCanContinue();
              if (permissionSnapshot.baseline) {
                let currentSnapshot: PermissionSnapshot;
                try {
                  currentSnapshot = await this.buildPermissionSnapshot(call, prepared.args, prepared.execution, toolDefinition.risk, signal);
                } catch (error) {
                  if (isAbortError(error, signal)) throw error;
                  this.permissionManager.revokeResult(permissionRequest, grantedPermission);
                  const message = `The target changed after the permission preview: ${formatToolError(call.name, error)} Retry the tool call to review and approve the current target.`;
                  return {
                    result: { status: "permission_required", approved: false, stalePreview: true, reason: message },
                    executionStatus: "failed" as const,
                    errorMessage: message
                  };
                }
                if (permissionSnapshot.targetPath !== currentSnapshot.targetPath
                  || !sameFileBaseline(permissionSnapshot.baseline, currentSnapshot.baseline)
                  || !samePermissionPreview(permissionRequest, currentSnapshot.request)) {
                  this.permissionManager.revokeResult(permissionRequest, grantedPermission);
                  const message = "The target changed after the permission preview. Retry the tool call to review and approve the updated contents.";
                  return {
                    result: { status: "permission_required", approved: false, stalePreview: true, reason: message },
                    executionStatus: "failed" as const,
                    errorMessage: message,
                    permissionRequest: currentSnapshot.request
                  };
                }
              }
              const approvedFile = permissionSnapshot.baseline && permissionSnapshot.targetPath
                ? { path: permissionSnapshot.targetPath, snapshot: permissionSnapshot.baseline.snapshot }
                : undefined;
              const blocked = await this.runBeforeToolHooks(call.name, prepared.args, signal);
              if (blocked) return blocked;
              await this.ensureCheckpoint(toolDefinition.risk, call.name);
              // 这是工具副作用前的持久边界：记录成功后才允许进入 executeResolvedTool。
              // 崩溃发生在这里之后时，恢复不能再假设工具没有运行。
              await persistState("admitted");
              return await this.executeResolvedTool(
                call,
                prepared.execution,
                source,
                signal,
                approvedFile,
                operationId,
                retrySafety,
                (state, evidence) => recordState(state, evidence),
                () => { executionStarted = true; },
                toolDefinition.parameters,
                async (change) => {
                  try {
                    if (!prepared.execution.fileChange) throw new Error("File change was not declared before execution.");
                    assertMatchingFileChange(prepared.execution.fileChange, change);
                    if (committedChange) {
                      if (stableJson(committedChange) !== stableJson(change)) throw new Error("Conflicting file commit evidence.");
                      return;
                    }
                    const event = await this.recordAndFlush({
                      type: "tool_execution", tool: call.name, toolCallId: call.id, sequence, operationId,
                      state: "side_effect_committed", change, fileChangeIsResult: prepared.execution.fileChangeIsResult === true,
                      retrySafety
                    });
                    committedChange = change;
                    updateState("side_effect_committed");
                    // 广播使用落盘后的脱敏记录，不能把原始文件内容绕过 recorder 发给界面。
                    if (event.type === "tool_execution" && event.change) {
                      this.emit({ type: "tool.change_committed", tool: call.name, toolCallId: call.id, operationId, change: event.change });
                    }
                  } catch (error) {
                    updateState("unknown", "File commit evidence could not be persisted.");
                    throw new FileChangeUncertainError(`File side effect occurred, but commit evidence could not be recorded: ${formatToolError(call.name, error)}`);
                  }
                }
              );
            }
          });
          const diagnosed = await this.attachDiagnostics(toolDefinition.risk, prepared.args, outcome.result, outcome.errorMessage, signal);
          const hooked = await this.attachAfterToolHooks(call.name, prepared.args, diagnosed, signal);
          return await finish(
            hooked,
            outcome.errorMessage,
            outcome.executionStatus ?? terminalResultStatus(latestState, hooked)
          );
        }
      });
    } catch (error) {
      const aborted = isAbortError(error, signal);
      const status = aborted
        ? classifyCancellation(latestState, executionStarted, retrySafety)
        : "failed";
      const message = aborted ? abortedToolMessage(call.name, error) : formatToolError(call.name, error);
      return await finish(
        aborted ? { status: status === "unknown" ? "unknown" : status, error: message } : { error: message },
        message,
        status
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async finishSyntheticCall(
    call: { id: string; name: string; args: unknown },
    sequence: number,
    result: unknown,
    errorMessage: string | undefined,
    metadata: {
      executionStatus?: ToolExecutionResultStatus;
      recovered?: boolean;
      operationId?: string;
      evidence?: string;
      auditOnly?: boolean;
    } = {}
  ): Promise<unknown> {
    const modelResult = await this.applyToolResultBudget(call, sequence, result);
    // 模型侧预算只改变返回值；session、实时界面和归档都以工具实际产出的结果为事实。
    // 否则一次预算溢出会把“模型看见的引用”误当成工具真正返回的内容，后续恢复只能看到二次包装。
    const persistedResult = await this.outlineToolResultForPersistence(call, sequence, result);
    await this.recordAndFlush({
      type: "tool_result",
      tool: call.name,
      result: persistedResult,
      toolCallId: call.id,
      sequence,
      executionStatus: metadata.executionStatus,
      recovered: metadata.recovered,
      operationId: metadata.operationId,
      evidence: metadata.evidence,
      auditOnly: metadata.auditOnly
    });
    try {
      await this.onToolResultPersisted?.();
    } catch {
      // TurnStore 是崩溃安全断点，不能把已经持久化的 tool_result 变成工具失败。
    }
    this.context.contextMemory?.observeToolResult(call.name, call.args, result);
    if (errorMessage) {
      this.context.recorder.record({ type: "error", message: errorMessage });
      this.emit({ type: "error", message: errorMessage, recorded: true, fatal: false });
    }
    this.emitToolResult(call, result, errorMessage, metadata);
    return modelResult;
  }

  private emitToolResult(
    call: { id: string; name: string },
    result: unknown,
    errorMessage?: string,
    metadata: { executionStatus?: ToolExecutionResultStatus; recovered?: boolean; operationId?: string; evidence?: string } = {}
  ): void {
    const durationMs = resultNumber(result, "durationMs");
    const error = metadata.executionStatus === "unknown" || metadata.executionStatus === "cancelled"
      ? undefined
      : errorMessage ?? failedToolResultMessage(result);
    if (error) {
      this.emit({
        type: "tool.failed",
        toolCallId: call.id,
        tool: call.name,
        error,
        result,
        durationMs,
        executionStatus: metadata.executionStatus,
        recovered: metadata.recovered,
        operationId: metadata.operationId,
        evidence: metadata.evidence
      });
      return;
    }
    this.emit({
      type: "tool.completed",
      toolCallId: call.id,
      tool: call.name,
      result,
      durationMs,
      executionStatus: metadata.executionStatus,
      recovered: metadata.recovered,
      operationId: metadata.operationId,
      evidence: metadata.evidence
    });
  }

  /**
   * The loop retains every returned value until the turn finishes. Keep the
   * first bounded slice of useful results inline, then preserve
   * later outputs durably instead of letting ordinary repository inspection
   * overflow the provider context window.
   *
   * The budget bounds what actually reaches the model, so an archived result's
   * own envelope and preview are charged against it too. Once the budget is
   * spent, later results collapse to a bare reference the model can reopen with
   * `read_tool_result` — otherwise a long turn would still accumulate one
   * preview per step and overflow the window it was meant to protect.
   */
  private applyToolResultBudget(
    call: { id: string; name: string; args: unknown },
    sequence: number,
    result: unknown
  ): Promise<unknown> {
    const current = this.toolResultBudgetTail.then(async () => {
      const budget = this.context.config.context.maxTurnToolResultBytes;
      const rawOutput = serializeToolResult(result);
      const rawResultBytes = Buffer.byteLength(rawOutput, "utf8");
      const modelResult = await projectSingleToolResultForModel(call.name, call.args, result, {
        toolCallId: call.id,
        sequence,
        archiveResult: async ({ result: archivedResult, output }) => await archiveToolResult({
          workspaceRoot: this.context.workspaceRoot,
          sessionId: this.context.recorder.sessionId,
          toolCallId: call.id,
          sequence,
          tool: call.name,
          result: archivedResult,
          output
        })
      });
      const output = serializeToolResult(modelResult);
      const resultBytes = Buffer.byteLength(output, "utf8");
      this.producedToolResultBytes += rawResultBytes;
      const remaining = Math.max(0, budget - this.inlineToolResultBytes);
      // 两种显式回查都已限制单页大小；预算耗尽时再次归档会让模型永远读不到证据。
      if (resultBytes <= remaining || call.name === readToolResultToolName || call.name === "read_checkpoint_evidence") {
        this.inlineToolResultBytes += resultBytes;
        return modelResult;
      }

      const envelope = await this.archivedToolResultEnvelope(call, sequence, result, rawOutput, rawResultBytes, remaining);
      this.inlineToolResultBytes += Buffer.byteLength(serializeToolResult(envelope), "utf8");
      return envelope;
    });
    this.toolResultBudgetTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async archivedToolResultEnvelope(
    call: { id: string; name: string },
    sequence: number,
    result: unknown,
    output: string,
    resultBytes: number,
    remaining: number
  ): Promise<Record<string, unknown>> {
    // 预算耗尽后连摘要都不再放行，只留引用；否则每步一个 preview 仍会把窗口撑爆。
    const preview = toolResultPreview(output, Math.min(remaining, maxArchivedPreviewCharacters));
    const shared = {
      archived: true,
      resultBytes,
      resultFingerprint: createHash("sha256").update(output).digest("hex"),
      producedResultBytes: this.producedToolResultBytes,
      turnBudgetBytes: this.context.config.context.maxTurnToolResultBytes,
      ...(preview ? { preview } : {})
    };
    try {
      const archived = await archiveToolResult({
        workspaceRoot: this.context.workspaceRoot,
        sessionId: this.context.recorder.sessionId,
        toolCallId: call.id,
        sequence,
        tool: call.name,
        result,
        output
      });
      return {
        ...shared,
        archivePath: archived.archivePath,
        summary: `Tool result exceeded the ${String(this.context.config.context.maxTurnToolResultBytes)} byte turn output budget and was archived. Call read_tool_result with archivePath "${archived.archivePath}" to read it.`
      };
    } catch (error) {
      return {
        ...shared,
        archiveError: formatToolError(call.name, error),
        result,
        summary: "Tool result exceeded the turn output budget, but archiving failed. The original result is included under result and remains in session history."
      };
    }
  }

  /**
   * 持久化层的大结果外置：回合预算只约束模型上下文，落盘 JSONL 的单行仍可能拖到 MB 级，
   * 让列表扫描、打开会话和回放全部变慢。超过行内上限的结果归档到 .biny/tool-results，
   * 事件里只留与预算归档一致的 envelope（preview + archivePath）；回放时模型看到的是
   * preview + 可取回全文的指引，运行中的内存上下文与实时事件不受影响。
   */
  private async outlineToolResultForPersistence(
    call: { id: string; name: string },
    sequence: number,
    modelResult: unknown
  ): Promise<unknown> {
    // 工具本身若已经返回可取回的归档引用，不再重复包装它。
    if (typeof modelResult === "object" && modelResult !== null && (modelResult as { archived?: unknown }).archived === true) {
      return modelResult;
    }
    const output = serializeToolResult(modelResult);
    const resultBytes = Buffer.byteLength(output, "utf8");
    if (resultBytes <= inlineResultPersistMaxBytes) return modelResult;
    const preview = toolResultPreview(output, maxArchivedPreviewCharacters);
    try {
      const archived = await archiveToolResult({
        workspaceRoot: this.context.workspaceRoot,
        sessionId: this.context.recorder.sessionId,
        toolCallId: call.id,
        sequence,
        tool: call.name,
        result: modelResult,
        output
      });
      return {
        archived: true,
        archivePath: archived.archivePath,
        resultBytes,
        preview,
        summary: `Tool result exceeded the ${String(inlineResultPersistMaxBytes)} byte inline persistence limit and was archived. Call read_tool_result with archivePath "${archived.archivePath}" to read it.`
      };
    } catch (error) {
      // 归档失败不能把工具调用变成失败：留预览和错误说明，模型仍能继续。
      return {
        archived: true,
        resultBytes,
        preview,
        archiveError: formatToolError(call.name, error),
        result: modelResult,
        summary: "Tool result exceeded the inline persistence limit, but archiving failed. The original result is included under result and remains in session history."
      };
    }
  }

  /**
   * 执行前钩子。任一条非零退出就阻止这次调用，并把它的输出作为拒绝理由回给模型 —— 模型
   * 需要知道为什么被拦，否则只会原样重试。
   */
  private async runBeforeToolHooks(tool: string, args: unknown, signal?: AbortSignal): Promise<ToolExecutionOutcome | undefined> {
    if (this.context.planning || !this.hooks.hasHooks("beforeTool")) return undefined;
    const outcomes = await this.hooks.run("beforeTool", { tool, path: mutatedFilePath(args) ?? "" }, signal);
    const failed = outcomes.find((outcome) => outcome.exitCode !== 0);
    if (!failed) return undefined;
    const message = `Blocked by a configured beforeTool hook (${failed.command}): ${failed.output || `exit ${String(failed.exitCode)}`}`;
    return { result: { status: "blocked_by_hook", hook: failed.command, exitCode: failed.exitCode, output: failed.output }, errorMessage: message };
  }

  /** 执行后钩子的输出只作为附加信息；它的退出码不改变这次调用的成败。 */
  private async attachAfterToolHooks(tool: string, args: unknown, result: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.context.planning || !this.hooks.hasHooks("afterTool")) return result;
    try {
      const outcomes = await this.hooks.run("afterTool", { tool, path: mutatedFilePath(args) ?? "" }, signal);
      if (!outcomes.length) return result;
      return typeof result === "object" && result !== null && !Array.isArray(result)
        ? { ...result as Record<string, unknown>, hooks: outcomes }
        : { result, hooks: outcomes };
    } catch {
      return result;
    }
  }

  /**
   * 本回合第一次真正改动工作区之前建一个快照。
   *
   * 建在权限通过之后、执行之前：用户拒绝的调用不该留下快照，而一旦要执行就必须先有退路。
   * 建快照失败不能挡住工具执行 —— 没有 git 仓库是常态，为此拒绝干活是本末倒置。
   */
  private async ensureCheckpoint(risk: ToolRisk | undefined, toolName: string): Promise<void> {
    if (this.context.planning || this.checkpointTaken || risk !== "write" || !this.context.createCheckpoint) return;
    this.checkpointTaken = true;
    try {
      await this.context.createCheckpoint(`before ${toolName}`);
    } catch {
      // 快照不可用时静默继续；/undo 会告诉用户没有可回退的点。
    }
  }

  /**
   * 写入类工具成功后跑一次项目自己的检查，把结果挂在该次工具结果上。
   *
   * 只在成功路径上跑：失败的编辑没改动文件，跑检查只是浪费时间并可能报告上一次的旧错误。
   * 诊断自身出错也不能影响工具结果 —— 它是附加信息，不是这次调用的成败依据。
   */
  private async attachDiagnostics(
    risk: ToolRisk | undefined,
    args: unknown,
    result: unknown,
    errorMessage: string | undefined,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.context.planning || !this.diagnostics || errorMessage || risk !== "write") return result;
    const targetPath = mutatedFilePath(args);
    if (!targetPath) return result;
    try {
      const outcome = await this.diagnostics.run(targetPath, signal);
      if (!outcome) return result;
      const diagnostics = formatDiagnostics(outcome);
      return typeof result === "object" && result !== null && !Array.isArray(result)
        ? { ...result as Record<string, unknown>, diagnostics }
        : { result, diagnostics };
    } catch {
      return result;
    }
  }

  private async prepareToolCall(
    toolDefinition: Tool,
    call: { id: string; name: string; args: unknown },
    source: ToolSource,
    signal?: AbortSignal
  ): Promise<PreparedToolCall | FailedPreparedToolCall> {
    let resolution: Promise<ToolExecution> | undefined;
    try {
      const schemaValidation = validateJsonSchema(toolDefinition.parameters, call.args);
      if (!schemaValidation.ok) {
        const message = `Invalid tool arguments for ${call.name}: ${schemaValidation.errors.join("; ")}`;
        return { ok: false, result: { error: message, validation: true }, errorMessage: message };
      }
      const args = toolDefinition.schema.parse(call.args);
      resolution = Promise.resolve(toolDefinition.resolveExecution(args));
      const execution = source === "builtin"
        ? await resolution
        : await waitForAbortWithDrain(resolution, signal, externalToolAbortDrainMs);
      if (isToolExecutionError(execution)) return { ok: false, result: execution.result, errorMessage: execution.errorMessage };
      return { ok: true, args, execution };
    } catch (error) {
      if (error instanceof ExternalToolQuarantineError && resolution) {
        this.context.quarantineExternalTool?.(call.name, call.id, resolution);
        const message = `Tool ${call.name} was aborted, but its external ${source} resolveExecution did not settle within ${String(externalToolAbortDrainMs)}ms. This agent session is quarantined until that resolution settles, so later operations cannot overlap its possible side effects.`;
        return {
          ok: false,
          result: {
            status: "unknown",
            quarantined: true,
            externalToolSource: source,
            stage: "resolveExecution",
            error: message
          },
          errorMessage: message,
          executionStatus: "unknown",
          evidence: message
        };
      }
      if (isAbortError(error, signal)) throw error;
      const message = formatToolError(call.name, error);
      return {
        ok: false,
        result: error instanceof ZodError ? { error: message, validation: true } : { error: message },
        errorMessage: message
      };
    }
  }

  private async executeResolvedTool(
    call: { id: string; name: string; args?: unknown },
    execution: RunnableToolExecution,
    source: ToolSource,
    signal?: AbortSignal,
    approvedFile?: ApprovedFileSnapshot,
    operationId?: string,
    retrySafety: ToolRetrySafety = "unknown",
    onExecutionState?: (state: ToolExecutionState, evidence?: string) => void,
    onStarted?: () => void,
    capabilitySchema?: unknown,
    onFileChangeCommitted?: (change: CommittedFileChange) => Promise<void>
  ): Promise<ToolExecutionOutcome> {
    const startedAt = Date.now();
    let executionPromise: Promise<unknown> | undefined;
    let executionStarted = false;
    let latestExecutionState: ToolExecutionState = "running";
    let committedChange: CommittedFileChange | undefined;
    const reportExecutionState = (state: ToolExecutionState, evidence?: string): void => {
      latestExecutionState = state;
      onExecutionState?.(state, evidence);
    };
    try {
      signal?.throwIfAborted();
      executionStarted = true;
      onStarted?.();
      const executeWithSignal = (executionSignal?: AbortSignal): Promise<unknown> => execution.execute({
        toolCallId: call.id,
        operationId: operationId ?? createToolOperationId(this.context.recorder.sessionId, call.id),
        sessionId: this.context.recorder.sessionId,
        runId: this.context.runId,
        turnId: this.context.turnId,
        signal: executionSignal,
        onUpdate: (update) => {
          if (!executionSignal?.aborted) this.emit({ type: "tool.progress", toolCallId: call.id, tool: call.name, update });
        },
        onExecutionState: reportExecutionState,
        onFileChangeCommitted: async (change) => {
          // 解析会复制记录，防止扩展在 await 期间修改同一对象，令返回结果与落盘证据分叉。
          const snapshot = parseFileChange(change);
          if (!snapshot) throw new FileChangeUncertainError("Invalid file commit evidence after a possible side effect.");
          await onFileChangeCommitted?.(snapshot);
          committedChange = snapshot;
          latestExecutionState = "side_effect_committed";
        },
        approvedFile
      });
      executionPromise = (source === "mcp" || source === "plugin") && this.context.capabilities
        ? this.context.capabilities.executeHostCapability({
          capabilityName: `host:${source}:${call.name}`,
          schema: capabilitySchema ?? { type: "object" },
          sessionId: this.context.recorder.sessionId,
          runId: this.context.runId,
          turnId: this.context.turnId,
          toolCallId: call.id,
          offerId: operationId,
          request: call.args ?? {}
        }, executeWithSignal, signal)
        : executeWithSignal(signal);
      // Built-ins own a real cancellation contract, so their scheduler resources
      // remain held until the underlying operation has actually stopped. External
      // tools get a bounded drain so a non-cooperative extension cannot hang close.
      const result = source === "builtin"
        ? await executionPromise
        : await waitForAbortWithDrain(executionPromise, signal, externalToolAbortDrainMs);
      if (execution.fileChangeIsResult) {
        const resultChange = typeof result === "object" && result !== null ? parseFileChange((result as { change?: unknown }).change) : undefined;
        if (!committedChange || !resultChange || stableJson(committedChange) !== stableJson(resultChange)) {
          throw new FileChangeUncertainError("File change result does not match durable commit evidence.");
        }
      }
      const summarized = attachToolSummary(result, Date.now() - startedAt);
      const executionFailure = failedToolResultMessage(summarized);
      reportExecutionState(executionFailure ? "failed" : "succeeded", executionFailure);
      return {
        result: summarized,
        errorMessage: executionFailure,
        executionStatus: executionFailure ? "failed" : "succeeded",
        evidence: executionFailure
      };
    } catch (error) {
      if (error instanceof ExternalToolQuarantineError && executionPromise) {
        this.context.quarantineExternalTool?.(call.name, call.id, executionPromise);
        const message = `Tool ${call.name} was aborted, but its external ${source} execution did not settle within ${String(externalToolAbortDrainMs)}ms. This agent session is quarantined until that execution settles, so later operations cannot overlap its possible side effects.`;
        reportExecutionState("unknown", message);
        return {
          result: {
            status: "unknown",
            quarantined: true,
            externalToolSource: source,
            error: message,
            durationMs: Date.now() - startedAt
          },
          errorMessage: message,
          executionStatus: "unknown",
          evidence: message
        };
      }
      const message = formatToolError(call.name, error);
      const aborted = isAbortError(error, signal);
      const status: ToolExecutionResultStatus = error instanceof FileChangeUncertainError ? "unknown" : aborted
        ? isSideEffectCommitted(latestExecutionState)
          ? "unknown"
          : !executionStarted || retrySafety === "safe" || retrySafety === "idempotent"
            ? "cancelled"
            : "unknown"
        : "failed";
      reportExecutionState(executionStateForResultStatus(status), message);
      return {
        result: aborted
          ? { status: status === "unknown" ? "unknown" : "cancelled", error: message, durationMs: Date.now() - startedAt }
          : { error: message, durationMs: Date.now() - startedAt },
        errorMessage: message,
        executionStatus: status,
        evidence: message
      };
    }
  }

  private async buildPermissionRequest(
    call: { id: string; name: string; args: unknown },
    args: unknown,
    execution: RunnableToolExecution,
    toolRisk: ToolRisk | undefined
  ): Promise<AgentPermissionRequest> {
    const permissionArgs = this.canonicalPermissionArgs(args, execution);
    const permissionContext = analyzePermissionRequest({
      toolName: call.name,
      args: permissionArgs,
      sessionId: this.context.recorder.sessionId,
      projectRoot: this.context.workspaceRoot,
      toolRisk,
      fileChange: execution.fileChange
    });
    const request = await createToolPermissionRequest({ id: call.id, name: call.name, args: permissionArgs }, {
      workspaceRoot: this.context.workspaceRoot,
      ignore: this.context.config.workspace.ignore,
      sessionId: this.context.recorder.sessionId
    }, permissionContext);
    return {
      ...request,
      requireFullYes: request.requireFullYes || execution.fileChange?.operation === "delete" || execution.fileChange?.operation === "move",
      approvalRule: permissionApprovalFingerprint(execution.approvalRule, permissionArgs),
      reason: execution.description ?? request.reason,
      changeSummary: request.changeSummary ?? displaySummary(execution.display)
    };
  }

  private canonicalPermissionArgs(args: unknown, execution: RunnableToolExecution): unknown {
    if (execution.fileChange?.server) return args;
    if (typeof args !== "object" || args === null || !("path" in args) || typeof args.path !== "string") return args;
    if (args.path.startsWith("@attachments/")) return args;
    const declaredPath = execution.accesses?.find((access) => access.kind === "file")?.path;
    if (!declaredPath) return args;
    const relative = toWorkspaceRelative(this.context.workspaceRoot, declaredPath);
    const firstSegment = relative.split(/[\\/]+/u)[0];
    if (relative === "." || firstSegment === "..") return args;
    return { ...args, path: relative };
  }

  private async buildPermissionSnapshot(
    call: { id: string; name: string; args: unknown },
    args: unknown,
    execution: RunnableToolExecution,
    toolRisk: ToolRisk | undefined,
    signal?: AbortSignal
  ): Promise<PermissionSnapshot> {
    signal?.throwIfAborted();
    const targetPath = this.resolvePermissionTarget(execution);
    const before = await this.captureFileBaseline(targetPath, signal);
    signal?.throwIfAborted();
    const request = await this.buildPermissionRequest(call, args, execution, toolRisk);
    signal?.throwIfAborted();
    if (!before) return { request, baseline: undefined, targetPath: undefined };

    const currentTargetPath = this.resolvePermissionTarget(execution);
    const after = await this.captureFileBaseline(currentTargetPath, signal);
    if (targetPath !== currentTargetPath || !sameFileBaseline(before, after)) {
      throw new Error("The target changed while the permission preview was being generated. Retry the tool call to review the current contents.");
    }
    return { request, baseline: after, targetPath };
  }

  private resolvePermissionTarget(execution: RunnableToolExecution): string | undefined {
    if (execution.fileChange?.server) return undefined;
    const declaredAccess = execution.accesses?.find((access) =>
      access.kind === "file" && (access.operation === "write" || access.operation === "readwrite")
    );
    const declaredPath = declaredAccess?.kind === "file" ? declaredAccess.path : undefined;
    // 内置文件工具用 fileChange 作为变更权威；扩展工具尚未提供协议元数据时，仍以已解析的
    // 写访问声明建立授权快照，不能因此失去授权后的目标变化检查。
    if (!execution.fileChange) return declaredAccess?.kind === "file" && !declaredAccess.recursive ? declaredPath : undefined;
    const resolvedPath = resolveWorkspacePath(this.context.workspaceRoot, execution.fileChange.path, this.context.config.workspace.ignore);
    if (declaredPath && declaredPath !== resolvedPath) {
      throw new Error("The target path changed after the tool call was prepared. Retry the tool call to review the current target.");
    }
    if (!declaredPath) throw new Error("Local file change requires a matching file write access.");
    if (execution.fileChange.destinationPath) {
      const destination = resolveWorkspacePath(this.context.workspaceRoot, execution.fileChange.destinationPath, this.context.config.workspace.ignore);
      if (!execution.accesses?.some((access) => access.kind === "file" && access.path === destination && (access.operation === "write" || access.operation === "readwrite"))) {
        throw new Error("Move destination requires a matching file write access.");
      }
    }
    return declaredPath ?? resolvedPath;
  }

  private async captureFileBaseline(absolutePath: string | undefined, signal?: AbortSignal): Promise<FilePermissionBaseline | undefined> {
    if (!absolutePath) return undefined;
    try {
      const { content, snapshot } = await readBoundedUtf8File(absolutePath, maxEditFileBytes, "reject", signal);
      return { exists: true, content, snapshot };
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) return { exists: false, content: "", snapshot: null };
      throw error;
    }
  }

  private nextSequence(): number {
    return this.context.recorder.nextToolCallSequence();
  }

  /**
   * 没有 await 的同步临界区：同一批并行 execute 即使同时恢复 microtask，也会逐个检查并占用
   * 额度，后来的调用无法越过前一个调用刚提交的计数。
   */
  private admitToolCall(call: { name: string; args: unknown }): ToolBudgetRejection | undefined {
    const budget = this.executionBudget;
    if (!budget) return undefined;
    const attemptedToolCallCount = this.accountedToolCallCount + 1;
    const fingerprint = `${call.name}\0${stableJson(call.args)}`;
    const actionCount = this.accountedActionCounts.get(fingerprint) ?? 0;
    const attemptedRestoredCount = this.restoredMaxRepeatedActionCount > 0
      ? this.restoredMaxRepeatedActionCount + 1
      : 0;
    const attemptedActionCount = Math.max(actionCount + 1, attemptedRestoredCount);
    // 被重复动作规则拒绝的调用仍是真实 provider Tool Call，也必须消耗总调用额度。先原子记账，
    // 再选择拒绝原因，保证同一批后续调用看见最新计数。
    this.accountedToolCallCount = attemptedToolCallCount;
    this.accountedActionCounts.set(fingerprint, actionCount + 1);
    this.restoredMaxRepeatedActionCount = attemptedRestoredCount;

    if (attemptedToolCallCount > budget.maxToolCalls) {
      return {
        status: "budget_rejected",
        reason: "tool_call_limit",
        resumable: true,
        limit: budget.maxToolCalls,
        attemptedToolCallCount,
        attemptedActionCount,
        error: `Tool ${call.name} was not executed because the run reached its ${String(budget.maxToolCalls)}-call limit.`
      };
    }
    if (attemptedActionCount > budget.maxRepeatedActions) {
      return {
        status: "budget_rejected",
        reason: "repeated_action_limit",
        resumable: true,
        limit: budget.maxRepeatedActions,
        attemptedToolCallCount,
        attemptedActionCount,
        error: `Tool ${call.name} was not executed because the same structured action reached its repeat limit of ${String(budget.maxRepeatedActions)}.`
      };
    }

    return undefined;
  }

  private duplicateAuditId(toolCallId: string, sequence: number): string {
    const count = (this.duplicateExecutionCounts.get(toolCallId) ?? 0) + 1;
    this.duplicateExecutionCounts.set(toolCallId, count);
    return `${toolCallId}:duplicate:${String(count)}:${String(sequence)}`;
  }

  private trackExecution<T>(execution: Promise<T>): Promise<T> {
    this.pendingExecutions.add(execution);
    void execution.then(
      () => this.pendingExecutions.delete(execution),
      () => this.pendingExecutions.delete(execution)
    );
    return execution;
  }

  private async withPermissionGate<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.permissionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.permissionTail = current;
    try {
      await waitForAbort(previous, signal);
      signal?.throwIfAborted();
      return await waitForAbort(fn(), signal);
    } finally {
      release();
    }
  }
}

function validateStrongConfirmation(
  request: AgentPermissionRequest,
  result: AgentPermissionResult
): AgentPermissionResult {
  if (!request.requireFullYes || !result.approved || isFullYesConfirmation(result.confirmation ?? "")) return result;
  return {
    approved: false,
    action: "deny",
    scope: "once",
    message: "Full yes confirmation was not provided.",
    confirmation: result.confirmation
  };
}

function permissionApprovalFingerprint(approvalRule: string, args: unknown): string {
  const input = `${approvalRule}\0${stableJson(args)}`;
  return createHash("sha256").update(input).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Tool execution budget ${field} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Tool execution budget ${field} must be a non-negative safe integer.`);
  }
}

function isToolExecutionError(execution: unknown): execution is { isError: true; result: unknown; errorMessage: string } {
  return typeof execution === "object" && execution !== null && "isError" in execution && execution.isError === true && "errorMessage" in execution && typeof execution.errorMessage === "string";
}

function executionStateForResultStatus(status: ToolExecutionResultStatus): ToolExecutionState {
  if (status === "cancelled") return "cancelled";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "unknown";
}

function terminalResultStatus(state: ToolExecutionState, result: unknown): ToolExecutionResultStatus {
  if (state === "cancelled" || state === "cancel_requested") return "cancelled";
  if (state === "unknown" || state === "running" || state === "admitted" || state === "side_effect_committed" || state === "not_started") return "unknown";
  if (state === "failed") return "failed";
  return failedToolResultMessage(result) ? "failed" : "succeeded";
}

function classifyCancellation(state: ToolExecutionState, executionStarted: boolean, retrySafety: ToolRetrySafety): ToolExecutionResultStatus {
  if (!executionStarted || retrySafety === "safe" || retrySafety === "idempotent") return "cancelled";
  if (state === "side_effect_committed" || state === "cancel_requested" || executionStarted) return "unknown";
  return "cancelled";
}

function isSideEffectCommitted(state: ToolExecutionState): boolean {
  return state === "side_effect_committed";
}

function exposeExecutionMetadata(
  result: unknown,
  status: ToolExecutionResultStatus,
  operationId: string,
  evidence: string | undefined
): unknown {
  if (status === "succeeded" || status === "failed" || status === "cancelled") return result;
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return {
      ...(result as Record<string, unknown>),
      executionStatus: status,
      operationId,
      evidence
    };
  }
  return { result, executionStatus: status, operationId, evidence };
}

function formatToolError(toolName: string, error: unknown): string {
  if (error instanceof ZodError) return `Invalid tool arguments for ${toolName}: ${error.issues.map((issue) => issue.message).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function abortedToolMessage(toolName: string, reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "The operation was aborted.";
  return `Tool ${toolName} was aborted: ${detail}`;
}

function sameFileBaseline(left: FilePermissionBaseline | undefined, right: FilePermissionBaseline | undefined): boolean {
  if (!left || !right) return left === right;
  return left.exists === right.exists
    && left.content === right.content
    && sameOptionalFileSnapshot(left.snapshot, right.snapshot);
}

function samePermissionPreview(left: AgentPermissionRequest, right: AgentPermissionRequest): boolean {
  return left.details === right.details
    && left.diff === right.diff
    && left.preview === right.preview
    && left.changeSummary === right.changeSummary;
}

function readStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function resultNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function failedToolResultMessage(result: unknown, seen = new Set<object>()): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  if (seen.has(result)) return undefined;
  seen.add(result);
  const record = result as Record<string, unknown>;
  const nestedFailure = record.result !== result ? failedToolResultMessage(record.result, seen) : undefined;
  const failed = typeof record.error === "string"
    || (typeof record.exitCode === "number" && record.exitCode !== 0)
    || record.approved === false
    || record.status === "denied"
    || record.status === "failed"
    || record.status === "timed_out"
    || record.status === "aborted"
    || record.status === "permission_required";
  if (!failed && !nestedFailure) return undefined;
  return readStringField(result, "error")
    || readStringField(result, "reason")
    || readStringField(result, "message")
    || (typeof record.exitCode === "number" ? `Command exited with code ${String(record.exitCode)}.` : undefined)
    || nestedFailure
    || `Tool did not complete (${typeof record.status === "string" ? record.status : "failed"}).`;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function waitForAbortWithDrain<T>(promise: Promise<T>, signal: AbortSignal | undefined, drainMs: number): Promise<T> {
  if (!signal) return await promise;
  const outcome = promise.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error })
  );
  if (signal.aborted) {
    const settled = await Promise.race([outcome, delay(drainMs).then(() => ({ kind: "timeout" as const }))]);
    if (settled.kind === "timeout") throw new ExternalToolQuarantineError(abortReason(signal));
    if (settled.kind === "value") return settled.value;
    throw settled.error;
  }
  let onAbort!: () => void;
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const first = await Promise.race([outcome, aborted]);
  signal.removeEventListener("abort", onAbort);
  if (first.kind === "value") return first.value;
  if (first.kind === "error") throw first.error;
  const settled = await Promise.race([outcome, delay(drainMs).then(() => ({ kind: "timeout" as const }))]);
  if (settled.kind === "timeout") throw new ExternalToolQuarantineError(abortReason(signal));
  if (settled.kind === "value") return settled.value;
  throw settled.error;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

class ExternalToolQuarantineError extends Error {
  constructor(readonly abortCause: unknown) {
    super("The cancelled external tool did not settle during its bounded drain.");
    this.name = "ExternalToolQuarantineError";
  }
}

function deniedToolResult(request: AgentPermissionRequest, reason: string): unknown {
  return { status: "denied", approved: false, tool: request.tool, actionType: request.actionType, riskLevel: request.riskLevel, targetPath: request.targetPath, command: request.command, reason };
}

function displaySummary(display: ToolInputDisplay | undefined): string | undefined {
  if (!display) return undefined;
  if (display.kind === "command") return `Run command: ${display.command}`;
  if (display.kind === "file_io") return `${display.operation}${display.path ? ` ${display.path}` : ""}`.trim();
  return display.summary;
}

function attachToolSummary(result: unknown, durationMs: number): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return { result, durationMs };
  const record = result as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return {
    ...record,
    durationMs,
    outputLines: output ? output.split(/\r?\n/).length : undefined,
    // Bash 已经分别记录两个输出流的截断状态。保留 UI 使用的历史聚合字段，但不能
    // 覆盖更精确的逐流证据。
    truncated: record.truncated === true || record.stdoutTruncated === true || record.stderrTruncated === true
  };
}

/** 文件变更统一用 `path` 表达源目标，移动额外用 `to`；取不到就不跑诊断。 */
function mutatedFilePath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "to"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (typeof record.operation === "object" && record.operation !== null && "path" in record.operation && typeof record.operation.path === "string") return record.operation.path;
  return undefined;
}
