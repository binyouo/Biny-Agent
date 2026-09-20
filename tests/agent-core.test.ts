import assert from "node:assert/strict";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentAssistantMessage, AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentModel, AgentTool, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";

/** 测试入口只负责把首条 user message 放进 context；loop 本身来自 Vercel 适配层。 */
async function* agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal
): AsyncGenerator<AgentEvent, AgentMessage[], void> {
  yield* vercelAgentLoopContinue({
    ...context,
    messages: [...context.messages, ...prompts]
  }, config, signal);
}

async function main(): Promise<void> {
  await testToolProgressBeforeCompletion();
  await testReasoningSignatureAndReplacedContext();
  await testAssistantDeltasAreForwardedBeforeProviderCompletes();
  await testModelErrorRecoveryRetriesBeforeAnyDelta();
  await testModelStreamWithoutFinishFails();
  await testNextTurnRefreshesModelAndTools();
  await testQueuedFollowUpPreparesOnlyTheNextModelStep();
  await testStepPersistencePrecedesMilestoneAndQueue();
  await testStepPersistenceFailureStopsTheLoop();
  await testRemovedToolNameIsRejected();
  await testUnknownToolCallStopsWithoutRetry();
  await testTruncatedInvalidToolCallPreservesLength();
  await testTruncatedValidToolCallDoesNotExecute();
  await testDirectProviderTruncatedValidToolCallDoesNotExecute();
  const calls: ModelStreamContext[] = [];
  const model: AgentModel = {
    provider: "test",
    modelId: "test-model",
    async stream(context): Promise<AsyncIterable<ModelStreamEvent>> {
      calls.push({ ...context, messages: [...context.messages], tools: [...context.tools] });
      if (calls.length === 1) {
        return events([
          { type: "start" },
          { type: "text-delta", text: "reading" },
          { type: "tool-call", id: "call-1", name: "read", arguments: { path: "README.md" } },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }
        ]);
      }
      return events([
        { type: "start" },
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "stop", usage: { inputTokens: 20, outputTokens: 1, totalTokens: 21 } }
      ]);
    }
  };
  const tool: AgentTool = {
    name: "read",
    label: "Read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    },
    async execute(_toolCallId, args) {
      return { content: [{ type: "text", text: `content for ${String(args.path)}` }], details: { ok: true } };
    }
  };
  const received: string[] = [];
  for await (const event of agentLoop([{ role: "user", content: "inspect README.md" }], {
    messages: [],
    tools: [tool]
  }, { model, tools: [tool], maxSteps: 4 })) {
    received.push(event.type);
  }
  assert.deepEqual(calls.length, 2);
  assert.deepEqual(calls[1]?.messages.at(-1)?.role, "toolResult");
  assert.equal(received.includes("tool_execution_start"), true);
  assert.equal(received.includes("tool_execution_end"), true);
  assert.equal(received.filter((type) => type === "turn_end").length, 2);
  console.log("agent core tests passed");
}

async function testToolProgressBeforeCompletion(): Promise<void> {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  const displayOrder: string[] = [];
  const tool: AgentTool = {
    name: "slow", description: "test", parameters: { type: "object" },
    async execute(_id, _args, _signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "progress" }] });
      await barrier;
      completed = true;
      return { content: [] };
    }
  };
  const model: AgentModel = {
    provider: "test", modelId: "test",
    stream: async () => events([
      { type: "tool-call", id: "slow", name: "slow", arguments: {} },
      { type: "finish", reason: "tool-calls" }
    ])
  };
  const running = (async () => {
    for await (const event of agentLoop([{ role: "user", content: "test" }], { messages: [], tools: [] }, { model, tools: [tool], maxSteps: 1 })) {
      if (event.type === "tool_execution_start") {
        displayOrder.push(event.type);
        assert.equal(completed, false);
      }
      if (event.type === "tool_execution_update") {
        displayOrder.push(event.type);
        assert.equal(completed, false);
        release();
      }
      if (event.type === "tool_execution_end") displayOrder.push(event.type);
      if (event.type === "message_end" && event.message.role === "assistant") displayOrder.push(event.type);
    }
  })();
  try { await settlesWithin(running, 1000); } finally { release(); }
  assert.deepEqual(displayOrder, [
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "message_end"
  ], "展示事件保持局部顺序，assistant 里程碑在工具完成后由控制流直接发出");
}

async function testReasoningSignatureAndReplacedContext(): Promise<void> {
  let requests = 0;
  const model: AgentModel = {
    provider: "test", modelId: "test",
    stream: async () => {
      requests += 1;
      return events(requests === 1 ? [
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", text: "thinking" },
        { type: "reasoning-end", id: "r", providerMetadata: { anthropic: { signature: "sig" } } },
        { type: "tool-call", id: "call", name: "read", arguments: {} },
        { type: "finish", reason: "tool-calls" }
      ] : [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }]);
    }
  };
  const tool: AgentTool = { name: "read", description: "test", parameters: { type: "object" }, execute: async () => ({ content: [] }) };
  for await (const event of agentLoop([{ role: "user", content: "test" }], { messages: [], tools: [] }, {
    model, tools: [tool], maxSteps: 2,
    prepareNextTurn: async ({ context }) => ({ context: { ...context, messages: [...context.messages] } })
  })) {
    if (event.type === "agent_end") {
      assert.deepEqual(event.contextMessages.slice(1), event.messages);
      const assistant = event.contextMessages[1] as AgentAssistantMessage;
      const reasoning = assistant.content.find((part) => part.type === "reasoning");
      assert.deepEqual(reasoning?.providerMetadata, { anthropic: { signature: "sig" } });
    }
  }
}

async function testUnknownToolCallStopsWithoutRetry(): Promise<void> {
  let requests = 0;
  const model: AgentModel = {
    provider: "malformed-tool-test",
    modelId: "malformed-tool-model",
    stream: async (): Promise<AsyncIterable<ModelStreamEvent>> => {
      requests += 1;
      return events([
        { type: "tool-call", id: "invalid-call", name: "", arguments: {} },
        { type: "finish", reason: "tool-calls" }
      ]);
    }
  };
  const received: AgentEvent[] = [];
  for await (const event of agentLoop([{ role: "user", content: "run" }], { messages: [], tools: [] }, {
    model,
    tools: [],
    maxSteps: 4
  })) received.push(event);

  assert.equal(requests, 1, "an unknown tool must not trigger another provider request");
  const failure = received.find((event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error");
  assert.equal(failure?.fatal, true);
  assert.match(failure?.error ?? "", /missing a function name/iu);
}

async function testTruncatedInvalidToolCallPreservesLength(): Promise<void> {
  let requests = 0;
  let executions = 0;
  const tool: AgentTool = {
    name: "Write",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false
    },
    execute: async () => {
      executions += 1;
      return { content: [] };
    }
  };
  const model: AgentModel = {
    provider: "truncated-tool-test",
    modelId: "truncated-tool-model",
    stream: async () => {
      requests += 1;
      return events([
        { type: "tool-call", id: "truncated-write", name: "Write", arguments: {} },
        { type: "finish", reason: "length" }
      ]);
    }
  };
  const received: AgentEvent[] = [];
  for await (const event of agentLoop([{ role: "user", content: "write" }], { messages: [], tools: [tool] }, {
    model,
    tools: [tool],
    maxSteps: 4
  })) received.push(event);

  assert.equal(requests, 1, "a truncated tool call must not trigger another provider request");
  assert.equal(executions, 0, "a truncated tool call must never execute");
  assert.equal(received.some((event) => event.type === "error"), false);
  const assistant = received.find((event): event is Extract<AgentEvent, { type: "message_end" }> =>
    event.type === "message_end" && event.message.role === "assistant");
  assert.equal(assistant?.message.role === "assistant" ? assistant.message.stopReason : undefined, "length");
}

async function testTruncatedValidToolCallDoesNotExecute(): Promise<void> {
  let requests = 0;
  let executions = 0;
  const tool: AgentTool = {
    name: "Write",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false
    },
    execute: async () => {
      executions += 1;
      return { content: [{ type: "text", text: "written" }] };
    }
  };
  const model: AgentModel = {
    provider: "truncated-valid-tool-test",
    modelId: "truncated-valid-tool-model",
    stream: async () => {
      requests += 1;
      return events([
        { type: "tool-call", id: "complete-write", name: "Write", arguments: { path: "result.txt", content: "complete" } },
        { type: "finish", reason: "length" }
      ]);
    }
  };
  const received: AgentEvent[] = [];
  for await (const event of agentLoop([{ role: "user", content: "write" }], { messages: [], tools: [tool] }, {
    model,
    tools: [tool],
    maxSteps: 4
  })) received.push(event);

  assert.equal(requests, 1, "a length-limited tool call must not trigger another provider request");
  assert.equal(executions, 0, "a length-limited step must not execute even a schema-valid tool call");
  assert.equal(received.some((event) => event.type === "tool_execution_start"), false);
}

async function testDirectProviderTruncatedValidToolCallDoesNotExecute(): Promise<void> {
  let executions = 0;
  const tool: AgentTool = {
    name: "Write",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false
    },
    execute: async () => {
      executions += 1;
      return { content: [{ type: "text", text: "written" }] };
    }
  };
  const parts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "direct-complete-write", toolName: "Write", input: JSON.stringify({ path: "result.txt", content: "complete" }) },
    {
      type: "finish",
      finishReason: { unified: "length", raw: "length" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 }
      }
    }
  ];
  const provider: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "direct-truncated-valid-tool-test",
    modelId: "direct-truncated-valid-tool-model",
    supportedUrls: {},
    doGenerate: async () => { throw new Error("unexpected generate"); },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        }
      })
    })
  };
  const model: AgentModel = {
    provider: provider.provider,
    modelId: provider.modelId,
    stream: async () => events([{ type: "finish", reason: "stop" }])
  };
  const received: AgentEvent[] = [];
  for await (const event of agentLoop([{ role: "user", content: "write" }], { messages: [], tools: [tool] }, {
    model,
    vercelModel: provider,
    tools: [tool],
    maxSteps: 4
  })) received.push(event);

  assert.equal(executions, 0, "a direct provider length-limited step must not execute a schema-valid tool call");
  assert.equal(received.some((event) => event.type === "tool_execution_start"), false);
}

async function testRemovedToolNameIsRejected(): Promise<void> {
  let requests = 0;
  const tool: AgentTool = {
    name: "Write",
    description: "Write a file.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "written" }] })
  };
  const model: AgentModel = {
    provider: "legacy-tool-test",
    modelId: "legacy-tool-model",
    stream: async () => {
      requests += 1;
      return requests === 1
        ? events([
          { type: "tool-call", id: "legacy-write", name: "write_file", arguments: {} },
          { type: "finish", reason: "tool-calls" }
        ])
        : events([{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }]);
    }
  };
  const received: AgentEvent[] = [];
  for await (const event of agentLoop([{ role: "user", content: "write" }], { messages: [], tools: [tool] }, {
    model,
    tools: [tool],
    maxSteps: 2
  })) received.push(event);

  assert.equal(requests, 1);
  assert.equal(received.some((event) => event.type === "tool_execution_start"), false);
  assert.equal(received.some((event) => event.type === "error"), true);
}

async function testModelStreamWithoutFinishFails(): Promise<void> {
  const model: AgentModel = {
    provider: "truncated-test",
    modelId: "truncated-model",
    stream: async () => events([
      { type: "start" },
      { type: "text-delta", text: "partial answer" }
    ])
  };
  let assistant: AgentAssistantMessage | undefined;
  let errorMessage = "";
  for await (const event of agentLoop([{ role: "user", content: "answer" }], { messages: [], tools: [] }, {
    model,
    tools: [],
    maxSteps: 1
  })) {
    if (event.type === "error") errorMessage = event.error;
    if (event.type === "message_end" && event.message.role === "assistant") assistant = event.message;
  }
  assert.match(errorMessage, /ended without a finish event/u);
  assert.equal(assistant, undefined, "Vercel SDK does not emit a completed assistant message for a truncated provider stream");
}

async function testModelErrorRecoveryRetriesBeforeAnyDelta(): Promise<void> {
  let requests = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "recovery-model",
    async stream(): Promise<AsyncIterable<ModelStreamEvent>> {
      requests += 1;
      if (requests === 1) throw new Error("maximum context length exceeded");
      return events([{ type: "text-delta", text: "recovered" }, { type: "finish", reason: "stop" }]);
    }
  };
  const received: string[] = [];
  for await (const event of agentLoop([{ role: "user", content: "recover" }], { messages: [], tools: [] }, {
    model,
    tools: [],
    maxSteps: 1,
    recoverFromModelError: async (_error, context) => {
      context.messages.splice(0, context.messages.length, { role: "user", content: "compacted" });
      return { reason: "context_overflow", attempt: 1, compactedMessages: 4 };
    }
  })) received.push(event.type);
  assert.equal(requests, 2);
  assert.equal(received.includes("model_retry"), true);
}

async function testNextTurnRefreshesModelAndTools(): Promise<void> {
  const firstTool: AgentTool = {
    name: "first_tool",
    description: "First tool.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "first result" }] })
  };
  const nextTool: AgentTool = { ...firstTool, name: "next_tool", description: "Next tool." };
  const firstModel: AgentModel = {
    provider: "test",
    modelId: "first-model",
    stream: async () => events([
      { type: "tool-call", id: "first-call", name: "first_tool", arguments: {} },
      { type: "finish", reason: "tool-calls" }
    ])
  };
  let refreshedContext: ModelStreamContext | undefined;
  const nextModel: AgentModel = {
    provider: "test",
    modelId: "next-model",
    stream: async (context) => {
      refreshedContext = context;
      return events([{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }]);
    }
  };
  for await (const _event of agentLoop([{ role: "user", content: "refresh" }], { messages: [], tools: [firstTool] }, {
    model: firstModel,
    tools: [firstTool],
    maxSteps: 2,
    prepareNextTurn: async ({ context }) => ({ context: { ...context, systemPrompt: "refreshed" }, model: nextModel, tools: [nextTool] })
  })) {
    // Drain the loop.
  }
  assert.equal(refreshedContext?.systemPrompt, "refreshed");
  assert.deepEqual(refreshedContext?.tools.map((tool) => tool.name), ["next_tool"]);
}

async function testQueuedFollowUpPreparesOnlyTheNextModelStep(): Promise<void> {
  let requests = 0;
  let preparations = 0;
  let queueRead = false;
  const model: AgentModel = {
    provider: "test",
    modelId: "queued-follow-up",
    stream: async () => {
      requests += 1;
      return events([{ type: "text-delta", text: `answer-${String(requests)}` }, { type: "finish", reason: "stop" }]);
    }
  };
  const completedRoles: AgentMessage["role"][] = [];
  for await (const event of agentLoop([{ role: "user", content: "first" }], { messages: [], tools: [] }, {
    model,
    tools: [],
    maxSteps: 3,
    getQueuedMessages: async () => {
      if (queueRead) return [];
      queueRead = true;
      return [{ role: "user", content: "follow up" }];
    },
    prepareNextTurn: async ({ context }) => {
      preparations += 1;
      return { context };
    }
  })) {
    if (event.type === "message_end") completedRoles.push(event.message.role);
  }

  assert.equal(requests, 2);
  assert.equal(preparations, 1, "最终回答后没有下一次模型请求时不应再准备或压缩上下文");
  assert.deepEqual(completedRoles, ["assistant", "user", "assistant"]);
}

async function testStepPersistencePrecedesMilestoneAndQueue(): Promise<void> {
  let persisted = false;
  const model: AgentModel = {
    provider: "test",
    modelId: "persist-order",
    stream: async () => events([{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }])
  };
  for await (const event of agentLoop([{ role: "user", content: "persist" }], { messages: [], tools: [] }, {
    model,
    tools: [],
    maxSteps: 1,
    persistStep: async () => { persisted = true; },
    getQueuedMessages: async () => {
      assert.equal(persisted, true, "读取后续输入前必须已经提交当前 step");
      return [];
    }
  })) {
    if (event.type === "message_end" && event.message.role === "assistant") {
      assert.equal(persisted, true, "完成通知不能早于 step 持久化");
    }
  }
}

async function testStepPersistenceFailureStopsTheLoop(): Promise<void> {
  let requests = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "persist-failure",
    stream: async () => {
      requests += 1;
      return events([{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }]);
    }
  };
  const received: AgentEvent[] = [];
  for await (const event of agentLoop([{ role: "user", content: "persist" }], { messages: [], tools: [] }, {
    model,
    tools: [],
    maxSteps: 2,
    persistStep: async () => { throw new Error("session write failed"); }
  })) received.push(event);

  assert.equal(requests, 1);
  assert.equal(received.some((event) => event.type === "message_end" && event.message.role === "assistant"), false);
  const failure = received.find((event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error");
  assert.equal(failure?.fatal, true);
  assert.match(failure?.error ?? "", /session write failed/u);
}

async function testAssistantDeltasAreForwardedBeforeProviderCompletes(): Promise<void> {
  let providerFinished = false;
  let firstDeltaForwarded = false;
  const model: AgentModel = {
    provider: "stream-test",
    modelId: "stream-test-model",
    async stream(): Promise<AsyncIterable<ModelStreamEvent>> {
      return delayedEvents();
    }
  };

  for await (const event of agentLoop([{ role: "user", content: "stream" }], {
    messages: [],
    tools: []
  }, { model, tools: [], maxSteps: 1 })) {
    if (event.type === "message_update" && event.event.type === "text-delta" && event.event.text === "first") {
      firstDeltaForwarded = true;
      assert.equal(providerFinished, false, "the first assistant delta must arrive before the provider finishes");
    }
  }

  assert.equal(firstDeltaForwarded, true);

  async function* delayedEvents(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "start" };
    yield { type: "text-delta", text: "first" };
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    yield { type: "text-delta", text: "second" };
    yield { type: "finish", reason: "stop" };
    providerFinished = true;
  }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${String(timeoutMs)}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function* events(events: ModelStreamEvent[]): AsyncGenerator<ModelStreamEvent, void, void> {
  for (const event of events) yield event;
}

await main();
