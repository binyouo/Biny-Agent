/** Cancellation must reach memory models without accepting late results or counting cancelled hits. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { executeCodeModeCell } from "../src/agent/codeMode.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, AgentTool, ModelStreamEvent } from "../src/agent/core/types.js";
import { HybridMemoryRetriever, type HybridMemoryRetrieverOptions } from "../src/agent/context/HybridMemoryRetriever.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "../src/agent/context/memoryTypes.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { createMemoryTools } from "../src/extensions/memory.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { ProviderEmbeddingRuntime } from "../src/llm/embedding/ProviderEmbeddingRuntime.js";
import type { EmbeddingModelRuntime, EmbeddingResult } from "../src/llm/embedding/types.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const entry: MemoryEntry = {
  id: "fixture", content: "The release checklist uses the test fixture.", tags: ["release"], threadId: "thread-a",
  source: "manual", importance: 0.5, durability: "permanent", revision: 1, accessCount: 0,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z"
};
const result: MemorySearchResult = { matches: [], storeRevision: 1, report: { omitted: [] } };
const embedding: EmbeddingResult = {
  embeddings: [new Float32Array([1, 0])], dimensions: 2, fingerprint: "fixture-model",
  model: { kind: "local", model: "multilingual-e5-small" }
};

await testToolBoundary();
await testRetrieverBoundaries();
await testRewriteCancellation();
await testRewriteTimeoutFallback();
await testEmbeddingCancellation();
await testSessionModelPropagation();
await testSdkCleanupQuarantine();
await testSdkCleanupSessionQuarantine();
console.log("memory cancellation tests passed");

async function testToolBoundary(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-tool-cancellation-"));
  const memory = new LocalMemory(root, () => { throw new Error("No model calls expected"); });
  let lookups = 0;
  const calls: Array<{ query: string; paths: string[]; options: MemorySearchOptions }> = [];
  let search: () => Promise<MemorySearchResult> = async () => result;
  try {
    const tool = createMemoryTools(() => { lookups++; return memory; }, async (query, paths, options) => {
      calls.push({ query, paths, options });
      return await search();
    })[1]!;
    const execution = await tool.resolveExecution({ query: " release ", tags: ["release"], threadId: "thread-a" });
    assert.ok(!("isError" in execution));
    const controller = new AbortController();
    assert.equal(await execution.execute({ toolCallId: "direct", operationId: "direct", signal: controller.signal }), result);
    assert.deepEqual(calls[0], { query: "release", paths: [], options: {
      tags: ["release"], threadId: "thread-a", limit: 5, threshold: 0.3, signal: controller.signal
    } });
    assert.equal(await execution.execute({ toolCallId: "direct-unsignalled", operationId: "direct-unsignalled" }), result);
    assert.equal(calls[1]?.options.signal, undefined, "direct calls without a signal remain supported");
    const reason = new Error("cancelled before recall");
    controller.abort(reason);
    const previousLookups = lookups;
    await assert.rejects(execution.execute({ toolCallId: "pre-cancelled", operationId: "pre-cancelled", signal: controller.signal }),
      (error: unknown) => error === reason);
    assert.equal(lookups, previousLookups);
    assert.equal(calls.length, 2);

    const lateController = new AbortController();
    const lateReason = new Error("cancelled during recall");
    const held = deferred<MemorySearchResult>();
    search = () => held.promise;
    const late = execution.execute({ toolCallId: "late", operationId: "late", signal: lateController.signal });
    lateController.abort(lateReason);
    held.resolve(result);
    await assert.rejects(late, (error: unknown) => error === lateReason);
  } finally { memory.close(); await rm(root, { recursive: true, force: true }); }
}

async function testRetrieverBoundaries(): Promise<void> {
  // Cancellation during a non-cancellable snapshot read must win even on empty/limit-zero fast paths.
  for (const empty of [true, false]) {
    const controller = new AbortController();
    const reason = new Error("cancelled after snapshot read");
    const fixture = createFixture({ localMemory: {
      listMemoryEntries: async ({ signal } = {}) => {
        assert.equal(signal, controller.signal);
        controller.abort(reason);
        return { entries: empty ? [] : [entry], total: empty ? 0 : 1, storeRevision: 1 };
      },
      recordRecallUsage: async () => { throw new Error("Usage must not start"); }
    } });
    await assert.rejects(fixture.retriever.retrieve("release", [], { limit: empty ? 1 : 0, signal: controller.signal }),
      (error: unknown) => error === reason);
    assert.equal(fixture.embedCalls.length, 0);
  }
  // A cancelled runtime lookup is not an ordinary unavailable-model degradation.
  {
    const controller = new AbortController();
    const reason = new Error("cancelled during runtime lookup");
    const fixture = createFixture({ getEmbeddingRuntime: async () => { controller.abort(reason); return undefined; } });
    await assert.rejects(fixture.retriever.retrieve("release", [], { limit: 1, signal: controller.signal }),
      (error: unknown) => error === reason);
    assert.equal(fixture.usage.length, 0);
  }
  // A cancellation triggered by scope filtering cannot start the usage mutation.
  {
    const controller = new AbortController();
    const reason = new Error("cancelled before usage write");
    const fixture = createFixture({ allowEntry: () => { controller.abort(reason); return true; } });
    await assert.rejects(fixture.retriever.retrieve("release", [], { limit: 1, signal: controller.signal }),
      (error: unknown) => error === reason);
    assert.equal(fixture.usage.length, 0);
  }
  // An already-started usage write may have committed; cancellation cannot manufacture a success result or rollback.
  {
    const controller = new AbortController();
    const reason = new Error("cancelled after usage write");
    const fixture = createFixture({ localMemory: {
      listMemoryEntries: async () => ({ entries: [entry], total: 1, storeRevision: 1 }),
      recordRecallUsage: async (_ids, { signal } = {}) => {
        assert.equal(signal, controller.signal);
        controller.abort(reason);
      }
    } });
    await assert.rejects(fixture.retriever.retrieve("release", [], { limit: 1, signal: controller.signal }),
      (error: unknown) => error === reason);
  }
  // Normal search contracts and optional rewrite-error fallback remain intact.
  const fixture = createFixture({ rewriteQuery: async () => { throw new Error("Optional rewrite unavailable"); } });
  const recalled = await fixture.retriever.retrieve("release", [], { limit: 1, tags: ["release"], threadId: "thread-a" });
  assert.deepEqual(recalled.matches.map(({ entry }) => entry.id), ["fixture"]);
  assert.equal(recalled.report.degraded, undefined);
  assert.equal(recalled.originalQuery, "release");
  assert.equal(fixture.embedCalls[0]?.texts[0], "release");
  assert.deepEqual(fixture.usage, [["fixture"]]);
}

async function testRewriteCancellation(): Promise<void> {
  for (const synchronous of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("cancelled during rewrite");
    const started = deferred<AbortSignal>();
    const held = deferred<string>();
    const fixture = createFixture({ rewriteQuery: (_query, signal) => {
      assert.ok(signal);
      started.resolve(signal);
      if (synchronous) controller.abort(reason);
      return held.promise;
    } });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = fixture.retriever.retrieve("release", [], { limit: 1, signal: controller.signal });
      let settled = false;
      const rejected = assert.rejects(pending, (error: unknown) => error === reason).finally(() => { settled = true; });
      const rewriteSignal = await bounded(started.promise);
      if (!synchronous) controller.abort(reason);
      assert.equal(rewriteSignal.aborted, true);
      assert.equal(rewriteSignal.reason, reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "an ignored rewrite abort keeps recall pending until the model settles");
      assert.equal(fixture.embedCalls.length, 0);
      assert.equal(fixture.usage.length, 0);
      // A late failure is observed; the original cancellation still wins and cannot start embedding.
      held.reject(new Error("late rewrite failure"));
      await bounded(rejected);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(fixture.embedCalls.length, 0);
    } finally { controller.abort(reason); held.resolve("late rewrite"); process.removeListener("unhandledRejection", onUnhandled); }
  }
}

async function testEmbeddingCancellation(): Promise<void> {
  for (const outcome of ["cooperative", "late-success", "late-failure"] as const) {
    const controller = new AbortController();
    const reason = new Error("cancelled during embedding");
    const started = deferred<AbortSignal>();
    const held = deferred<EmbeddingResult>();
    const fixture = createFixture();
    fixture.runtime.embed = async ({ signal }) => {
      assert.equal(signal, controller.signal);
      assert.ok(signal);
      started.resolve(signal);
      return outcome === "cooperative" ? await rejectedOnAbort(signal) : await held.promise;
    };
    let settled = false;
    const pending = fixture.retriever.retrieve("release", [], { limit: 1, signal: controller.signal });
    const rejected = assert.rejects(pending, (error: unknown) => error === reason).finally(() => { settled = true; });
    try {
      await bounded(started.promise);
      controller.abort(reason);
      if (outcome !== "cooperative") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "local inference that ignores cancellation remains in flight until it settles");
        if (outcome === "late-success") held.resolve(embedding);
        else held.reject(new Error("late embedding failure"));
      }
      await bounded(rejected);
      assert.equal(fixture.searches.length, 0);
      assert.equal(fixture.usage.length, 0);
    } finally { controller.abort(reason); held.resolve(embedding); }
  }
}

async function testRewriteTimeoutFallback(): Promise<void> {
  const held = deferred<string>();
  const started = deferred<AbortSignal>();
  const fixture = createFixture({ rewriteQuery: (_query, signal) => {
    assert.ok(signal);
    started.resolve(signal);
    return held.promise;
  } });
  let settled = false;
  const pending = fixture.retriever.retrieve("release", [], { limit: 1 }).finally(() => { settled = true; });
  try {
    const rewriteSignal = await bounded(started.promise);
    await bounded(rejectedOnAbort(rewriteSignal).catch((error: unknown) => {
      assert.ok(error instanceof DOMException && error.name === "TimeoutError");
    }));
    assert.equal(settled, false, "rewrite timeout cannot detach an uncooperative model");
    assert.equal(fixture.embedCalls.length, 0, "embedding must not overlap the timed-out rewrite");
    held.resolve("late rewritten terms");
    const recalled = await bounded(pending);
    assert.equal(recalled.rewrittenQuery, "release");
    assert.equal(fixture.embedCalls[0]?.texts[0], "release", "settled timeout retains the original-query fallback");
    assert.deepEqual(fixture.usage, [["fixture"]]);
  } finally { held.resolve("late rewrite"); await pending; }
}

async function testSessionModelPropagation(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-session-cancellation-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  const agentRoot = path.join(root, "agent");
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  let stage: "rewrite" | "uncooperative-rewrite" | "embed" | "success" = "rewrite";
  let started = deferred<AbortSignal>();
  let rewriteHeld = deferred<void>();
  let fetchCalls = 0;
  const model: AgentModel = {
    provider: "fixture", modelId: "fixture-rewrite",
    stream: async (context, options) => {
      assert.ok(options?.signal);
      assert.equal("awaitModelSettlementOnAbort" in options, false, "helper-only options must not leak into model.stream");
      const rewriting = context.systemPrompt?.includes("Rewrite the user's message") === true;
      if (rewriting && stage === "rewrite") { started.resolve(options.signal); await rejectedOnAbort(options.signal); }
      if (rewriting && stage === "uncooperative-rewrite") { started.resolve(options.signal); await rewriteHeld.promise; }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: "release checklist" };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  // Exercise the real provider wire with a fake fetcher. No external API or credentials are used.
  const runtime = new ProviderEmbeddingRuntime("fixture", { type: "openai-compatible", baseUrl: "https://fixture.invalid/v1" }, {
    type: "fixture", protocol: "openai-compatible", requiresApiKey: false, authModes: ["api-key"],
    embedding: { wire: "openai-compatible", models: [{ id: "fixture-embedding", displayName: "fixture", dimensions: 2, recommendedThreshold: 0.3 }] }
  }, "fixture-embedding", { fetcher: async (_input, init) => {
    fetchCalls++;
    assert.ok(init?.signal);
    if (stage === "embed") { started.resolve(init.signal); await rejectedOnAbort(init.signal); }
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  } });
  const config = structuredClone(defaultConfig);
  config.context.memory.queryRewrite = true;
  config.context.memory.enabled = true;
  config.context.memory.useMemories = true;
  config.context.memory.generateMemories = false;
  const recorder = new SessionRecorder(workspace);
  const agent = new AgentSession({ workspaceRoot: workspace, config, model, recorder,
    toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission) });
  const storage = new MemoryStorage(agentRoot, { agentDir: agentRoot });
  try {
    await agent.initialize();
    const stored = (await storage.writeEntry({ content: entry.content, tags: entry.tags, threadId: entry.threadId })).entry!;
    const index = new MemoryVectorIndex(agentRoot);
    try { index.replaceAll(runtime.fingerprint, 2, [{ entryId: stored.id, revision: stored.revision, embedding: [1, 0] }]); }
    finally { index.close(); }
    // Substitute only runtime selection, retaining Session's rewrite, retriever and real SQLite path.
    const service = (agent as unknown as { memoryEmbeddingService: { embeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined> } }).memoryEmbeddingService;
    service.embeddingRuntime = async () => runtime;
    const recall = createMemoryTools(() => agent.getLocalMemory(), agent.searchMemory.bind(agent))[1]!;
    const execution = await recall.resolveExecution({ query: "release", tags: ["release"], threadId: "thread-a" });
    assert.ok(!("isError" in execution));
    for (const cancelledStage of ["rewrite", "embed"] as const) {
      stage = cancelledStage;
      started = deferred<AbortSignal>();
      const controller = new AbortController();
      const reason = new Error(`cancelled in real ${stage} path`);
      const pending = execution.execute({ toolCallId: stage, operationId: stage, signal: controller.signal });
      const rejected = assert.rejects(pending, (error: unknown) => error === reason);
      try {
        const modelSignal = await bounded(started.promise);
        controller.abort(reason);
        await bounded(rejected);
        assert.equal(modelSignal.aborted, true);
        assert.equal(modelSignal.reason, reason);
        assert.equal((await storage.getEntry(stored.id))?.accessCount, 0);
        assert.equal((await storage.getEntry(stored.id))?.content, entry.content);
        assert.equal(fetchCalls, cancelledStage === "rewrite" ? 0 : 1);
      } finally { controller.abort(reason); }
    }
    stage = "uncooperative-rewrite";
    started = deferred<AbortSignal>();
    const controller = new AbortController();
    const reason = new Error("cancelled Code Mode recall");
    const recallAgentTool: AgentTool = {
      name: recall.name, description: recall.description, parameters: recall.parameters,
      execute: async (toolCallId, args, signal) => {
        const execution = await recall.resolveExecution(args);
        assert.ok(!("isError" in execution));
        return { content: [], details: await execution.execute({ toolCallId, operationId: toolCallId, signal }) };
      }
    };
    let unsettled: readonly { toolCallId: string; settlement: Promise<unknown> }[] = [];
    const cell = executeCodeModeCell({
      code: "return await tools.recall_memory({query: 'release'});", parentToolCallId: "memory-cell",
      tools: [recallAgentTool], signal: controller.signal, isCurrent: () => true,
      onUnsettled: (operations) => { unsettled = operations; }
    });
    try {
      const rewriteSignal = await bounded(started.promise);
      controller.abort(reason);
      const cancelled = await bounded(cell);
      assert.equal(rewriteSignal.aborted, true);
      assert.equal(cancelled.outcomeUnknown, true, "an ignored model abort must reach the existing Code Mode quarantine boundary");
      assert.deepEqual(unsettled.map(({ toolCallId }) => toolCallId), ["memory-cell:nested:1"]);
      assert.equal(fetchCalls, 1);
      assert.equal((await storage.getEntry(stored.id))?.accessCount, 0);
      const rejected = assert.rejects(unsettled[0]!.settlement, (error: unknown) => error === reason);
      rewriteHeld.resolve();
      await bounded(rejected);
      assert.equal(fetchCalls, 1, "late rewrite settlement cannot launch embedding");
      assert.equal((await storage.getEntry(stored.id))?.accessCount, 0);
    } finally { controller.abort(reason); rewriteHeld.resolve(); await cell; }
    // Automatic recall is prompt preparation, so an ignored rewrite cannot newly block turn stop.
    started = deferred<AbortSignal>();
    rewriteHeld = deferred<void>();
    const turnController = new AbortController();
    const turn = agent.runTask("What is the release checklist?", { abortSignal: turnController.signal, emotionAnalysis: false });
    try {
      await bounded(started.promise);
      turnController.abort(new Error("cancelled automatic recall"));
      const outcome = await bounded(turn);
      assert.equal(outcome.status, "cancelled");
      assert.equal(fetchCalls, 1);
      assert.equal((await storage.getEntry(stored.id))?.accessCount, 0);
    } finally { turnController.abort(); rewriteHeld.resolve(); await turn; }
    stage = "success";
    const recalled = await execution.execute({ toolCallId: "direct-success", operationId: "direct-success" }) as MemorySearchResult;
    assert.deepEqual(recalled.matches.map(({ entry }) => entry.id), [stored.id]);
    assert.equal(recalled.rewrittenQuery, "release checklist");
    assert.equal((await storage.getEntry(stored.id))?.accessCount, 1);
    const reopened = MemoryVectorIndex.openReadOnly(agentRoot)!;
    try { assert.equal(reopened.status().active?.vectorCount, 1); }
    finally { reopened.close(); }
  } finally {
    rewriteHeld.resolve();
    await agent.close(); storage.close();
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function testSdkCleanupQuarantine(): Promise<void> {
  const started = deferred<void>();
  const cancelStarted = deferred<void>();
  const cleanupHeld = deferred<void>();
  let source: ReadableStream<LanguageModelV4StreamPart> | undefined;
  let cancelled = false;
  let lateChunks = 0;
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "late-chunk-cleanup", supportedUrls: {},
    doGenerate: async () => { throw new Error("Only streaming is allowed"); },
    doStream: async ({ abortSignal }) => {
      assert.ok(abortSignal);
      source = new ReadableStream<LanguageModelV4StreamPart>({
        start(wire) {
          // The provider delivers a late chunk before our abort handler can cancel the source.
          abortSignal.addEventListener("abort", () => {
            wire.enqueue({ type: "text-start", id: "late" });
            lateChunks++;
          }, { once: true });
          started.resolve();
        },
        async cancel() { cancelStarted.resolve(); await cleanupHeld.promise; cancelled = true; }
      });
      return { stream: source };
    }
  };
  const fixture = createFixture({ rewriteQuery: async (query, signal, options) => {
    const result = await generateNativeText({ provider: "fixture", modelId: provider.modelId, vercelModel: provider },
      [{ role: "user", content: query }], { signal, awaitModelSettlementOnAbort: options?.awaitModelSettlementOnAbort });
    return result.text;
  } });
  let wrapperSettled = false;
  const recall: AgentTool = {
    name: "recall_memory", description: "Fixture memory recall",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (_id, _args, signal) => {
      try { return { content: [], details: await fixture.retriever.retrieve("release", [], { limit: 1, signal }) }; }
      finally { wrapperSettled = true; }
    }
  };
  const controller = new AbortController();
  const reason = new Error("stop SDK memory recall");
  let unsettled: readonly { toolCallId: string; settlement: Promise<unknown> }[] = [];
  const cell = executeCodeModeCell({
    code: "return await tools.recall_memory({query: 'release'});", parentToolCallId: "sdk-memory-cell",
    tools: [recall], signal: controller.signal, isCurrent: () => true,
    onUnsettled: (operations) => { unsettled = operations; }
  });
  try {
    await bounded(started.promise);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await bounded(cancelStarted.promise);
    const result = await bounded(cell);
    assert.equal(lateChunks, 1);
    assert.equal(result.outcomeUnknown, true, "SDK synthetic completion cannot hide pending provider cleanup from Code Mode");
    assert.equal(wrapperSettled, false);
    assert.equal(cancelled, false);
    assert.equal(source?.locked, true);
    assert.deepEqual(unsettled.map(({ toolCallId }) => toolCallId), ["sdk-memory-cell:nested:1"]);
    assert.equal(fixture.embedCalls.length, 0);
    assert.deepEqual(fixture.usage, []);
    const rejected = assert.rejects(unsettled[0]!.settlement, (error: unknown) => error === reason);
    cleanupHeld.resolve();
    await bounded(rejected);
    assert.equal(wrapperSettled, true);
    assert.equal(cancelled, true);
    assert.equal(source?.locked, false);
    assert.equal(fixture.embedCalls.length, 0);
    assert.deepEqual(fixture.usage, []);
  } finally { controller.abort(reason); cleanupHeld.resolve(); await cell; }
}

async function testSdkCleanupSessionQuarantine(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-sdk-session-quarantine-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  const started = deferred<void>();
  const cleanupHeld = deferred<void>();
  const wrapperDone = deferred<void>();
  let providerCalls = 0;
  let cleanupFinished = false;
  let lateChunks = 0;
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "session-cleanup", supportedUrls: {},
    doGenerate: async () => { throw new Error("Only streaming is allowed"); },
    doStream: async ({ abortSignal }) => {
      assert.ok(abortSignal);
      providerCalls++;
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(wire) {
          abortSignal.addEventListener("abort", () => {
            wire.enqueue({ type: "text-start", id: "late" });
            lateChunks++;
          }, { once: true });
          started.resolve();
        },
        async cancel() { await cleanupHeld.promise; cleanupFinished = true; }
      }) };
    }
  };
  const fixture = createFixture({ rewriteQuery: async (query, signal, options) => {
    const rewritten = await generateNativeText({ provider: "fixture", modelId: provider.modelId, vercelModel: provider },
      [{ role: "user", content: query }], { signal, awaitModelSettlementOnAbort: options?.awaitModelSettlementOnAbort });
    return rewritten.text;
  } });
  const localMemory = new LocalMemory(workspace, () => { throw new Error("No real model calls allowed"); });
  const registry = new ToolRegistry();
  const recall = createMemoryTools(() => localMemory, async (query, paths, options) => {
    try { return await fixture.retriever.retrieve(query, paths, { ...options, limit: options.limit ?? 5 }); }
    finally { wrapperDone.resolve(); }
  })[1]!;
  registry.registerBuiltinTool(recall);
  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "code_mode";
  config.permission.mode = "full-access";
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  let execSteps = 0;
  const mainModel: AgentModel = {
    provider: "fixture", modelId: "main", supportsTools: true,
    stream: async (context) => {
      const hasExec = context.tools.some(({ name }) => name === "exec");
      if (hasExec) execSteps++;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (hasExec && execSteps === 1) {
          yield { type: "tool-call", id: "sdk-session-exec", name: "exec", arguments: {
            code: "return await tools.recall_memory({query: 'release'});"
          } };
          yield { type: "finish", reason: "tool-calls" };
        } else { yield { type: "text-delta", text: "ready" }; yield { type: "finish", reason: "stop" }; }
      })();
    }
  };
  const agent = new AgentSession({ workspaceRoot: workspace, config, model: mainModel,
    toolRegistry: registry, permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(workspace) });
  const controller = new AbortController();
  try {
    await agent.initialize();
    const first = agent.runTask("Recall release", { emotionAnalysis: false, abortSignal: controller.signal });
    await bounded(started.promise);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("stop while SDK cleanup is gated"));
    assert.equal((await bounded(first)).status, "cancelled");
    assert.equal(lateChunks, 1);
    assert.equal(cleanupFinished, false);
    const blocked = await bounded(agent.runTask("Second request", { emotionAnalysis: false }));
    assert.equal(blocked.status, "failed");
    assert.match(blocked.error ?? "", /quarantined/u);
    assert.equal(providerCalls, 1, "the second run cannot replay or overlap the unsettled SDK memory call");
    assert.equal(fixture.embedCalls.length, 0);
    assert.deepEqual(fixture.usage, []);
    const quarantined = (agent as unknown as { lingeringExternalTools: ReadonlyMap<Promise<unknown>, unknown> }).lingeringExternalTools;
    assert.ok(quarantined.size > 0);
    const settlements = [...quarantined.keys()];
    cleanupHeld.resolve();
    await bounded(wrapperDone.promise);
    await bounded(Promise.allSettled(settlements));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(quarantined.size, 0);
    assert.equal(cleanupFinished, true);
    assert.equal((await bounded(agent.runTask("Third request", { emotionAnalysis: false }))).status, "completed");
    assert.equal(providerCalls, 1, "clearing quarantine does not replay the prior cell");
    assert.equal(fixture.embedCalls.length, 0);
    assert.deepEqual(fixture.usage, []);
  } finally {
    controller.abort(); cleanupHeld.resolve();
    await agent.close(); localMemory.close();
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function createFixture(overrides: Partial<HybridMemoryRetrieverOptions> = {}) {
  const usage: string[][] = [];
  const embedCalls: Array<{ texts: readonly string[]; signal?: AbortSignal }> = [];
  const searches: ArrayLike<number>[] = [];
  const runtime: EmbeddingModelRuntime = {
    fingerprint: embedding.fingerprint,
    descriptor: { ref: embedding.model, fingerprint: embedding.fingerprint, displayName: "fixture",
      source: "local", dimensions: 2, recommendedThreshold: 0.3 },
    embed: async (request) => { embedCalls.push(request); return embedding; }
  };
  const retriever = new HybridMemoryRetriever({
    localMemory: {
      listMemoryEntries: async () => ({ entries: [entry], total: 1, storeRevision: 1 }),
      recordRecallUsage: async (ids) => { usage.push(ids); }
    },
    getEmbeddingRuntime: async () => runtime,
    getReadOnlyVectorIndex: () => ({
      status: () => ({ active: { modelFingerprint: runtime.fingerprint, dimensions: 2, vectorCount: 1, createdAt: "now", completedAt: "now" } }),
      search: (query) => { searches.push(query); return [{ entryId: entry.id, similarity: 1 }]; }
    }),
    getThreshold: () => 0.3,
    rewriteQuery: async () => "release checklist",
    ...overrides
  });
  return { retriever, runtime, usage, embedCalls, searches };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function rejectedOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Cancellation test did not reach its expected event within 5 seconds")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
