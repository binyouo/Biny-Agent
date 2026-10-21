/**
 * A direct runtime must not move its pending messages into another session.
 * Real Runtime, AgentSession, SDK, recorder, resume and leases; only the model
 * transport is synthetic. No Host/socket or TUI automation is claimed here.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentModel } from "../src/agent/core/types.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";

// Install isolation before importing any product module or native model SDK.
const suiteRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-queue-resume-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
const previousFetch = globalThis.fetch;
const networkAttempts: string[] = [];
const retainedRoots = new Set<string>();
process.env.BINY_AGENT_DIR = path.join(suiteRoot, "agent");
globalThis.fetch = async (input: string | URL | Request) => {
  networkAttempts.push(input instanceof Request ? input.url : String(input));
  throw new Error("Queue ownership fixture forbids network access");
};
after(async () => {
  assert.equal(retainedRoots.size, 0, "fixture cleanup did not join all writers; retain files and network isolation");
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await fs.rm(suiteRoot, { recursive: true, force: true });
  assert.deepEqual(networkAttempts, [], "no model or background network request may be hidden");
});

const [{ AgentSession }, { defaultConfig }, { PermissionManager }, { InteractiveAgentRuntime },
  { SessionLeaseStore, SessionWriterConflictError }, { SessionRecorder }, { readSessionEvents },
  { ensureAgentDirs, sessionFilePath }, { ToolRegistry }, { refreshSessionIndex }] = await Promise.all([
  import("../src/agent/AgentSession.js"), import("../src/config/schema.js"),
  import("../src/permission/PermissionManager.js"), import("../src/runtime/InteractiveAgentRuntime.js"),
  import("../src/runtime/SessionLease.js"), import("../src/session/recorder.js"),
  import("../src/session/events.js"), import("../src/session/store.js"),
  import("../src/tools/registry.js"), import("../src/session/catalog.js")
]);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture did not reach ${label}`)), 10_000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const queuedText = "QUEUED_ONLY_FOR_A";
const followupText = "Continue in the currently selected session";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(suiteRoot, "case-"));
  retainedRoots.add(root);
  const entered = deferred();
  const release = deferred();
  const completions: Promise<unknown>[] = [];
  const events: AgentHostEvent[] = [];
  const resources: {
    agent?: InstanceType<typeof AgentSession>;
    runtime?: InstanceType<typeof InteractiveAgentRuntime>;
    leases?: InstanceType<typeof SessionLeaseStore>;
    observer?: InstanceType<typeof SessionLeaseStore>;
    unsubscribe?: () => void;
  } = {};
  t.after(async () => {
    release.resolve();
    resources.runtime?.cancelCurrentRun("paused");
    const failures: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>, label: string): Promise<boolean> => {
      try {
        await bounded(work(), label);
        return true;
      } catch (error) {
        failures.push(error);
        return false;
      }
    };
    let writersJoined = false;
    let closed = false;
    let indexed = false;
    try {
      const completionsJoined = await attempt(async () => await Promise.allSettled(completions), "cleanup completions");
      const idle = await attempt(async () => await resources.runtime?.waitForIdle(), "cleanup idle");
      writersJoined = completionsJoined && idle;
    } finally {
      // Always attempt close, independently of a failed join. A bounded Runtime
      // close alone is not proof that an uncooperative writer has stopped.
      closed = await attempt(async () => {
        if (resources.runtime) await resources.runtime.close();
        else {
          await resources.agent?.close();
          resources.leases?.close();
        }
      }, "cleanup close");
      if (writersJoined && closed) {
        indexed = await attempt(async () => await refreshSessionIndex(root), "cleanup catalog");
      }
      resources.unsubscribe?.();
      resources.observer?.close();
      if (writersJoined && closed && indexed) {
        await fs.rm(root, { recursive: true, force: true });
        retainedRoots.delete(root);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Queue ownership fixture cleanup failed");
  });
  await ensureAgentDirs(root);
  const a = "queue-source-a";
  const b = "queue-target-b";
  const bRecorder = new SessionRecorder(root, b);
  try {
    bRecorder.record({ type: "user_message", content: "Independent B history" });
    bRecorder.record({ type: "assistant_message", content: "B answer" });
  } finally {
    await bRecorder.close();
  }
  const aPath = sessionFilePath(root, a);
  const bPath = sessionFilePath(root, b);
  const bBefore = await fs.readFile(bPath);
  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "direct";
  config.context.maxInputTokens = 1_000_000;
  config.context.memory.enabled = false;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.diagnostics.enabled = false;
  config.chat.skillExtraction.enabled = false;
  let requests = 0;
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  };
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "queue-ownership", supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: "text", text: "Auxiliary answer" }],
      finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
    async doStream(options) {
      if (options.headers?.["x-biny-operation"] === "agent") {
        requests += 1;
        if (requests === 1) {
          entered.resolve();
          await release.promise;
          options.abortSignal?.throwIfAborted();
        }
      }
      const parts: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Done." },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }
      ];
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); }
      }) };
    }
  };
  const model: AgentModel = { provider: "fixture", modelId: "queue-ownership",
    runtime: "builtin-llama.cpp", dataResidency: "local", supportsTools: true, vercelModel: provider };
  const agent = new AgentSession({ workspaceRoot: root, config, model,
    recorder: new SessionRecorder(root, a), toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission) });
  resources.agent = agent;
  await agent.initialize();
  const leases = await SessionLeaseStore.open(root);
  resources.leases = leases;
  const observer = await SessionLeaseStore.open(root);
  resources.observer = observer;
  // Unrelated surrounding CommandRuntime services are adapters; no queue,
  // execution, persistence, cancellation or resume implementation is replaced.
  const runtime = new InteractiveAgentRuntime({ agent, persistenceRoot: root,
    refreshSkills: async () => {}, setSubagentParentRunId: () => {}, close: async () => await agent.close()
  } as unknown as ConstructorParameters<typeof InteractiveAgentRuntime>[0], { sessionLeases: leases });
  resources.runtime = runtime;
  resources.unsubscribe = runtime.subscribe(update => { if (update.event) events.push(update.event); });
  await runtime.claimSession(a);
  function track<T>(completion: Promise<T>): Promise<T> {
    completions.push(completion);
    return completion;
  }
  function submit(input: string) {
    const submitted = runtime.submitPrompt(input);
    track(submitted.completion);
    return submitted;
  }
  async function pauseWithQueue() {
    const first = submit("Start A and wait at the synthetic provider");
    await bounded(entered.promise, "first model request");
    const queued = await runtime.enqueue(queuedText);
    assert.equal(runtime.cancelRun(first.runId, "paused"), true);
    release.resolve();
    const outcome = await bounded(first.completion, "paused A completion");
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.stopReason, "paused");
    assert.equal(runtime.getSnapshot().state.kind, "idle");
    assert.deepEqual(runtime.getSnapshot().queuedMessages, [
      { messageId: queued.messageId, content: queuedText, attachmentCount: 0 }
    ]);
    return queued;
  }
  async function continueAndDrain() {
    const next = submit(followupText);
    assert.equal((await bounded(next.completion, "following turn")).status, "completed");
    await bounded(runtime.waitForIdle(), "automatic queue delivery");
    assert.equal(runtime.getSnapshot().queuedMessages?.length, 0);
  }
  return { root, runtime, agent, observer, a, b, aPath, bPath, bBefore, events,
    pauseWithQueue, continueAndDrain, submit, release, track,
    get requests() { return requests; } };
}

test("cross-session resume cannot deliver A's pending queue into B", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const queued = await f.pauseWithQueue();
  const resume = await f.runtime.resumeSession(f.b).then(
    value => ({ accepted: true as const, value }),
    (error: unknown) => ({ accepted: false as const, error })
  );
  // Continue the selected session in both Red and Green. Baseline enters B and
  // automatically writes A's queued marker there; the repair keeps it in A.
  await f.continueAndDrain();
  const aEvents = await readSessionEvents(f.aPath);
  const bEvents = await readSessionEvents(f.bPath);
  assert.equal(bEvents.some(event => event.type === "user_message" && event.content === queuedText), false,
    "A's queued input must never become a canonical user message in B");
  assert.equal(resume.accepted, false, "pending input must block a cross-session resume");
  if (resume.accepted) throw new Error("unreachable accepted cross-session resume");
  assert.match(String(resume.error), /queued messages/iu);
  assert.equal(f.runtime.getSnapshot().info.sessionId, f.a);
  assert.equal(aEvents.filter(event => event.type === "user_message" && event.content === queuedText && !event.auditOnly).length, 1);
  assert.equal(f.events.filter(event => event.type === "message.user" && event.content === queuedText
    && event.sessionId === f.a).length, 1);
  assert.equal(f.requests, 3);
  assert.deepEqual(await fs.readFile(f.bPath), f.bBefore);
  assert.throws(() => f.observer.acquire(f.a), SessionWriterConflictError);
  f.observer.acquire(f.b).close();
  assert.ok(queued.messageId);
});

test("same-session resume preserves and later delivers pending input", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const queued = await f.pauseWithQueue();
  const resumed = await f.runtime.resumeSession(f.a);
  assert.equal(resumed.sessionId, f.a);
  assert.equal(f.runtime.getSnapshot().queuedMessages?.[0]?.messageId, queued.messageId);
  await f.continueAndDrain();
  const events = await readSessionEvents(f.aPath);
  assert.equal(events.filter(event => event.type === "user_message" && event.content === queuedText && !event.auditOnly).length, 1);
  assert.deepEqual(await fs.readFile(f.bPath), f.bBefore);
  assert.equal(f.requests, 3);
});

test("input arriving during session claim resolution retains its original owner", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  // Join initialization's catalog refresh before counting B's two resolutions.
  await bounded(refreshSessionIndex(f.root), "setup catalog");
  const claimEntered = deferred();
  const releaseClaim = deferred();
  const originalRealpath = fs.realpath;
  let resolutions = 0;
  const spy = t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
    if (args[0] === f.bPath && ++resolutions === 2) {
      claimEntered.resolve();
      await releaseClaim.promise;
    }
    return await originalRealpath(...args);
  });
  const resume = f.track(f.runtime.resumeSession(f.b).then(
    value => ({ accepted: true as const, value }),
    (error: unknown) => ({ accepted: false as const, error })
  ));
  try {
    await bounded(claimEntered.promise, "claim target resolution");
    // Only the already-held B resolution stays gated; all new work uses real fs.
    spy.mock.restore();
    const queued = await f.pauseWithQueue();
    releaseClaim.resolve();
    const outcome = await bounded(resume, "claim resolution outcome");
    const afterClaim = f.runtime.getSnapshot();
    await f.continueAndDrain();
    const bEvents = await readSessionEvents(f.bPath);
    assert.equal(bEvents.some(event => event.type === "user_message" && event.content === queuedText), false,
      "input queued while claiming B must remain a canonical user message only in A");
    assert.equal(outcome.accepted, false);
    if (outcome.accepted) throw new Error("unreachable accepted cross-session claim");
    assert.match(String(outcome.error), /queued messages/iu);
    assert.equal(afterClaim.info.sessionId, f.a);
    assert.equal(afterClaim.queuedMessages?.[0]?.messageId, queued.messageId);
    assert.equal(f.runtime.getSnapshot().info.sessionId, f.a);
    assert.equal((await readSessionEvents(f.aPath)).filter(event => event.type === "user_message"
      && event.content === queuedText && !event.auditOnly).length, 1);
    assert.equal(f.events.filter(event => event.type === "message.user" && event.content === queuedText
      && event.sessionId === f.a).length, 1);
    assert.equal(f.requests, 3);
    assert.deepEqual(await fs.readFile(f.bPath), f.bBefore);
    assert.throws(() => f.observer.acquire(f.a), SessionWriterConflictError);
    f.observer.acquire(f.b).close();
    assert.ok(queued.messageId);
  } finally {
    releaseClaim.resolve();
    spy.mock.restore();
  }
});

test("removing pending input permits a different session without leaking it", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const queued = await f.pauseWithQueue();
  await f.runtime.removeQueuedRunMessage(queued.messageId);
  assert.equal((await f.runtime.resumeSession(f.b)).sessionId, f.b);
  await f.continueAndDrain();
  const events = await readSessionEvents(f.bPath);
  assert.equal(events.some(event => event.type === "user_message" && event.content === queuedText), false);
  assert.equal(events.filter(event => event.type === "user_message" && event.content === followupText).length, 1);
  assert.equal(f.requests, 2);
  f.observer.acquire(f.a).close();
  assert.throws(() => f.observer.acquire(f.b), SessionWriterConflictError);
});

test("a missing resume target leaves pending input and its source intact", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const queued = await f.pauseWithQueue();
  await assert.rejects(f.runtime.resumeSession("missing-queue-session"));
  assert.equal(f.runtime.getSnapshot().info.sessionId, f.a);
  assert.equal(f.runtime.getSnapshot().queuedMessages?.[0]?.messageId, queued.messageId);
  await f.continueAndDrain();
  assert.deepEqual(await fs.readFile(f.bPath), f.bBefore);
  assert.equal(f.requests, 3);
});

test("an explicit new draft retains its existing queue-reset behavior", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.pauseWithQueue();
  const draft = await f.runtime.startDraft();
  assert.notEqual(draft.sessionId, f.a);
  assert.equal(f.runtime.getSnapshot().queuedMessages?.length, 0);
  await f.continueAndDrain();
  const events = await readSessionEvents(draft.sessionFile);
  assert.equal(events.some(event => event.type === "user_message" && event.content === queuedText), false);
  assert.equal(f.requests, 2);
  assert.deepEqual(await fs.readFile(f.bPath), f.bBefore);
});
