/** 主 Agent 通过模型可见 Task / TaskStatus 进入既有 TaskRun 验收闭环。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { approveTaskVerification } from "../src/runtime/TaskClosure.js";
import { pendingTaskVerificationApproval, taskCheckRecoveryToolCallIds } from "../src/runtime/taskVerification.js";
import type { AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { validateJsonSchema, type JsonSchema } from "../src/tools/schema.js";

const verificationCommand = "node -e \"const fs=require('node:fs');const p='.verification-state/count';const n=Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1;fs.writeFileSync(p,String(n));process.exit(fs.readFileSync('artifact.txt','utf8').trim()==='good'?0:1)\"";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-main-agent-verification-"));
  const originalFetch = globalThis.fetch;
  let workerRequests = 0;
  let rootTaskRequests = 0;
  let rootStatusRequests = 0;
  let expectingStatusResult = false;
  let taskRunId = "";
  let phase: "initial" | "status" | "simple" = "initial";
  const seenRootTools = new Set<string>();
  globalThis.fetch = (async (_input, init): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ name?: string; parameters?: JsonSchema; function?: { name?: string; parameters?: JsonSchema } }>;
    };
    const messages = body.messages ?? [];
    const system = textContent(messages[0]?.content);
    const last = messages.at(-1);
    const lastText = textContent(last?.content);
    const availableToolNames = new Set((body.tools ?? []).flatMap((tool) => {
      const name = tool.name ?? tool.function?.name;
      return name ? [name] : [];
    }));
    const isWorker = system.includes("focused, bounded worker inside Biny");
    if (system.includes("tool search assistant")) {
      return streamText(lastText.includes("TaskStatus") ? '{"tools":["TaskStatus"]}' : '{"tools":["Task"]}');
    }
    if (system.includes("选择需要的工具")) return streamText('{"tools":[]}');
    if (system.includes("选择需要的技能")) return streamText('{"skillIds":[]}');
    if (isWorker) {
      workerRequests += 1;
      return workerRequests % 2 === 1
        ? streamToolCall("worker-write", "Write", { path: "artifact.txt", content: "good\n" })
        : streamText("candidate ready");
    }
    for (const tool of body.tools ?? []) {
      const name = tool.name ?? tool.function?.name;
      if (name) seenRootTools.add(name);
    }
    const serializedMessages = JSON.stringify(messages);
    if (phase === "initial" && !availableToolNames.has("Task")) {
      return streamToolCall("discover-verified-task", "ToolSearch", { query: "Task" });
    }
    if (phase === "initial" && rootTaskRequests === 0 && availableToolNames.has("Task")) {
      rootTaskRequests += 1;
      const args = {
        task: "修复 artifact.txt，使原测试通过。",
        constraints: ["不得删除、跳过或弱化原测试"],
        verification: {
          objective: "原测试必须通过",
          checks: [{ id: "original-test", command: verificationCommand, definitionPaths: [] }],
          artifactPaths: ["artifact.txt"],
          allowedRepairPaths: ["artifact.txt"],
          maxAttempts: 2
        }
      };
      const taskTool = body.tools?.find((tool) => (tool.name ?? tool.function?.name) === "Task");
      const parameters = taskTool?.parameters ?? taskTool?.function?.parameters;
      assert.ok(parameters, JSON.stringify(body.tools));
      assert.deepEqual(validateJsonSchema(parameters, args), { ok: true, errors: [] });
      return streamToolCall("verified-task", "Task", args);
    }
    if (phase === "status" && !availableToolNames.has("TaskStatus")) {
      return streamToolCall("discover-task-status", "ToolSearch", { query: "TaskStatus" });
    }
    if (phase === "status" && rootStatusRequests === 0 && availableToolNames.has("TaskStatus")) {
      rootStatusRequests += 1;
      return streamToolCall("verified-task-status", "TaskStatus", { taskRunId });
    }
    if (phase === "simple") return streamText("普通回答");
    const toolResult = last?.role === "tool" ? JSON.stringify(last.content) : serializedMessages;
    if (toolResult.includes("needs_approval")) {
      return streamText(`任务尚未完成，正在等待具体验收命令审批。${toolResult}`);
    }
    if (expectingStatusResult && rootStatusRequests > 0 && serializedMessages.includes("completed") && serializedMessages.includes("passed")) {
      return streamText("任务已按原验收条件通过，证据来自实际命令结果。");
    }
    return streamText("未获得可证明的任务结果。");
  }) as typeof fetch;

  try {
    await mkdir(path.join(root, ".verification-state"), { recursive: true });
    const testConfig = config();
    const configStore: AgentConfigStore = {
      load: async () => structuredClone(testConfig),
      save: async () => undefined
    };
    const firstCommands = await createCommandRuntime(root, { configStore });
    const sessionId = firstCommands.agent.getInfo().sessionId;
    const firstRuntime = new InteractiveAgentRuntime(firstCommands);
    approveVisiblePermissions(firstRuntime);
    const waitingOutcome = await firstRuntime.submitPrompt("请修复失败测试，并明确保证原测试通过。不要让我手写内部 JSON。").completion;
    assert.equal(waitingOutcome.status, "completed", JSON.stringify(waitingOutcome));
    assert.equal(rootTaskRequests, 1);
    assert.equal(workerRequests, 2, "Worker should run exactly once before approval");
    assert.equal(seenRootTools.has("Task"), true);
    const waitingTasks = firstCommands.taskRuns.list({ limit: 10 }).tasks;
    assert.equal(waitingTasks.length, 1, "plain user text should create one verified TaskRun through Task");
    const waitingTask = waitingTasks[0]!;
    assert.match(waitingOutcome.output ?? "", /等待具体验收命令审批/u, JSON.stringify(waitingTask));
    taskRunId = waitingTask.taskRunId;
    assert.equal(waitingTask.status, "needs_approval");
    assert.equal(waitingTask.attempts.length, 1);
    const pending = pendingTaskVerificationApproval(waitingTask.attempts[0]?.verification);
    assert.ok(pending);
    assert.equal(pending.checkId, "original-test");
    assert.match(waitingOutcome.output ?? "", new RegExp(pending.approvalId, "u"));
    assert.match(waitingOutcome.output ?? "", /original-test/u);
    assert.match(waitingOutcome.output ?? "", /Verification command requires permission/u);
    assert.match(waitingOutcome.output ?? "", /\.verification-state\/count/u);
    assert.equal((waitingTask.task as { constraints?: string[] }).constraints?.[0], "不得删除、跳过或弱化原测试");
    const taskResult = (await readSessionEvents(sessionFilePath(root, sessionId))).find((event) =>
      event.type === "tool_result" && event.tool === "Task" && event.toolCallId === "verified-task"
    );
    assert.ok(taskResult?.type === "tool_result");
    const waitingProjection = taskResult.result as { status?: string; approval?: Record<string, unknown> };
    assert.equal(waitingProjection.status, "needs_approval");
    assert.deepEqual(waitingProjection.approval, {
      approvalId: pending.approvalId,
      checkId: "original-test",
      command: verificationCommand,
      cwd: ".",
      reason: "Verification command requires permission.",
      taskRunId,
      attemptId: pending.attemptId
    });
    assert.equal(seenRootTools.has("TaskApprove"), false, "the model must not receive an approval-escalation tool");
    const approvedToolCallId = taskCheckRecoveryToolCallIds({
      attemptId: pending.attemptId,
      checkId: pending.checkId,
      contractFingerprint: pending.contractFingerprint,
      approval: { ...pending, approvedAt: new Date().toISOString() }
    })[1]!;
    firstCommands.runtimeAuthority.appendEvent({
      eventId: "foreign-verification-result",
      sessionId: "foreign-session",
      runId: "foreign-task",
      turnId: "foreign-attempt",
      eventType: "session.tool_result",
      payload: {
        type: "tool_result",
        tool: "Bash",
        toolCallId: approvedToolCallId,
        sequence: 1,
        operationId: "foreign-operation",
        executionStatus: "succeeded",
        result: { status: "completed", exitCode: 0 },
        runtime: { eventId: "foreign-verification-result", eventSeq: 1, runId: "foreign-task", turnId: "foreign-attempt" }
      }
    });
    await firstRuntime.close();

    // 重建整个 CommandRuntime，证明恢复依赖持久事实；审批后只继续验收，不再运行 Worker。
    const recoveredCommands = await createCommandRuntime(root, { sessionId, configStore });
    await approveTaskVerification({
      taskRuns: recoveredCommands.taskRuns,
      taskRunId,
      approvalId: pending.approvalId,
      workspaceRoot: root,
      ignore: recoveredCommands.config.workspace.ignore
    });
    const approvedTask = recoveredCommands.taskRuns.get(taskRunId)!;
    const approvedAttempt = approvedTask.attempts[0]!;
    assert.equal(approvedAttempt.attemptId, pending.attemptId);
    assert.equal(((approvedAttempt.artifacts as { verificationApprovals?: unknown[] }).verificationApprovals ?? []).length, 1);
    const resumed = await recoveredCommands.startTaskRun(taskRunId);
    const resumedOutcome = await resumed.completion;
    const resumedTask = recoveredCommands.taskRuns.get(taskRunId)!;
    assert.equal(resumedOutcome.status, "completed", JSON.stringify({
      outcome: resumedOutcome,
      status: resumedTask.status,
      attempts: resumedTask.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        status: attempt.status,
        verification: attempt.verification,
        artifacts: attempt.artifacts,
        failure: attempt.failure
      })),
      workerRequests
    }));
    assert.equal(workerRequests, 2, "approval recovery must not rerun Worker");
    assert.equal(await readFile(path.join(root, ".verification-state", "count"), "utf8"), "1");
    const completed = recoveredCommands.taskRuns.get(taskRunId)!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.attempts.length, 1);
    assert.equal((completed.attempts[0]?.verification as { status?: string }).status, "passed");

    const recoveredRuntime = new InteractiveAgentRuntime(recoveredCommands);
    approveVisiblePermissions(recoveredRuntime);
    phase = "status";
    expectingStatusResult = true;
    const statusOutcome = await recoveredRuntime.submitPrompt("读取此前任务的真实验收结果并告诉我。不要重新创建任务。").completion;
    expectingStatusResult = false;
    assert.match(statusOutcome.output ?? "", /按原验收条件通过/u);
    assert.equal(rootStatusRequests, 1);
    assert.equal(seenRootTools.has("TaskStatus"), true);
    assert.equal(recoveredCommands.taskRuns.list({ limit: 10 }).tasks.length, 1, "TaskStatus must not duplicate the TaskRun");
    assert.equal(workerRequests, 2);

    phase = "simple";
    const simpleOutcome = await recoveredRuntime.submitPrompt("简单回答：1+1 等于几？").completion;
    assert.equal(simpleOutcome.output, "普通回答");
    assert.equal(recoveredCommands.taskRuns.list({ limit: 10 }).tasks.length, 1, "ordinary chat must not be promoted to TaskRun or Graph");
    assert.equal(recoveredCommands.graphs.listGraphs().length, 0);
    await recoveredRuntime.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
}

function approveVisiblePermissions(runtime: InteractiveAgentRuntime): void {
  runtime.subscribe((update: AgentRuntimeUpdate) => {
    if (update.event?.type !== "permission.requested") return;
    runtime.answerPermission(update.event.requestId, {
      approved: true,
      action: "allow_once",
      scope: "once",
      confirmation: update.event.request.requireFullYes ? "yes" : undefined
    });
  });
}

function config(): AgentConfig {
  return {
    ...defaultConfig,
    defaultModel: "main-agent-verification-test",
    providers: { test: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "test-key" } },
    models: {
      "main-agent-verification-test": {
        ...defaultConfig.models["deepseek-v4-flash"],
        provider: "test",
        model: "main-agent-verification-test",
        displayName: "Main Agent Verification Test"
      }
    },
    permission: { ...defaultConfig.permission, mode: "ask", criticalAlwaysAsk: true },
    checkpoints: { enabled: false },
    workspace: { ...defaultConfig.workspace, ignore: [...defaultConfig.workspace.ignore, ".verification-state"] },
    extensions: {
      ...defaultConfig.extensions,
      subagent: { ...defaultConfig.extensions.subagent, enabled: true, maxSteps: 4 }
    },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  };
}

function streamToolCall(id: string, name: string, args: Record<string, unknown>): Response {
  return stream([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ]);
}

function streamText(content: string): Response {
  return stream([
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ]);
}

function stream(parts: unknown[]): Response {
  return new Response([...parts.map((part) => `data: ${JSON.stringify(part)}`), "data: [DONE]"].join("\n\n") + "\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "object" && part !== null && "text" in part ? String(part.text) : "").join("");
}

await main();
console.log("main agent task verification tests passed");
