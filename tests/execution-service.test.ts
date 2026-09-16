import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentRunOptions,
  AgentSessionInfo
} from "../src/agent/AgentSession.js";
import type {
  AgentPermissionRequest,
  AgentSessionEvent,
  AgentTurnOutcome
} from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { ExecutionService } from "../src/runtime/ExecutionService.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { SessionRunLedger } from "../src/session/runLedger.js";

await testChatUsesOrdinaryAgentLoop();
await testNaturalLanguageNeverSelectsAnotherExecutionFramework();
await testExecutionBridgesCliPermission();
await testExecutionCleansPermissionListenerWhenSubmitFails();
await testExecutionUsesPromptBoundary();

async function testChatUsesOrdinaryAgentLoop(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-execution-chat-"));
  try {
    const prompts: string[] = [];
    const runtime = new InteractiveAgentRuntime(fakeRuntime(root, async function* (input) {
      prompts.push(input);
      yield done({
        status: "completed",
        stopReason: "model_stop",
        finishReason: "stop",
        steps: 1,
        output: "direct answer"
      });
    }));

    const outcome = await runtime.submitPrompt("回答一个问题").completion;
    assert.equal(outcome.status, "completed");
    assert.deepEqual(prompts, ["回答一个问题"]);
    await assert.rejects(fs.stat(path.join(root, ".biny", "tasks")), { code: "ENOENT" });
    await runtime.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testNaturalLanguageNeverSelectsAnotherExecutionFramework(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-execution-unified-"));
  try {
    const prompts: string[] = [];
    const runtime = fakeRuntime(root, async function* (input) {
      prompts.push(input);
      const suffix = String(prompts.length);
      yield {
        type: "tool.started",
        toolCallId: `read-${suffix}`,
        tool: "Read",
        args: { path: "README.md" }
      };
      yield {
        type: "tool.completed",
        toolCallId: `read-${suffix}`,
        tool: "Read",
        result: { content: "project" }
      };
      yield done({
        status: "completed",
        stopReason: "model_stop",
        finishReason: "stop",
        steps: 2,
        output: "ordinary agent loop completed"
      });
    });
    const service = new ExecutionService(runtime);
    const inputs = [
      "修改登录流程并修复测试",
      "start the project and fix the health check",
      "先查看仓库现状，再根据实际结果完成后续步骤"
    ];
    for (const input of inputs) {
      const result = await service.execute({
        input,
        signal: new AbortController().signal
      });
      assert.equal(result.turn.status, "completed");
      assert.equal(result.turn.output, "ordinary agent loop completed");
    }

    assert.deepEqual(prompts, inputs);
    await assert.rejects(fs.stat(path.join(root, ".biny", "tasks")), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testExecutionBridgesCliPermission(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-execution-permission-"));
  try {
    const request = permissionRequest(root, "write-call");
    const runtime = fakeRuntime(root, async function* (_input, options) {
      const result = await options.confirmPermission?.(request);
      assert.equal(result?.approved, true);
      yield done({
        status: "completed",
        stopReason: "model_stop",
        steps: 1,
        output: "permission accepted"
      });
    });
    const observed: AgentPermissionRequest[] = [];
    const result = await new ExecutionService(runtime).execute({
      input: "更新 feature.ts",
      signal: new AbortController().signal,
      confirmPermission: async (pending) => {
        observed.push(pending);
        return { approved: true, scope: "once" };
      }
    });

    assert.equal(result.turn.status, "completed");
    assert.equal(observed[0]?.toolName, "Write");
    assert.equal(observed[0]?.sessionId, "session-1");
    assert.equal(observed[0]?.projectRoot, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testExecutionCleansPermissionListenerWhenSubmitFails(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-execution-listener-"));
  try {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const request = permissionRequest(root, "write-after-busy");
    const runtime = fakeRuntime(root, async function* (input, options) {
      if (input === "first") await firstGate;
      if (input === "third") {
        const permission = await options.confirmPermission?.(request);
        assert.equal(permission?.approved, true);
      }
      yield done({
        status: "completed",
        stopReason: "model_stop",
        steps: 1,
        output: input
      });
    });
    const service = new ExecutionService(runtime);
    const first = service.execute({
      input: "first",
      signal: new AbortController().signal
    });
    let stalePermissionCalls = 0;
    await assert.rejects(service.execute({
      input: "second",
      signal: new AbortController().signal,
      confirmPermission: async () => {
        stalePermissionCalls += 1;
        return { approved: true, scope: "once" };
      }
    }), /runtime.*busy/u);
    releaseFirst();
    await first;

    let currentPermissionCalls = 0;
    await service.execute({
      input: "third",
      signal: new AbortController().signal,
      confirmPermission: async () => {
        currentPermissionCalls += 1;
        return { approved: true, scope: "once" };
      }
    });
    assert.equal(stalePermissionCalls, 0);
    assert.equal(currentPermissionCalls, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testExecutionUsesPromptBoundary(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-execution-boundary-"));
  try {
    let promptCalls = 0;
    const runtime = fakeRuntime(root, async function* () {
      promptCalls += 1;
      yield done({
        status: "completed",
        stopReason: "model_stop",
        steps: 1,
        output: "prompt boundary"
      });
    });
    const result = await new ExecutionService(runtime).execute({
      input: "回答一个简单问题",
      signal: new AbortController().signal
    });
    assert.equal(result.turn.output, "prompt boundary");
    assert.equal(promptCalls, 1);
    const run = await new SessionRunLedger(root).latestSessionRun("session-1");
    assert.equal(run?.runId, result.runId);
    assert.equal(run?.status, "completed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function fakeRuntime(
  workspaceRoot: string,
  run: (input: string, options: AgentRunOptions) => AsyncGenerator<AgentSessionEvent>
): CommandRuntime {
  const info: AgentSessionInfo = {
    workspaceRoot,
    sessionId: "session-1",
    sessionFile: path.join(workspaceRoot, "session-1.jsonl"),
    provider: "test",
    modelLabel: "test/model",
    reasoningLabel: "Off",
    modelAlias: "test",
    thinking: "off"
  };
  const agent = {
    getInfo: () => info,
    getPermissionMode: () => "ask" as const,
    prompt: run,
    interruptedTurn: async () => undefined,
    contextStatus: async () => ({
      loadedInstructions: [],
      instructionBytes: 0,
      instructionCapBytes: 1,
      snapshotDirty: false,
      repoMapDirty: false,
      repoMapEntries: 0,
      activePaths: [],
      recentActivity: { paths: [], summaries: [] },
      compaction: { summaryPresent: false, compactedMessages: 0 },
      budget: { maxTokens: 1, usedTokens: 0, omitted: [], autoCompacted: false },
      memoryEnabled: false,
      memoryTopics: []
    }),
    recordError: () => undefined,
    close: async () => undefined
  };
  return {
    workspaceRoot,
    persistenceRoot: workspaceRoot,
    config: defaultConfig,
    agent,
    managedProcesses: {
      close: async () => []
    },
    extensionReport: () => "",
    extensionStatus: () => ({
      mcp: [],
      skills: [],
      skillWarnings: [],
      plugins: [],
      subagent: {
        enabled: false,
        maxSteps: 0,
        maxOutputTokens: 0,
        maxConcurrentSubagents: 0,
        maxPendingSubagents: 0,
        timeoutMs: 0,
        allowedTools: [],
        agents: []
      },
      toolScheduling: { maxConcurrentTools: 0, maxQueuedToolCalls: 0 },
      toolCounts: { builtin: 0, mcp: 0, skill: 0, plugin: 0, subagent: 0 }
    }),
    refreshSkills: async () => undefined,
    setSubagentParentRunId: () => undefined,
    cancelSubagentTasks: () => undefined,
    close: async () => undefined
  } as unknown as CommandRuntime;
}

function permissionRequest(root: string, toolCallId: string): AgentPermissionRequest {
  return {
    toolCallId,
    tool: "Write",
    toolName: "Write",
    title: "Write file",
    details: "Write feature.ts",
    requireFullYes: false,
    actionType: "write",
    riskLevel: "medium",
    targetPath: "feature.ts",
    sessionId: "session-1",
    projectRoot: root
  };
}

function done(outcome: AgentTurnOutcome): AgentSessionEvent {
  return {
    type: "done",
    content: outcome.output,
    usage: outcome.usage,
    outcome
  };
}
