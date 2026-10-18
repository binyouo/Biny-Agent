/** The actual completed-turn extraction and cleanup must keep their source and owner together. */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentSession } from "../src/agent/AgentSession.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { SessionEvent, SessionRecorder } from "../src/session/recorder.js";

const userInput = "Keep the Atlas project review preference.";
const savedAt = new Date("2026-10-15T12:00:00.000Z");
const storedAnchor = {
  messageId: "earlier-atlas-source",
  sentAt: "2026-09-20T02:30:00.000Z",
  timeZone: "Asia/Shanghai"
};
const extractionUsage = { inputTokens: 101, outputTokens: 7, totalTokens: 108 };
const cleanupUsage = { inputTokens: 31, outputTokens: 3, totalTokens: 34 };

interface EmbeddingBoundary {
  findSimilarEntries(query: string, entries: readonly MemoryEntry[], limit: number,
    minimumSimilarity: number, signal?: AbortSignal): Promise<MemoryEntry[] | undefined>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    void promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-origin-cleanup-handoff-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const releaseCleanup = deferred();
  const cleanupEntered = deferred();
  const memoryHandled = deferred();
  const transitions: Promise<unknown>[] = [];
  const recorders: SessionRecorder[] = [];
  const restores: Array<() => void> = [];
  const owners: { agent?: AgentSession; runtime?: InteractiveAgentRuntime } = {};
  const requests: Array<{ kind: "extraction" | "cleanup"; prompt: string; systemPrompt?: string }> = [];
  const searches: Array<{ query: string; ids: string[]; limit: number; minimumSimilarity: number }> = [];
  let cleanupReleased = false;
  const blockedFetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Cross-layer memory fixtures must not make network requests.");
  });
  const blockedSocket = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Cross-layer memory fixtures must not open network sockets.");
  });

  // Even assertion failures and runner timeouts release providers before draining owners.
  t.after(async () => {
    cleanupReleased = true;
    releaseCleanup.resolve();
    await Promise.allSettled(transitions);
    const errors: unknown[] = [];
    try {
      if (owners.runtime) await owners.runtime.close();
      else await owners.agent?.close();
    } catch (error) { errors.push(error); }
    for (const recorder of recorders) {
      try { await recorder.close(); } catch (error) { errors.push(error); }
    }
    for (const restore of restores) restore();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    try { await rm(root, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    const fetchCalls = blockedFetch.mock.callCount();
    const socketCalls = blockedSocket.mock.callCount();
    blockedFetch.mock.restore();
    blockedSocket.mock.restore();
    assert.equal(fetchCalls, 0);
    assert.equal(socketCalls, 0);
    if (errors.length) throw new AggregateError(errors, "Cross-layer memory fixture cleanup failed.");
  });

  // Global paths and network guards exist before loading application modules.
  const [agentModule, configModule, permissions, runtimeModule, eventsModule, treeModule,
    recorderModule, replayModule, store, registry, extractionPrompts] = await Promise.all([
    import("../src/agent/AgentSession.js"),
    import("../src/config/schema.js"),
    import("../src/permission/PermissionManager.js"),
    import("../src/runtime/InteractiveAgentRuntime.js"),
    import("../src/session/events.js"),
    import("../src/session/messageTree.js"),
    import("../src/session/recorder.js"),
    import("../src/session/replay.js"),
    import("../src/session/store.js"),
    import("../src/tools/registry.js"),
    import("../src/agent/context/memoryExtraction.js")
  ]);
  t.signal.throwIfAborted();
  await store.ensureAgentDirs(root);
  const model: AgentModel = {
    provider: "synthetic", modelId: "origin-cleanup-handoff", supportsTools: false,
    async stream(context, options) {
      const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      const kind = prompt.startsWith("Extract memories from this conversation:") ? "extraction"
        : prompt.startsWith("Current date and time:") ? "cleanup" : undefined;
      if (kind) requests.push({ kind, prompt, systemPrompt: context.systemPrompt });
      if (kind === "cleanup") {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta", text: kind === "extraction" ? '["NO_MEMORY"]'
          : kind === "cleanup" ? "[]" : "Acknowledged." };
        yield { type: "finish", reason: "stop", usage: kind === "extraction" ? extractionUsage
          : kind === "cleanup" ? cleanupUsage : { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
      })();
    }
  };
  const { defaultConfig } = configModule;
  const config = configModule.configSchema.parse({
    ...defaultConfig,
    defaultModel: "origin-cleanup-handoff",
    providers: { synthetic: { type: "openai-compatible", baseUrl: "http://fixture.invalid", requiresApiKey: false } },
    models: { "origin-cleanup-handoff": { provider: "synthetic", model: "origin-cleanup-handoff" } },
    activity: { ...defaultConfig.activity, enabled: false },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context,
      compaction: { ...defaultConfig.context.compaction, enabled: false },
      memory: { ...defaultConfig.context.memory, enabled: true, useMemories: false,
        generateMemories: true, queryRewrite: false, excludeExternalContext: false, embeddingModel: undefined } }
  });
  const recorder = new recorderModule.SessionRecorder(root);
  recorders.push(recorder);
  const append = recorder.recordWithRuntimeContext.bind(recorder);
  recorder.recordWithRuntimeContext = (event, context) => {
    const recorded = append(event, context);
    if (event.type === "message_metadata" && event.metadata.memoryExtracted === true) memoryHandled.resolve();
    return recorded;
  };
  restores.push(() => { recorder.recordWithRuntimeContext = append; });
  const agent = new agentModule.AgentSession({
    workspaceRoot: root, config, model, recorder,
    toolRegistry: new registry.ToolRegistry(),
    permissionManager: new permissions.PermissionManager(config.permission)
  });
  owners.agent = agent;
  await agent.initialize();
  t.signal.throwIfAborted();

  // Only vector availability and ranking are synthetic. AgentSession still loads
  // persisted candidates, and LocalMemory still scopes/counts them and builds both prompts.
  const embedding = (agent as unknown as { memoryEmbeddingService: EmbeddingBoundary }).memoryEmbeddingService;
  const findSimilarEntries = embedding.findSimilarEntries;
  embedding.findSimilarEntries = async (query, entries, limit, minimumSimilarity, signal) => {
    signal?.throwIfAborted();
    searches.push({ query, ids: entries.map((entry) => entry.id), limit, minimumSimilarity });
    return [...entries];
  };
  restores.push(() => { embedding.findSimilarEntries = findSimilarEntries; });
  agent.getEmbeddingRuntime = async () => ({} as Awaited<ReturnType<AgentSession["getEmbeddingRuntime"]>>);
  const memory = agent.getLocalMemory();
  const seeded = await memory.writeEntry({
    content: "The ongoing Atlas project review remains open.", durability: "temporary",
    originAnchors: [storedAnchor]
  }, { now: savedAt });
  assert.ok(seeded.entry);
  const entry = seeded.entry;
  const commands = {
    agent, persistenceRoot: root, refreshSkills: async () => undefined,
    setSubagentParentRunId: () => undefined, close: async () => await agent.close()
  } as unknown as CommandRuntime;
  const runtime = new runtimeModule.InteractiveAgentRuntime(commands);
  owners.runtime = runtime;
  const track = <T>(operation: Promise<T>): Promise<T> => {
    transitions.push(operation);
    void operation.then(() => undefined, () => undefined);
    return operation;
  };
  return {
    agent, runtime, recorder, memory, entry, requests, searches, config, extractionPrompts,
    cleanupEntered: cleanupEntered.promise,
    memoryHandled: memoryHandled.promise,
    cleanupReleased: () => cleanupReleased,
    releaseCleanup() { cleanupReleased = true; releaseCleanup.resolve(); },
    track,
    async prompt(input: string) {
      const completion = track(runtime.submitPrompt(input, [], { continuationSource: "origin-cleanup-handoff-test" },
        undefined, { tools: "none", skills: "none" }).completion);
      const outcome = await waitWithSignal(completion, t.signal);
      assert.equal(outcome.status, "completed", outcome.error);
      return runtime.getSnapshot().info.sessionId;
    },
    async seedSession() {
      const target = new recorderModule.SessionRecorder(root);
      recorders.push(target);
      target.record({ type: "user_message", content: "An existing second session." });
      await target.close();
      return target.sessionId;
    },
    async events(sessionId: string) { return await eventsModule.readSessionEvents(store.sessionFilePath(root, sessionId)); },
    memoryUsage: (events: SessionEvent[]) => replayModule.replaySessionEvents(events).usage.filter((usage) => usage.operation === "memory"),
    memoryRequests: (events: SessionEvent[]) => events.flatMap((event) =>
      event.type === "model_request" && event.metrics.requestContext?.operation === "memory" ? [event.metrics] : []),
    messageMetadata: treeModule.sessionMessageMetadata
  };
}

for (const sample of [
  { route: "new session", completed: false },
  { route: "existing session", completed: false },
  { route: "existing session", completed: true }
] as const) {
  await test(`canonical source anchors and ${sample.completed ? "completed" : "pending"} cleanup survive ${sample.route} handoff`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    const target = sample.route === "existing session" ? await f.seedSession() : undefined;
    const original = await f.prompt(userInput);
    await waitWithSignal(f.cleanupEntered, t.signal);
    await f.recorder.flush();
    const before = await f.events(original);
    const user = before.find((event) => event.type === "user_message" && !event.auditOnly && event.content === userInput);
    const assistant = before.find((event) => event.type === "assistant_message" && !event.auditOnly && event.messageId);
    assert.ok(user?.type === "user_message" && user.messageId && user.time);
    assert.ok(assistant?.type === "assistant_message" && assistant.messageId);
    const assistantId = assistant.messageId;
    const anchor = {
      messageId: user.messageId, sentAt: new Date(user.time).toISOString(),
      timeZone: typeof user.metadata?.sentAtTimeZone === "string" ? user.metadata.sentAtTimeZone : "unknown"
    };
    assert.deepEqual(f.requests.map(({ kind }) => kind), ["extraction", "cleanup"]);
    const extraction = f.requests[0]!;
    const cleanup = f.requests[1]!;
    assert.ok(extraction.prompt.includes(`- messageId: ${anchor.messageId}; sentAt: ${anchor.sentAt}; timeZone: ${anchor.timeZone}`));
    assert.ok(cleanup.prompt.includes(`Current conversation source: source-message anchors: ${JSON.stringify([anchor])}`));
    assert.ok(cleanup.prompt.includes(JSON.stringify([storedAnchor])));
    assert.ok(cleanup.prompt.includes(`Memory saved-at: ${savedAt.toISOString()}`));
    assert.match(cleanup.prompt, /saved-at is NOT event\/due\/completion time/u);
    assert.equal(cleanup.systemPrompt, f.extractionPrompts.temporaryMemoryCleanupPrompt + "\n\n" + f.extractionPrompts.memoryTimeAnchorInstruction);
    // AgentSession's rendered user content includes its existing transient turn
    // context. Compare the actual extraction window, not a raw-input substitute.
    // Source anchors are a separate section and must never join the search text.
    const extractionHeader = "Extract memories from this conversation:\n\n";
    const sourceSeparator = "\n\nOriginal user message source anchors:\n";
    assert.ok(extraction.prompt.startsWith(extractionHeader));
    const sourceStart = extraction.prompt.indexOf(sourceSeparator, extractionHeader.length);
    assert.ok(sourceStart > extractionHeader.length, "the real extraction must separate conversation from source anchors");
    assert.equal(extraction.prompt.indexOf(sourceSeparator, sourceStart + sourceSeparator.length), -1);
    const conversation = extraction.prompt.slice(extractionHeader.length, sourceStart);
    assert.ok(conversation.startsWith("user: <!-- biny-turn-context:start -->\n\n"));
    const contextEnd = "<!-- biny-turn-context:end -->";
    const contextEndAt = conversation.indexOf(contextEnd);
    assert.ok(contextEndAt > 0);
    assert.ok(conversation.slice(0, contextEndAt).includes("<biny_reminder>Authoritative Local DateTime: "));
    assert.equal(conversation.slice(contextEndAt + contextEnd.length), `\n\n${userInput}\n\nassistant: Acknowledged.`,
      "the runtime prefix must be followed by the exact user text and completed assistant response");
    assert.deepEqual(f.searches, [{ query: conversation, ids: [f.entry.id], limit: 20, minimumSimilarity: 0.3 }],
      "cleanup search must receive the same rendered conversation as the real extraction");
    assert.ok(cleanup.prompt.includes(`\n\nCurrent conversation context:\n${conversation}\n\nCurrent conversation source:`),
      "cleanup model context must preserve that same conversation window");
    for (const sourceMetadata of [
      "Original user message source anchors:", "Current conversation source:", "source-message anchors:",
      "Memory saved-at:", "messageId:", "sentAt:", "timeZone:",
      anchor.messageId, storedAnchor.messageId, f.entry.id, anchor.sentAt, storedAnchor.sentAt, savedAt.toISOString()
    ]) {
      assert.equal(f.searches[0]!.query.includes(sourceMetadata), false,
        `source metadata must not leak into the semantic query: ${sourceMetadata}`);
    }
    assert.equal(f.messageMetadata(before, assistantId).memoryExtracted, undefined);

    if (sample.completed) {
      f.releaseCleanup();
      await waitWithSignal(f.memoryHandled, t.signal);
      await f.recorder.flush();
      const completed = await f.events(original);
      assert.equal(f.messageMetadata(completed, assistantId).memoryExtracted, true);
      assert.equal(f.memoryRequests(completed).length, 2);
      assert.equal(f.memoryUsage(completed).some((usage) => usage.inputTokens === cleanupUsage.inputTokens), false,
        "the completed cleanup bill still awaits a foreground audit when resume starts");
    }

    const maintenanceEntered = deferred();
    const unsubscribe = f.runtime.subscribe(({ snapshot }) => {
      if (snapshot.state.kind === "maintenance") maintenanceEntered.resolve();
    });
    t.after(unsubscribe);
    const transition = f.track(target === undefined
      ? f.runtime.startDraft().then((info) => info.sessionId)
      : f.runtime.resumeSession(target).then(() => target));
    await waitWithSignal(maintenanceEntered.promise, t.signal);
    assert.equal(f.cleanupReleased(), sample.completed);
    f.releaseCleanup();
    const next = await waitWithSignal(transition, t.signal);
    assert.notEqual(next, original);
    const assertOriginalOwner = async (): Promise<void> => {
      const events = await f.events(original);
      assert.deepEqual(f.memoryUsage(events).map(({ inputTokens, outputTokens, totalTokens }) =>
        ({ inputTokens, outputTokens, totalTokens })), [extractionUsage, cleanupUsage]);
      const requests = f.memoryRequests(events);
      assert.equal(requests.length, 2, "extraction and cleanup both have native request audits");
      for (const request of requests) assert.equal(request.requestContext?.sessionId, original);
      assert.equal(f.messageMetadata(events, assistantId).memoryExtracted, true);
    };
    await assertOriginalOwner();
    assert.equal(f.agent.usageSummary().calls, 0);
    assert.equal(f.agent.modelRequestSummary().calls, 0);
    const retained = await f.memory.getEntry(f.entry.id);
    assert.ok(retained);
    assert.equal(retained.content, f.entry.content);
    assert.equal(retained.revision, f.entry.revision);
    assert.equal(retained.createdAt, f.entry.createdAt);
    assert.deepEqual(retained.originAnchors, [storedAnchor]);
    assert.equal(retained.accessCount, f.entry.accessCount + 1);
    f.config.context.memory.generateMemories = false;
    assert.equal(await f.prompt("Continue this separate conversation."), next);
    await f.runtime.close();
    await assertOriginalOwner();
    assert.deepEqual(f.memoryUsage(await f.events(next)), []);
    assert.deepEqual(f.memoryRequests(await f.events(next)), []);
    assert.equal(f.requests.length, 2);
  });
}
