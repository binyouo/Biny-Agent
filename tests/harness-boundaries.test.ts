/** 使用真实入口和模拟 provider，覆盖主/后台请求、停止语义及持久化恢复边界。 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APICallError, type LanguageModelV4, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "../src/agent/AgentSession.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentEvent, AgentModel, ModelRequestMetrics, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { runSubagentTask } from "../src/extensions/subagent.js";
import { createNativeModelSettings } from "../src/llm/nativeFactory.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { SubagentTaskIncompleteError, SubagentTaskManager } from "../src/runtime/SubagentTaskManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { undeliveredMessageNotices } from "../src/session/queuedMessages.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { TurnStore } from "../src/session/turnStore.js";
import { sessionFilePath } from "../src/session/store.js";
import { createToolRegistry, ToolRegistry } from "../src/tools/registry.js";
import { sessionEventsToTranscript } from "../src/tui/sessionTranscript.js";

const config = configSchema.parse({
  ...defaultConfig,
  defaultModel: "audit",
  thinking: { ...defaultConfig.thinking, enabled: false },
  providers: { audit: { type: "openai-compatible", baseUrl: "https://audit.invalid/v1", apiKey: "synthetic-test-key" } },
  models: { audit: { provider: "audit", model: "audit-model", capabilities: { tools: true, reasoning: false } } },
  context: {
    ...defaultConfig.context,
    emotion: { ...defaultConfig.context.emotion, enabled: false },
    memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
  }
});

const workerRoot = process.argv[2] === "queue-crash-worker" ? process.argv[3] : undefined;
const root = workerRoot ?? await mkdtemp(path.join(os.tmpdir(), "biny-harness-boundaries-"));
if (workerRoot) {
  await queueCrashWorker();
} else try {
  await testWireCompatibility();
  await testDirectProviderMetrics();
  await testSubagentStopsAndExplicitBudget();
  await testQueuedMessageCancellationAndRecovery();
  await testRecoveryOnlyBlocksRelatedOperations();
  await testCanonicalUserContentSurvivesTurns();
  console.log("harness boundary tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testWireCompatibility(): Promise<void> {
  for (const providerType of ["openai-compatible", "openai"] as const) {
    for (const developerRole of [true, false]) {
      const selected = structuredClone(config);
      selected.providers.audit!.type = providerType;
      selected.models.audit!.compatibility = {
        supportsDeveloperRole: developerRole,
        maxTokensField: developerRole ? "max_completion_tokens" : "max_tokens"
      };
      const bodies: Record<string, any>[] = [];
      const fetcher: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ error: { message: "synthetic request captured" } }), {
          status: 400, headers: { "content-type": "application/json" }
        });
      };
      const settings = createNativeModelSettings(selected, "audit", fetcher);
      await assert.rejects(async () => {
        for await (const _event of await settings.model.stream({ systemPrompt: "audit", messages: [{ role: "user", content: "hello" }], tools: [] }, { maxOutputTokens: 123 })) { /* 消费请求。 */ }
      }, /synthetic request captured/u);
      const metrics: ModelRequestMetrics[] = [];
      for await (const _event of vercelAgentLoopContinue({ systemPrompt: "audit", messages: [{ role: "user", content: "hello" }], tools: [] }, {
        model: settings.model, vercelModel: settings.vercelModel, maxRetries: 0, tools: [], maxSteps: 1,
        modelOptions: { maxOutputTokens: 123, onRequestMetrics: (value) => { metrics.push(value); } }
      })) { /* 真正经过主 Agent 的 SDK 调用入口。 */ }
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies.map((body) => ({
        max_tokens: body.max_tokens,
        max_completion_tokens: body.max_completion_tokens,
        firstRole: body.messages[0].role
      })), [0, 1].map(() => ({
        max_tokens: developerRole ? undefined : 123,
        max_completion_tokens: developerRole ? 123 : undefined,
        firstRole: developerRole ? "developer" : "system"
      })));
      assert.equal(metrics.length, 1);
      assert.ok(metrics[0]?.error);
      assert.equal(metrics[0]?.errorCode, "http_error");
    }
  }
}

async function testDirectProviderMetrics(): Promise<void> {
  const previousConsoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    for (const scenario of ["success", "request-error", "stream-error", "abort", "timeout", "retry", "empty-success-response"] as const) {
      let calls = 0;
      const abort = new AbortController();
      const metrics: ModelRequestMetrics[] = [];
      const provider: LanguageModelV4 = {
        specificationVersion: "v4", provider: "synthetic", modelId: "synthetic", supportedUrls: {},
        doGenerate: async () => { throw new Error("unexpected generate"); },
        doStream: async (options) => {
          calls += 1;
          if (scenario === "request-error") throw new TypeError("synthetic network failure");
          if (scenario === "retry" && calls === 1) throw new APICallError({ message: "synthetic retry", url: "https://audit.invalid", requestBodyValues: {}, statusCode: 503, isRetryable: true });
          if (scenario === "empty-success-response" && calls === 1) throw new APICallError({
            message: "Failed to process successful response",
            url: "https://audit.invalid",
            requestBodyValues: {},
            statusCode: 200
          });
          if (scenario === "abort" || scenario === "timeout") {
            if (scenario === "abort") setTimeout(() => abort.abort(new Error("synthetic user stop")), 5);
            return await new Promise<never>((_resolve, reject) => {
              const stop = (): void => { reject(options.abortSignal?.reason); };
              if (options.abortSignal?.aborted) stop();
              else options.abortSignal?.addEventListener("abort", stop, { once: true });
            });
          }
          const parts: LanguageModelV4StreamPart[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "hello" },
            { type: "text-end", id: "text" }
          ];
          if (scenario === "stream-error") parts.push({ type: "error", error: new TypeError("synthetic socket failure") });
          else parts.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 }
          } });
          return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
        }
      };
      const received: AgentEvent[] = [];
      const run = async (): Promise<void> => {
        for await (const event of vercelAgentLoopContinue({ messages: [{ role: "user", content: "audit" }], tools: [] }, {
          model: textModel(), vercelModel: provider, tools: [], maxSteps: 1,
          maxRetries: scenario === "retry" || scenario === "empty-success-response" ? 1 : 0,
          modelOptions: { timeoutMs: scenario === "timeout" ? 20 : undefined, onRequestMetrics: (value) => { metrics.push(value); } }
        }, abort.signal)) received.push(event);
      };
      const watchdog = setTimeout(() => abort.abort(new Error(`Test stalled: ${scenario}`)), 5_000);
      try {
        if (scenario === "abort") await assert.rejects(run, /synthetic user stop/u);
        else await run();
      } finally { clearTimeout(watchdog); }
      assert.equal(metrics.length, 1, scenario);
      if (scenario === "success" || scenario === "retry" || scenario === "empty-success-response") assert.equal(metrics[0]?.finishReason, "stop", scenario);
      else assert.ok(metrics[0]?.error, scenario);
      if (scenario === "abort" || scenario === "timeout") assert.equal(metrics[0]?.errorCode, scenario === "abort" ? "aborted" : "timeout");
      if (scenario === "stream-error") assert.equal(metrics[0]?.errorPhase, "stream");
      if (scenario === "retry" || scenario === "empty-success-response") {
        assert.equal(calls, 2);
        assert.equal(metrics[0]?.attempts.length, 2);
        assert.deepEqual(metrics[0]?.attempts.map((attempt) => attempt.willRetry), [true, false]);
      }
    }
    assert.deepEqual(errors, [], "SDK errors must not write into terminal rendering");
  } finally {
    console.error = previousConsoleError;
  }
}

async function testSubagentStopsAndExplicitBudget(): Promise<void> {
  await writeFile(path.join(root, "README.md"), "fixture");
  const selected = structuredClone(config);
  selected.extensions.subagent.maxSteps = 10;
  selected.extensions.subagent.allowedTools = ["Read"];
  const registry = createToolRegistry({ workspaceRoot: root, ignore: [] }, { ...config.web.search, enabled: false });
  let calls = 0;
  const model: AgentModel = {
    ...textModel(),
    stream: async () => (async function* () {
      calls += 1;
      yield { type: "start" } as const;
      yield { type: "text-delta", text: `partial-${calls}` } as const;
      if (calls < 9) yield { type: "tool-call", id: `read-${calls}`, name: "Read", arguments: { path: "README.md" } } as const;
      yield { type: "finish", reason: calls < 9 ? "tool-calls" : "stop" } as const;
    })()
  };
  const options = { workspaceRoot: root, config: selected, toolRegistry: registry, getAccessMode: () => "read-only" as const, getModelSettings: () => ({ model, contextWindow: undefined }) };
  for (const word of ["审阅", "审计", "检查"]) {
    calls = 0;
    assert.equal(await runSubagentTask(options, `${word}权限链路`), "partial-9");
    assert.equal(calls, 9);
  }
  calls = 0;
  selected.extensions.subagent.maxSteps = 1;
  const authority = await RuntimeEventAuthority.open(root);
  const taskRuns = await DurableTaskRunStore.open(root, authority);
  const manager = new SubagentTaskManager({
    maxConcurrentSubagents: 1, timeoutMs: 5_000,
    onSnapshot: (snapshot) => { taskRuns.syncSubagentSnapshot(snapshot); },
    execute: async (task, context) => await runSubagentTask(options, task, context.signal)
  });
  try {
    const submitted = manager.submit("审阅权限链路");
    await assert.rejects(submitted.completion, (error) => error instanceof SubagentTaskIncompleteError && error.stopReason === "step_limit" && error.output.includes("partial-1"));
    assert.equal(manager.getSnapshot(submitted.taskId)?.status, "incomplete");
    assert.equal(taskRuns.get(submitted.taskId)?.status, "incomplete");
  } finally {
    await manager.close();
    taskRuns.close();
    authority.close();
  }
}

async function testQueuedMessageCancellationAndRecovery(): Promise<void> {
  let started!: () => void;
  const firstRequest = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const abort = new AbortController();
  const recorder = new SessionRecorder(root, "queued-cancel");
  const agent = makeAgent(recorder, { ...textModel(), stream: async () => {
    started();
    return (async function* () { await gate; yield { type: "finish", reason: "stop" } as const; })();
  } });
  await agent.initialize();
  try {
    const run = agent.runTask("first", { abortSignal: abort.signal, emotionAnalysis: false });
    await firstRequest;
    await agent.queueMessage("queued-message", "second draft");
    await agent.queueMessage("queued-remove", "remove this draft");
    await agent.queueMessage("queued-steer", "correction, must not be lost");
    await agent.updateQueuedRunMessage("queued-message", "second, edited and must not be lost");
    await agent.moveQueuedRunMessage("queued-steer", "queued-message", false);
    assert.deepEqual(agent.queuedRunMessages().map((message) => message.messageId), ["queued-steer", "queued-message", "queued-remove"]);
    await agent.removeQueuedRunMessage("queued-remove");
    await agent.steerQueuedRunMessage("queued-steer");
    assert.deepEqual(agent.queuedRunMessages(), [{ messageId: "queued-message", content: "second, edited and must not be lost", attachmentCount: 0 }]);
    await agent.steerAllQueuedRunMessages();
    assert.deepEqual(agent.queuedRunMessages(), []);
    const accepted = await readSessionEvents(recorder.filePath);
    assert.equal(accepted.filter((event) => event.type === "user_message" && event.auditOnly).length, 3);
    abort.abort(new Error("synthetic stop"));
    release();
    await run;
    const saved = await readSessionEvents(recorder.filePath);
    assert.equal(saved.filter((event) => event.type === "error" && event.message.includes("不会自动执行")).length, 2);
    assert.ok(JSON.stringify(sessionEventsToTranscript(saved)).includes("must not be lost"), "undelivered input must remain visible in the transcript");
    assert.equal(JSON.stringify(sessionEventsToTranscript(saved)).includes("remove this draft"), false, "removed queued input must stay removed");
    assert.ok(JSON.stringify(sessionEventsToTranscript(saved)).includes("second, edited and must not be lost"), "edited queued input must use its latest content");
    assert.equal(undeliveredMessageNotices(saved).length, 0);
    assert.equal(JSON.stringify(replaySessionEvents(saved).messages).includes("must not be lost"), false);
  } finally {
    release();
    await agent.close();
  }
  // 子进程必须先发出真实接收回执，再被 SIGKILL；不能靠优雅退出时补写来通过测试。
  const child = fork(fileURLToPath(import.meta.url), ["queue-crash-worker", root], { silent: true });
  let childError = "";
  child.stderr?.on("data", (chunk: Buffer) => { childError += chunk.toString(); });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Queue worker stalled: ${childError}`)), 10_000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Queue worker exited early: ${childError}`)); });
    });
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  let requests = 0;
  const restored = makeAgent(new SessionRecorder(root), textModel(() => { requests += 1; }));
  await restored.initialize();
  try {
    await restored.resume("queued-recovery");
    const saved = await readSessionEvents(sessionFilePath(root, "queued-recovery"));
    assert.ok(saved.some((event) => event.type === "error" && event.message.includes("recoverable draft")));
    assert.equal(requests, 0, "opening a recovered session must not execute pending input");
    await restored.resume("queued-recovery");
    assert.equal((await readSessionEvents(sessionFilePath(root, "queued-recovery"))).filter((event) => event.type === "error" && event.message.includes("recoverable draft")).length, 1);
  } finally { await restored.close(); }
}

async function queueCrashWorker(): Promise<void> {
  const watchdog = setTimeout(() => process.exit(1), 15_000);
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const agent = makeAgent(new SessionRecorder(root, "queued-recovery"), {
    ...textModel(),
    stream: async () => {
      started();
      return await new Promise<never>(() => { /* 等待父进程强制结束，模拟在途 provider。 */ });
    }
  });
  await agent.initialize();
  void agent.runTask("original", { emotionAnalysis: false }).catch(() => { clearTimeout(watchdog); process.exit(1); });
  await requestStarted;
  await agent.queueMessage("pending", "recoverable draft");
  process.send?.({ accepted: true });
}

async function testRecoveryOnlyBlocksRelatedOperations(): Promise<void> {
  for (const oldTurn of ["old-turn", "current-turn", undefined]) {
    const sessionId = `unknown-${oldTurn ?? "unattributed"}`;
    const recorder = new SessionRecorder(root, sessionId);
    recorder.setRuntimeContext({ runId: "old-run", turnId: oldTurn });
    recorder.record({ type: "user_message", content: "old task" });
    recorder.record({ type: "tool_call", tool: "Write", args: {}, toolCallId: "unknown-write" });
    recorder.record({ type: "tool_result", tool: "Write", toolCallId: "unknown-write", result: "unknown", executionStatus: "unknown" });
    recorder.setRuntimeContext({ runId: "current-run", turnId: "current-turn" });
    recorder.record({ type: "user_message", content: "new explicit task" });
    await recorder.flush();
    await new TurnStore(root, sessionId).save("new explicit task", "audit", [{ role: "user", content: "new explicit task" }], 0, undefined, undefined, undefined, recorder.runtimeHighWater());
    await recorder.close();
    let requests = 0;
    const agent = makeAgent(new SessionRecorder(root), textModel(() => { requests += 1; }));
    await agent.initialize();
    try {
      await agent.resume(sessionId);
      const events = [];
      for await (const event of agent.continueInterruptedTurn({ emotionAnalysis: false })) events.push(event);
      const outcome = events.find((event) => event.type === "done")?.outcome;
      assert.equal(outcome?.status, oldTurn === "old-turn" ? "completed" : "blocked");
      assert.equal(requests, oldTurn === "old-turn" ? 1 : 0);
    } finally { await agent.close(); }
  }
}

async function testCanonicalUserContentSurvivesTurns(): Promise<void> {
  const literal = "逐字解释：<!-- biny-turn-context:start -->用户原文<!-- biny-turn-context:end -->";
  const received: string[] = [];
  const agent = makeAgent(new SessionRecorder(root), { ...textModel(), stream: async (context) => {
    received.push(JSON.stringify(context.messages));
    return await textModel().stream(context);
  } });
  await agent.initialize();
  try {
    await agent.runTask(literal, { emotionAnalysis: false });
    await agent.runTask("继续解释", { emotionAnalysis: false });
    await agent.runTask("再检查原文", { emotionAnalysis: false });
    assert.ok(received.at(-1)?.includes(literal));
  } finally { await agent.close(); }
}

function makeAgent(recorder: SessionRecorder, model: AgentModel): AgentSession {
  return new AgentSession({ workspaceRoot: root, config, model, recorder, toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission) });
}

function textModel(onRequest?: () => void): AgentModel {
  return {
    provider: "synthetic", modelId: "synthetic", supportsTools: true,
    stream: async () => {
      onRequest?.();
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "start" };
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
}
