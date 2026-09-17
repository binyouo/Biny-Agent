/**
 * TaskRun 的确定性验收协议与证据。
 *
 * 本模块只负责解析契约、绑定候选产物版本并执行检查；任务派发、Attempt 生命周期和修复
 * 仍由现有 TaskRun / Runtime 入口负责。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import type { PlanReviewCandidate } from "./planWork.js";
import type { SessionEvent } from "../session/recorder.js";
import { createToolOperationId } from "../tools/types.js";
import { isIgnoredPath } from "../workspace/ignore.js";
import { resolveWorkspaceDirectory, resolveWorkspacePath } from "../workspace/resolvePath.js";

export const taskVerificationContractVersion = 1;
export const defaultTaskVerificationMaxAttempts = 2;
export const taskVerificationPermissionRequiredReason = "Task verification requires explicit permission for this command.";

export interface TaskCommandCheck {
  id: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * 冻结验收标准本身依赖的工作区文件，例如 package.json、tsconfig 或验收脚本。
   * 待修复的测试与产物应放在 artifactPaths，而不是放进这里禁止修改。
   */
  definitionPaths: string[];
}

export interface TaskVerificationContract {
  version: 1;
  objective: string;
  context?: string;
  checks: TaskCommandCheck[];
  artifactPaths: string[];
  allowedRepairPaths: string[];
  /** 包含首次执行在内的 Attempt 总数上限，不是额外修复次数。 */
  maxAttempts: number;
}

export interface TaskCommandExecution {
  result: unknown;
  toolCallId: string;
  operationId?: string;
  resultEventId?: string;
  eventReferences: string[];
  recovered?: boolean;
  approvalRequired?: boolean;
}

export interface TaskVerificationApproval {
  approvalId: string;
  taskRunId: string;
  attemptId: string;
  checkId: string;
  toolCallId: string;
  deniedResultEventId: string;
  contractFingerprint: string;
  artifactFingerprint: string;
  definitionFingerprint: string;
  approvedAt: string;
}

export interface TaskCommandExecutor {
  executeTaskCheck(input: {
    command: string;
    checkId: string;
    contractFingerprint: string;
    cwd?: string;
    timeoutMs?: number;
    taskRunId: string;
    attemptId: string;
    approval?: TaskVerificationApproval;
    signal?: AbortSignal;
  }): Promise<TaskCommandExecution>;
}

export interface TaskCheckEvidence {
  checkId: string;
  command: string;
  cwd?: string;
  status: "passed" | "failed" | "blocked" | "cancelled";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  reason?: string;
  toolCallId: string;
  operationId?: string;
  resultEventId?: string;
  eventReferences: string[];
  recovered?: boolean;
  approvalRequired?: boolean;
}

export interface TaskRepairScopeEvidence {
  enforcement: "post_execution_change_guard";
  changedPaths: string[];
  violationPaths: string[];
}

export interface TaskVerificationEvidence {
  taskRunId: string;
  attemptId: string;
  contractVersion: 1;
  contractFingerprint: string;
  artifactFingerprint: string;
  definitionFingerprint: string;
  status: "passed" | "failed" | "blocked" | "cancelled";
  reason?: string;
  checks: TaskCheckEvidence[];
  repairScope?: TaskRepairScopeEvidence;
  verifiedAt: string;
}

export interface TaskCandidateArtifacts {
  output: string;
  definitionFingerprint: string;
  repairScope: TaskRepairScopeEvidence;
  artifactFingerprint?: string;
  verificationApprovals?: TaskVerificationApproval[];
}

export type TaskWorkspaceSnapshot = Record<string, string>;

export interface TaskDefinition {
  prompt: string;
  constraints?: string[];
  agent?: string;
  verification?: TaskVerificationContract;
  review?: PlanReviewCandidate;
  /** 无命令验收的计划节点只能产出只读报告，不授予工作区写权限。 */
  reportOnly?: boolean;
}

export function readTaskDefinition(task: unknown): TaskDefinition {
  if (typeof task === "string") return { prompt: requiredText(task, "task") };
  if (typeof task !== "object" || task === null || Array.isArray(task)) {
    return { prompt: JSON.stringify(task) ?? String(task) };
  }
  const value = task as Record<string, unknown>;
  const titledPrompt = [value.title, value.description]
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim())
    .join("\n\n");
  const prompt = firstText(value.prompt) ?? (titledPrompt || JSON.stringify(task));
  if (!prompt?.trim()) throw new Error("Task prompt cannot be empty.");
  const reportOnly = typeof value.planBlock === "object" && value.planBlock !== null && (value.planBlock as { kind?: unknown }).kind === "report";
  if (reportOnly && (value.verification !== undefined || value.review !== undefined)) throw new Error("Read-only report nodes cannot replace verified-candidate contracts.");
  return {
    prompt: prompt.trim(),
    constraints: value.constraints === undefined ? undefined : readStringList(value.constraints, "constraints", false),
    agent: optionalText(value.agent, "task.agent"),
    reportOnly: reportOnly ? true : undefined,
    review: value.review === undefined ? undefined : readReviewCandidate(value.review),
    verification: value.verification === undefined ? undefined : readTaskVerificationContract(value.verification)
  };
}

function readReviewCandidate(value: unknown): PlanReviewCandidate {
  if (typeof value !== "object" || value === null) throw new Error("Invalid review candidate.");
  const record = value as Record<string, unknown>;
  if (!isTaskVerificationEvidence(record.evidence) || record.evidence.status !== "passed") throw new Error("Review requires passed candidate evidence.");
  const taskRunId = requiredText(record.taskRunId, "review.taskRunId");
  const attemptId = requiredText(record.attemptId, "review.attemptId");
  if (record.evidence.taskRunId !== taskRunId || record.evidence.attemptId !== attemptId) throw new Error("Review evidence identity mismatch.");
  return { taskRunId, attemptId, evidence: record.evidence, contract: readTaskVerificationContract(record.contract) };
}

export function readTaskVerificationContract(value: unknown): TaskVerificationContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Task verification must be an object.");
  }
  const record = value as Record<string, unknown>;
  const version = record.version ?? taskVerificationContractVersion;
  if (version !== taskVerificationContractVersion) throw new Error(`Unsupported task verification version: ${String(version)}.`);
  const checks = record.checks;
  if (!Array.isArray(checks) || checks.length === 0) throw new Error("Task verification requires at least one check.");
  const parsedChecks = checks.map((check, index) => readCommandCheck(check, index));
  if (new Set(parsedChecks.map((check) => check.id)).size !== parsedChecks.length) {
    throw new Error("Task verification check ids must be unique.");
  }
  const artifactPaths = readStringList(record.artifactPaths, "artifactPaths", true);
  const allowedRepairPaths = record.allowedRepairPaths === undefined
    ? [...artifactPaths]
    : readStringList(record.allowedRepairPaths, "allowedRepairPaths", true);
  const maxAttempts = record.maxAttempts ?? defaultTaskVerificationMaxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 10) {
    throw new Error("Task verification maxAttempts must be an integer between 1 and 10.");
  }
  return {
    version,
    objective: requiredText(record.objective, "verification.objective"),
    context: optionalText(record.context, "verification.context"),
    checks: parsedChecks,
    artifactPaths,
    allowedRepairPaths,
    maxAttempts: maxAttempts as number
  };
}

export function taskVerificationFingerprint(contract: TaskVerificationContract): string {
  return createHash("sha256").update(stableJson(contract)).digest("hex");
}

export async function fingerprintTaskVerificationDefinitions(
  workspaceRoot: string,
  contract: TaskVerificationContract,
  ignore: readonly string[]
): Promise<string> {
  const paths = [...new Set(contract.checks.flatMap((check) => check.definitionPaths))].sort();
  const hash = createHash("sha256");
  hash.update(`contract\0${taskVerificationFingerprint(contract)}\0`);
  for (const requestedPath of paths) {
    const absolute = requestedPath === "."
      ? resolveWorkspaceDirectory(workspaceRoot, requestedPath, [...ignore])
      : resolveWorkspacePath(workspaceRoot, requestedPath, [...ignore]);
    await hashArtifactPath(hash, workspaceRoot, absolute, [...ignore]);
  }
  return hash.digest("hex");
}

export async function captureTaskWorkspaceSnapshot(
  workspaceRoot: string,
  ignore: readonly string[]
): Promise<TaskWorkspaceSnapshot> {
  const snapshot: TaskWorkspaceSnapshot = {};
  await snapshotWorkspacePath(snapshot, workspaceRoot, workspaceRoot, ignore);
  return snapshot;
}

export function compareTaskWorkspaceSnapshots(
  before: TaskWorkspaceSnapshot,
  after: TaskWorkspaceSnapshot,
  allowedRepairPaths: readonly string[]
): TaskRepairScopeEvidence {
  const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((relative) => before[relative] !== after[relative])
    .sort();
  const normalizedAllowed = allowedRepairPaths.map(normalizeRelativePath);
  return {
    enforcement: "post_execution_change_guard",
    changedPaths,
    violationPaths: changedPaths.filter((relative) => !normalizedAllowed.some((allowed) => pathContains(allowed, relative)))
  };
}

export async function fingerprintTaskArtifacts(
  workspaceRoot: string,
  artifactPaths: readonly string[],
  ignore: readonly string[]
): Promise<string> {
  const hash = createHash("sha256");
  for (const requestedPath of [...artifactPaths].sort()) {
    const absolute = requestedPath === "."
      ? resolveWorkspaceDirectory(workspaceRoot, requestedPath, [...ignore])
      : resolveWorkspacePath(workspaceRoot, requestedPath, [...ignore]);
    await hashArtifactPath(hash, workspaceRoot, absolute, [...ignore]);
  }
  return hash.digest("hex");
}

export async function verifyTaskCandidate(input: {
  workspaceRoot: string;
  ignore: readonly string[];
  taskRunId: string;
  attemptId: string;
  contract: TaskVerificationContract;
  definitionFingerprint: string;
  expectedArtifactFingerprint?: string;
  approvals?: readonly TaskVerificationApproval[];
  repairScope?: TaskRepairScopeEvidence;
  executor: TaskCommandExecutor;
  signal?: AbortSignal;
}): Promise<TaskVerificationEvidence> {
  const contractFingerprint = taskVerificationFingerprint(input.contract);
  if (input.repairScope?.violationPaths.length) {
    return emptyEvidence(
      input,
      contractFingerprint,
      input.definitionFingerprint,
      "blocked",
      `Task changed paths outside allowedRepairPaths: ${input.repairScope.violationPaths.join(", ")}`,
      input.repairScope
    );
  }
  const currentDefinitionFingerprint = await fingerprintTaskVerificationDefinitions(
    input.workspaceRoot,
    input.contract,
    input.ignore
  ).catch(() => undefined);
  if (currentDefinitionFingerprint === undefined || currentDefinitionFingerprint !== input.definitionFingerprint) {
    return emptyEvidence(
      input,
      contractFingerprint,
      input.definitionFingerprint,
      "blocked",
      "Verification definition inputs changed after task execution started; the original acceptance standard cannot be proven.",
      input.repairScope
    );
  }
  let artifactFingerprint: string;
  try {
    artifactFingerprint = await fingerprintTaskArtifacts(input.workspaceRoot, input.contract.artifactPaths, input.ignore);
  } catch (error) {
    return emptyEvidence(input, contractFingerprint, input.definitionFingerprint, "blocked", `Cannot fingerprint candidate artifacts: ${errorMessage(error)}`, input.repairScope);
  }
  if (input.expectedArtifactFingerprint !== undefined && input.expectedArtifactFingerprint !== artifactFingerprint) {
    return evidence(
      input,
      contractFingerprint,
      artifactFingerprint,
      input.definitionFingerprint,
      [],
      "blocked",
      "Candidate artifacts changed after verification paused; the previous approval or evidence cannot be reused.",
      input.repairScope
    );
  }
  const verificationWorkspace = await captureTaskWorkspaceSnapshot(input.workspaceRoot, input.ignore).catch(() => undefined);
  if (verificationWorkspace === undefined) {
    return emptyEvidence(
      input,
      contractFingerprint,
      input.definitionFingerprint,
      "blocked",
      "Cannot capture the workspace baseline required to prove verification stability.",
      input.repairScope
    );
  }
  const checks: TaskCheckEvidence[] = [];
  for (const check of input.contract.checks) {
    if (input.signal?.aborted) {
      return evidence(input, contractFingerprint, artifactFingerprint, input.definitionFingerprint, checks, "cancelled", "Task verification was cancelled.", input.repairScope);
    }
    let execution: TaskCommandExecution;
    try {
      execution = await input.executor.executeTaskCheck({
        command: check.command,
        checkId: check.id,
        contractFingerprint,
        cwd: check.cwd,
        timeoutMs: check.timeoutMs,
        taskRunId: input.taskRunId,
        attemptId: input.attemptId,
        approval: input.approvals?.find((approval) => matchingTaskVerificationApproval(approval, {
          taskRunId: input.taskRunId,
          attemptId: input.attemptId,
          checkId: check.id,
          toolCallId: taskCheckToolCallId({ attemptId: input.attemptId, checkId: check.id, contractFingerprint }),
          contractFingerprint,
          artifactFingerprint,
          definitionFingerprint: input.definitionFingerprint
        })),
        signal: input.signal
      });
    } catch (error) {
      const status = input.signal?.aborted ? "cancelled" : "blocked";
      checks.push({
        checkId: check.id,
        command: check.command,
        cwd: check.cwd,
        status,
        reason: errorMessage(error),
        toolCallId: `verification:${input.attemptId}:${check.id}`,
        eventReferences: []
      });
      return evidence(input, contractFingerprint, artifactFingerprint, input.definitionFingerprint, checks, status, errorMessage(error), input.repairScope);
    }
    const result = commandResult(execution.result);
    const classified = classifyCheckResult(result, input.signal);
    checks.push({
      checkId: check.id,
      command: check.command,
      cwd: check.cwd,
      status: classified.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      reason: classified.reason,
      toolCallId: execution.toolCallId,
      operationId: execution.operationId,
      resultEventId: execution.resultEventId,
      eventReferences: execution.eventReferences,
      recovered: execution.recovered,
      approvalRequired: execution.approvalRequired
    });
    if (classified.status === "blocked" || classified.status === "cancelled") {
      return evidence(input, contractFingerprint, artifactFingerprint, input.definitionFingerprint, checks, classified.status, classified.reason, input.repairScope);
    }
  }
  const afterFingerprint = await fingerprintTaskArtifacts(input.workspaceRoot, input.contract.artifactPaths, input.ignore).catch(() => undefined);
  if (afterFingerprint === undefined || afterFingerprint !== artifactFingerprint) {
    return evidence(
      input,
      contractFingerprint,
      artifactFingerprint,
      input.definitionFingerprint,
      checks,
      "blocked",
      "Candidate artifacts changed while verification was running; the evidence cannot approve either version.",
      input.repairScope
    );
  }
  const afterDefinitionFingerprint = await fingerprintTaskVerificationDefinitions(
    input.workspaceRoot,
    input.contract,
    input.ignore
  ).catch(() => undefined);
  if (afterDefinitionFingerprint === undefined || afterDefinitionFingerprint !== input.definitionFingerprint) {
    return evidence(
      input,
      contractFingerprint,
      artifactFingerprint,
      input.definitionFingerprint,
      checks,
      "blocked",
      "Verification definition inputs changed while checks were running.",
      input.repairScope
    );
  }
  const afterWorkspace = await captureTaskWorkspaceSnapshot(input.workspaceRoot, input.ignore).catch(() => undefined);
  if (afterWorkspace === undefined) {
    return evidence(input, contractFingerprint, artifactFingerprint, input.definitionFingerprint, checks, "blocked", "Cannot prove that the workspace stayed stable during verification.", input.repairScope);
  }
  const verificationChanges = compareTaskWorkspaceSnapshots(verificationWorkspace, afterWorkspace, []);
  if (verificationChanges.changedPaths.length) {
    return evidence(
      input,
      contractFingerprint,
      artifactFingerprint,
      input.definitionFingerprint,
      checks,
      "blocked",
      `Workspace changed while verification was running: ${verificationChanges.changedPaths.join(", ")}`,
      input.repairScope
    );
  }
  const failed = checks.find((check) => check.status === "failed");
  return evidence(
    input,
    contractFingerprint,
    artifactFingerprint,
    input.definitionFingerprint,
    checks,
    failed ? "failed" : "passed",
    failed?.reason,
    input.repairScope
  );
}

export async function canReuseTaskVerification(input: {
  evidence: unknown;
  contract: TaskVerificationContract;
  definitionFingerprint: string;
  workspaceRoot: string;
  ignore: readonly string[];
}): Promise<boolean> {
  if (!isTaskVerificationEvidence(input.evidence) || input.evidence.status !== "passed") return false;
  if (input.evidence.contractFingerprint !== taskVerificationFingerprint(input.contract)) return false;
  const currentDefinitionFingerprint = await fingerprintTaskVerificationDefinitions(input.workspaceRoot, input.contract, input.ignore).catch(() => undefined);
  if (currentDefinitionFingerprint === undefined
    || currentDefinitionFingerprint !== input.definitionFingerprint
    || input.evidence.definitionFingerprint !== input.definitionFingerprint) return false;
  const current = await fingerprintTaskArtifacts(input.workspaceRoot, input.contract.artifactPaths, input.ignore).catch(() => undefined);
  return current !== undefined && current === input.evidence.artifactFingerprint;
}

export function isTaskVerificationEvidence(value: unknown): value is TaskVerificationEvidence {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<TaskVerificationEvidence>;
  return record.contractVersion === 1
    && typeof record.contractFingerprint === "string"
    && typeof record.artifactFingerprint === "string"
    && typeof record.definitionFingerprint === "string"
    && (record.status === "passed" || record.status === "failed" || record.status === "blocked" || record.status === "cancelled")
    && Array.isArray(record.checks);
}

export function pendingTaskVerificationApproval(evidence: unknown): Omit<TaskVerificationApproval, "approvedAt"> | undefined {
  if (!isTaskVerificationEvidence(evidence) || evidence.status !== "blocked") return undefined;
  const check = evidence.checks.find((candidate) => candidate.status === "blocked" && candidate.approvalRequired === true);
  if (!check?.resultEventId) return undefined;
  const approval = {
    taskRunId: evidence.taskRunId,
    attemptId: evidence.attemptId,
    checkId: check.checkId,
    toolCallId: check.toolCallId,
    deniedResultEventId: check.resultEventId,
    contractFingerprint: evidence.contractFingerprint,
    artifactFingerprint: evidence.artifactFingerprint,
    definitionFingerprint: evidence.definitionFingerprint
  };
  return { approvalId: taskVerificationApprovalId(approval), ...approval };
}

/** 用户批准的是这一份持久化等待事实，而不是“当前碰巧排在前面的检查”。 */
export function taskVerificationApprovalId(
  approval: Omit<TaskVerificationApproval, "approvalId" | "approvedAt">
): string {
  return `task-approval:${createHash("sha256").update(stableJson(approval)).digest("hex")}`;
}

export function isTaskVerificationApproval(value: unknown): value is TaskVerificationApproval {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<TaskVerificationApproval>;
  return typeof record.approvalId === "string"
    && typeof record.taskRunId === "string"
    && typeof record.attemptId === "string"
    && typeof record.checkId === "string"
    && typeof record.toolCallId === "string"
    && typeof record.deniedResultEventId === "string"
    && typeof record.contractFingerprint === "string"
    && typeof record.artifactFingerprint === "string"
    && typeof record.definitionFingerprint === "string"
    && typeof record.approvedAt === "string";
}

export function matchingTaskVerificationApproval(
  approval: TaskVerificationApproval | undefined,
  expected: Omit<TaskVerificationApproval, "approvalId" | "deniedResultEventId" | "approvedAt">
): boolean {
  return approval !== undefined
    && approval.approvalId === taskVerificationApprovalId({
      taskRunId: expected.taskRunId,
      attemptId: expected.attemptId,
      checkId: expected.checkId,
      toolCallId: expected.toolCallId,
      deniedResultEventId: approval.deniedResultEventId,
      contractFingerprint: expected.contractFingerprint,
      artifactFingerprint: expected.artifactFingerprint,
      definitionFingerprint: expected.definitionFingerprint
    })
    && approval.taskRunId === expected.taskRunId
    && approval.attemptId === expected.attemptId
    && approval.checkId === expected.checkId
    && approval.toolCallId === expected.toolCallId
    && approval.contractFingerprint === expected.contractFingerprint
    && approval.artifactFingerprint === expected.artifactFingerprint
    && approval.definitionFingerprint === expected.definitionFingerprint;
}

function readCommandCheck(value: unknown, index: number): TaskCommandCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Task verification check ${String(index)} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const timeoutMs = record.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 600_000)) {
    throw new Error(`Task verification check ${String(index)} timeoutMs is invalid.`);
  }
  return {
    id: optionalText(record.id, `verification.checks[${String(index)}].id`) ?? `check-${String(index + 1)}`,
    command: requiredText(record.command, `verification.checks[${String(index)}].command`),
    cwd: optionalText(record.cwd, `verification.checks[${String(index)}].cwd`),
    timeoutMs: timeoutMs as number | undefined,
    definitionPaths: record.definitionPaths === undefined
      ? []
      : readStringList(record.definitionPaths, `checks[${String(index)}].definitionPaths`, false)
  };
}

function readStringList(value: unknown, label: string, required: boolean): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Task verification ${label} must be a string array.`);
  }
  if (required && value.length === 0) throw new Error(`Task verification ${label} cannot be empty.`);
  return value.map((item) => (item as string).trim());
}

export function taskCheckToolCallId(input: { attemptId: string; checkId: string; contractFingerprint: string }): string {
  const checkFingerprint = createHash("sha256")
    .update(`${input.contractFingerprint}\0${input.checkId}`)
    .digest("hex")
    .slice(0, 20);
  return `task-verification:${input.attemptId}:${checkFingerprint}`;
}

export function taskCheckRecoveryToolCallIds(input: {
  attemptId: string;
  checkId: string;
  contractFingerprint: string;
  approval?: TaskVerificationApproval;
}): string[] {
  const toolCallId = taskCheckToolCallId(input);
  return input.approval
    ? [toolCallId, approvedTaskCheckToolCallId(toolCallId, input.approval.deniedResultEventId)]
    : [toolCallId];
}

export type TaskCheckRecoveryDecision =
  | { action: "execute"; toolCallId: string }
  | { action: "reuse"; execution: TaskCommandExecution }
  | { action: "block"; execution: TaskCommandExecution };

export function recoverTaskCheckExecution(
  events: readonly SessionEvent[],
  sessionId: string,
  input: { attemptId: string; checkId: string; contractFingerprint: string; approval?: TaskVerificationApproval }
): TaskCheckRecoveryDecision {
  const [toolCallId] = taskCheckRecoveryToolCallIds(input);
  if (!toolCallId) throw new Error("Task verification recovery has no tool call identity.");
  const original = taskCheckOperationFacts(events, sessionId, toolCallId);
  const approval = input.approval;
  const approvedDeniedResult = approval !== undefined
    && original.result !== undefined
    && original.result.runtime?.eventId === approval.deniedResultEventId
    && approval.toolCallId === toolCallId
    && isTaskVerificationPermissionResult(original.result.result)
    && !original.possiblyDispatched;
  if (approval && approvedDeniedResult) {
    return recoverTaskCheckOperation(
      events,
      sessionId,
      approvedTaskCheckToolCallId(toolCallId, approval.deniedResultEventId)
    );
  }
  if (approval) {
    const originalRecovery = recoverTaskCheckOperation(events, sessionId, toolCallId);
    if (originalRecovery.action === "reuse"
      && !isTaskVerificationPermissionResult(originalRecovery.execution.result)) return originalRecovery;
    if (originalRecovery.action === "block") return originalRecovery;
    const reason = "The approved verification denial cannot be matched to the current durable tool log; the check will not be replayed.";
    return {
      action: "block",
      execution: {
        result: { status: "unknown", error: reason },
        toolCallId,
        operationId: original.operationId,
        resultEventId: original.result?.runtime?.eventId,
        eventReferences: original.references,
        recovered: true
      }
    };
  }
  return recoverTaskCheckOperation(events, sessionId, toolCallId);
}

function approvedTaskCheckToolCallId(toolCallId: string, deniedResultEventId: string): string {
  const approvalFingerprint = createHash("sha256").update(deniedResultEventId).digest("hex").slice(0, 16);
  return `${toolCallId}:approved:${approvalFingerprint}`;
}

function recoverTaskCheckOperation(
  events: readonly SessionEvent[],
  sessionId: string,
  toolCallId: string
): TaskCheckRecoveryDecision {
  const facts = taskCheckOperationFacts(events, sessionId, toolCallId);
  if (facts.result && !facts.possiblyDispatchedAfterResult) {
    const recovered = recoveredCommandResult(facts.result);
    return {
      action: "reuse",
      execution: {
        result: recovered,
        toolCallId,
        operationId: facts.operationId,
        resultEventId: facts.result.runtime?.eventId,
        eventReferences: facts.references,
        recovered: true,
        approvalRequired: isTaskVerificationPermissionResult(recovered)
      }
    };
  }
  if (!facts.possiblyDispatched) return { action: "execute", toolCallId };
  const reason = `Verification operation ${facts.operationId} may have been dispatched, but no durable tool result proves its outcome.`;
  return {
    action: "block",
    execution: {
      result: { status: "unknown", error: reason },
      toolCallId,
      operationId: facts.operationId,
      resultEventId: facts.result?.runtime?.eventId,
      eventReferences: facts.references,
      recovered: true
    }
  };
}

function taskCheckOperationFacts(events: readonly SessionEvent[], sessionId: string, toolCallId: string): {
  operationId: string;
  result: Extract<SessionEvent, { type: "tool_result" }> | undefined;
  references: string[];
  possiblyDispatched: boolean;
  possiblyDispatchedAfterResult: boolean;
} {
  const matching = events.filter((event) =>
    (event.type === "tool_execution" || event.type === "tool_result" || event.type === "tool_call")
    && event.toolCallId === toolCallId
  );
  const persistedOperation = [...matching].reverse().find((event) =>
    (event.type === "tool_execution" || event.type === "tool_result") && event.operationId !== undefined
  );
  const operationId = persistedOperation && "operationId" in persistedOperation && persistedOperation.operationId
    ? persistedOperation.operationId
    : createToolOperationId(sessionId, toolCallId);
  let resultIndex = -1;
  for (let index = matching.length - 1; index >= 0; index -= 1) {
    const event = matching[index];
    if (event?.type === "tool_result") {
      resultIndex = index;
      break;
    }
  }
  const result = resultIndex < 0
    ? undefined
    : matching[resultIndex] as Extract<SessionEvent, { type: "tool_result" }>;
  const references = [toolCallId, operationId, ...matching.flatMap((event) => event.runtime?.eventId ? [event.runtime.eventId] : [])];
  const executions = matching.filter((event): event is Extract<SessionEvent, { type: "tool_execution" }> => event.type === "tool_execution");
  const possiblyDispatchedAfterResult = matching.slice(resultIndex + 1).some((event) =>
    event.type === "tool_execution" && operationMayHaveDispatched(event.state)
  );
  const possiblyDispatched = executions.some((event) => operationMayHaveDispatched(event.state));
  return {
    operationId,
    result,
    references: [...new Set(references)],
    possiblyDispatched,
    possiblyDispatchedAfterResult
  };
}

export function isTaskVerificationPermissionResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.status === "denied" && record.reason === taskVerificationPermissionRequiredReason;
}

function operationMayHaveDispatched(state: Extract<SessionEvent, { type: "tool_execution" }>["state"]): boolean {
  return state === "admitted" || state === "side_effect_committed" || state === "succeeded" || state === "unknown";
}

function recoveredCommandResult(event: Extract<SessionEvent, { type: "tool_result" }>): unknown {
  if (typeof event.result === "object" && event.result !== null && (event.result as { archived?: unknown }).archived === true) {
    return {
      status: "unknown",
      error: "The durable verification result was archived and cannot be reconstructed safely for automatic recovery."
    };
  }
  const result = typeof event.result === "object" && event.result !== null
    ? event.result as Record<string, unknown>
    : {};
  if (event.executionStatus === "unknown") return { ...result, status: "unknown" };
  if (event.executionStatus === "cancelled") return { ...result, status: "cancelled" };
  return event.result;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()));
}

async function hashArtifactPath(
  hash: ReturnType<typeof createHash>,
  workspaceRoot: string,
  absolute: string,
  ignore: readonly string[]
): Promise<void> {
  const relative = path.relative(workspaceRoot, absolute) || ".";
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      hash.update(`missing\0${relative}\0`);
      return;
    }
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    hash.update(`symlink\0${relative}\0${await readlink(absolute)}\0`);
    return;
  }
  if (metadata.isDirectory()) {
    hash.update(`directory\0${relative}\0`);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(absolute, entry.name);
      const childRelative = path.relative(workspaceRoot, child);
      if (isIgnoredPath(childRelative, [...ignore])) continue;
      await hashArtifactPath(hash, workspaceRoot, child, ignore);
    }
    return;
  }
  if (!metadata.isFile()) {
    hash.update(`special\0${relative}\0${String(metadata.mode)}\0`);
    return;
  }
  hash.update(`file\0${relative}\0${String(metadata.size)}\0`);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => { hash.update(chunk); });
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  hash.update("\0");
}

async function snapshotWorkspacePath(
  snapshot: TaskWorkspaceSnapshot,
  workspaceRoot: string,
  absolute: string,
  ignore: readonly string[]
): Promise<void> {
  const relative = path.relative(workspaceRoot, absolute) || ".";
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (metadata.isDirectory()) {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(absolute, entry.name);
      const childRelative = path.relative(workspaceRoot, child);
      if (isIgnoredPath(childRelative, [...ignore])) continue;
      await snapshotWorkspacePath(snapshot, workspaceRoot, child, ignore);
    }
    return;
  }
  const hash = createHash("sha256");
  if (metadata.isSymbolicLink()) hash.update(`symlink\0${await readlink(absolute)}`);
  else if (metadata.isFile()) {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolute);
      stream.on("data", (chunk) => { hash.update(chunk); });
      stream.once("end", resolve);
      stream.once("error", reject);
    });
  } else hash.update(`special\0${String(metadata.mode)}`);
  snapshot[normalizeRelativePath(relative)] = hash.digest("hex");
}

function normalizeRelativePath(value: string): string {
  const normalized = path.normalize(value).replaceAll(path.sep, "/").replace(/^\.\//u, "");
  return normalized || ".";
}

function pathContains(parent: string, child: string): boolean {
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

function classifyCheckResult(
  result: { status?: string; exitCode?: number; reason?: string; error?: string },
  signal: AbortSignal | undefined
): { status: TaskCheckEvidence["status"]; reason?: string } {
  if (signal?.aborted || result.status === "cancelled" || result.status === "aborted") {
    return { status: "cancelled", reason: result.error ?? result.reason ?? "Task verification was cancelled." };
  }
  if (result.status === "denied" || result.status === "permission_required") {
    return { status: "blocked", reason: result.reason ?? result.error ?? "Verification command requires permission." };
  }
  if (result.status === "unknown") {
    return { status: "blocked", reason: result.reason ?? result.error ?? "Verification command has an unknown side effect outcome." };
  }
  if (result.exitCode === 126 || result.exitCode === 127) {
    return { status: "blocked", reason: result.error ?? `Verification environment cannot execute the command (exit ${String(result.exitCode)}).` };
  }
  if (result.status === "timed_out") {
    return { status: "blocked", reason: result.error ?? "Verification command timed out." };
  }
  if (result.exitCode === 0 && result.status !== "failed") return { status: "passed" };
  return {
    status: "failed",
    reason: result.error ?? result.reason ?? (result.exitCode === undefined
      ? "Verification command did not produce a trustworthy exit code."
      : `Verification command exited with code ${String(result.exitCode)}.`)
  };
}

function commandResult(value: unknown): {
  status?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  reason?: string;
  error?: string;
} {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  return {
    status: typeof record.status === "string" ? record.status : undefined,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
    stdout: typeof record.stdout === "string" ? evidenceOutputPreview(record.stdout) : undefined,
    stderr: typeof record.stderr === "string" ? evidenceOutputPreview(record.stderr) : undefined,
    stdoutTruncated: record.stdoutTruncated === true || typeof record.stdout === "string" && record.stdout.length > 8_192,
    stderrTruncated: record.stderrTruncated === true || typeof record.stderr === "string" && record.stderr.length > 8_192,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    error: typeof record.error === "string" ? record.error : undefined
  };
}

function evidenceOutputPreview(value: string): string {
  return value.length <= 8_192 ? value : value.slice(-8_192);
}

function emptyEvidence(
  input: { taskRunId: string; attemptId: string },
  contractFingerprint: string,
  definitionFingerprint: string,
  status: TaskVerificationEvidence["status"],
  reason: string,
  repairScope?: TaskRepairScopeEvidence
): TaskVerificationEvidence {
  return {
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    contractVersion: 1,
    contractFingerprint,
    artifactFingerprint: "unavailable",
    definitionFingerprint,
    status,
    reason,
    checks: [],
    repairScope,
    verifiedAt: new Date().toISOString()
  };
}

function evidence(
  input: { taskRunId: string; attemptId: string },
  contractFingerprint: string,
  artifactFingerprint: string,
  definitionFingerprint: string,
  checks: TaskCheckEvidence[],
  status: TaskVerificationEvidence["status"],
  reason?: string,
  repairScope?: TaskRepairScopeEvidence
): TaskVerificationEvidence {
  return {
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    contractVersion: 1,
    contractFingerprint,
    artifactFingerprint,
    definitionFingerprint,
    status,
    reason,
    checks,
    repairScope,
    verifiedAt: new Date().toISOString()
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
