import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import { defaultConfig, configSchema } from "../src/config/schema.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { createNativeModelSettings } from "../src/llm/nativeFactory.js";
import { createNativeModel } from "../src/llm/nativeModel.js";
import { ApiAdapterRegistry } from "../src/llm/ApiAdapterRegistry.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { FileModelsStore, restoreProviderCatalogs, type ModelsStore } from "../src/llm/ModelsStore.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import type { AgentModel, ModelRequestMetrics, ModelStreamContext, ModelStreamOptions } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";

async function main(): Promise<void> {
  await testApiAdapterDispatch();
  await testProviderRuntimeCatalog();
  await testProviderRuntimeMetadata();
  await testNoOffThinkingUsesDefaultEffort();
  await testModelSwitchRecalculatesBudget();
  await testOpenCodeModelSwitchRepairsThinkingMetadata();
  await testModelSwitchDoesNotPersistInferredMetadata();
  await testPersistedProviderCatalog();
  await testRefreshModelsForceBypassesConditionalGet();
  await testExtensibleProviderRuntime();
  await testCompatibleSystemRole();
  await testFactoryProviderDefaults();
  await testAnthropicSubscriptionAndHistory();
  await testCompatibleReasoningPayloads();
  await testKimiPromptCacheKey();
  await testOpenAiPromptCacheKey();
  await testCompatibleEmptyAssistantHistory();
  await testAnthropicSkipsEmptyAssistantHistory();
  await testGoogleSkipsEmptyAssistantHistory();
  await testChatParamsApplyToFirstModelRequest();
  await testNativeTimeout();
  await testOpenAiResponsesTransport();
  await testStreamingProtocolsRequireTerminalEvents();
  await testOpenAiToolCallsRequireFunctionNames();
  await testGoogleGenerativeAiTransport();
  await testAudioPayloads();
  await testQueuedMessage();
  const originalFetch = globalThis.fetch;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-native-agent-"));
  await ensureAgentDirs(workspaceRoot);
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    const parts = requestCount === 1
      ? [
        { choices: [{ index: 0, delta: { reasoning_content: "先检查当前状态。" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "echo", arguments: '{"value":"ok"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
      ]
      : [
        { choices: [{ index: 0, delta: { reasoning_content: "根据结果整理回复。" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "native answer" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ];
    return new Response([
      ...parts.map((part) => `data: ${JSON.stringify(part)}`),
      "data: [DONE]"
    ].join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "test-model",
    providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://example.test/v1" } },
    models: { "test-model": { provider: "active", model: "test-model", contextWindow: 128_000 } },
    thinking: { enabled: false, effort: "high" },
    permission: defaultConfig.permission,
    workspace: defaultConfig.workspace,
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const registry = new ToolRegistry();
  let releaseTool!: () => void;
  const toolProgressSeen = new Promise<void>((resolve) => { releaseTool = resolve; });
  let echoCompleted = false;
  const echoTool: Tool<{ value: string }, { value: string }> = {
    name: "echo",
    description: "Echo one value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    },
    schema: z.object({ value: z.string() }),
    risk: "read",
    resolveExecution: (args) => ({
      approvalRule: "echo",
      execute: async (context) => {
        context.onUpdate?.({ kind: "progress", text: "waiting for consumer" });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            toolProgressSeen,
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("tool progress was buffered")), 2000); })
          ]);
        } finally { clearTimeout(timer); }
        echoCompleted = true;
        return { value: args.value };
      }
    })
  };
  registry.registerBuiltinTool(echoTool);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    modelManager: new ModelManager(workspaceRoot, config),
    toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  await agent.initialize();
  let closed = false;
  try {
    const events: AgentSessionEvent[] = [];
    for await (const event of agent.prompt("answer briefly", {
      confirmPermission: async () => ({ approved: true, scope: "once" }),
      emotionAnalysis: false
    })) {
      if (event.type === "tool.progress") {
        assert.equal(echoCompleted, false, "session progress must arrive while the tool is running");
        releaseTool();
      }
      events.push(event);
    }
    const done = events.find((event): event is Extract<AgentSessionEvent, { type: "done" }> => event.type === "done");
    assert.equal(requestCount, 2);
    assert.equal(done?.outcome.status, "completed");
    assert.equal(done?.outcome.stopReason, "model_stop");
    assert.equal(done?.content, "native answer");
    assert.equal(events.some((event) => event.type === "assistant.delta" && event.content === "native answer"), true);
    assert.equal(events.some((event) => event.type === "tool.completed" && event.tool === "echo"), true);
    const requestSummary = agent.modelRequestSummary();
    assert.equal(requestSummary.calls, 2);
    assert.equal(requestSummary.failed, 0);
    assert.equal(requestSummary.totalAttempts, 2);
    assert.equal(requestSummary.retries, 0);
    assert.equal(requestSummary.averageTimeToFirstEventMs !== undefined, true);
    const initialReplay = await replaySession(recorder.filePath);
    const target = [...initialReplay.messageTree].reverse().find((node) => node.message.role === "assistant" && node.message.content.some((part) => part.type === "text" && part.text === "native answer"));
    assert.ok(target);
    const retryEvents: AgentSessionEvent[] = [];
    for await (const event of agent.retry(target.id, {
      confirmPermission: async () => ({ approved: true, scope: "once" })
    })) retryEvents.push(event);
    const retryDone = retryEvents.find((event): event is Extract<AgentSessionEvent, { type: "done" }> => event.type === "done");
    assert.equal(requestCount, 3);
    assert.equal(retryDone?.outcome.status, "completed");
    assert.equal(retryDone?.content, "native answer");
    const replayedAfterRetry = await replaySession(recorder.filePath);
    const retryMessageId = replayedAfterRetry.messageReferences.at(-1)?.id;
    assert.notEqual(retryMessageId, target.id);
    assert.equal(replayedAfterRetry.messages.at(-1)?.role, "assistant");
    assert.equal(replayedAfterRetry.modelRequests.length, 3);
    assert.ok(retryMessageId);
    await agent.switchMessageVersion(retryMessageId, "prev");
    const replayedPreviousVersion = await replaySession(recorder.filePath);
    assert.equal(replayedPreviousVersion.messageReferences.at(-1)?.id, target.id);
    const sourceUserId = replayedPreviousVersion.messageReferences.find((reference) => {
      const message = replayedPreviousVersion.messages[reference.index];
      return message?.role === "user";
    })?.id;
    assert.ok(sourceUserId);
    const editEvents: AgentSessionEvent[] = [];
    for await (const event of agent.retry(sourceUserId, {
      confirmPermission: async () => ({ approved: true, scope: "once" }),
      replaceUserMessageId: sourceUserId,
      replacementInput: "edited prompt",
      replacementUserMessageId: "edited-user"
    })) editEvents.push(event);
    const editDone = editEvents.find((event): event is Extract<AgentSessionEvent, { type: "done" }> => event.type === "done");
    assert.equal(requestCount, 4);
    assert.equal(editDone?.outcome.status, "completed");
    const replayedAfterEdit = await replaySession(recorder.filePath);
    const editedAssistantId = replayedAfterEdit.messageReferences.at(-1)?.id;
    assert.equal(replayedAfterEdit.messageReferences[0]?.id, "edited-user");
    assert.equal(replayedAfterEdit.messages[0]?.role, "user");
    const editedUserMessage = replayedAfterEdit.messages[0];
    assert.equal(editedUserMessage?.role === "user" && typeof editedUserMessage.content === "string" ? editedUserMessage.content : undefined, "edited prompt");
    assert.notEqual(editedAssistantId, target.id);
    assert.ok(editedAssistantId);
    await agent.switchMessageVersion(editedAssistantId, "prev");
    const replayedAfterEditSwitch = await replaySession(recorder.filePath);
    assert.equal(replayedAfterEditSwitch.messageReferences[0]?.id, sourceUserId);
    assert.notEqual(replayedAfterEditSwitch.messageReferences.at(-1)?.id, editedAssistantId);
    await agent.close();
    closed = true;
    const storedEvents = (await readFile(recorder.filePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        type: string;
        reasoningContent?: string;
        metrics?: {
          requestContext?: {
            sessionId?: string;
            runId?: string;
            turnId?: string;
            step?: number;
            promptEpoch?: number;
            relatedToolCallIds?: string[];
          };
          promptShape?: {
            stablePrefixHash?: string;
            requestShapeChangeReason?: string;
            epoch?: { reason?: string; createdAt?: string };
          };
          promptShapeDurationMs?: number;
          promptShapeStatus?: string;
          promptShapeBudgetExceeded?: boolean;
        };
      });
    assert.equal(storedEvents.find((event) => event.type === "tool_call")?.reasoningContent, "先检查当前状态。");
    assert.equal([...storedEvents].reverse().find((event) => event.type === "assistant_message")?.reasoningContent, "根据结果整理回复。");
    assert.equal(storedEvents.filter((event) => event.type === "user_message").length, 2);
    assert.equal(storedEvents.filter((event) => event.type === "assistant_message").length, 3);
    assert.equal(storedEvents.filter((event) => event.type === "message_version_selected").length, 4);
    const requestEvents = storedEvents.filter((event) => event.type === "model_request");
    assert.equal(requestEvents.length, 4);
    assert.deepEqual(requestEvents.map((event) => event.metrics?.requestContext?.step), [1, 2, 1, 1]);
    assert.equal(requestEvents[0]?.metrics?.requestContext?.sessionId, recorder.sessionId);
    assert.equal(requestEvents[0]?.metrics?.requestContext?.runId, requestEvents[1]?.metrics?.requestContext?.runId);
    assert.deepEqual(requestEvents[1]?.metrics?.requestContext?.relatedToolCallIds, ["call-1"]);
    assert.equal(requestEvents[0]?.metrics?.requestContext?.promptEpoch, 0);
    assert.equal(requestEvents[0]?.metrics?.promptShape?.epoch?.reason, "initial");
    assert.equal(typeof requestEvents[0]?.metrics?.promptShapeDurationMs, "number");
    assert.equal(requestEvents[0]?.metrics?.promptShapeStatus, "full");
    assert.equal(requestEvents[1]?.metrics?.promptShape?.stablePrefixHash, requestEvents[0]?.metrics?.promptShape?.stablePrefixHash);
    assert.equal(requestEvents[1]?.metrics?.promptShape?.requestShapeChangeReason, "history_projection_changed");
    assert.equal((await replaySession(recorder.filePath)).modelRequests.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (!closed) await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testRefreshModelsForceBypassesConditionalGet(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-models-force-"));
  const filePath = path.join(root, "models-store.json");
  const store = new FileModelsStore(filePath);
  const cached = {
    id: "cached-model",
    displayName: "Cached Model",
    provider: "catalog",
    contextWindow: 64_000,
    maxOutputTokens: 8_000,
    maxInputTokens: 60_000,
    capabilities: { tools: true, reasoning: false },
    reasoningEfforts: [] as string[],
    reasoningEffortsSource: "inferred" as const
  };
  try {
    await store.write("catalog", { models: [cached], checkedAt: 1, etag: "first-etag" });
    const config = configSchema.parse({
      ...defaultConfig,
      defaultModel: "configured-model",
      providers: {
        catalog: {
          type: "openai-compatible",
          baseUrl: "https://catalog.example/v1",
          apiKey: "test-key"
        }
      },
      models: {
        "configured-model": { provider: "catalog", model: "configured-model" }
      }
    });
    const catalogs = await restoreProviderCatalogs(["catalog"], new FileModelsStore(filePath));
    const runtime = new ModelRuntime(config, catalogs, undefined, new FileModelsStore(filePath));
    const originalFetch = globalThis.fetch;
    let conditionalHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      conditionalHeaders = new Headers(init?.headers);
      return Response.json({ data: [{ id: "fresh-model" }] });
    }) as typeof fetch;
    try {
      const models = await runtime.refreshModels("catalog", undefined, true);
      // force refresh must skip the conditional cache headers entirely.
      assert.equal(conditionalHeaders?.get("if-none-match"), null);
      assert.equal(conditionalHeaders?.get("if-modified-since"), null);
      assert.equal(models.some((entry) => entry.id === "fresh-model"), true);
      const persisted = await new FileModelsStore(filePath).read("catalog");
      assert.equal(persisted?.models.some((entry) => entry.id === "fresh-model"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testGoogleGenerativeAiTransport(): Promise<void> {
  let requestUrl = "";
  let requestHeaders: Headers | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "google-native",
    modelId: "gemini-test",
    api: "google_generative_ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "google-key",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "consider", thought: true }] } }] })}`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { query: "value" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5, total_cached_tokens: 2 } })}`
      ].join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  const events = [];
  for await (const event of await model.stream({
    systemPrompt: "Be useful",
    messages: [{ role: "user", content: "find it" }],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }]
  }, { reasoning: "high" })) events.push(event);
  assert.equal(requestUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
  assert.equal(requestHeaders?.get("x-goog-api-key"), "google-key");
  assert.equal(((requestBody?.generationConfig as Record<string, unknown>).thinkingConfig as Record<string, unknown>).thinkingBudget, 8_192);
  assert.equal(events.find((event) => event.type === "reasoning-delta")?.text, "consider");
  assert.equal(events.find((event) => event.type === "tool-call")?.name, "lookup");
  assert.equal(events.find((event) => event.type === "finish")?.usage?.totalTokens, 5);
  assert.equal(events.find((event) => event.type === "finish")?.usage?.cacheReadTokens, 2);
  assert.equal(events.find((event) => event.type === "finish")?.usage?.cacheMissTokens, 1);
}

async function testExtensibleProviderRuntime(): Promise<void> {
  let observedReasoning: string | undefined;
  const ai = new AiRegistry();
  ai.registerProvider({
    type: "plugin-provider",
    name: "Plugin Provider",
    protocol: "openai-compatible",
    api: "plugin-api",
    baseUrl: "https://plugin.example/v1",
    requiresApiKey: false,
    authModes: ["api-key"],
    filterModels: (models) => models.filter((model) => model.id !== "hidden")
  }, [
    catalogEntry("visible", "Built-in Visible"),
    catalogEntry("hidden", "Hidden")
  ]);
  ai.registerModels("plugin-provider", [catalogEntry("visible", "Extension Visible")]);
  ai.registerApiAdapter({
    id: "plugin-api",
    stream: async function* (_request, _context, options) {
      observedReasoning = options?.reasoning;
      yield { type: "start" };
      yield { type: "reasoning-delta", id: "reasoning-0", text: "check" };
      yield { type: "tool-call", id: "tool-1", name: "lookup", arguments: { query: "value" } };
      yield { type: "finish", reason: "tool-calls" };
    }
  });
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "configured",
    providers: {
      custom: {
        type: "plugin-provider",
        baseUrl: "https://configured.example/v1",
        requiresApiKey: false,
        apiBackend: "plugin-api"
      }
    },
    models: {
      configured: {
        provider: "custom",
        model: "configured-model",
        displayName: "Configured Model",
        contextWindow: 32_000,
        capabilities: { tools: true, reasoning: true, streaming: true },
        thinkingLevelMap: { off: "none", high: "provider-high" }
      }
    },
    thinking: { enabled: true, effort: "high" }
  });
  const liveModels = [catalogEntry("visible", "Live Visible"), catalogEntry("live-only", "Live Only")];
  const runtime = new ModelRuntime(config, [["custom", liveModels]], ai);
  const choices = runtime.listModels();
  assert.equal(choices.find((choice) => choice.alias === "custom/visible")?.displayName, "Live Visible");
  assert.equal(choices.some((choice) => choice.alias === "custom/hidden"), false);
  assert.equal(choices.some((choice) => choice.alias === "custom/live-only"), true);

  const settings = new ProviderRegistry(config, [["custom", liveModels]], ai).createModelSettings();
  const events = [];
  for await (const event of await settings.model.streamSimple?.({
    messages: [{ role: "user", content: "use a tool" }],
    tools: []
  }, { reasoning: "high" }) ?? []) events.push(event);
  assert.equal(observedReasoning, "high");
  assert.equal(events.some((event) => event.type === "reasoning-delta"), true);
  assert.equal(events.find((event) => event.type === "tool-call")?.name, "lookup");
}

function catalogEntry(id: string, displayName: string) {
  return {
    id,
    displayName,
    provider: "custom",
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    capabilities: { tools: true, streaming: true },
    reasoningEfforts: []
  };
}

async function testApiAdapterDispatch(): Promise<void> {
  let observedProvider = "";
  const adapters = new ApiAdapterRegistry([{
    id: "chat_completions",
    stream: async function* (request, context) {
      observedProvider = request.provider;
      assert.equal(context.messages.at(-1)?.role, "user");
      yield { type: "start" };
      yield { type: "text-delta", text: "adapter answer" };
      yield { type: "finish", reason: "stop" };
    }
  }]);
  const model = createNativeModel({
    provider: "adapter-test",
    modelId: "adapter-model",
    api: "chat_completions",
    baseUrl: "https://example.test/v1",
    fetch: async () => new Response(null, { status: 500 }),
    apiAdapters: adapters
  });
  const events = [];
  for await (const event of await model.stream({ messages: [{ role: "user", content: "hello" }], tools: [] })) {
    events.push(event);
  }
  assert.equal(observedProvider, "adapter-test");
  assert.equal(events.find((event) => event.type === "text-delta")?.text, "adapter answer");
}

async function testProviderRuntimeCatalog(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), "https://catalog.example/v1/models");
    return new Response(JSON.stringify({ data: [{
      id: "catalog-model",
      context_window: 32_000,
      max_input_tokens: 30_000,
      max_output_tokens: 8_000,
      supports_reasoning: true,
      supports_reasoning_stream: true,
      supports_reasoning_summary: true,
      supports_parallel_tool_calls: true
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const config = configSchema.parse({
      ...defaultConfig,
      defaultModel: "configured-model",
      providers: {
        catalog: {
          type: "openai-compatible",
          baseUrl: "https://catalog.example/v1",
          apiKey: "test-key"
        }
      },
      models: {
        "configured-model": { provider: "catalog", model: "configured-model" }
      }
    });
    const providers = new ProviderRegistry(config);
    assert.equal(providers.require("catalog").isConfigured(config.models["configured-model"]), true);
    const models = await providers.refreshModels("catalog");
    assert.equal(models[0]?.id, "catalog-model");
    assert.equal(models[0]?.maxInputTokens, 30_000);
    assert.equal(models[0]?.maxOutputTokens, 8_000);
    assert.equal(models[0]?.capabilities.reasoningStream, true);
    assert.equal(models[0]?.capabilities.reasoningSummary, true);
    assert.equal(models[0]?.capabilities.parallelToolCalls, true);
    assert.deepEqual(models[0]?.reasoningEfforts, ["high", "max"]);
    assert.deepEqual(models[0]?.thinkingLevelMap, {
      off: "none",
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max"
    });
    assert.equal(providers.catalogsSnapshot()[0]?.[1][0]?.provider, "catalog");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testProviderRuntimeMetadata(): Promise<void> {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "flash-alias",
    providers: {
      deepseek: { type: "deepseek", apiKey: "test-key" },
      openai: { type: "openai", apiKey: "test-key" },
      gemini: { type: "gemini", apiKey: "test-key" },
      unknown: { type: "openai-compatible", baseUrl: "https://unknown.example/v1", apiKey: "test-key" }
    },
    models: {
      "flash-alias": { provider: "deepseek", model: "deepseek-v4-flash" },
      "pro-alias": { provider: "deepseek", model: "deepseek-v4-pro" },
      "gpt-alias": { provider: "openai", model: "gpt-5.2" },
      "gemini-flash": { provider: "gemini", model: "gemini-3.5-flash", contextWindow: 128_000 },
      "gemini-pro": { provider: "gemini", model: "gemini-3.5-pro", contextWindow: 1_048_576 },
      unknown: { provider: "unknown", model: "future-model", contextWindow: 64_000 }
    }
  });
  const providers = new ProviderRegistry(config);
  assert.deepEqual(providers.forModel("flash-alias").model.reasoning?.efforts, ["low", "high", "max"]);
  assert.deepEqual(providers.forModel("pro-alias").model.reasoning?.efforts, ["high", "max"]);
  assert.equal(providers.forModel("gemini-flash").model.capabilities?.reasoning, true);
  assert.equal(providers.forModel("unknown").model.capabilities?.reasoning, false);
  assert.equal(providers.forModel("unknown").model.thinkingLevelMap, undefined);
  assert.equal(providers.createModelSettings("unknown").providerOptions, undefined);
  const untrustedCatalog = new ProviderRegistry(config, [["unknown", [{
    id: "future-model",
    displayName: "Untrusted transport",
    provider: "unknown",
    contextWindow: 64_000,
    maxOutputTokens: 8_000,
    capabilities: { tools: true, streaming: true },
    reasoningEfforts: [],
    apiBackend: "responses",
    baseUrl: "http://127.0.0.1:9/private",
    headers: { Authorization: "Bearer catalog-key", "x-catalog": "untrusted" },
    compatibility: { supportsDeveloperRole: true }
  }]]]);
  const untrustedResolved = untrustedCatalog.forModel("unknown").model;
  assert.equal(untrustedResolved.apiBackend, undefined);
  assert.equal(untrustedResolved.baseUrl, undefined);
  assert.equal(untrustedResolved.headers, undefined);
  assert.equal(untrustedResolved.compatibility, undefined);
  assert.equal(new ModelRuntime(config, [["unknown", [{
    id: "future-model",
    displayName: "Untrusted transport",
    provider: "unknown",
    contextWindow: 64_000,
    maxOutputTokens: 8_000,
    capabilities: { tools: true, streaming: true },
    reasoningEfforts: [],
    baseUrl: "http://127.0.0.1:9/private"
  }]]]).listModels().find((choice) => choice.alias === "unknown")?.baseUrl, "https://unknown.example/v1");
  const staleGeminiCatalog = new ProviderRegistry(config, [["gemini", [{
    id: "gemini-3.5-flash",
    displayName: "Gemini Flash (目录)",
    provider: "gemini",
    contextWindow: undefined,
    maxOutputTokens: undefined,
    capabilities: { reasoning: true },
    reasoningEfforts: ["high", "max"]
  }]]]);
  assert.equal(staleGeminiCatalog.forModel("gemini-flash").model.capabilities?.reasoning, true);

  const catalogRuntime = new ProviderRegistry(config, [["openai", [{
    id: "gpt-5.2",
    displayName: "GPT-5.2 (目录)",
    provider: "openai",
    contextWindow: 128_000,
    maxInputTokens: 120_000,
    maxOutputTokens: 16_384,
    capabilities: { reasoning: true },
    reasoningEfforts: ["high", "max"]
  }]]]);
  const catalogResolved = catalogRuntime.forModel("gpt-alias").model;
  assert.equal(catalogResolved.contextWindow, 128_000);
  assert.equal(catalogResolved.maxInputTokens, 120_000);
  assert.equal(catalogResolved.maxOutputTokens, 16_384);
  const catalogChoice = new ModelRuntime(config, [["openai", [{
    id: "gpt-5.2",
    displayName: "GPT-5.2 (目录)",
    provider: "openai",
    contextWindow: 128_000,
    maxInputTokens: 120_000,
    maxOutputTokens: 16_384,
    capabilities: { reasoning: true },
    reasoningEfforts: ["high", "max"]
  }]]]).listModels().find((choice) => choice.alias === "gpt-alias");
  assert.equal(catalogChoice?.maxInputTokens, 120_000);
  assert.ok((catalogChoice?.inputBudgetTokens ?? 0) < 128_000);

  const openaiSettings = providers.require("openai").createModelSettings({ ...config, defaultModel: "gpt-alias", thinking: { enabled: true, effort: "high" } }, config.models["gpt-alias"]!);
  assert.deepEqual(openaiSettings.providerOptions, { openai: { reasoningEffort: "high" } });
  const geminiSettings = providers.require("gemini").createModelSettings({ ...config, defaultModel: "gemini-pro", thinking: { enabled: true, effort: "high" } }, config.models["gemini-pro"]!);
  // 按ID 推断 [high,max] 后同名快照保证选 high 就下发 high，不再错位成 max。
  assert.deepEqual(geminiSettings.providerOptions, { google: { reasoningEffort: "high", thinkingBudget: 4_096, includeThoughts: true } });

  const liveConfig = configSchema.parse({
    ...defaultConfig,
    defaultModel: "live",
    providers: { relay: { type: "openai-compatible", baseUrl: "https://relay.example/v1", apiKey: "test-key" } },
    models: { live: { provider: "relay", model: "live-reasoning-model" } },
    thinking: { enabled: true, effort: "high" }
  });
  const liveCatalog: ConstructorParameters<typeof ModelManager>[5] = [["relay", [{
    id: "live-reasoning-model",
    displayName: "Live Reasoning Model",
    provider: "relay",
    contextWindow: 131_072,
    maxInputTokens: 120_000,
    maxOutputTokens: 16_384,
    capabilities: { tools: true, reasoning: true, streaming: true },
    reasoningEfforts: ["high", "max"]
  }]]];
  const infoStore: AgentConfigStore = {
    load: async () => structuredClone(liveConfig),
    save: async () => undefined
  };
  const manager = new ModelManager(
    "/tmp/biny-live-model-info-test",
    liveConfig,
    infoStore,
    new AiRegistry(),
    undefined,
    liveCatalog
  );
  const info = manager.getInfo();
  assert.equal(info.contextWindow, 131_072);
  assert.equal(info.maxInputTokens, manager.getContextBudget().maxInputTokens);
  assert.equal(info.thinking, "high");
  assert.equal(info.reasoningLabel, "High");
}

async function testModelSwitchRecalculatesBudget(): Promise<void> {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "large",
    providers: {
      relay: {
        type: "openai-compatible",
        baseUrl: "https://relay.example/v1",
        apiKey: "test-key"
      }
    },
    models: {
      large: { provider: "relay", model: "large-model", contextWindow: 1_000_000, maxOutputTokens: 32_768 },
      small: { provider: "relay", model: "small-model", contextWindow: 8_192, maxOutputTokens: 2_048 }
    },
    thinking: { enabled: false, effort: "high" }
  });
  let stored = structuredClone(config);
  let revision = 0;
  const configStore: AgentConfigStore = {
    load: async () => structuredClone(stored),
    save: async (next) => {
      stored = structuredClone(next);
      revision += 1;
    },
    revision: () => revision,
    loadVersioned: async () => ({ config: structuredClone(stored), revision: String(revision) }),
    saveVersioned: async (next, expectedRevision) => {
      assert.equal(expectedRevision, String(revision));
      stored = structuredClone(next);
      revision += 1;
      return { config: structuredClone(stored), revision: String(revision) };
    }
  };
  const manager = new ModelManager("/tmp/biny-model-switch-test", config, configStore);
  const largeBudget = manager.getContextBudget();
  assert.equal(largeBudget.contextWindow, 1_000_000);
  assert.ok(largeBudget.maxInputTokens > 8_192);

  await manager.switchModel("small", "off");
  const smallBudget = manager.getContextBudget();
  assert.equal(smallBudget.contextWindow, 8_192);
  assert.ok(smallBudget.maxInputTokens < largeBudget.maxInputTokens);
  assert.equal(manager.getInfo().modelAlias, "small");

  await manager.switchModel("large", "off");
  assert.equal(manager.getContextBudget().contextWindow, 1_000_000);
  const reloadedManager = new ModelManager("/tmp/biny-model-switch-test", stored, configStore);
  assert.equal(reloadedManager.getInfo().modelAlias, "large");
  assert.equal(reloadedManager.getInfo().thinking, "off");
}

async function testOpenCodeModelSwitchRepairsThinkingMetadata(): Promise<void> {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "sol",
    providers: {
      "opencode-ai": {
        type: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "test-key"
      }
    },
    models: {
      sol: {
        provider: "opencode-ai",
        model: "gpt-5.6-sol",
        capabilities: { tools: true, reasoning: true, streaming: true },
        thinkingLevelMap: { off: "none", high: "high", max: "max" }
      },
      minimax: {
        provider: "opencode-ai",
        model: "minimax-m3",
        capabilities: { tools: true, reasoning: false, streaming: true },
        thinkingLevelMap: {}
      }
    },
    thinking: { enabled: true, effort: "max" }
  });
  let stored = structuredClone(config);
  let revision = 0;
  const configStore: AgentConfigStore = {
    load: async () => structuredClone(stored),
    save: async (next) => { stored = structuredClone(next); },
    loadVersioned: async () => ({ config: structuredClone(stored), revision: String(revision) }),
    saveVersioned: async (next, expectedRevision) => {
      assert.equal(expectedRevision, String(revision));
      stored = structuredClone(next);
      revision += 1;
      return { config: structuredClone(stored), revision: String(revision) };
    }
  };
  const manager = new ModelManager("/tmp/biny-opencode-model-switch-test", config, configStore);

  await manager.switchModel("minimax", "high");
  assert.equal(manager.getInfo().modelAlias, "minimax");
  assert.equal(manager.getInfo().thinking, "high");
  assert.equal(stored.models.minimax?.capabilities?.reasoning, true);
  assert.deepEqual(stored.models.minimax?.thinkingLevelMap, {
    off: "none",
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max"
  });
}

async function testNoOffThinkingUsesDefaultEffort(): Promise<void> {
  let requestBody: Record<string, unknown> | undefined;
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "always-reasoning",
    providers: { openai: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "test-key" } },
    models: {
      "always-reasoning": {
        provider: "openai",
        model: "always-reasoning",
        contextWindow: 128_000,
        capabilities: { tools: true, reasoning: true, streaming: true },
        thinkingLevelMap: { low: "low", high: "provider-high", max: "max" }
      }
    },
    thinking: { enabled: false, effort: "max" }
  });
  const configStore: AgentConfigStore = {
    load: async () => structuredClone(config),
    save: async () => undefined
  };
  const manager = new ModelManager("/tmp/biny-no-off-thinking-test", config, configStore);
  assert.equal(manager.getInfo().thinking, "high");
  assert.equal(manager.getModelSettings().reasoning, "high");
  assert.ok((manager.getContextBudget().reasoningReserveTokens ?? 0) > 0);

  const fetcher = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]"
    ].join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const providers = new ProviderRegistry(config, [], new AiRegistry(), undefined, fetcher);
  const settings = providers.createModelSettings();
  assert.equal(settings.reasoning, "high");
  assert.deepEqual(settings.providerOptions, { openai: { reasoningEffort: "provider-high" } });
  for await (const _event of await settings.model.streamSimple?.({
    messages: [{ role: "user", content: "think" }],
    tools: []
  }, {
    reasoning: settings.reasoning,
    providerOptions: settings.providerOptions
  }) ?? []) {
    // Drain the first-prompt path so the final provider payload is captured.
  }
  assert.equal(requestBody?.reasoning_effort, "provider-high");

  await assert.rejects(
    providers.require("openai").streamSimple(config, config.models["always-reasoning"]!, {
      messages: [{ role: "user", content: "disable" }],
      tools: []
    }, { reasoning: "off" }),
    /does not support disabling thinking/u
  );

  const disabledConfig = configSchema.parse({
    ...config,
    providers: {
      openai: { ...config.providers.openai, compatibility: { supportsReasoning: false } }
    }
  });
  const disabledManager = new ModelManager("/tmp/biny-disabled-reasoning-test", disabledConfig, {
    load: async () => structuredClone(disabledConfig),
    save: async () => undefined
  });
  assert.equal(disabledManager.getInfo().thinking, "off");
  assert.equal(disabledManager.getModelSettings().reasoning, "off");
  assert.equal(disabledManager.getContextBudget().reasoningReserveTokens, 0);
  assert.deepEqual(new ModelRuntime(disabledConfig).listModels().find((choice) => choice.alias === "always-reasoning")?.efforts, []);
  const disabledProviders = new ProviderRegistry(disabledConfig, [], new AiRegistry(), undefined, fetcher);
  assert.equal(disabledProviders.createModelSettings().providerOptions, undefined);
  await assert.rejects(
    disabledProviders.require("openai").streamSimple(disabledConfig, disabledConfig.models["always-reasoning"]!, {
      messages: [{ role: "user", content: "think" }],
      tools: []
    }, { reasoning: "high" }),
    /does not support high thinking effort/u
  );
}

async function testModelSwitchDoesNotPersistInferredMetadata(): Promise<void> {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "flash",
    providers: { deepseek: { ...defaultConfig.providers.deepseek, apiKey: "test-key" } },
    models: {
      flash: { provider: "deepseek", model: "deepseek-v4-flash" },
      pro: { provider: "deepseek", model: "deepseek-v4-pro" }
    },
    thinking: { enabled: false, effort: "high" }
  });
  let stored = structuredClone(config);
  let revision = 0;
  const configStore: AgentConfigStore = {
    load: async () => structuredClone(stored),
    save: async (next) => {
      stored = structuredClone(next);
      revision += 1;
    },
    revision: () => revision,
    loadVersioned: async () => ({ config: structuredClone(stored), revision: String(revision) }),
    saveVersioned: async (next, expectedRevision) => {
      assert.equal(expectedRevision, String(revision));
      stored = structuredClone(next);
      revision += 1;
      return { config: structuredClone(stored), revision: String(revision) };
    }
  };
  const manager = new ModelManager("/tmp/biny-model-switch-metadata-test", config, configStore);

  assert.equal(manager.getContextBudget().contextWindow, 1_000_000);
  await manager.switchModel("pro", "high");
  assert.equal(stored.models.pro?.contextWindow, undefined);
  assert.equal(manager.getContextBudget().contextWindow, 1_000_000);
}

async function testPersistedProviderCatalog(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-models-store-"));
  const filePath = path.join(root, "models-store.json");
  const firstStore = new FileModelsStore(filePath);
  const secondStore = new FileModelsStore(filePath);
  const model = {
    id: "cached-model",
    displayName: "Cached Model",
    provider: "catalog",
    contextWindow: 64_000,
    maxOutputTokens: 8_000,
    maxInputTokens: 60_000,
    limits: { toolSchemaReserveTokens: 2_048, protocolSafetyMarginTokens: 1_024 },
    capabilities: { tools: true, parallelToolCalls: true, reasoning: true, reasoningStream: true, reasoningSummary: true, streaming: true },
    reasoningEfforts: ["high" as const],
    reasoningEffortsSource: "inferred" as const,
    headers: { Authorization: "Bearer secret", "x-model-feature": "safe" }
  };
  try {
    await Promise.all([
      firstStore.write("catalog", { models: [model], checkedAt: 1, etag: "first-etag" }),
      secondStore.write("other", { models: [{ ...model, id: "other-model", provider: "other" }], checkedAt: 2 })
    ]);
    const restored = await new FileModelsStore(filePath).read("catalog");
    assert.equal(restored?.models[0]?.headers?.Authorization, undefined);
    assert.equal(restored?.models[0]?.headers?.["x-model-feature"], "safe");
    assert.equal(restored?.models[0]?.maxInputTokens, 60_000);
    assert.equal(restored?.models[0]?.limits?.toolSchemaReserveTokens, 2_048);
    assert.equal(restored?.models[0]?.capabilities.reasoningSummary, true);
    assert.equal(restored?.models[0]?.reasoningEffortsSource, "inferred");
    assert.equal((await secondStore.read("other"))?.models[0]?.id, "other-model");
    const batch = await new FileModelsStore(filePath).readMany(["catalog", "other", "missing"]);
    assert.deepEqual([...batch.keys()], ["catalog", "other"]);
    if (process.platform !== "win32") assert.equal((await stat(filePath)).mode & 0o777, 0o600);

    let singleReads = 0;
    let batchReads = 0;
    const batchStore: ModelsStore = {
      read: async () => {
        singleReads += 1;
        return undefined;
      },
      readMany: async (providerIds) => {
        batchReads += 1;
        return new Map(providerIds.map((providerId) => [providerId, { models: [{ ...model, provider: providerId }] }]));
      },
      write: async () => undefined,
      delete: async () => undefined
    };
    const batchCatalogs = await restoreProviderCatalogs(["first", "second"], batchStore);
    assert.equal(batchReads, 1);
    assert.equal(singleReads, 0);
    assert.deepEqual(batchCatalogs.map(([providerId]) => providerId), ["first", "second"]);

    const config = configSchema.parse({
      ...defaultConfig,
      defaultModel: "configured-model",
      providers: {
        catalog: {
          type: "openai-compatible",
          baseUrl: "https://catalog.example/v1",
          apiKey: "test-key"
        }
      },
      models: {
        "configured-model": { provider: "catalog", model: "configured-model", contextWindow: 64_000 }
      }
    });
    const catalogs = await restoreProviderCatalogs(["catalog"], new FileModelsStore(filePath));
    const runtime = new ModelRuntime(config, catalogs, undefined, new FileModelsStore(filePath));
    const originalFetch = globalThis.fetch;
    let conditionalHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      conditionalHeaders = new Headers(init?.headers);
      return new Response(null, { status: 304, headers: { etag: "first-etag" } });
    }) as typeof fetch;
    try {
      const models = await runtime.refreshModels("catalog");
      assert.equal(models.some((entry) => entry.id === "cached-model"), true);
      assert.equal(conditionalHeaders?.get("if-none-match"), "first-etag");

      globalThis.fetch = (async () => {
        throw new Error("offline");
      }) as typeof fetch;
      await assert.rejects(runtime.refreshModels("catalog"), /offline/u);
      assert.equal(runtime.listModels().some((entry) => entry.model === "cached-model"), true);

      globalThis.fetch = (async () => Response.json({ data: [] })) as typeof fetch;
      await assert.rejects(runtime.refreshModels("catalog"), /empty model catalog/u);
      assert.equal(runtime.listModels().some((entry) => entry.model === "cached-model"), true);
      assert.deepEqual((await secondStore.read("catalog"))?.models.map((entry) => entry.id), ["cached-model"]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    await writeFile(filePath, JSON.stringify({ version: 1, providers: { catalog: { models: [model] } } }));
    assert.equal(await new FileModelsStore(filePath).read("catalog"), undefined);

    await writeFile(filePath, "{broken", "utf8");
    await firstStore.write("recovered", { models: [{ ...model, id: "recovered-model", provider: "recovered" }] });
    assert.equal((await secondStore.read("recovered"))?.models[0]?.id, "recovered-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testQueuedMessage(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-native-queued-message-"));
  await ensureAgentDirs(workspaceRoot);
  const firstRequestStarted = deferred<void>();
  const releaseFirstRequest = deferred<void>();
  const contexts: ModelStreamContext[] = [];
  const model: AgentModel = {
    provider: "test",
    modelId: "queued-model",
    stream: async (context) => {
      contexts.push(structuredClone(context));
      const request = contexts.length;
      if (request === 1) {
        firstRequestStarted.resolve();
        await releaseFirstRequest.promise;
      }
      return (async function* () {
        yield { type: "start" as const };
        yield { type: "text-delta" as const, text: request === 1 ? "first answer" : "queued answer" };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "queued-model",
    providers: { test: { type: "openai", apiKey: "test-key", baseUrl: "https://example.test/v1" } },
    models: { "queued-model": { provider: "test", model: "queued-model" } },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
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
  await agent.initialize();
  try {
    const events: AgentSessionEvent[] = [];
    const run = (async () => {
      for await (const event of agent.prompt("first question")) events.push(event);
    })();
    await firstRequestStarted.promise;
    await agent.queueMessage("queued-message", "second question");
    releaseFirstRequest.resolve();
    await run;

    assert.equal(contexts.length, 2);
    assert.deepEqual(contexts[1]?.messages.at(-1), { role: "user", content: "second question" });
    assert.equal(events.some((event) => event.type === "message.user"
      && event.messageId === "queued-message"
      && event.delivery === "queue"), true);
    assert.equal(events.find((event) => event.type === "done")?.content, "queued answer");
    await recorder.flush();
    const stored = (await readFile(recorder.filePath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; auditOnly?: boolean; content?: string; message?: { role: string; content: Array<{ type: string; text?: string }> } });
    const firstAssistantIndex = stored.findIndex((event) => event.type === "agent_message"
      && event.message?.role === "assistant"
      && event.message.content.some((part) => part.type === "text" && part.text === "first answer"));
    const queuedUserIndex = stored.findIndex((event) => event.type === "user_message" && !event.auditOnly && event.content === "second question");
    assert.ok(firstAssistantIndex >= 0);
    assert.ok(queuedUserIndex > firstAssistantIndex, "queued message must be persisted after the completed assistant turn");
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testFactoryProviderDefaults(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    if (String(input).endsWith("/responses")) {
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const relayConfig = configSchema.parse({
      ...defaultConfig,
      defaultModel: "relay-model",
      providers: { relay: { type: "openai", apiKey: "key", baseUrl: "https://relay.example/v1" } },
      models: { "relay-model": { provider: "relay", model: "relay-model", capabilities: { tools: true, reasoning: false, streaming: true }, thinkingLevelMap: { off: "none" } } },
      thinking: { enabled: false, effort: "high" }
    });
    const relay = createNativeModelSettings(relayConfig);
    for await (const _event of await relay.model.stream({ systemPrompt: "Rules", messages: [{ role: "user", content: "hi" }], tools: [] })) {
      // Drain the native stream.
    }
    assert.equal((requests[0]?.body.messages as Array<{ role?: string }>)[0]?.role, "system");

    const codexConfig = configSchema.parse({
      ...defaultConfig,
      defaultModel: "codex-model",
      providers: { codex: { type: "openai-codex", apiKey: "oauth-token", baseUrl: "https://codex.example/backend-api/codex" } },
      models: { "codex-model": { provider: "codex", model: "codex-model", capabilities: { tools: true, reasoning: false, streaming: true }, thinkingLevelMap: { off: "none" } } },
      thinking: { enabled: false, effort: "high" }
    });
    const codex = createNativeModelSettings(codexConfig);
    for await (const _event of await codex.model.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) {
      // Drain the native stream.
    }
    assert.equal(requests[1]?.url, "https://codex.example/backend-api/codex/responses");
    assert.equal(requests[1]?.body.store, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAnthropicSubscriptionAndHistory(): Promise<void> {
  let requestUrl = "";
  let requestHeaders: Headers | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "claude-subscription",
    modelId: "claude-test",
    api: "anthropic_messages",
    baseUrl: "https://example.test/anthropic/v1",
    apiKey: "oauth-token",
    anthropicAuthMode: "bearer",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const events = [];
  for await (const event of await model.stream({
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "reasoning", text: "private thought", providerMetadata: { anthropic: { signature: "sig-1" } } }] }
    ],
    tools: []
  })) events.push(event);
  assert.equal(requestUrl, "https://example.test/anthropic/v1/messages");
  assert.equal(requestHeaders?.get("authorization"), "Bearer oauth-token");
  assert.equal(requestHeaders?.get("x-api-key"), null);
  assert.ok(requestHeaders?.get("anthropic-beta")?.includes("claude-code-20250219"));
  const messages = requestBody?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(messages[1]?.content[0], { type: "thinking", thinking: "private thought", signature: "sig-1" });
  assert.equal(events.some((event) => event.type === "text-delta" && event.text === "ok"), true);
}

async function testNativeTimeout(): Promise<void> {
  let observedMetrics: ModelRequestMetrics | undefined;
  const model = createNativeModel({
    provider: "timeout-test",
    modelId: "timeout-model",
    api: "chat_completions",
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const timer = setTimeout(() => reject(new Error("request did not time out")), 1_000);
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    })
  });
  await assert.rejects(async () => {
    for await (const _event of await model.stream({ messages: [{ role: "user", content: "wait" }], tools: [] }, {
      timeoutMs: 20,
      onRequestMetrics: (metrics) => {
        observedMetrics = metrics;
      }
    })) {
      // The request must abort before yielding a response.
    }
  }, /timeout|aborted/iu);
  assert.equal(observedMetrics?.errorCode, "timeout");
  assert.equal(observedMetrics?.errorPhase, "request");
}

async function testCompatibleReasoningPayloads(): Promise<void> {
  const bodies: Record<string, unknown>[] = [];
  const response = (): Response => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const qwen = createNativeModel({
    provider: "qwen",
    modelId: "qwen-test",
    api: "chat_completions",
    reasoningProtocol: "alibaba",
    providerOptions: { alibaba: { enableThinking: true, thinkingBudget: 512 } },
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return response();
    }
  });
  for await (const _event of await qwen.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) {
    // Drain the native stream.
  }
  assert.equal(bodies[0]?.enable_thinking, true);
  assert.equal(bodies[0]?.thinking_budget, 512);

  const kimi = createNativeModel({
    provider: "kimi",
    modelId: "kimi-k2.5",
    api: "chat_completions",
    reasoningProtocol: "moonshotai",
    providerOptions: { moonshotai: { thinking: { type: "enabled" } } },
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return response();
    }
  });
  for await (const _event of await kimi.stream({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "reasoning", text: "keep this" }, { type: "text", text: "answer" }] }
    ],
    tools: []
  })) {
    // Drain the native stream.
  }
  assert.deepEqual(bodies[1]?.thinking, { type: "enabled" });
  assert.equal((bodies[1]?.messages as Array<Record<string, unknown>>)[1]?.reasoning_content, "keep this");

  const kimiK3 = createNativeModel({
    provider: "kimi",
    modelId: "kimi-k3",
    api: "chat_completions",
    reasoningProtocol: "moonshotai",
    providerOptions: { moonshotai: { reasoningEffort: "max" } },
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return response();
    }
  });
  for await (const _event of await kimiK3.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) {
    // Drain the native stream.
  }
  assert.equal(bodies[2]?.reasoning_effort, "max");
  assert.equal(bodies[2]?.thinking, undefined);

  const originalFetch = globalThis.fetch;
  let relayBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    relayBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return response();
  }) as typeof fetch;
  try {
    const relayConfig = configSchema.parse({
      ...defaultConfig,
      defaultModel: "grok",
      providers: { relay: { type: "openai-compatible", baseUrl: "https://relay.example/v1", apiKey: "test-key" } },
      models: {
        grok: {
          provider: "relay",
          model: "grok-4.5",
          capabilities: { tools: true, reasoning: true, streaming: true },
          thinkingLevelMap: { off: "none", high: "high", max: "max" }
        }
      },
      thinking: { enabled: true, effort: "high" }
    });
    const settings = new ProviderRegistry(relayConfig).createModelSettings();
    assert.deepEqual(settings.providerOptions, { openai: { reasoningEffort: "high" } });
    for await (const _event of await settings.model.stream({ messages: [{ role: "user", content: "think" }], tools: [] })) {
      // Drain the transport so the final Chat Completions request body is captured.
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(relayBody?.reasoning_effort, "high");
}

async function testCompatibleEmptyAssistantHistory(): Promise<void> {
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "deepseek",
    modelId: "deepseek-test",
    api: "chat_completions",
    reasoningProtocol: "deepseek",
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  for await (const _event of await model.stream({
    messages: [
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "reasoning", text: "orphan reasoning" }] },
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "value" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "lookup", content: [{ type: "text", text: "result" }] }
    ],
    tools: []
  })) {
    // Drain the response so the request path is fully exercised.
  }
  const messages = requestBody?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.equal(messages[1]?.content, undefined);
  assert.deepEqual(messages[1]?.tool_calls, [{
    id: "call-1",
    type: "function",
    function: { name: "lookup", arguments: JSON.stringify({ query: "value" }) }
  }]);
}

async function testAnthropicSkipsEmptyAssistantHistory(): Promise<void> {
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "anthropic",
    modelId: "claude-test",
    api: "anthropic_messages",
    baseUrl: "https://example.test/anthropic",
    apiKey: "token",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  for await (const _event of await model.stream({
    messages: [
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "reasoning", text: "orphan reasoning" }] },
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "value" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "lookup", content: [{ type: "text", text: "result" }] }
    ],
    tools: []
  })) {
    // Drain the transport so the request body is captured.
  }
  const messages = requestBody?.messages as Array<Record<string, unknown>>;
  // 与 OpenAI 路径对齐：无签名 reasoning-only 与空 assistant 都必须跳过，否则 Anthropic 对空 content 返回 400。
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(messages[1]?.content, [{ type: "tool_use", id: "call-1", name: "lookup", input: { query: "value" } }]);
  assert.deepEqual(messages[2]?.content, [{ type: "tool_result", tool_use_id: "call-1", content: "result", is_error: false }]);
}

async function testGoogleSkipsEmptyAssistantHistory(): Promise<void> {
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "google-native",
    modelId: "gemini-test",
    api: "google_generative_ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "google-key",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  });
  for await (const _event of await model.stream({
    messages: [
      { role: "user", content: "continue" },
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "value" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "lookup", content: [{ type: "text", text: "result" }] }
    ],
    tools: []
  })) {
    // Drain the transport so the request body is captured.
  }
  const contents = requestBody?.contents as Array<Record<string, unknown>>;
  // 与 OpenAI 路径对齐：空 assistant 必须跳过，否则 Gemini 对空 parts 返回 400。
  assert.deepEqual(contents.map((message) => message.role), ["user", "model", "user"]);
  assert.deepEqual(contents[1]?.parts, [{ functionCall: { id: "call-1", name: "lookup", args: { query: "value" } } }]);
}

async function testChatParamsApplyToFirstModelRequest(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-chat-params-first-"));
  await ensureAgentDirs(workspaceRoot);
  const observedOptions: Array<ModelStreamOptions | undefined> = [];
  const model: AgentModel = {
    provider: "test",
    modelId: "chat-params-model",
    stream: async (_context, options) => {
      observedOptions.push(options === undefined ? undefined : { ...options });
      return (async function* () {
        yield { type: "start" as const };
        yield { type: "text-delta" as const, text: "ok" };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "chat-params-model",
    providers: { test: { type: "openai", apiKey: "test-key", baseUrl: "https://example.test/v1" } },
    models: { "chat-params-model": { provider: "test", model: "chat-params-model" } },
    chat: { temperature: 0.3, maxOutputTokens: 2_048 },
    context: {
      ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
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
  await agent.initialize();
  try {
    for await (const _event of agent.prompt("hi")) {
      // Drain the turn so the first model request is issued.
    }
    // 回归：全局聊天采样参数必须覆盖每回合第 1 个请求；此前只在 prepareNextTurn（第 2 步起）生效。
    assert.equal(observedOptions.length, 1);
    assert.equal(observedOptions[0]?.temperature, 0.3);
    assert.equal(observedOptions[0]?.maxOutputTokens, 2_048);
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testCompatibleSystemRole(): Promise<void> {
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "openai-compatible",
    modelId: "compat-model",
    api: "chat_completions",
    baseUrl: "https://example.test/v1",
    apiKey: "token",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  for await (const _event of await model.stream({ systemPrompt: "Follow the rules.", messages: [{ role: "user", content: "hi" }], tools: [] })) {
    // Drain the native stream.
  }
  const messages = requestBody?.messages as Array<{ role?: string }> | undefined;
  assert.equal(messages?.[0]?.role, "system");
}

async function testKimiPromptCacheKey(): Promise<void> {
  const keys: string[] = [];
  const model = createNativeModel({
    provider: "openai-compatible",
    providerAlias: "kimi",
    modelId: "kimi-k2",
    api: "chat_completions",
    baseUrl: "https://example.test/v1",
    apiKey: "token",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      keys.push(String(body.prompt_cache_key ?? ""));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  for (const sessionId of ["session-1", "session-1", "session-2"]) {
    for await (const _event of await model.stream({
      systemPrompt: "Stable system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    }, { requestContext: { sessionId } })) {
      // Drain the response so the adapter records the request normally.
    }
  }
  assert.equal(keys[0], "session-1");
  assert.equal(keys[1], keys[0]);
  assert.equal(keys[2], "session-2");
}

async function testOpenAiPromptCacheKey(): Promise<void> {
  let officialKey: unknown;
  const response = (): Response => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const official = createNativeModel({
    provider: "openai",
    modelId: "gpt-5",
    api: "chat_completions",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "token",
    fetch: async (_input, init) => {
      officialKey = (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>).prompt_cache_key;
      return response();
    }
  });
  for await (const _event of await official.stream({ messages: [{ role: "user", content: "hello" }], tools: [] }, { requestContext: { sessionId: "openai-session" } })) {
    // Drain the response.
  }
  assert.equal(officialKey, "openai-session");

  let relayBody: Record<string, unknown> | undefined;
  const relay = createNativeModel({
    provider: "openai-compatible",
    providerAlias: "relay",
    modelId: "gpt-5",
    api: "chat_completions",
    baseUrl: "https://relay.example/v1",
    fetch: async (_input, init) => {
      relayBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return response();
    }
  });
  for await (const _event of await relay.stream({ messages: [{ role: "user", content: "hello" }], tools: [] }, { requestContext: { sessionId: "relay-session" } })) {
    // Unknown compatible services must not receive provider-specific cache parameters.
  }
  assert.equal(relayBody?.prompt_cache_key, undefined);
}

async function testOpenAiResponsesTransport(): Promise<void> {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "openai-codex",
    modelId: "gpt-test",
    api: "responses",
    baseUrl: "https://example.test/backend-api/codex",
    apiKey: "token",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const body = [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"lookup"}}\n\n',
        'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"item-1","arguments":"{\\"query\\":\\"value\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"lookup","arguments":"{\\"query\\":\\"value\\"}"}}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"brief reasoning"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"responses ok"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n'
      ].join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  const events = [];
  for await (const event of await model.stream({
    systemPrompt: "Follow the rules.",
    messages: [{ role: "user", content: "hello" }],
    tools: []
  }, { maxOutputTokens: 8_000 })) events.push(event);
  assert.equal(requestUrl, "https://example.test/backend-api/codex/responses");
  assert.equal(requestBody?.store, false);
  assert.equal(requestBody?.max_output_tokens, undefined);
  assert.deepEqual(requestBody?.input, [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  assert.equal(events.some((event) => event.type === "text-delta" && event.text === "responses ok"), true);
  assert.deepEqual(events.find((event) => event.type === "reasoning-delta")?.providerMetadata, { openai: { summary: true } });
  assert.deepEqual(events.filter((event) => event.type === "tool-call"), [{
    type: "tool-call",
    id: "call-1",
    name: "lookup",
    arguments: { query: "value" },
    invalid: false
  }]);
  assert.deepEqual(events.find((event) => event.type === "finish"), {
    type: "finish",
    reason: "stop",
    usage: {
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      reasoningTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      cacheMissTokens: undefined
    }
  });

  let officialRequestBody: Record<string, unknown> | undefined;
  const officialModel = createNativeModel({
    provider: "openai",
    modelId: "gpt-test",
    api: "responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "token",
    fetch: async (_input, init) => {
      officialRequestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
  });
  for await (const _event of await officialModel.stream(
    { messages: [{ role: "user", content: "hello" }], tools: [] },
    { maxOutputTokens: 1_024 }
  )) {
    // 保证官方 Responses 的输出上限契约仍然被保留。
  }
  assert.equal(officialRequestBody?.max_output_tokens, 1_024);
}

async function testStreamingProtocolsRequireTerminalEvents(): Promise<void> {
  const cases: AgentModel[] = [
    createNativeModel({
      provider: "openai-compatible",
      modelId: "truncated-chat",
      api: "chat_completions",
      baseUrl: "https://example.test/v1",
      fetch: async () => new Response(
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    }),
    createNativeModel({
      provider: "openai-codex",
      modelId: "truncated-responses",
      api: "responses",
      baseUrl: "https://example.test/v1",
      fetch: async () => new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    }),
    createNativeModel({
      provider: "anthropic",
      modelId: "truncated-anthropic",
      api: "anthropic_messages",
      baseUrl: "https://example.test",
      fetch: async () => new Response(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    }),
    createNativeModel({
      provider: "google-native",
      modelId: "truncated-google",
      api: "google_generative_ai",
      baseUrl: "https://example.test/v1beta",
      fetch: async () => new Response(
        'data: {"usageMetadata":{"promptTokenCount":1,"totalTokenCount":1}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    })
  ];
  for (const model of cases) {
    await assert.rejects(async () => {
      for await (const _event of await model.stream({ messages: [{ role: "user", content: "hello" }], tools: [] })) {
        // Drain until the adapter detects the missing protocol terminator.
      }
    }, /stream ended/iu);
  }
}

async function testOpenAiToolCallsRequireFunctionNames(): Promise<void> {
  const model = createNativeModel({
    provider: "openai-compatible",
    modelId: "missing-tool-name",
    api: "chat_completions",
    baseUrl: "https://example.test/v1",
    fetch: async () => new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"arguments":"{}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]"
    ].join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
  });

  await assert.rejects(async () => {
    for await (const _event of await model.stream({
      messages: [{ role: "user", content: "call a tool" }],
      tools: [{
        name: "known",
        description: "Known tool",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: [{ type: "text", text: "ok" }] })
      }]
    })) {
      // Drain until the adapter rejects the malformed tool call.
    }
  }, /without a function name/iu);
}

async function testAudioPayloads(): Promise<void> {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const openAi = createNativeModel({
    provider: "openai-compatible",
    modelId: "audio-test",
    api: "chat_completions",
    baseUrl: "https://example.test/v1",
    fetch: fetcher
  });
  for await (const _event of await openAi.stream({
    messages: [{ role: "user", content: [{ type: "text", text: "transcribe" }, { type: "audio", data: "bXAz", mimeType: "audio/mpeg" }] }],
    tools: []
  })) {
    // Drain the native stream.
  }
  const messages = bodies[0]?.messages as Array<{ content?: unknown[] }>;
  assert.deepEqual(messages[0]?.content?.[1], { type: "input_audio", input_audio: { data: "bXAz", format: "mp3" } });

  const anthropic = createNativeModel({
    provider: "anthropic",
    modelId: "audio-test",
    api: "anthropic_messages",
    baseUrl: "https://example.test/v1",
    fetch: fetcher
  });
  await assert.rejects(async () => {
    for await (const _event of await anthropic.stream({
      messages: [{ role: "user", content: [{ type: "audio", data: "bXAz", mimeType: "audio/mpeg" }] }],
      tools: []
    })) {
      // Transport must reject before sending a malformed request.
    }
  }, /does not support audio input/u);
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T | PromiseLike<T>): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value as T | PromiseLike<T>) };
}

await main();
console.log("native agent tests passed");
