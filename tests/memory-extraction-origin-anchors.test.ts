import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel } from "../src/agent/core/types.js";
import type { MemoryOriginAnchor } from "../src/agent/context/memoryTypes.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const firstInput = "For project Atlas, I use pnpm.";
const secondInput = "Remember that project preference.";
const thirdInput = "I prefer short status updates.";

interface Extraction {
  messages: AgentMessage[];
  sessionId: string;
  turnId: string;
  messageId?: string;
  originAnchors?: MemoryOriginAnchor[];
}

interface Fixture {
  agent: AgentSession;
  recorder: SessionRecorder;
  signal: AbortSignal;
  pendingRuns: Set<Promise<unknown>>;
  captures: Map<string, Extraction>;
  waitForExtraction(turnId: string): Promise<Extraction>;
  pauseNextEmbedding(): { entered: Promise<void>; release(): void };
}

await test("one completed turn retains its canonical user source anchor", { timeout: 15_000 }, async (t) => {
  await withFixture(t, async (fixture) => {
    await run(fixture, firstInput, "origin-turn-1");
    await settleMemoryTasks(fixture);
    const events = await readEvents(fixture.recorder);
    assertExtraction(fixture, "origin-turn-1", [firstInput], events);
  });
});

await test("two serial completed turns retain both user anchors in the last-four window", { timeout: 15_000 }, async (t) => {
  await withFixture(t, async (fixture) => {
    await run(fixture, firstInput, "origin-turn-1");
    await settleMemoryTasks(fixture);
    await run(fixture, secondInput, "origin-turn-2");
    await settleMemoryTasks(fixture);
    const events = await readEvents(fixture.recorder);
    assertExtraction(fixture, "origin-turn-1", [firstInput], events);
    assertExtraction(fixture, "origin-turn-2", [firstInput, secondInput], events);
  });
});

await test("a detached extraction keeps its original window while a later turn completes", { timeout: 15_000 }, async (t) => {
  await withFixture(t, async (fixture) => {
    await run(fixture, firstInput, "origin-turn-1");
    await settleMemoryTasks(fixture);
    const gate = fixture.pauseNextEmbedding();
    try {
      await run(fixture, secondInput, "origin-turn-2");
      await waitWithSignal(gate.entered, t.signal);
      assert.equal(fixture.captures.has("origin-turn-2"), false);
      await run(fixture, thirdInput, "origin-turn-3");
      await fixture.waitForExtraction("origin-turn-3");
      assert.equal(fixture.captures.has("origin-turn-2"), false, "the earlier extraction remains gated");
    } finally {
      gate.release();
    }
    await settleMemoryTasks(fixture);
    const events = await readEvents(fixture.recorder);
    assertExtraction(fixture, "origin-turn-2", [firstInput, secondInput], events);
    assertExtraction(fixture, "origin-turn-3", [secondInput, thirdInput], events);
  });
});

async function withFixture(t: TestContext, body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-origin-anchors-"));
  const previousGlobalRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  const blockedFetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Origin-anchor fixtures must not make network requests.");
  });
  const blockedSocket = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Origin-anchor fixtures must not open network sockets.");
  });
  const gates: Array<{ entered: Deferred<void>; released: Deferred<void> }> = [];
  const pendingRuns = new Set<Promise<unknown>>();
  const setupFinished = deferred<void>();
  let nextEmbeddingGate: typeof gates[number] | undefined;
  let agent: AgentSession | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    await setupFinished.promise;
    for (const gate of gates) gate.released.resolve(undefined);
    try {
      await Promise.allSettled([...pendingRuns]);
      await agent?.close();
    } finally {
      if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        blockedFetch.mock.restore();
        blockedSocket.mock.restore();
      }
    }
  })();
  // The runner also awaits this hook when its timeout wins the race with the body.
  t.after(cleanup);
  try {
    t.signal.throwIfAborted();
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot);
    await ensureAgentDirs(workspaceRoot);
    const config = structuredClone(defaultConfig);
    config.activity.enabled = false;
    config.chat.skillExtraction.enabled = false;
    config.models = { [config.defaultModel]: config.models[config.defaultModel]! };
    config.toolModel = config.defaultModel;
    config.providers.deepseek = { ...config.providers.deepseek!, apiKey: "fixture-key", apiKeyEnv: undefined };
    config.providers.deepseek = { ...config.providers.deepseek!, apiKeyEnv: "BINY_ORIGIN_ANCHOR_TEST_UNCONFIGURED_KEY" };
    config.context.memory.enabled = true;
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = true;
    config.context.memory.excludeExternalContext = false;
    const model: AgentModel = testModel({
      provider: "origin-anchor-fixture",
      modelId: "origin-anchor-fixture",
      async stream() {
        return (async function* () {
          yield { type: "text-delta" as const, text: "Acknowledged." };
          yield { type: "finish" as const, reason: "stop" as const };
        })();
      }
    });
    const recorder = new SessionRecorder(workspaceRoot, "origin-anchor-session");
    agent = new AgentSession({
      workspaceRoot,
      config,
      model,
      recorder,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" })
    });
    await agent.initialize();
    agent.setOnTitleGenerated(undefined);
    t.signal.throwIfAborted();
    agent.getEmbeddingRuntime = async () => {
      const gate = nextEmbeddingGate;
      nextEmbeddingGate = undefined;
      if (gate) {
        gate.entered.resolve(undefined);
        await gate.released.promise;
      }
      // The summarizer below is a spy, so only the availability gate needs a fake.
      return {} as Awaited<ReturnType<AgentSession["getEmbeddingRuntime"]>>;
    };
    const captures = new Map<string, Extraction>();
    const waiting = new Map<string, Deferred<Extraction>>();
    agent.getLocalMemory().summarizeAndStoreMemories = async (messages, options) => {
      const extraction: Extraction = {
        messages: structuredClone([...messages]),
        sessionId: options.sessionId,
        turnId: options.turnId,
        messageId: options.messageId,
        originAnchors: structuredClone(options.originAnchors)
      };
      captures.set(options.turnId, extraction);
      waiting.get(options.turnId)?.resolve(extraction);
      return { created: [], updated: [], deleted: [] };
    };
    setupFinished.resolve(undefined);
    await body({
      agent,
      recorder,
      signal: t.signal,
      pendingRuns,
      captures,
      waitForExtraction: async (turnId) => {
        const captured = captures.get(turnId);
        if (captured) return captured;
        let pending = waiting.get(turnId);
        if (!pending) {
          pending = deferred<Extraction>();
          waiting.set(turnId, pending);
        }
        return await waitWithSignal(pending.promise, t.signal);
      },
      pauseNextEmbedding: () => {
        assert.equal(nextEmbeddingGate, undefined);
        const gate = { entered: deferred<void>(), released: deferred<void>() };
        gates.push(gate);
        nextEmbeddingGate = gate;
        return { entered: gate.entered.promise, release: () => gate.released.resolve(undefined) };
      }
    });
  } finally {
    setupFinished.resolve(undefined);
    await cleanup();
  }
  assert.equal(blockedFetch.mock.callCount(), 0);
  assert.equal(blockedSocket.mock.callCount(), 0);
}

async function run(fixture: Fixture, input: string, turnId: string): Promise<void> {
  fixture.signal.throwIfAborted();
  const task = fixture.agent.runTask(input, {
    turnId,
    runId: turnId + "-run",
    abortSignal: fixture.signal,
    emotionAnalysis: false
  });
  fixture.pendingRuns.add(task);
  void task.then(() => fixture.pendingRuns.delete(task), () => fixture.pendingRuns.delete(task));
  const outcome = await waitWithSignal(task, fixture.signal);
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
}

async function settleMemoryTasks(fixture: Fixture): Promise<void> {
  // Serialize the first two cases; the regression does not depend on a race.
  const pending = (fixture.agent as unknown as { pendingMemoryTasks: ReadonlySet<Promise<unknown>> }).pendingMemoryTasks;
  await waitWithSignal(Promise.allSettled([...pending]), fixture.signal);
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    // Observe the underlying promise even if the signal is already aborted.
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

async function readEvents(recorder: SessionRecorder): Promise<SessionEvent[]> {
  await recorder.flush();
  return await readSessionEvents(recorder.filePath);
}

function assertExtraction(fixture: Fixture, turnId: string, inputs: string[], events: SessionEvent[]): void {
  const extraction = fixture.captures.get(turnId);
  assert.ok(extraction, "the completed turn must invoke automatic extraction");
  const tail = extraction.messages.slice(-4);
  assert.deepEqual(tail.map((message) => message.role), inputs.flatMap(() => ["user", "assistant"]));
  const users = tail.filter((message) => message.role === "user");
  assert.deepEqual(users.map((message) => message.originalContent ?? message.content), inputs);
  const origins = inputs.map((input) => {
    const event = events.find((item) => item.type === "user_message" && !item.auditOnly && item.content === input);
    assert.ok(event?.type === "user_message" && event.messageId && event.time);
    assert.ok(Number.isFinite(Date.parse(event.time)), "the anchor time must already exist in the canonical event");
    return {
      messageId: event.messageId,
      sentAt: event.time,
      timeZone: typeof event.metadata?.sentAtTimeZone === "string" ? event.metadata.sentAtTimeZone : "unknown"
    };
  });
  assert.equal(new Set(origins.map((origin) => origin.messageId)).size, inputs.length);
  assert.equal(extraction.sessionId, fixture.recorder.sessionId);
  assert.ok(extraction.messageId);
  assert.ok(events.some((event) => event.type === "assistant_message"
    && event.messageId === extraction.messageId && event.runtime?.turnId === turnId),
  "the batch source still identifies the assistant that completed this turn");
  assert.deepEqual(extraction.originAnchors, origins,
    "every canonical user source inside the existing last-four window must retain its ID, time and timezone");
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
