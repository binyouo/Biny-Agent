import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sessionFilePath } from "../session/store.js";
import type { RuntimeEventAuthority } from "./RuntimeAuthority.js";
import { isLegacyWorkerOwnerBoundary, type LegacyWorkerOwnerProof, type TaskRunWithAttempts } from "./TaskRunStore.js";
import { readWorkerAttemptCheckpoint } from "./TaskClosure.js";
import { readWorkerSessionCheckpoint } from "./WorkerSession.js";

/** Read-only proof for the old slash-child projection that omitted its owner. */
export async function readLegacyWorkerOwner(
  persistenceRoot: string,
  task: TaskRunWithAttempts,
  authority: RuntimeEventAuthority,
  workspaceRoot?: string
): Promise<LegacyWorkerOwnerProof> {
  const reject = (): never => { throw new Error("Legacy Worker owner cannot be uniquely validated; unsafe recovery is blocked."); };
  if (!isLegacyWorkerOwnerBoundary(task)) return reject();
  const attempt = task.attempts.at(-1)!;
  const admission = readWorkerAttemptCheckpoint(attempt.artifacts);
  if (!admission || admission.communication !== false || admission.prompt !== task.task) return reject();
  const { checkpoint, facts, events } = await readWorkerSessionCheckpoint(persistenceRoot, attempt.attemptId);
  const sessionId = facts.parentSessionId;
  if (!sessionId?.trim() || checkpoint.prompt !== admission.prompt
    || !task.parentRunId || task.parentRunId !== attempt.parentRunId || facts.parentRunId !== task.parentRunId
    || facts.workspaceRoot !== await realpath(facts.workspaceRoot)
    || (workspaceRoot !== undefined && facts.workspaceRoot !== await realpath(workspaceRoot))) return reject();
  let completionDigest: string | undefined;
  if (facts.status === "completed") {
    const terminalRecords = events.flatMap((event, index) => event.type === "turn_status" ? [{ event, index }] : []);
    const terminals = terminalRecords.map(record => record.event);
    const highWaterIndex = events.findIndex(event => event.runtime?.eventId === checkpoint.runtimeHighWater?.eventId
      && event.runtime?.eventSeq === checkpoint.runtimeHighWater?.eventSeq);
    if (typeof facts.output !== "string" || !terminals.length || terminalRecords.some(record => record.index > highWaterIndex)
      || events.slice(terminalRecords.at(-1)!.index + 1).some(event => event.type !== "model_request")
      || terminals.some(event =>
      event.status !== "completed" || event.stopReason !== "completed" || event.steps !== facts.startedSteps
      || event.summary !== facts.output || !event.runtime?.eventId || event.runtime.turnId !== `worker-turn:${attempt.attemptId}`
    )) return reject();
    // Pin the authoritative output and its terminal facts across policy preparation without copying the output into the owner event.
    completionDigest = createHash("sha256").update(JSON.stringify({ output: facts.output, steps: facts.startedSteps,
      policy: facts.policy, systemPrompt: checkpoint.systemPrompt,
      terminals: terminals.map(event => ({ runtime: event.runtime, summary: event.summary,
        status: event.status, stopReason: event.stopReason, steps: event.steps })) })).digest("hex");
  }
  // Validate the parent identity as a session ID before using it for Host routing.
  sessionFilePath(persistenceRoot, sessionId);
  const calls = authority.readToolEvents([task.taskRunId]);
  if (calls.length !== 1 || calls.some(event => {
    const payload = event.payload as { tool?: unknown; toolCallId?: unknown; auditOnly?: unknown; args?: { task?: unknown } } | undefined;
    return event.eventType !== "session.tool_call" || event.sessionId !== sessionId || payload?.tool !== "Task" || payload.toolCallId !== task.taskRunId
      || payload.auditOnly !== true || payload.args?.task !== admission.prompt;
  })) return reject();
  return {
    taskRunId: task.taskRunId, attemptId: attempt.attemptId, expectedRevision: task.revision,
    sessionId, parentRunId: task.parentRunId, runId: attempt.runId, turnId: attempt.turnId,
    prompt: admission.prompt, workspaceRoot: facts.workspaceRoot, parentEventIds: calls.map(event => event.eventId), completionDigest
  };
}
