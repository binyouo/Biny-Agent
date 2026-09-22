/** 普通运行自然收尾，不通过额外模型请求或完成声明证明任务达成。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentTurnCancellationError } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function testNaturalCompletion(scenario: "answer" | "write" | "recovery" | "limit" | "length" | "notification"): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-natural-completion-"));
  await ensureAgentDirs(workspaceRoot);
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createWriteFileTool({ workspaceRoot, ignore: [] }));
  registry.registerBuiltinTool({
    name: "check", description: "Check the selected command", risk: "read",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    schema: z.object({ command: z.string() }),
    resolveExecution: (args) => ({ approvalRule: "check", execute: async () => {
      if (args.command === "wrong") throw new Error("command not found");
      return { ok: true };
    } })
  });
  let requests = 0;
  const model: AgentModel = {
    provider: "test", modelId: "natural-completion", supportsTools: true,
    async stream(context) {
      requests += 1;
      assert.ok(context.tools.length > 0, "ordinary runs must not invoke a tool-free completion judge");
      assert.equal(context.tools.some((tool) => tool.name === "attempt_completion"), false);
      assert.ok(requests <= 3, "natural completion must not inject continuation prompts");
      if (requests > 1 && !(scenario === "length" && requests === 2)) {
        assert.equal(context.messages.at(-1)?.role, "toolResult");
      }
      if (scenario === "length" && requests === 2) assert.equal(context.messages.at(-1)?.role, "user");
      const response: ModelStreamEvent[] = [];
      if ((scenario === "write" || scenario === "limit") && requests === 1) {
        response.push({ type: "tool-call", id: "write", name: "Write", arguments: { path: "result.txt", content: "written" } });
      } else if (scenario === "length" && requests <= 2) {
        response.push({ type: "tool-call", id: `length-write-${String(requests)}`, name: "Write", arguments: { path: "result.txt", content: "written" } });
      } else if (scenario === "recovery" && requests <= 2) {
        response.push({ type: "tool-call", id: `check-${requests}`, name: "check", arguments: { command: requests === 1 ? "wrong" : "correct" } });
      } else if (scenario === "notification") {
        response.push(
          { type: "text-delta", text: "已完成，结果已检查。\n\n<bin" },
          { type: "text-delta", text: "y_notification>修复了登录崩溃，测试通过。</biny_not" },
          { type: "text-delta", text: "ification>" }
        );
      } else {
        response.push({ type: "text-delta", text: "已完成，结果已检查。" });
      }
      response.push({
        type: "finish",
        reason: scenario === "length" && requests === 1
          ? "length"
          : response[0]?.type === "tool-call" ? "tool-calls" : "stop"
      });
      return (async function* () { yield* response; })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    agent: { ...defaultConfig.agent, hardStepLimit: scenario === "limit" ? 1 : scenario === "write" ? 2 : 4 },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({ workspaceRoot, config, model, toolRegistry: registry, permissionManager: new PermissionManager(config.permission), recorder });
  try {
    await agent.initialize();
    const streamedEvents = [];
    let outcome;
    for await (const event of agent.prompt("Perform the requested work and report the result", { confirmPermission: async () => ({ approved: true, scope: "once" }) })) {
      streamedEvents.push(event);
      if (event.type === "done") outcome = event.outcome;
    }
    assert.ok(outcome);
    assert.equal(requests, scenario === "recovery" ? 3 : scenario === "write" ? 2 : 1);
    assert.equal(outcome.status, scenario === "limit" || scenario === "length" ? "incomplete" : "completed");
    if (scenario === "notification") {
      assert.equal(outcome.notification, "修复了登录崩溃，测试通过。");
      assert.equal(outcome.output.includes("<biny_notification>"), false, "通知块不能进入对外输出");
      const streamedAssistant = streamedEvents
        .filter((event) => event.type === "assistant.delta")
        .map((event) => event.content)
        .join("");
      assert.equal(streamedAssistant.includes("<"), false, "通知标签的分片不能进入流式界面事件");
      assert.equal(streamedAssistant.includes("修复了登录崩溃"), false, "通知正文不能进入流式界面事件");
    }
    if (scenario !== "notification" && scenario !== "answer") assert.equal(outcome.notification, undefined);
    if (scenario === "limit" || scenario === "length") {
      assert.equal(outcome.stopReason, scenario === "limit" ? "hard_step_limit" : "model_length");
      assert.equal(outcome.resumable, true);
    }
    if (scenario === "write" || scenario === "limit") assert.equal(await readFile(path.join(workspaceRoot, "result.txt"), "utf8"), "written");
    if (scenario === "length") {
      await assert.rejects(readFile(path.join(workspaceRoot, "result.txt"), "utf8"), { code: "ENOENT" });
      let resumedOutcome;
      for await (const event of agent.continueInterruptedTurn({
        confirmPermission: async () => ({ approved: true, scope: "once" })
      })) {
        if (event.type === "done") resumedOutcome = event.outcome;
      }
      assert.equal(resumedOutcome?.status, "completed", JSON.stringify(resumedOutcome));
      assert.equal(requests, 3);
      assert.equal(await readFile(path.join(workspaceRoot, "result.txt"), "utf8"), "written");
    }
    await recorder.flush();
    const stored = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; content?: string; message?: AgentMessage });
    for (const type of ["user_message", "assistant_message"]) assert.ok(stored.some((event) => event.type === type));
    assert.equal(
      stored.some((event) => event.type === "assistant_message" && event.content?.includes("<biny_notification>")),
      false,
      "通知块不能进入 session 落盘"
    );
    assert.equal(
      stored.some((event) => event.type === "agent_message" && JSON.stringify(event.message).includes("<biny_notification>")),
      false,
      "通知块不能进入 canonical agent_message"
    );
    if (scenario === "write" || scenario === "recovery" || scenario === "limit" || scenario === "length") {
      for (const type of ["tool_call", "tool_result"]) assert.ok(stored.some((event) => event.type === type));
    }
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testStepPersistenceFailureIsATurnFailure(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-step-persistence-failure-"));
  await ensureAgentDirs(workspaceRoot);
  class FailingRecorder extends SessionRecorder {
    private failed = false;

    override record(event: SessionEvent): SessionEvent {
      if (!this.failed && event.type === "agent_message") {
        this.failed = true;
        throw new Error("injected step persistence failure");
      }
      return super.record(event);
    }
  }
  const model: AgentModel = {
    provider: "test",
    modelId: "persistence-failure",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: "must not complete" };
      yield { type: "finish", reason: "stop" };
    })()
  };
  const config = configSchema.parse({
    ...defaultConfig,
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new FailingRecorder(workspaceRoot);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  try {
    await agent.initialize();
    const outcome = await agent.runTask("persist the response");
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.stopReason, "provider_error");
    assert.match(outcome.error ?? "", /injected step persistence failure/u);
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testRepeatedActionBudgetStopsTheLoop(withFileProgress = false): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-repeated-action-limit-"));
  await ensureAgentDirs(workspaceRoot);
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createWriteFileTool({ workspaceRoot, ignore: [] }));
  let executions = 0;
  registry.registerBuiltinTool({
    name: "repeatable_check",
    description: "Run a repeatable check",
    risk: "read",
    parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    schema: z.object({ target: z.string() }),
    resolveExecution: () => ({
      approvalRule: "repeatable_check",
      execute: async () => {
        executions += 1;
        return { ok: true };
      }
    })
  });
  let requests = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "repeated-action-limit",
    supportsTools: true,
    async stream() {
      requests += 1;
      assert.ok(requests <= (withFileProgress ? 7 : 3), "budget rejection must stop the loop before another model request");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (withFileProgress && requests === 3) {
          yield { type: "tool-call", id: "progress-write", name: "Write", arguments: { path: "progress.txt", content: "changed" } };
        } else if (withFileProgress && requests === 6) {
          yield { type: "text-delta", text: "Rechecked after changing the file." };
          yield { type: "finish", reason: "stop" };
          return;
        } else {
          yield {
            type: "tool-call",
            id: `repeat-${String(requests)}`,
            name: "repeatable_check",
            arguments: { target: "same" }
          };
        }
        yield { type: "finish", reason: "tool-calls" };
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    agent: {
      ...defaultConfig.agent,
      hardStepLimit: 8,
      maxRepeatedActions: 2
    },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    },
    permission: { ...defaultConfig.permission, mode: "full-access" }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  try {
    await agent.initialize();
    const outcome = await agent.runTask("Repeat the same check forever");
    if (withFileProgress) {
      assert.equal(outcome.status, "completed");
      assert.equal(executions, 4, "真实文件修改之后允许重新执行相同测试");
      assert.equal(await readFile(path.join(workspaceRoot, "progress.txt"), "utf8"), "changed");
      await recorder.flush();
      const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
      assert.equal(events.filter((event) => event.type === "tool_result" && event.tool === "repeatable_check" && event.executionStatus === "succeeded").length, 4);
      return;
    }
    assert.equal(requests, 3);
    assert.equal(executions, 2);
    assert.equal(outcome.status, "incomplete");
    assert.equal(outcome.stopReason, "repeated_action_limit");
    assert.equal(outcome.resumable, true);
    assert.match(outcome.error ?? "", /repeat limit of 2/u);
    const interrupted = await agent.interruptedTurn();
    assert.equal(interrupted?.completedSteps, 0, "explicit continuation must open a new budget window");
    assert.equal(interrupted?.terminal?.stopReason, "repeated_action_limit");
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testInterruptedTurnMarkerIsModelVisibleOnlyForManualStop(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-turn-interruption-"));
  await ensureAgentDirs(workspaceRoot);
  let started: (() => void) | undefined;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  let requests = 0;
  let resumedMessages: AgentMessage[] | undefined;
  const model: AgentModel = {
    provider: "test",
    modelId: "turn-interruption",
    async stream(context, options) {
      requests += 1;
      if (requests > 1) {
        resumedMessages = context.messages;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: "continued safely" };
          yield { type: "finish", reason: "stop" };
        })();
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        started?.();
        const signal = options?.signal;
        if (!signal) throw new Error("missing abort signal");
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield { type: "finish", reason: "aborted" };
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  try {
    await agent.initialize();
    const controller = new AbortController();
    const interruptedRun = agent.runTask("start a long task", { abortSignal: controller.signal });
    await modelStarted;
    controller.abort(new AgentTurnCancellationError("interrupted"));
    const interrupted = await interruptedRun;
    assert.equal(interrupted.status, "cancelled");
    assert.equal(interrupted.stopReason, "interrupted");

    await recorder.flush();
    const replay = await replaySession(recorder.filePath);
    assert.equal(replay.events.filter((event) => event.type === "turn_interrupted").length, 1);
    assert.equal(replay.messageTree.length, 1, "the hidden marker must not become a visible message-tree node");

    const continued = await agent.runTask("continue with the new instruction");
    assert.equal(continued.status, "completed");
    assert.equal(resumedMessages?.some((message) => message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("<turn_aborted>")), true, "the next model request must see the interruption marker");
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testReplacedTurnDoesNotWriteInterruptionMarker(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-turn-replaced-"));
  await ensureAgentDirs(workspaceRoot);
  let started: (() => void) | undefined;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  const model: AgentModel = {
    provider: "test",
    modelId: "turn-replaced",
    async stream(_context, options) {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        started?.();
        const signal = options?.signal;
        if (!signal) throw new Error("missing abort signal");
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield { type: "finish", reason: "aborted" };
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  try {
    await agent.initialize();
    const controller = new AbortController();
    const replacedRun = agent.runTask("old instruction", { abortSignal: controller.signal });
    await modelStarted;
    controller.abort(new AgentTurnCancellationError("replaced"));
    const replaced = await replacedRun;
    assert.equal(replaced.status, "cancelled");
    assert.equal(replaced.stopReason, "replaced");
    await recorder.flush();
    const replay = await replaySession(recorder.filePath);
    assert.equal(replay.events.some((event) => event.type === "turn_interrupted"), false);
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testUnattributedCancellationDoesNotWriteInterruptionMarker(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-turn-cancelled-"));
  await ensureAgentDirs(workspaceRoot);
  let started: (() => void) | undefined;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  const model: AgentModel = {
    provider: "test",
    modelId: "turn-cancelled",
    async stream(_context, options) {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        started?.();
        const signal = options?.signal;
        if (!signal) throw new Error("missing abort signal");
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield { type: "finish", reason: "aborted" };
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  try {
    await agent.initialize();
    const controller = new AbortController();
    const cancelledRun = agent.runTask("cancel for an unspecified host reason", { abortSignal: controller.signal });
    await modelStarted;
    controller.abort();
    const cancelled = await cancelledRun;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.stopReason, "cancelled");
    await recorder.flush();
    const replay = await replaySession(recorder.filePath);
    assert.equal(replay.events.some((event) => event.type === "turn_interrupted"), false);
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

for (const scenario of ["answer", "write", "recovery", "limit", "length", "notification"] as const) await testNaturalCompletion(scenario);
await testRepeatedActionBudgetStopsTheLoop();
await testRepeatedActionBudgetStopsTheLoop(true);
await testStepPersistenceFailureIsATurnFailure();
await testInterruptedTurnMarkerIsModelVisibleOnlyForManualStop();
await testReplacedTurnDoesNotWriteInterruptionMarker();
await testUnattributedCancellationDoesNotWriteInterruptionMarker();
console.log("agent natural completion tests passed");
