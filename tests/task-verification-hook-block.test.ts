import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import {
  fingerprintTaskVerificationDefinitions,
  pendingTaskVerificationApproval,
  readTaskVerificationContract,
  recoverTaskCheckExecution,
  taskCheckToolCallId,
  taskVerificationFingerprint,
  verifyTaskCandidate,
  type TaskCommandExecutor
} from "../src/runtime/taskVerification.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createRunCommandTool } from "../src/tools/shell/runCommand.js";

const ignore = [".biny"];
const contract = readTaskVerificationContract({
  objective: "verify the candidate",
  checks: [{ id: "check", command: "check candidate" }],
  artifactPaths: ["artifact.txt"],
  allowedRepairPaths: ["artifact.txt"],
  maxAttempts: 3
});

await test("a hook denial is blocked evidence, not a failed acceptance command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-verification-hook-"));
  try {
    await writeFile(path.join(root, "artifact.txt"), "candidate");
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, ignore);
    const result = await verifyTaskCandidate({
      workspaceRoot: root, ignore, contract, definitionFingerprint,
      taskRunId: "task", attemptId: "attempt",
      executor: {
        executeTaskCheck: async () => ({
          result: { status: "blocked_by_hook", hook: "check maintenance lock", exitCode: 3, output: "maintenance lock" },
          toolCallId: "check-result", eventReferences: ["check-result"]
        })
      }
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.checks[0]?.status, "blocked");
    assert.match(result.reason ?? "", /beforeTool hook/u);
    assert.equal(result.checks[0]?.exitCode, 3);
    assert.deepEqual(result.checks[0]?.eventReferences, ["check-result"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const hookBlocks of [true, false]) {
  await test(hookBlocks
    ? "a configured beforeTool hook stops verification without starting repair attempts"
    : "an unmatched hook preserves repair after an ordinary acceptance-command failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-verification-hook-closure-"));
    const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const tasks = await DurableTaskRunStore.open(root, authority);
    const recorder = new SessionRecorder(root, "hook-checks", undefined, authority.asSink());
    recorder.repairTailForAppend();
    try {
      await writeFile(path.join(root, "artifact.txt"), "candidate");
      const config = structuredClone(defaultConfig);
      config.permission.mode = "full-access";
      config.permission.denyPaths = [];
      config.sandbox.mode = "off";
      config.hooks.beforeTool = [{
        command: "printf 'maintenance lock' >&2; exit 3",
        tools: hookBlocks ? ["Bash"] : ["Read"], extensions: [], timeoutMs: 1_000
      }];
      const registry = new ToolRegistry();
      const bash = createRunCommandTool({ workspaceRoot: root, ignore }, config.sandbox);
      const resolve = bash.resolveExecution.bind(bash);
      let commandExecutions = 0;
      registry.registerBuiltinTool({
        ...bash,
        async resolveExecution(args) {
          const execution = await resolve(args);
          assert.ok("execute" in execution);
          return {
            ...execution,
            async execute() {
              commandExecutions += 1;
              return commandExecutions === 1
                ? { status: "failed", exitCode: 1 }
                : { status: "completed", exitCode: 0 };
            }
          };
        }
      });
      const permission = new PermissionManager(config.permission);
      const executor: TaskCommandExecutor = {
        async executeTaskCheck(input) {
          const toolCallId = taskCheckToolCallId(input);
          const coordinator = new ToolExecutionCoordinator(
            { workspaceRoot: root, config, recorder, toolRegistry: registry, runId: input.taskRunId, turnId: input.attemptId },
            permission, () => {}, () => ({}), new Set(["Bash"]), { maxToolCalls: 1, maxRepeatedActions: 1 }
          );
          const tool = coordinator.createAgentTools().find((entry) => entry.name === "Bash");
          assert.ok(tool);
          const response = await tool.execute(toolCallId, { command: input.command, cwd: ".", timeoutMs: 1_000 });
          await coordinator.waitForIdle();
          await recorder.flush();
          return { result: response.details, toolCallId, eventReferences: [toolCallId] };
        }
      };
      const task = tasks.create({ task: { prompt: "produce candidate", verification: contract } });
      let workerCalls = 0;
      const result = await runTaskClosure({
        taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore, executor,
        executeAttempt: async () => { workerCalls += 1; return "candidate"; }
      });
      const attempts = tasks.get(task.taskRunId)!.attempts;
      const repairEvents = tasks.events(task.taskRunId).filter((event) => event.eventType === "task.verification.repair");
      if (hookBlocks) {
        assert.equal(commandExecutions, 0, "the hook must prevent acceptance-command execution");
        assert.equal(result.status, "blocked");
        assert.equal(result.evidence?.checks[0]?.status, "blocked");
        assert.equal(workerCalls, 1);
        assert.equal(attempts.length, 1);
        assert.equal(repairEvents.length, 0);
        const events = await readSessionEvents(recorder.filePath);
        assert.equal(events.some((event) => event.type === "tool_execution" && event.state === "admitted"), false);
        const checkInput = { attemptId: attempts[0]!.attemptId, checkId: "check", contractFingerprint: taskVerificationFingerprint(contract) };
        const recovery = recoverTaskCheckExecution(events, recorder.sessionId, checkInput);
        assert.equal(recovery.action, "reuse", "a persisted hook outcome must not dispatch the command again");
        if (recovery.action !== "reuse") assert.fail("missing durable hook result");
        assert.equal(recovery.execution.approvalRequired, false);
        assert.ok(recovery.execution.resultEventId);
        assert.ok(recovery.execution.eventReferences.includes(recovery.execution.resultEventId));
        const recovered = await verifyTaskCandidate({
          workspaceRoot: root, ignore, contract,
          definitionFingerprint: await fingerprintTaskVerificationDefinitions(root, contract, ignore),
          taskRunId: task.taskRunId, attemptId: attempts[0]!.attemptId,
          executor: { executeTaskCheck: async () => recovery.execution }
        });
        assert.equal(recovered.status, "blocked");
        assert.equal(recovered.checks[0]?.recovered, true);
        assert.deepEqual(recovered.checks[0]?.eventReferences, recovery.execution.eventReferences);
        assert.equal(pendingTaskVerificationApproval(recovered), undefined);
        const resumed = await runTaskClosure({
          taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore,
          executor: { executeTaskCheck: async () => assert.fail("a blocked task must not replay a check") },
          executeAttempt: async () => assert.fail("a blocked task must not start a repair")
        });
        assert.equal(resumed.status, "blocked");
        assert.equal(commandExecutions, 0);
        assert.equal(tasks.get(task.taskRunId)?.attempts.length, 1);
      } else {
        assert.equal(result.status, "completed");
        assert.equal(commandExecutions, 2);
        assert.equal(workerCalls, 2);
        assert.equal(attempts.length, 2);
        assert.equal(repairEvents.length, 1);
        assert.equal(attempts[0]?.status, "failed");
        assert.equal(attempts[1]?.status, "completed");
      }
    } finally {
      await recorder.close();
      tasks.close();
      authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
