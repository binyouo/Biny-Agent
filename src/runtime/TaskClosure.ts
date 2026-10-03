/**
 * TaskRun 的执行、验收与有限修复闭环。
 *
 * Worker 仍由调用方已有的 Subagent 或 Graph Runtime 提供；这里仅统一 Attempt 生命周期和
 * 验收完成权，避免不同入口各自实现一套重试状态机。
 */
import { isTaskRunTerminal, type DurableTaskRunStore, type TaskAttemptRecord, type TaskRetrySafety, type TaskRunStatus } from "./TaskRunStore.js";
import { planReviewResultSchema, type PlanReviewResult } from "./planWork.js";
import { z } from "zod";
import {
  captureTaskWorkspaceSnapshot,
  canReuseTaskVerification,
  compareTaskWorkspaceSnapshots,
  fingerprintTaskArtifacts,
  fingerprintTaskVerificationDefinitions,
  isTaskVerificationApproval,
  isTaskVerificationEvidence,
  matchingTaskVerificationApproval,
  pendingTaskVerificationApproval,
  readTaskDefinition,
  taskVerificationFingerprint,
  verifyTaskCandidate,
  type TaskCandidateArtifacts,
  type TaskCommandExecutor,
  type TaskVerificationApproval,
  type TaskVerificationEvidence,
  type TaskWorkspaceSnapshot
} from "./taskVerification.js";

export interface TaskClosureResult {
  status: "completed" | "incomplete" | "blocked" | "needs_approval" | "cancelled";
  output?: string;
  evidence?: TaskVerificationEvidence;
  reason?: string;
  review?: PlanReviewResult;
}

const workerAttemptSchema = z.object({
  prompt: z.string().min(1), beforeWorkspace: z.record(z.string(), z.string()).optional(),
  definitionFingerprint: z.string().optional(), accessMode: z.enum(["read-only", "workspace"]).optional(), agent: z.string().optional(),
  communication: z.boolean().optional()
}).strict();

export function readWorkerAttemptCheckpoint(artifacts: unknown): z.infer<typeof workerAttemptSchema> | undefined {
  const parsed = workerAttemptSchema.safeParse((artifacts as { workerExecution?: unknown } | undefined)?.workerExecution);
  return parsed.success ? parsed.data : undefined;
}

export async function runTaskClosure(input: {
  taskRuns: DurableTaskRunStore;
  taskRunId: string;
  workspaceRoot: string;
  ignore: readonly string[];
  executor: TaskCommandExecutor;
  retrySafety?: TaskRetrySafety;
  signal?: AbortSignal;
  canRepair?: () => boolean;
  resumeWorker?: boolean;
  executeAttempt(prompt: string, attempt: TaskAttemptRecord): Promise<string>;
}): Promise<TaskClosureResult> {
  try {
    return await executeTaskClosure(input);
  } catch (error) {
    if (!input.signal?.aborted) throw error;
    return cancelCurrentTask(input);
  }
}

async function executeTaskClosure(input: Parameters<typeof runTaskClosure>[0]): Promise<TaskClosureResult> {
  const initial = input.taskRuns.get(input.taskRunId);
  if (!initial) throw new Error(`TaskRun ${input.taskRunId} does not exist.`);
  if (initial.status === "cancelled") return { status: "cancelled", reason: "Task was cancelled." };
  if (input.signal?.aborted && initial.status !== "completed") return cancelCurrentTask(input);
  const definition = readTaskDefinition(initial.task);
  const contract = definition.verification;
  const reviewCandidate = definition.review;
  if (definition.reportOnly && initial.status === "completed") {
    const output = (initial.attempts.at(-1)?.artifacts as { output?: unknown } | undefined)?.output;
    return typeof output === "string" && output.trim()
      ? { status: "completed", output }
      : { status: "blocked", reason: "Completed report has no persisted output." };
  }
  const reviewCurrent = async (): Promise<boolean> => {
    if (!reviewCandidate) return false;
    const source = input.taskRuns.get(reviewCandidate.taskRunId);
    const attempt = source?.attempts.at(-1);
    if (source?.status !== "completed" || attempt?.attemptId !== reviewCandidate.attemptId
      || JSON.stringify(attempt.verification) !== JSON.stringify(reviewCandidate.evidence)) return false;
    return await canReuseTaskVerification({
      evidence: reviewCandidate.evidence, contract: reviewCandidate.contract,
      definitionFingerprint: reviewCandidate.evidence.definitionFingerprint,
      workspaceRoot: input.workspaceRoot, ignore: input.ignore,
      signal: initial.status === "completed" ? undefined : input.signal
    });
  };
  if (reviewCandidate && !await reviewCurrent()) {
    if (input.signal?.aborted && initial.status !== "completed") return cancelCurrentTask(input);
    const reason = "Review candidate evidence is stale or missing.";
    if (!isTerminalForClosure(initial.status) && initial.status !== "completed") input.taskRuns.transition(input.taskRunId, "blocked", { attemptId: initial.attempts.at(-1)?.attemptId, failure: { failureClass: "stale_review_candidate", message: reason } });
    return { status: "blocked", reason };
  }
  if (reviewCandidate && initial.status === "completed") {
    const artifacts = initial.attempts.at(-1)?.artifacts as { output?: string; review?: unknown } | undefined;
    const parsed = planReviewResultSchema.safeParse(artifacts?.review);
    return parsed.success ? { status: "completed", output: artifacts?.output, review: parsed.data } : { status: "blocked", reason: "Persisted review evidence is missing." };
  }
  if (initial.status === "completed" && contract) {
    const attempt = initial.attempts.at(-1);
    if (!attempt) return { status: "blocked", reason: "Completed TaskRun has no Attempt evidence." };
    const artifacts = readCandidateArtifacts(attempt.artifacts);
    if (!artifacts) return { status: "blocked", reason: "Completed TaskRun has no persisted candidate verification metadata." };
    const reusable = await canReuseTaskVerification({
      evidence: attempt.verification,
      contract,
      definitionFingerprint: artifacts.definitionFingerprint,
      workspaceRoot: input.workspaceRoot,
      ignore: input.ignore
    });
    return reusable
      ? { status: "completed", output: artifacts.output, evidence: attempt.verification as TaskVerificationEvidence }
      : { status: "blocked", output: artifacts.output, reason: "Persisted TaskRun verification no longer matches the current contract, definitions, or artifacts." };
  }
  let resumeAttempt = initial.status === "verifying" ? initial.attempts.at(-1) : undefined;
  let workerAttempt = input.resumeWorker && initial.status === "running" ? initial.attempts.at(-1) : undefined;
  if (input.resumeWorker && !workerAttempt) throw new Error("Worker continuation requires the current running Attempt.");
  const latestAttempt = initial.attempts.at(-1);
  const latestEvent = input.taskRuns.events(input.taskRunId).at(-1);
  const persistedRepairEvidence = initial.status === "queued"
    && latestAttempt?.status === "failed"
    && latestEvent?.eventType === "task.verification.repair"
    && latestEvent.attemptId === latestAttempt.attemptId
    && isTaskVerificationEvidence(latestAttempt.verification)
    && latestAttempt.verification.status === "failed"
    ? latestAttempt.verification
    : undefined;
  let repairEvidence: TaskVerificationEvidence | undefined = persistedRepairEvidence;
  let definitionFingerprint = persistedDefinitionFingerprint(initial.attempts);

  // 报告完成只证明有可读取的产出，不创建 passed 验收证据；内容判断留给监督回合。
  const completeReport = (output: unknown, attempt: TaskAttemptRecord): TaskClosureResult => {
    if (input.signal?.aborted) return cancelCurrentTask(input);
    if (!isCurrentAttempt(input.taskRuns, input.taskRunId, attempt.attemptId)) return { status: "cancelled", reason: "A stale report result was ignored." };
    if (typeof output !== "string" || !output.trim()) return blockUnsafeRecovery(input.taskRuns, input.taskRunId, attempt.attemptId, "Read-only report output is empty or missing.");
    input.taskRuns.transition(input.taskRunId, "completed", { attemptId: attempt.attemptId, artifacts: {
      ...input.taskRuns.get(input.taskRunId)?.attempts.at(-1)?.artifacts as Record<string, unknown>, output
    } });
    return { status: "completed", output };
  };

  const completeReview = async (output: string, attempt: TaskAttemptRecord): Promise<TaskClosureResult> => {
    try {
      const review = planReviewResultSchema.parse(JSON.parse(output));
      if (!await reviewCurrent()) throw new Error("Review candidate changed during review.");
      input.signal?.throwIfAborted();
      const references = new Set([reviewCandidate!.taskRunId, reviewCandidate!.attemptId, ...reviewCandidate!.contract.artifactPaths]);
      if (review.evidenceReferences.some((reference) => !references.has(reference))) throw new Error("Review refers to evidence outside the candidate.");
      if (!isLatestNonCancelledAttempt(input.taskRuns, input.taskRunId, attempt.attemptId)) return { status: "cancelled", reason: "A stale review result was ignored." };
      input.taskRuns.transition(input.taskRunId, "completed", { attemptId: attempt.attemptId, artifacts: { output, review, candidate: reviewCandidate } });
      return { status: "completed", output, review };
    } catch (error) {
      if (input.signal?.aborted) return cancelCurrentTask(input);
      return blockUnsafeRecovery(input.taskRuns, input.taskRunId, attempt.attemptId, error instanceof Error ? error.message : String(error));
    }
  };

  for (;;) {
    if (input.signal?.aborted || input.taskRuns.get(input.taskRunId)?.status === "cancelled") {
      return cancelCurrentTask(input);
    }
    const current = input.taskRuns.get(input.taskRunId);
    if (!current) throw new Error(`TaskRun ${input.taskRunId} disappeared.`);
    if (isTerminalForClosure(current.status)) return terminalResult(current.status);

    const attempt = resumeAttempt ?? workerAttempt ?? input.taskRuns.createAttempt(input.taskRunId, {
      parentRunId: current.parentRunId,
      retrySafety: input.retrySafety ?? "unknown"
    });
    let output: string;
    let candidateArtifacts: TaskCandidateArtifacts;
    let candidateWorkspaceSnapshot: TaskWorkspaceSnapshot | undefined;
    if (resumeAttempt) {
      if (definition.reportOnly) return completeReport((attempt.artifacts as { output?: unknown } | undefined)?.output, attempt);
      if (reviewCandidate) {
        const output = (attempt.artifacts as { output?: unknown } | undefined)?.output;
        if (typeof output !== "string") return blockUnsafeRecovery(input.taskRuns, input.taskRunId, attempt.attemptId, "Missing persisted review output.");
        return await completeReview(output, attempt);
      }
      try {
        candidateArtifacts = requireCandidateArtifacts(attempt.artifacts);
        output = candidateArtifacts.output;
        definitionFingerprint = candidateArtifacts.definitionFingerprint;
      } catch (error) {
        return blockUnsafeRecovery(
          input.taskRuns,
          input.taskRunId,
          attempt.attemptId,
          error instanceof Error ? error.message : String(error)
        );
      }
      if (!contract) {
        return blockUnsafeRecovery(input.taskRuns, input.taskRunId, attempt.attemptId, "A verifying TaskRun has no verification contract.");
      }
      if (await canReuseTaskVerification({
        evidence: attempt.verification,
        contract,
        definitionFingerprint,
        workspaceRoot: input.workspaceRoot,
        ignore: input.ignore,
        signal: input.signal
      })) {
        input.signal?.throwIfAborted();
        transitionCurrent(input.taskRuns, input.taskRunId, attempt.attemptId, "completed", {
          artifacts: attempt.artifacts,
          verification: attempt.verification
        });
        return { status: "completed", output, evidence: attempt.verification as TaskVerificationEvidence };
      }
      input.signal?.throwIfAborted();
    } else {
      const workerCheckpoint = workerAttempt ? readWorkerAttemptCheckpoint(attempt.artifacts) : undefined;
      if (workerAttempt && (!workerCheckpoint || (contract && (!workerCheckpoint.beforeWorkspace || !workerCheckpoint.definitionFingerprint)))) {
        return blockUnsafeRecovery(input.taskRuns, input.taskRunId, attempt.attemptId, "Missing original Worker execution or verification baseline.");
      }
      if (workerAttempt && contract && workerCheckpoint?.definitionFingerprint !== await fingerprintTaskVerificationDefinitions(input.workspaceRoot, contract, input.ignore, input.signal)) {
        return blockUnsafeRecovery(input.taskRuns, input.taskRunId, attempt.attemptId, "Verification definition inputs changed; Worker continuation cannot change the original acceptance standard.");
      }
      const beforeWorkspace = workerCheckpoint?.beforeWorkspace ?? (contract
        ? await captureTaskWorkspaceSnapshot(input.workspaceRoot, input.ignore, input.signal)
        : undefined);
      if (workerCheckpoint?.definitionFingerprint) definitionFingerprint = workerCheckpoint.definitionFingerprint;
      definitionFingerprint ??= contract
        ? await fingerprintTaskVerificationDefinitions(input.workspaceRoot, contract, input.ignore, input.signal)
        : undefined;
      const basePrompt = definition.constraints?.length
        ? `${definition.prompt}\n\n用户约束：\n${definition.constraints.map((constraint) => `- ${constraint}`).join("\n")}`
        : definition.prompt;
      const prompt = workerCheckpoint?.prompt ?? (repairEvidence === undefined
        ? basePrompt
        : repairPrompt(basePrompt, contract!, repairEvidence, current.attempts.length));
      input.taskRuns.transition(input.taskRunId, "running", { attemptId: attempt.attemptId, artifacts: {
        ...input.taskRuns.get(input.taskRunId)?.attempts.at(-1)?.artifacts as Record<string, unknown>,
        workerExecution: { prompt, beforeWorkspace, definitionFingerprint }
      } });
      workerAttempt = undefined;
      input.signal?.throwIfAborted();
      output = await input.executeAttempt(prompt, attempt);
      input.signal?.throwIfAborted();
      if (!isLatestNonCancelledAttempt(input.taskRuns, input.taskRunId, attempt.attemptId)) {
        return { status: "cancelled", reason: "A stale Attempt result was ignored." };
      }
      if (definition.reportOnly) return completeReport(output, attempt);
      if (!contract) {
        if (reviewCandidate) {
          return await completeReview(output, attempt);
        }
        const settled = input.taskRuns.get(input.taskRunId)!;
        const existing = settled.attempts.at(-1)?.artifacts as Record<string, unknown> | undefined;
        input.taskRuns.transition(input.taskRunId, "completed", { attemptId: attempt.attemptId,
          artifacts: settled.status === "completed" ? { ...existing, output } : { output, communication: existing?.communication }
        });
        return { status: "completed", output };
      }
      // Reuse this immutable baseline immediately: the final full-workspace comparison
      // also detects changes between candidate capture and the first verification check.
      candidateWorkspaceSnapshot = await captureTaskWorkspaceSnapshot(input.workspaceRoot, input.ignore, input.signal);
      candidateArtifacts = {
        ...input.taskRuns.get(input.taskRunId)?.attempts.at(-1)?.artifacts as Record<string, unknown>,
        output,
        definitionFingerprint: definitionFingerprint!,
        repairScope: compareTaskWorkspaceSnapshots(beforeWorkspace!, candidateWorkspaceSnapshot, contract.allowedRepairPaths)
      };
      input.taskRuns.transition(input.taskRunId, "verifying", { attemptId: attempt.attemptId, artifacts: candidateArtifacts });
    }

    const evidence = await verifyTaskCandidate({
      workspaceRoot: input.workspaceRoot,
      ignore: input.ignore,
      taskRunId: input.taskRunId,
      attemptId: attempt.attemptId,
      contract,
      definitionFingerprint: candidateArtifacts.definitionFingerprint,
      expectedArtifactFingerprint: candidateArtifacts.artifactFingerprint,
      approvals: candidateArtifacts.verificationApprovals,
      repairScope: candidateArtifacts.repairScope,
      candidateWorkspaceSnapshot,
      executor: input.executor,
      signal: input.signal
    });
    if (!isCurrentAttempt(input.taskRuns, input.taskRunId, attempt.attemptId)) {
      return { status: "cancelled", reason: "A stale verification result was ignored." };
    }
    // 恢复时先在原候选和原 Attempt 上完成验收；若验收失败并进入修复，下一轮才创建新 Attempt。
    resumeAttempt = undefined;
    const artifacts: TaskCandidateArtifacts = {
      ...candidateArtifacts,
      artifactFingerprint: evidence.artifactFingerprint
    };
    input.taskRuns.transition(input.taskRunId, "verifying", { attemptId: attempt.attemptId, verification: evidence, artifacts });
    if (evidence.status === "cancelled" || input.signal?.aborted) {
      return cancelCurrentTask(input, { output, evidence, artifacts });
    }
    if (evidence.status === "passed") {
      input.taskRuns.transition(input.taskRunId, "completed", { attemptId: attempt.attemptId, verification: evidence, artifacts });
      return { status: "completed", output, evidence };
    }
    if (evidence.status === "blocked") {
      const approvalRequest = pendingTaskVerificationApproval(evidence);
      if (approvalRequest) {
        input.taskRuns.transition(input.taskRunId, "needs_approval", {
          attemptId: attempt.attemptId,
          verification: evidence,
          artifacts,
          failure: { failureClass: "verification_permission_required", message: evidence.reason }
        });
        return { status: "needs_approval", output, evidence, reason: evidence.reason };
      }
      input.taskRuns.transition(input.taskRunId, "blocked", {
        attemptId: attempt.attemptId,
        verification: evidence,
        artifacts,
        failure: { failureClass: "verification_unavailable", message: evidence.reason }
      });
      return { status: "blocked", output, evidence, reason: evidence.reason };
    }
    const attemptsUsed = input.taskRuns.get(input.taskRunId)?.attempts.length ?? contract.maxAttempts;
    if (attemptsUsed >= contract.maxAttempts) {
      const reason = `Verification failed after ${String(attemptsUsed)} attempt(s); the limit is ${String(contract.maxAttempts)}.`;
      input.taskRuns.transition(input.taskRunId, "incomplete", {
        attemptId: attempt.attemptId,
        verification: evidence,
        artifacts,
        failure: { failureClass: "verification_failed", message: reason }
      });
      return { status: "incomplete", output, evidence, reason };
    }
    if (input.canRepair?.() === false) {
      const reason = "Verification failed and the work budget is exhausted; no repair attempt started.";
      input.taskRuns.transition(input.taskRunId, "incomplete", {
        attemptId: attempt.attemptId,
        verification: evidence,
        artifacts,
        failure: { failureClass: "work_budget_exhausted", message: reason }
      });
      return { status: "incomplete", output, evidence, reason };
    }
    input.taskRuns.prepareVerificationRepair(input.taskRunId, attempt.attemptId, {
      verification: evidence,
      artifacts,
      failure: { failureClass: "verification_failed", message: evidence.reason }
    });
    repairEvidence = evidence;
  }
}

/**
 * 只批准当前 Attempt 已经持久化的那一个验收检查。
 * 批准同时绑定契约、定义输入、候选产物和被拒绝的 tool_result，不能变成通用 Bash 授权。
 */
export async function approveTaskVerification(input: {
  taskRuns: DurableTaskRunStore;
  taskRunId: string;
  approvalId: string;
  workspaceRoot: string;
  ignore: readonly string[];
}): Promise<void> {
  const task = input.taskRuns.get(input.taskRunId);
  if (!task) throw new Error(`TaskRun ${input.taskRunId} does not exist.`);
  const attempt = task.attempts.at(-1);
  if (!attempt) throw new Error(`TaskRun ${input.taskRunId} has no Attempt to approve.`);
  const existingArtifacts = readCandidateArtifacts(attempt.artifacts);
  if ((task.status !== "needs_approval" && task.status !== "verifying")
    || (attempt.status !== "needs_approval" && attempt.status !== "verifying")) {
    throw new Error(`TaskRun ${input.taskRunId} is not waiting for verification approval.`);
  }
  const contract = readTaskDefinition(task.task).verification;
  if (!contract || !existingArtifacts || !isTaskVerificationEvidence(attempt.verification)) {
    throw new Error("TaskRun approval requires persisted verification contract, candidate metadata, and evidence.");
  }
  const pending = pendingTaskVerificationApproval(attempt.verification);
  if (!pending || pending.taskRunId !== task.taskRunId || pending.attemptId !== attempt.attemptId) {
    throw new Error("TaskRun has no current verification permission request to approve.");
  }
  if (pending.approvalId !== input.approvalId) {
    throw new Error("TaskRun verification approval is stale or belongs to another check.");
  }
  if (pending.contractFingerprint !== taskVerificationFingerprint(contract)
    || pending.definitionFingerprint !== existingArtifacts.definitionFingerprint
    || pending.artifactFingerprint !== existingArtifacts.artifactFingerprint) {
    throw new Error("TaskRun verification approval no longer matches its persisted contract or candidate.");
  }
  const [definitionFingerprint, artifactFingerprint] = await Promise.all([
    fingerprintTaskVerificationDefinitions(input.workspaceRoot, contract, input.ignore),
    fingerprintTaskArtifacts(input.workspaceRoot, contract.artifactPaths, input.ignore)
  ]);
  if (definitionFingerprint !== pending.definitionFingerprint || artifactFingerprint !== pending.artifactFingerprint) {
    throw new Error("TaskRun verification inputs changed while waiting for approval.");
  }
  const existingApproval = existingArtifacts.verificationApprovals?.find((approval) => matchingTaskVerificationApproval(approval, pending));
  if (task.status === "verifying" && existingApproval) return;
  const approval: TaskVerificationApproval = { ...pending, approvedAt: new Date().toISOString() };
  input.taskRuns.transition(input.taskRunId, "verifying", {
    attemptId: attempt.attemptId,
    verification: attempt.verification,
    artifacts: {
      ...existingArtifacts,
      verificationApprovals: existingApproval
        ? existingArtifacts.verificationApprovals
        : [...(existingArtifacts.verificationApprovals ?? []), approval]
    }
  });
}

/** Cancellation may close live work, but must never overwrite an existing terminal outcome. */
function cancelCurrentTask(
  input: Pick<Parameters<typeof runTaskClosure>[0], "taskRuns" | "taskRunId">,
  result: { output?: string; evidence?: TaskVerificationEvidence; artifacts?: TaskCandidateArtifacts } = {}
): TaskClosureResult {
  const task = input.taskRuns.get(input.taskRunId);
  if (!task) return { status: "cancelled", reason: "Task was cancelled." };
  if (isTaskRunTerminal(task.status)) return terminalResult(task.status);
  const reason = "Task was cancelled.";
  const persistedEvidence = task.attempts.at(-1)?.verification;
  const previousEvidence = result.evidence ?? (isTaskVerificationEvidence(persistedEvidence) ? persistedEvidence : undefined);
  const evidence = previousEvidence && { ...previousEvidence, status: "cancelled" as const, reason };
  input.taskRuns.transition(input.taskRunId, "cancelled", {
    attemptId: task.attempts.at(-1)?.attemptId,
    verification: evidence,
    artifacts: result.artifacts
  });
  return { status: "cancelled", output: result.output, evidence, reason };
}

function repairPrompt(
  originalPrompt: string,
  contract: NonNullable<ReturnType<typeof readTaskDefinition>["verification"]>,
  evidence: TaskVerificationEvidence,
  attemptsUsed: number
): string {
  const failed = evidence.checks.filter((check) => check.status === "failed").map((check) => ({
    id: check.checkId,
    command: check.command,
    exitCode: check.exitCode,
    stdout: check.stdout,
    stderr: check.stderr,
    reason: check.reason,
    evidence: check.eventReferences
  }));
  return [
    originalPrompt,
    "",
    "这是同一 TaskRun 的定向修复 Attempt。验收条件不得修改。",
    `目标：${contract.objective}`,
    contract.context ? `上下文：${contract.context}` : undefined,
    `允许修改范围：${contract.allowedRepairPaths.join(", ")}`,
    `剩余 Attempt 预算：${String(contract.maxAttempts - attemptsUsed)}`,
    `当前候选产物指纹：${evidence.artifactFingerprint}`,
    `未通过检查与真实证据：${JSON.stringify(failed)}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

function requireCandidateArtifacts(artifacts: unknown): TaskCandidateArtifacts {
  const candidate = readCandidateArtifacts(artifacts);
  if (!candidate) throw new Error("Cannot resume verification without persisted candidate output, definition fingerprint, and repair scope evidence.");
  return candidate;
}

function readCandidateArtifacts(artifacts: unknown): TaskCandidateArtifacts | undefined {
  if (typeof artifacts !== "object" || artifacts === null) return undefined;
  const record = artifacts as Record<string, unknown>;
  const scope = record.repairScope;
  if (typeof record.output !== "string"
    || typeof record.definitionFingerprint !== "string"
    || typeof scope !== "object"
    || scope === null) return undefined;
  const repairScope = scope as Record<string, unknown>;
  if (repairScope.enforcement !== "post_execution_change_guard"
    || !isStringArray(repairScope.changedPaths)
    || !isStringArray(repairScope.violationPaths)) return undefined;
  return {
    output: record.output,
    communication: record.communication,
    definitionFingerprint: record.definitionFingerprint,
    repairScope: {
      enforcement: "post_execution_change_guard",
      changedPaths: repairScope.changedPaths,
      violationPaths: repairScope.violationPaths
    },
    artifactFingerprint: typeof record.artifactFingerprint === "string" ? record.artifactFingerprint : undefined,
    verificationApprovals: Array.isArray(record.verificationApprovals)
      && record.verificationApprovals.every(isTaskVerificationApproval)
      ? record.verificationApprovals
      : undefined
  };
}

function persistedDefinitionFingerprint(attempts: readonly TaskAttemptRecord[]): string | undefined {
  for (const attempt of attempts) {
    const artifacts = readCandidateArtifacts(attempt.artifacts);
    if (artifacts) return artifacts.definitionFingerprint;
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function blockUnsafeRecovery(
  taskRuns: DurableTaskRunStore,
  taskRunId: string,
  attemptId: string,
  reason: string
): TaskClosureResult {
  taskRuns.transition(taskRunId, "blocked", { attemptId, failure: { failureClass: "unsafe_recovery", message: reason } });
  return { status: "blocked", reason };
}

function isCurrentAttempt(taskRuns: DurableTaskRunStore, taskRunId: string, attemptId: string): boolean {
  const task = taskRuns.get(taskRunId);
  return task !== undefined
    && (task.status === "running" || task.status === "verifying")
    && task.attempts.at(-1)?.attemptId === attemptId;
}

function isLatestNonCancelledAttempt(taskRuns: DurableTaskRunStore, taskRunId: string, attemptId: string): boolean {
  const task = taskRuns.get(taskRunId);
  return task !== undefined && task.status !== "cancelled" && task.attempts.at(-1)?.attemptId === attemptId;
}

function transitionCurrent(
  taskRuns: DurableTaskRunStore,
  taskRunId: string,
  attemptId: string,
  status: TaskRunStatus,
  input: { verification?: unknown; artifacts?: unknown; failure?: unknown }
): void {
  if (isCurrentAttempt(taskRuns, taskRunId, attemptId)) taskRuns.transition(taskRunId, status, { attemptId, ...input });
}

function isTerminalForClosure(status: TaskRunStatus): boolean {
  return status === "completed" || status === "incomplete" || status === "blocked" || status === "policy_denied"
    || status === "budget_exhausted" || status === "needs_approval" || status === "aborted" || status === "cancelled" || status === "failed";
}

function terminalResult(status: TaskRunStatus): TaskClosureResult {
  if (status === "completed") return { status: "completed" };
  if (status === "cancelled" || status === "aborted") return { status: "cancelled" };
  if (status === "needs_approval") return { status: "needs_approval" };
  if (status === "blocked" || status === "policy_denied") return { status: "blocked" };
  return { status: "incomplete" };
}
