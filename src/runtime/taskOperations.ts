import { approveTaskVerification } from "./TaskClosure.js";
import type { InteractiveRuntimeHandle } from "./InteractiveAgentRuntime.js";
import type { TaskRunWithAttempts } from "./TaskRunStore.js";
import type { CommandRuntime } from "./CommandRuntime.js";

/** 重启只恢复已有候选的验证；未知的 Worker 副作用不会重放。 */
export async function recoverTaskRuns(
  commands: CommandRuntime,
  primarySessionId: string,
  resolveOwner: (sessionId: string) => Promise<CommandRuntime>,
  signal: AbortSignal
): Promise<void> {
  let cursor: number | undefined;
  do {
    signal.throwIfAborted();
    const page = commands.taskRuns.list({ limit: 1_000, cursor });
    for (const task of page.tasks) {
      signal.throwIfAborted();
      const latestAttempt = task.attempts.at(-1);
      if (task.status !== "running" && task.status !== "verifying") continue;
      const owner = task.sessionId === undefined || task.sessionId === primarySessionId
        ? commands : await resolveOwner(task.sessionId);
      signal.throwIfAborted();
      if (task.status === "running") {
        const resumable = await owner.canResumeWorkerTask(task.taskRunId);
        signal.throwIfAborted();
        owner.taskRuns.transition(task.taskRunId, "blocked", {
          attemptId: latestAttempt?.attemptId,
          artifacts: latestAttempt?.artifacts,
          verification: latestAttempt?.verification,
          highWaterSequence: latestAttempt?.highWaterSequence,
          failure: {
            failureClass: resumable ? "worker_interrupted" : "unsafe_recovery",
            message: resumable
              ? "Worker was interrupted with a durable checkpoint; explicit task resume is required."
              : "Host restarted without a safe Worker checkpoint; unknown side effects were not replayed."
          }
        });
      } else {
        const started = await owner.startTaskRun(task.taskRunId);
        void started.completion.catch(() => undefined);
      }
    }
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor !== undefined);
}

/** 审批与验证派发在准入内完成，模型验证的 completion 不阻塞其它准入。 */
export async function approveTaskRun(runtime: InteractiveRuntimeHandle, commands: CommandRuntime, taskRunId: string, approvalId: string, persistenceRoot: string): Promise<{ completion: Promise<TaskRunWithAttempts | undefined> }> {
  let admitted!: () => void;
  let rejectAdmission!: (error: unknown) => void;
  const admission = new Promise<void>((resolve, reject) => { admitted = resolve; rejectAdmission = reject; });
  const completion = runtime.runExclusiveOperation("subagent", async () => {
    await approveTaskVerification({
      taskRuns: commands.taskRuns, taskRunId, approvalId,
      workspaceRoot: commands.workspaceRoot || persistenceRoot,
      ignore: commands.config.workspace.ignore ?? []
    });
    const started = await commands.startTaskRun(taskRunId);
    admitted();
    const result = await started.completion;
    commands.graphs.projectTaskClosure(taskRunId, result);
    return commands.taskRuns.get(taskRunId);
  });
  void completion.catch(rejectAdmission);
  await admission;
  return { completion };
}
