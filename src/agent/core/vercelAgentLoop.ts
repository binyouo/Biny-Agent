/**
 * 用 Vercel AI SDK 的 streamText 执行 Biny 的单个模型步骤。
 *
 * Biny 仍然拥有上下文、权限、工具审计和 session 消息；主 Agent 的 provider/model
 * 请求与工具续环交给 AI SDK。没有直连 Vercel model 的注入场景仍通过 Biny AgentModel
 * adapter 运行，保持测试和后台模型调用的最小兼容面。
 */
import {
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type StepResult,
  type ToolSet
} from "ai";
import {
  APICallError,
  type LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import { LocalPromptProjectionCache, type PromptShapeDiagnostic } from "../../llm/promptCache.js";
import type {
  AgentAssistantMessage,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnContext,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolResultMessage,
  ModelStreamOptions
} from "./types.js";
import {
  beginDirectModelRequest,
  createLanguageModel,
  fromVercelFinishReason,
  fromVercelUsage,
  modelMessages,
  recordDirectModelRequest,
  recordDirectModelFailure,
  toVercelReasoning,
  toModelMessages,
  type DirectCallDiagnostics
} from "./vercelModelAdapter.js";
import { createVercelTools } from "./vercelAgentTools.js";
import { errorMessage, isRecord, providerMetadata, stringify } from "./vercelAgentUtils.js";
import { toolCallRepair } from "./toolCallRepair.js";
import { applyCacheMarkers, markInstructions } from "./cacheMarkers.js";
import { EventQueue } from "./EventQueue.js";

export interface VercelLoopState {
  context: AgentContext;
  config: AgentLoopConfig;
  signal: AbortSignal | undefined;
  model: AgentLoopConfig["model"];
  vercelModel: AgentLoopConfig["vercelModel"];
  maxRetries: number | undefined;
  modelOptions: ModelStreamOptions | undefined;
  tools: AgentTool[];
  newMessages: AgentMessage[];
  hasPendingMessages: boolean;
  /** 只承接工具执行和模型重试产生的展示事件，不参与控制流或持久化排序。 */
  displayEvents: EventQueue<AgentLoopDisplayEvent>;
  toolResults: Map<string, AgentToolResult>;
  lastStep: VercelStepRecord | undefined;
  completedSteps: number;
  terminateRequested: boolean;
  stopRequested: boolean;
  streamFailure: string | undefined;
  directModelError: unknown;
  sequentialToolTail: Promise<void>;
  currentText: string;
  currentReasoning: Map<string, { text: string; providerMetadata?: Record<string, unknown> }>;
  currentToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  directCall: DirectCallDiagnostics | undefined;
  directAttempts: Array<{ startedAtMs: number; durationMs?: number; error?: string }>;
  directPromptMessages: AgentMessage[] | undefined;
  previousPromptShape: PromptShapeDiagnostic | undefined;
  promptProjectionCache: LocalPromptProjectionCache;
  promptShapeSkipEpoch: number | undefined;
  outputProducedSinceStep: boolean;
}

interface VercelStepRecord {
  message: AgentAssistantMessage;
  toolResults: AgentToolResultMessage[];
  messages: AgentMessage[];
  hadToolCalls: boolean;
  error?: string;
}

type AgentLoopDisplayEvent = Extract<AgentEvent, {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "model_retry";
}>;

export async function* vercelAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal
): AsyncGenerator<AgentEvent, AgentMessage[], void> {
  if (!context.messages.length) throw new Error("Cannot continue an empty agent context.");
  if (context.messages.at(-1)?.role === "assistant") {
    throw new Error("Cannot continue from an assistant message.");
  }

  const state: VercelLoopState = {
    context: { ...context, messages: [...context.messages], tools: [...config.tools] },
    config,
    signal,
    model: config.model,
    vercelModel: config.vercelModel,
    maxRetries: config.maxRetries,
    modelOptions: config.modelOptions,
    tools: [...config.tools],
    newMessages: [],
    hasPendingMessages: false,
    displayEvents: new EventQueue<AgentLoopDisplayEvent>(),
    toolResults: new Map(),
    lastStep: undefined,
    completedSteps: 0,
    terminateRequested: false,
    stopRequested: false,
    streamFailure: undefined,
    directModelError: undefined,
    sequentialToolTail: Promise.resolve(),
    currentText: "",
    currentReasoning: new Map(),
    currentToolCalls: [],
    directCall: undefined,
    directAttempts: [],
    directPromptMessages: undefined,
    previousPromptShape: undefined,
    promptProjectionCache: new LocalPromptProjectionCache(),
    promptShapeSkipEpoch: undefined,
    outputProducedSinceStep: false
  };

  yield { type: "agent_start" };
  yield* appendQueuedMessages(state, await config.getSteeringMessages?.() ?? []);

  let needsFollowUp = true;
  while (needsFollowUp) {
    signal?.throwIfAborted();
    // 这些消息已经写入 context；标记只用于判断上一段 loop 是否需要再次启动。
    state.hasPendingMessages = false;
    const remainingSteps = config.maxSteps - state.completedSteps;
    if (remainingSteps <= 0) {
      yield {
        type: "error",
        error: `Agent reached its ${String(config.maxSteps)}-step limit.`,
        fatal: false,
        reason: "step_limit"
      };
      break;
    }

    state.terminateRequested = false;
    state.streamFailure = undefined;
    state.directModelError = undefined;
    state.directAttempts = [];
    state.outputProducedSinceStep = false;
    let stepResult: StepResult<ToolSet> | undefined;
    try {
      const result = streamModelStep(state);
      const stream = result.fullStream[Symbol.asyncIterator]();
      let nextStream = stream.next();
      while (true) {
        const next = await state.displayEvents.waitForEventOr(nextStream);
        yield* state.displayEvents.drain();
        if (!next) continue;
        if (next.done) break;
        yield* handleVercelStreamPart(state, next.value);
        nextStream = stream.next();
      }
      signal?.throwIfAborted();
      if (stream.return) await stream.return();
      stepResult = (await result.steps).at(-1);
      if (!stepResult) throw new Error("Provider stream ended without a completed step.");
    } catch (error) {
      // AI SDK 在首个输出前失败时可能向 fullStream 抛出通用的 NoOutputGeneratedError，
      // onError 仍保留了 provider 原始错误。持久化和界面都应展示原始原因。
      const providerError = state.directModelError ?? error;
      await recordDirectModelFailure(state, providerError);
      if (signal?.aborted) throw error;
      state.streamFailure = errorMessage(providerError);
      if (state.vercelModel === undefined) {
        yield { type: "error", error: state.streamFailure, fatal: true };
      }
    } finally {
      await recordDirectModelFailure(state, signal?.aborted ? signal.reason : state.directModelError ?? state.streamFailure ?? "Provider stream ended before a finish event.");
    }
    if (state.streamFailure && state.vercelModel !== undefined && !state.outputProducedSinceStep) {
      const failure = state.streamFailure;
      state.streamFailure = undefined;
      const recovery = await recoverDirectModelError(state, failure, signal);
      if (!recovery) {
        state.streamFailure = failure;
        yield { type: "error", error: failure, fatal: true };
      } else {
        yield { type: "model_retry", ...recovery };
      }
    }
    if (state.streamFailure && state.vercelModel !== undefined && state.outputProducedSinceStep) {
      yield { type: "error", error: state.streamFailure, fatal: true };
    }
    yield* state.displayEvents.drain();
    let completedStep: VercelStepRecord | undefined;
    if (!state.streamFailure && stepResult !== undefined) {
      try {
        completedStep = completeStep(state, stepResult);
        await state.config.persistStep?.(turnContext(state, completedStep));
      } catch (error) {
        if (signal?.aborted) throw error;
        state.streamFailure = errorMessage(error);
        yield { type: "error", error: state.streamFailure, fatal: true };
      }
    }
    if (completedStep !== undefined && !state.streamFailure) {
      yield* completedStepEvents(completedStep);
      if (completedStep.error) yield { type: "error", error: completedStep.error, fatal: true };
      yield* state.displayEvents.drain();
    }
    if (completedStep !== undefined && !state.streamFailure) {
      try {
        if (await state.config.shouldStopAfterTurn?.(turnContext(state, completedStep))) {
          state.stopRequested = true;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        state.streamFailure = errorMessage(error);
        yield { type: "error", error: state.streamFailure, fatal: true };
      }
    }
    if (state.streamFailure) break;
    if (state.stopRequested) break;

    // 当前 step 已经提交完成；此后读取追问，持久化顺序直接由控制流保证。
    if (!state.hasPendingMessages) {
      yield* appendQueuedMessages(state, await config.getSteeringMessages?.() ?? []);
    }
    const modelNeedsFollowUp = state.lastStep?.hadToolCalls === true && !state.terminateRequested;
    if (!state.hasPendingMessages && !modelNeedsFollowUp) {
      yield* appendQueuedMessages(state, await config.getQueuedMessages?.() ?? []);
    }
    needsFollowUp = state.hasPendingMessages || modelNeedsFollowUp;
    if (state.completedSteps >= config.maxSteps && needsFollowUp) {
      yield {
        type: "error",
        error: `Agent reached its ${String(config.maxSteps)}-step limit.`,
        fatal: false,
        reason: "step_limit"
      };
      break;
    }
    if (needsFollowUp && completedStep !== undefined) {
      try {
        await prepareNextModelStep(state, completedStep);
      } catch (error) {
        if (signal?.aborted) throw error;
        state.streamFailure = errorMessage(error);
        yield { type: "error", error: state.streamFailure, fatal: true };
        break;
      }
    }
  }

  yield {
    type: "agent_end",
    messages: state.newMessages,
    contextMessages: [...state.context.messages]
  };
  return state.newMessages;
}

async function recoverDirectModelError(
  state: VercelLoopState,
  error: string,
  signal: AbortSignal | undefined
): Promise<{ reason: string; attempt: number; compactedMessages: number } | undefined> {
  if (state.vercelModel === undefined || state.outputProducedSinceStep) return undefined;
  const recovery = await state.config.recoverFromModelError?.(error, state.context, signal);
  if (!recovery) return undefined;
  state.hasPendingMessages = true;
  return recovery;
}

function streamModelStep(state: VercelLoopState) {
  const tools = createVercelTools(state);
  const callSettings = vercelCallSettings(state);
  // SDK 的 call-start 只表示逻辑调用；物理重试要在 SDK middleware 的 doStream 边界计数。
  const model = state.vercelModel === undefined ? createLanguageModel(state) : wrapLanguageModel({
    model: state.vercelModel,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ doStream }) => {
        const attempt: VercelLoopState["directAttempts"][number] = { startedAtMs: Date.now() };
        state.directAttempts.push(attempt);
        try { return await doStream(); }
        catch (error) {
          attempt.error = errorMessage(error);
          attempt.durationMs = Math.max(0, Date.now() - attempt.startedAtMs);
          throw retryableEmptySuccessfulResponse(error);
        }
      }
    }
  });
  return streamText({
    messages: applyCacheMarkers(
      toModelMessages(state.context.messages, state.context.tools.some((tool) => tool.providerTool === "openai-apply-patch")),
      state.modelOptions?.cacheMarkers
    ),
    abortSignal: state.signal,
    model,
    instructions: markInstructions(state.context.systemPrompt, state.modelOptions?.cacheMarkers),
    tools,
    // 名字或参数不合法的工具调用先自愈再执行，避免可修复失败进入重试循环。
    repairToolCall: toolCallRepair,
    maxRetries: state.vercelModel === undefined ? 0 : state.maxRetries ?? 0,
    // 接管 SDK 默认的 console.error，错误仍由 fullStream 进入 Biny 稳定事件链。
    onError: ({ error }) => { state.directModelError = error; },
    onAbort: ({ reason }) => {
      state.directModelError = reason ?? new Error("Provider request aborted.");
      state.streamFailure = errorMessage(state.directModelError);
    },
    ...callSettings,
    // SDK 只负责一个 provider step（含该 step 的工具执行）。跨 step 的边界
    // 由 Biny 管理，才能在 assistant turn 完整落库后再消费追问队列。
    stopWhen: [
      stepCountIs(1),
      () => state.terminateRequested || state.stopRequested
    ],
    prepareStep: async () => ({
      model,
      instructions: markInstructions(state.context.systemPrompt, state.modelOptions?.cacheMarkers),
      messages: applyCacheMarkers(await modelMessages(state), state.modelOptions?.cacheMarkers),
      ...vercelCallSettings(state),
      activeTools: state.context.tools.map((candidate) => candidate.name) as Array<keyof ToolSet>
    }),
    onLanguageModelCallStart: state.vercelModel === undefined
      ? undefined
      : (event) => { beginDirectModelRequest(state, event.callId); },
    onLanguageModelCallEnd: state.vercelModel === undefined
      ? undefined
      : async (event) => { await recordDirectModelRequest(state, event); }
  });
}

/**
 * 部分 Anthropic 兼容端点会在 HTTP 200 后直接结束空 SSE 流。
 * 这类错误发生在首个事件之前，重放同一个模型步骤不会重复工具副作用，
 * 因此把它标记成可重试，让 AI SDK 的 maxRetries 真正覆盖该故障。
 */
function retryableEmptySuccessfulResponse(error: unknown): unknown {
  if (!APICallError.isInstance(error)
    || error.isRetryable
    || error.statusCode === undefined
    || error.statusCode < 200
    || error.statusCode >= 300
    || error.message !== "Failed to process successful response") {
    return error;
  }
  return new APICallError({
    message: error.message,
    url: error.url,
    requestBodyValues: error.requestBodyValues,
    statusCode: error.statusCode,
    responseHeaders: error.responseHeaders,
    responseBody: error.responseBody,
    cause: error.cause,
    data: error.data,
    isRetryable: true
  });
}

function completeStep(state: VercelLoopState, step: StepResult<ToolSet>): VercelStepRecord {
  const message = assistantFromStep(step);
  const toolResults = step.toolCalls.map((call) => toolResultMessage(
    call.toolCallId,
    call.toolName,
    state.toolResults.get(call.toolCallId),
    step
  ));
  const messages = [...state.context.messages, message, ...toolResults];
  state.context.messages.push(message, ...toolResults);
  state.newMessages.push(message, ...toolResults);
  state.completedSteps += 1;
  const record: VercelStepRecord = { message, toolResults, messages, hadToolCalls: step.toolCalls.length > 0 };
  state.lastStep = record;
  updateStepReasoningMetadata(state, record);
  const invalidToolCall = step.toolCalls.find((call) => call.invalid);
  const truncatedToolCall = step.finishReason === "length" && step.toolCalls.length > 0;
  const unavailableToolCall = step.toolCalls.find((call) => !call.toolName.trim()
    || !state.tools.some((candidate) => candidate.name === call.toolName));
  if (invalidToolCall || truncatedToolCall) {
    // AI SDK 只在 stop/tool-calls 时执行客户端工具，length 下即使参数通过 schema 也不会执行；
    // 这里负责停止 Biny 续环并保留 length，让上层将任务标记为可恢复的 model_length。
    state.stopRequested = true;
    if (invalidToolCall && step.finishReason !== "length") {
      const name = invalidToolCall.toolName.trim();
      const error = name
        ? `Tool call for ${name} is invalid.`
        : "Tool call is missing a function name.";
      record.error = error;
    }
  } else if (unavailableToolCall) {
    const error = unavailableToolCall.toolName.trim()
      ? `Tool ${unavailableToolCall.toolName} not found.`
      : "Tool call is missing a function name.";
    record.error = error;
    state.stopRequested = true;
  }

  return record;
}

function turnContext(state: VercelLoopState, record: VercelStepRecord): AgentLoopTurnContext {
  return {
    message: record.message,
    toolResults: record.toolResults,
    context: state.context,
    newMessages: state.newMessages
  };
}

async function prepareNextModelStep(state: VercelLoopState, record: VercelStepRecord): Promise<void> {
  const nextTurn = await state.config.prepareNextTurn?.(turnContext(state, record));
  if (!nextTurn) return;
  if (nextTurn.context) state.context = nextTurn.context;
  state.tools = [...(nextTurn.tools ?? state.context.tools)];
  state.context.tools = [...state.tools];
  if (nextTurn.model) {
    state.model = nextTurn.model;
    state.vercelModel = nextTurn.vercelModel;
  } else if (nextTurn.vercelModel) {
    state.vercelModel = nextTurn.vercelModel;
  }
  state.modelOptions = nextTurn.modelOptions ?? state.modelOptions;
  if ("maxRetries" in nextTurn) state.maxRetries = nextTurn.maxRetries;
}

function appendQueuedMessages(state: VercelLoopState, messages: AgentMessage[]): AgentEvent[] {
  if (!messages.length) return [];
  state.hasPendingMessages = true;
  state.context.messages.push(...messages);
  state.newMessages.push(...messages);
  return messages.flatMap((message): AgentEvent[] => [
    { type: "message_start", message },
    { type: "message_end", message }
  ]);
}

function vercelCallSettings(state: VercelLoopState): {
  maxOutputTokens: number | undefined;
  temperature: number | undefined;
  reasoning: LanguageModelV4CallOptions["reasoning"];
  providerOptions: LanguageModelV4CallOptions["providerOptions"];
  timeout: number | undefined;
} {
  return {
    maxOutputTokens: state.modelOptions?.maxOutputTokens,
    temperature: state.modelOptions?.temperature,
    reasoning: toVercelReasoning(state.modelOptions?.reasoning),
    providerOptions: vercelProviderOptions(state),
    timeout: state.modelOptions?.timeoutMs
  };
}

function vercelProviderOptions(state: VercelLoopState): LanguageModelV4CallOptions["providerOptions"] {
  const providerOptions = state.modelOptions?.providerOptions;
  if (!providerOptions || !state.vercelModel) return providerOptions as LanguageModelV4CallOptions["providerOptions"];
  const providerKey = state.vercelModel.provider.split(".", 1)[0] ?? state.vercelModel.provider;
  if (providerOptions[providerKey] !== undefined || providerOptions[state.model.provider] === undefined) {
    return providerOptions as LanguageModelV4CallOptions["providerOptions"];
  }
  // Biny 按协议名保存 provider options；AI SDK 的 custom provider 则按 factory name 取值。
  return {
    ...providerOptions,
    [providerKey]: providerOptions[state.model.provider]
  } as LanguageModelV4CallOptions["providerOptions"];
}

function handleVercelStreamPart(state: VercelLoopState, part: {
  type: string;
  [key: string]: unknown;
}): AgentEvent[] {
  if (part.type === "start-step") {
    state.currentText = "";
    state.currentReasoning.clear();
    state.currentToolCalls = [];
    return [{ type: "turn_start" }, { type: "message_start", message: emptyAssistant() }];
  }
  if (part.type === "text-delta" && typeof part.text === "string") {
    state.outputProducedSinceStep = true;
    state.currentText += part.text;
    return [{
      type: "message_update",
      message: assistantSnapshot(state),
      event: { type: "text-delta", text: part.text }
    }];
  }
  if (part.type === "reasoning-start" && typeof part.id === "string") {
    state.currentReasoning.set(part.id, {
      text: "",
      providerMetadata: providerMetadata(part.providerMetadata)
    });
    return [{
      type: "message_update",
      message: assistantSnapshot(state),
      event: { type: "reasoning-start", id: part.id, providerMetadata: providerMetadata(part.providerMetadata) }
    }];
  }
  if (part.type === "reasoning-delta" && typeof part.id === "string" && typeof part.text === "string") {
    state.outputProducedSinceStep = true;
    const reasoning = state.currentReasoning.get(part.id) ?? { text: "" };
    reasoning.text += part.text;
    reasoning.providerMetadata = providerMetadata(part.providerMetadata) ?? reasoning.providerMetadata;
    state.currentReasoning.set(part.id, reasoning);
    return [{
      type: "message_update",
      message: assistantSnapshot(state),
      event: { type: "reasoning-delta", id: part.id, text: part.text, providerMetadata: providerMetadata(part.providerMetadata) }
    }];
  }
  if (part.type === "reasoning-end" && typeof part.id === "string") {
    const reasoning = state.currentReasoning.get(part.id);
    if (reasoning) reasoning.providerMetadata = providerMetadata(part.providerMetadata) ?? reasoning.providerMetadata;
    return [{
      type: "message_update",
      message: assistantSnapshot(state),
      event: { type: "reasoning-end", id: part.id, providerMetadata: providerMetadata(part.providerMetadata) }
    }];
  }
  if (part.type === "tool-call" && typeof part.toolCallId === "string" && typeof part.toolName === "string") {
    state.outputProducedSinceStep = true;
    const input = isRecord(part.input) ? part.input : {};
    state.currentToolCalls.push({ id: part.toolCallId, name: part.toolName, arguments: input });
    return [{
      type: "message_update",
      message: assistantSnapshot(state),
      event: { type: "tool-call", id: part.toolCallId, name: part.toolName, arguments: input }
    }];
  }
  if (part.type === "finish-step") {
    return [];
  }
  if (part.type === "error") {
    const error = errorMessage(part.error);
    state.streamFailure = error;
    return state.vercelModel === undefined ? [{ type: "error", error, fatal: true }] : [];
  }
  return [];
}

function completedStepEvents(record: VercelStepRecord): AgentEvent[] {
  return [
    { type: "message_end", message: record.message },
    {
      type: "turn_end",
      message: record.message,
      toolResults: record.toolResults,
      messages: record.messages
    }
  ];
}

function updateStepReasoningMetadata(state: VercelLoopState, record: VercelStepRecord): void {
  const previousMessage = record.message;
  const message = attachStreamedReasoningMetadata(previousMessage, state.currentReasoning);
  if (message === previousMessage) return;
  const contextIndex = state.context.messages.indexOf(previousMessage);
  if (contextIndex >= 0) state.context.messages[contextIndex] = message;
  const newMessageIndex = state.newMessages.indexOf(previousMessage);
  if (newMessageIndex >= 0) state.newMessages[newMessageIndex] = message;
  record.message = message;
  record.messages = record.messages.map((candidate) => candidate === previousMessage ? message : candidate);
}

function attachStreamedReasoningMetadata(
  message: AgentAssistantMessage,
  reasoning: Map<string, { text: string; providerMetadata?: Record<string, unknown> }>
): AgentAssistantMessage {
  const streamed = [...reasoning.values()];
  let index = 0;
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "reasoning") return part;
    const metadata = streamed[index++]?.providerMetadata;
    if (!metadata || part.providerMetadata) return part;
    changed = true;
    return { ...part, providerMetadata: metadata };
  });
  return changed ? { ...message, content } : message;
}

function assistantFromStep(step: StepResult<ToolSet>): AgentAssistantMessage {
  const content: AgentAssistantMessage["content"] = [];
  const text = step.text || step.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (text) content.push({ type: "text", text });
  for (const part of step.reasoning) {
    if (part.type === "reasoning") {
      content.push({
        type: "reasoning",
        text: part.text,
        providerMetadata: providerMetadata((part as { providerMetadata?: unknown }).providerMetadata)
      });
    }
  }
  for (const call of step.toolCalls) {
    content.push({
      type: "toolCall",
      id: call.toolCallId,
      name: call.toolName,
      arguments: isRecord(call.input) ? call.input : {},
      invalid: call.invalid
    });
  }
  return {
    role: "assistant",
    content,
    stopReason: fromVercelFinishReason(step.finishReason),
    usage: fromVercelUsage(step.usage),
    timestamp: Date.now()
  };
}

function assistantSnapshot(state: VercelLoopState): AgentAssistantMessage {
  const content: AgentAssistantMessage["content"] = [];
  if (state.currentText) content.push({ type: "text", text: state.currentText });
  for (const reasoning of state.currentReasoning.values()) {
    if (reasoning.text) content.push({ type: "reasoning", text: reasoning.text, providerMetadata: reasoning.providerMetadata });
    else content.push({ type: "reasoning", text: "", providerMetadata: reasoning.providerMetadata });
  }
  content.push(...state.currentToolCalls.map((call) => ({
    type: "toolCall" as const,
    id: call.id,
    name: call.name,
    arguments: call.arguments
  })));
  return {
    role: "assistant",
    content,
    timestamp: Date.now()
  };
}

function emptyAssistant(): AgentAssistantMessage {
  return { role: "assistant", content: [] };
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  result: AgentToolResult | undefined,
  step: StepResult<ToolSet>
): AgentToolResultMessage {
  if (result) {
    return {
      role: "toolResult",
      toolCallId,
      toolName,
      content: result.content,
      details: result.details,
      isError: result.isError,
      timestamp: Date.now()
    };
  }
  const output = step.toolResults.find((candidate) => candidate.toolCallId === toolCallId)?.output;
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: stringify(output ?? "Tool execution returned no result.") }],
    isError: true,
    timestamp: Date.now()
  };
}
