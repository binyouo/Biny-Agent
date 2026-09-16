/**
 * TaskRun 的执行、验收与有限修复闭环。
 *
 * Worker 仍由调用方已有的 Subagent 或 Graph Runtime 提供；这里仅统一 Attempt 生命周期和
 * 验收完成权，避免不同入口各自实现一套重试状态机。
 */
import type { DurableTaskRunStore, TaskAttemptRecord, TaskRetrySafety, TaskRunStatus } from "./TaskRunStore.js";
import {
  captureTaskWorkspaceSnapshot,
  canReuseTaskVerification,
  compareTaskWorkspaceSnapshots,
  fingerprintTaskVerificationDefinitions,
  readTaskDefinition,
  verifyTaskCandidate,
  type TaskCandidateArtifacts,
  type TaskCommandExecutor,
  type TaskVerificationEvidence
} from "./taskVerification.js";

export interface TaskClosureResult {
  status: "completed" | "incomplete" | "blocked" | "cancelled";
  output?: string;
  evidence?: TaskVerificationEvidence;
  reason?: string;
}

export async function runTaskClosure(input: {
  taskRuns: DurableTaskRunStore;
  taskRunId: string;
  workspaceRoot: string;
  ignore: readonly string[];
  executor: TaskCommandExecutor;
  retrySafety?: TaskRetrySafety;
  signal?: AbortSignal;
  executeAttempt(prompt: string, attempt: TaskAttemptRecord): Promise<string>;
}): Promise<TaskClosureResult> {
  const initial = input.taskRuns.get(input.taskRunId);
  if (!initial) throw new Error(`TaskRun ${input.taskRunId} does not exist.`);
  const definition = readTaskDefinition(initial.task);
  const contract = definition.verification;
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
  let repairEvidence: TaskVerificationEvidence | undefined;
  let definitionFingerprint = persistedDefinitionFingerprint(initial.attempts);

  for (;;) {
    if (input.signal?.aborted || input.taskRuns.get(input.taskRunId)?.status === "cancelled") {
      return { status: "cancelled", reason: "Task was cancelled." };
    }
    const current = input.taskRuns.get(input.taskRunId);
    if (!current) throw new Error(`TaskRun ${input.taskRunId} disappeared.`);
    if (isTerminalForClosure(current.status)) return terminalResult(current.status);

    const attempt = resumeAttempt ?? input.taskRuns.createAttempt(input.taskRunId, {
      parentRunId: current.parentRunId,
      retrySafety: input.retrySafety ?? "unknown"
    });
    let output: string;
    let candidateArtifacts: TaskCandidateArtifacts;
    if (resumeAttempt) {
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
        ignore: input.ignore
      })) {
        transitionCurrent(input.taskRuns, input.taskRunId, attempt.attemptId, "completed", {
          artifacts: attempt.artifacts,
          verification: attempt.verification
        });
        return { status: "completed", output, evidence: attempt.verification as TaskVerificationEvidence };
      }
      resumeAttempt = undefined;
    } else {
      const beforeWorkspace = contract
        ? await captureTaskWorkspaceSnapshot(input.workspaceRoot, input.ignore)
        : undefined;
      definitionFingerprint ??= contract
        ? await fingerprintTaskVerificationDefinitions(input.workspaceRoot, contract, input.ignore)
        : undefined;
      const prompt = repairEvidence === undefined
        ? definition.prompt
        : repairPrompt(definition.prompt, contract!, repairEvidence, current.attempts.length);
      input.taskRuns.transition(input.taskRunId, "running", { attemptId: attempt.attemptId });
      output = await input.executeAttempt(prompt, attempt);
      if (!isLatestNonCancelledAttempt(input.taskRuns, input.taskRunId, attempt.attemptId)) {
        return { status: "cancelled", reason: "A stale Attempt result was ignored." };
      }
      if (!contract) {
        input.taskRuns.transition(input.taskRunId, "completed", { attemptId: attempt.attemptId, artifacts: { output } });
        return { status: "completed", output };
      }
      const afterWorkspace = await captureTaskWorkspaceSnapshot(input.workspaceRoot, input.ignore);
      candidateArtifacts = {
        output,
        definitionFingerprint: definitionFingerprint!,
        repairScope: compareTaskWorkspaceSnapshots(beforeWorkspace!, afterWorkspace, contract.allowedRepairPaths)
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
      repairScope: candidateArtifacts.repairScope,
      executor: input.executor,
      signal: input.signal
    });
    if (!isCurrentAttempt(input.taskRuns, input.taskRunId, attempt.attemptId)) {
      return { status: "cancelled", reason: "A stale verification result was ignored." };
    }
    const artifacts: TaskCandidateArtifacts = {
      ...candidateArtifacts,
      artifactFingerprint: evidence.artifactFingerprint
    };
    input.taskRuns.transition(input.taskRunId, "verifying", { attemptId: attempt.attemptId, verification: evidence, artifacts });
    if (evidence.status === "passed") {
      input.taskRuns.transition(input.taskRunId, "completed", { attemptId: attempt.attemptId, verification: evidence, artifacts });
      return { status: "completed", output, evidence };
    }
    if (evidence.status === "cancelled" || input.signal?.aborted) {
      if (input.taskRuns.get(input.taskRunId)?.status !== "cancelled") {
        input.taskRuns.transition(input.taskRunId, "cancelled", { attemptId: attempt.attemptId, verification: evidence, artifacts });
      }
      return { status: "cancelled", output, evidence, reason: evidence.reason };
    }
    if (evidence.status === "blocked") {
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
    input.taskRuns.prepareVerificationRepair(input.taskRunId, attempt.attemptId, {
      verification: evidence,
      artifacts,
      failure: { failureClass: "verification_failed", message: evidence.reason }
    });
    repairEvidence = evidence;
  }
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
    definitionFingerprint: record.definitionFingerprint,
    repairScope: {
      enforcement: "post_execution_change_guard",
      changedPaths: repairScope.changedPaths,
      violationPaths: repairScope.violationPaths
    },
    artifactFingerprint: typeof record.artifactFingerprint === "string" ? record.artifactFingerprint : undefined
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
  if (status === "blocked" || status === "needs_approval" || status === "policy_denied") return { status: "blocked" };
  return { status: "incomplete" };
}
