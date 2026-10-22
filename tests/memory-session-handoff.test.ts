import { testModel } from "./helpers/model.js";
/** Real same-runtime transitions with one controlled background memory-model request. */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionMessageMetadata } from "../src/session/messageTree.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs, sessionFilePath } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function memoryUsage(events: SessionEvent[]) {
  return replaySessionEvents(events).usage.filter((usage) => usage.operation === "memory");
}

function memoryRequests(events: SessionEvent[]) {
  return events.flatMap((event) =>
    event.type === "model_request" && event.metrics.requestContext?.operation === "memory"
      ? [event.metrics] : []);
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-memory-handoff-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const releaseMemory = deferred();
  const memoryStarted = deferred();
  const handled = new Set<string>();
  const handledWaiters = new Map<string, ReturnType<typeof deferred>>();
  const transitions: Promise<unknown>[] = [];
  const recorders: SessionRecorder[] = [];
  const owned: { agent?: AgentSession; runtime?: InteractiveAgentRuntime } = {};
  let memoryCalls = 0;
  let foregroundCalls = 0;
  let memoryReleased = false;

  // The hook is separate from the test body, so cleanup cannot replace its assertion error.
  // Release the provider first, join transitions, then close the real runtime/resources.
  t.after(async () => {
    memoryReleased = true;
    releaseMemory.resolve();
    await Promise.allSettled(transitions);
    const errors: unknown[] = [];
    try {
      if (owned.runtime) await owned.runtime.close();
      else await owned.agent?.close();
    } catch (error) { errors.push(error); }
    for (const recorder of recorders) {
      try { await recorder.close(); } catch (error) { errors.push(error); }
    }
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    try { await rm(root, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Memory handoff fixture cleanup failed.");
  });

  await ensureAgentDirs(root);
  const model: AgentModel = testModel({
    provider: "synthetic", modelId: "memory-handoff", supportsTools: false,
    async stream(context) {
      const memory = context.systemPrompt?.startsWith("You are a memory management assistant.") === true;
      if (memory) {
        memoryCalls += 1;
        memoryStarted.resolve();
        await releaseMemory.promise;
      } else {
        foregroundCalls += 1;
      }
      const text = memory ? '["NO_MEMORY"]' : "Completed " + foregroundCalls + ".";
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text };
        yield { type: "finish", reason: "stop", usage: memory
          ? { inputTokens: 101, outputTokens: 7, totalTokens: 108 }
          : { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
      })();
    }
  });
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "memory-handoff",
    providers: { synthetic: { type: "openai-compatible", baseUrl: "http://fixture.invalid", requiresApiKey: false } },
    models: { "memory-handoff": { provider: "synthetic", model: "memory-handoff" } },
    activity: { ...defaultConfig.activity, enabled: false },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context,
      compaction: { ...defaultConfig.context.compaction, enabled: false },
      memory: { ...defaultConfig.context.memory, enabled: true, useMemories: false,
        generateMemories: true, queryRewrite: false, excludeExternalContext: false, embeddingModel: undefined } }
  });
  const recorder = new SessionRecorder(root);
  recorders.push(recorder);
  const recordWithRuntimeContext = recorder.recordWithRuntimeContext.bind(recorder);
  // Observe the real append; do not replace recording, persistence, or extraction behavior.
  recorder.recordWithRuntimeContext = (event, context) => {
    const recorded = recordWithRuntimeContext(event, context);
    if (event.type === "message_metadata" && event.metadata.memoryExtracted === true) {
      handled.add(event.messageId);
      handledWaiters.get(event.messageId)?.resolve();
    }
    return recorded;
  };
  const agent = new AgentSession({
    workspaceRoot: root, config, model, recorder,
    toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission)
  });
  owned.agent = agent;
  await agent.initialize();
  // Only availability is synthetic. NO_MEMORY avoids vector writes; the real LocalMemory
  // extraction, native metrics callback, usage callback and metadata append still execute.
  agent.getEmbeddingRuntime = async () => ({} as Awaited<ReturnType<AgentSession["getEmbeddingRuntime"]>>);
  const currentAgent = agent;
  const commands = { agent: currentAgent, persistenceRoot: root, refreshSkills: async () => undefined,
    setSubagentParentRunId: () => undefined, close: async () => await currentAgent.close()
  } as unknown as CommandRuntime;
  const runtime = new InteractiveAgentRuntime(commands);
  owned.runtime = runtime;
  const currentRuntime = runtime;

  return {
    root, config, agent: currentAgent, runtime: currentRuntime, recorder,
    memoryStarted: memoryStarted.promise,
    memoryCalls: () => memoryCalls,
    memoryReleased: () => memoryReleased,
    releaseMemory() { memoryReleased = true; releaseMemory.resolve(); },
    track<T>(operation: Promise<T>): Promise<T> {
      transitions.push(operation);
      void operation.then(() => undefined, () => undefined);
      return operation;
    },
    async metadataCommitted(messageId: string) {
      if (!handled.has(messageId)) {
        const ready = deferred();
        handledWaiters.set(messageId, ready);
        await ready.promise;
      }
      await recorder.flush();
    },
    async prompt(input: string) {
      const completion = currentRuntime.submitPrompt(input, [], { continuationSource: "memory-handoff-test" },
        undefined, { tools: "none", skills: "none" }).completion;
      transitions.push(completion);
      void completion.then(() => undefined, () => undefined);
      const outcome = await completion;
      assert.equal(outcome.status, "completed", outcome.error);
      return currentRuntime.getSnapshot().info.sessionId;
    },
    async firstAssistantId() {
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      const event = events.find((item) => item.type === "assistant_message" && item.messageId && !item.auditOnly);
      assert.ok(event && event.type === "assistant_message" && event.messageId);
      return event.messageId;
    },
    async seed() {
      const seeded = new SessionRecorder(root);
      recorders.push(seeded);
      seeded.record({ type: "user_message", content: "SESSION_B" });
      await seeded.close();
      return seeded.sessionId;
    },
    async events(sessionId: string) { return await readSessionEvents(sessionFilePath(root, sessionId)); }
  };
}

function assertOldOwnership(events: SessionEvent[], sessionId: string, assistantId: string) {
  assert.deepEqual(memoryUsage(events).map(({ inputTokens, outputTokens, totalTokens }) =>
    ({ inputTokens, outputTokens, totalTokens })), [{ inputTokens: 101, outputTokens: 7, totalTokens: 108 }]);
  const requests = memoryRequests(events);
  assert.equal(requests.length, 1, "exactly one native request belongs to the original session");
  assert.equal(requests[0]?.requestContext?.sessionId, sessionId);
  assert.equal(sessionMessageMetadata(events, assistantId).memoryExtracted, true);
}

for (const route of ["same session", "different session"] as const) {
  test("completed memory usage survives " + route + " resume before another foreground audit", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    const target = route === "different session" ? await f.seed() : f.recorder.sessionId;
    const original = await f.prompt("SESSION_A");
    await f.memoryStarted;
    const assistantId = await f.firstAssistantId();
    f.releaseMemory();
    await f.metadataCommitted(assistantId);
    const beforeUsage = f.agent.usageSummary();
    const beforeRequests = f.agent.modelRequestSummary();
    assert.ok(beforeUsage.inputTokens >= 101);
    assert.equal(memoryUsage(await f.events(original)).length, 0, "the memory bill is still awaiting an audit");
    // Deterministic regression: resume previously discarded this already-completed relatedUsage.
    await f.track(f.runtime.resumeSession(target));
    assertOldOwnership(await f.events(original), original, assistantId);
    if (route === "same session") {
      assert.deepEqual(f.agent.usageSummary(), beforeUsage, "replay must retain completed memory usage");
      assert.deepEqual(f.agent.modelRequestSummary(), beforeRequests);
    } else {
      assert.equal(f.agent.usageSummary().calls, 0);
      assert.equal(f.agent.modelRequestSummary().calls, 0);
      assert.equal(memoryUsage(await f.events(target)).length, 0);
      assert.equal(memoryRequests(await f.events(target)).length, 0);
    }
    await f.runtime.close();
    assertOldOwnership(await f.events(original), original, assistantId);
    assert.equal(f.memoryCalls(), 1);
  });
}

for (const route of ["new session", "different session", "same session"] as const) {
  test("pending memory keeps its ownership across " + route + " transition", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    const original = await f.prompt("SESSION_A");
    await f.memoryStarted;
    const assistantId = await f.firstAssistantId();
    const target = route === "different session" ? await f.seed() : original;
    const entered = deferred();
    const unsubscribe = f.runtime.subscribe(({ snapshot }) => {
      if (snapshot.state.kind === "maintenance") entered.resolve();
    });
    t.after(unsubscribe);
    const transition = f.track(route === "new session"
      ? f.runtime.startDraft().then((info) => info.sessionId)
      : f.runtime.resumeSession(target).then(() => target));
    // Public maintenance entry is a scheduling barrier, not proof that a private drain started.
    // This is integrity/liveness coverage; only the completed-usage tests above claim stable Red.
    await entered.promise;
    assert.equal(f.memoryReleased(), false);
    f.releaseMemory();
    const next = await transition;
    assertOldOwnership(await f.events(original), original, assistantId);
    if (route !== "same session") {
      assert.notEqual(next, original);
      assert.equal(f.agent.usageSummary().calls, 0);
      assert.equal(f.agent.modelRequestSummary().calls, 0);
      f.config.context.memory.generateMemories = false;
      await f.prompt("An ordinary prompt in SESSION_B");
    }
    await f.runtime.close();
    assertOldOwnership(await f.events(original), original, assistantId);
    if (route !== "same session") {
      assert.equal(memoryUsage(await f.events(next)).length, 0);
      assert.equal(memoryRequests(await f.events(next)).length, 0);
    }
    assert.equal(f.memoryCalls(), 1);
  });
}

test("an unresolved resume target preserves the original pending memory owner", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const original = await f.prompt("SESSION_A");
  await f.memoryStarted;
  const assistantId = await f.firstAssistantId();
  await assert.rejects(f.track(f.runtime.resumeSession("missing-memory-handoff-target")));
  assert.equal(f.runtime.getSnapshot().info.sessionId, original);
  assert.equal(f.memoryReleased(), false, "target validation must not wait on unrelated extraction");
  f.releaseMemory();
  await f.metadataCommitted(assistantId);
  await f.runtime.close();
  assertOldOwnership(await f.events(original), original, assistantId);
});

test("another ordinary foreground turn stays nonblocking while memory is pending", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const original = await f.prompt("SESSION_A");
  await f.memoryStarted;
  const assistantId = await f.firstAssistantId();
  f.config.context.memory.generateMemories = false;
  assert.equal(await f.prompt("Continue the original session without waiting for extraction"), original);
  assert.equal(f.memoryReleased(), false, "only session replacement should join background memory");
  f.releaseMemory();
  await f.metadataCommitted(assistantId);
  await f.runtime.close();
  assertOldOwnership(await f.events(original), original, assistantId);
  assert.equal(f.memoryCalls(), 1);
});
