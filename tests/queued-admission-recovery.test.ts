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
const suiteRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-queue-handoff-recovery-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
const previousFetch = globalThis.fetch;
const networkAttempts: string[] = [];
const retainedRoots = new Set<string>();
process.env.BINY_AGENT_DIR = path.join(suiteRoot, "agent");
globalThis.fetch = async (input: string | URL | Request) => {
  networkAttempts.push(input instanceof Request ? input.url : String(input));
  throw new Error("Queue handoff recovery fixture forbids network access");
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
  { SessionLeaseStore }, { SessionRecorder }, { readSessionEvents },
  { ensureAgentDirs, sessionFilePath }, { ToolRegistry }, { refreshSessionIndex }, { saveAttachment, readAttachment }] = await Promise.all([
  import("../src/agent/AgentSession.js"), import("../src/config/schema.js"),
  import("../src/permission/PermissionManager.js"), import("../src/runtime/InteractiveAgentRuntime.js"),
  import("../src/runtime/SessionLease.js"), import("../src/session/recorder.js"),
  import("../src/session/events.js"), import("../src/session/store.js"),
  import("../src/tools/registry.js"), import("../src/session/catalog.js"), import("../src/attachments/store.js")
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
    if (failures.length) throw new AggregateError(failures, "Queue handoff recovery fixture cleanup failed");
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
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.diagnostics.enabled = false;
  config.chat.skillExtraction.enabled = false;
  let requests = 0;
  let failAgentRequest = false;
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
        if (requests > 1 && failAgentRequest) throw new Error("fixture provider failure");
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
  const recorder = new SessionRecorder(root, a);
  const agent = new AgentSession({ workspaceRoot: root, config, model,
    recorder, toolRegistry: new ToolRegistry(),
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
    pauseWithQueue, continueAndDrain, submit, release, entered, track, recorder,
    failAgentRequest: () => { failAgentRequest = true; },
    get requests() { return requests; } };
}


for (const fault of ["before-record", "flush-before", "flush-after", "checkpoint"] as const) {
  test(`automatic report queue handoff remains read-only after ${fault} failure`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const first = f.submit("Start the report analysis and wait");
    await bounded(f.entered.promise, "first provider");
    const saved = await saveAttachment(f.root, "report.txt", "text/plain", Buffer.from("REPORT"));
    const attachment = await readAttachment(f.root, saved);
    assert.ok(attachment);
    const firstQueued = await f.runtime.enqueue("Analyse the attached report", [attachment]);
    const secondQueued = await f.runtime.enqueue("Then summarise risks");
    const combined = "Analyse the attached report\n\nThen summarise risks";
    let armed = false;
    let injected = false;
    const originalRecord = f.recorder.record.bind(f.recorder);
    t.mock.method(f.recorder, "record", (...args: Parameters<typeof f.recorder.record>) => {
      const event = args[0];
      if (!injected && event.type === "user_message" && !event.auditOnly && event.content === combined) {
        if (fault === "before-record") { injected = true; throw new Error("fixture canonical record failure"); }
        armed = true;
      }
      return originalRecord(...args);
    });
    const originalFlush = f.recorder.flush.bind(f.recorder);
    t.mock.method(f.recorder, "flush", async () => {
      if (armed && !injected && (fault === "flush-before" || fault === "flush-after")) {
        injected = true;
        if (fault === "flush-after") await originalFlush();
        throw new Error("fixture uncertain flush failure");
      }
      await originalFlush();
    });
    const store = (f.agent as unknown as { turnStore: { save: (...args: unknown[]) => Promise<void> } }).turnStore;
    const originalSave = store.save.bind(store);
    t.mock.method(store, "save", async (...args: unknown[]) => {
      if (!injected && fault === "checkpoint" && args[0] === combined) {
        injected = true;
        throw new Error("fixture checkpoint persistence failure");
      }
      await originalSave(...args);
    });
    f.release.resolve();
    assert.equal((await bounded(first.completion, "first task")).status, "completed");
    await bounded(f.runtime.waitForIdle(), "queue admission terminal");
    assert.equal(injected, true);
    assert.equal(f.requests, 1, "failed admission must never reach provider");
    const recovered = f.runtime.getSnapshot().queuedMessages ?? [];
    assert.deepEqual(recovered.map(item => item.messageId), [firstQueued.messageId, secondQueued.messageId]);
    assert.deepEqual(recovered.map(item => item.content), ["Analyse the attached report", "Then summarise risks"]);
    assert.equal(recovered[0]?.attachmentCount, 1);
    assert.deepEqual(recovered[0]?.recovery?.attachments, [saved]);
    assert.deepEqual(recovered[0]?.recovery?.unavailableAttachmentNames, []);
    assert.ok(recovered.every(item => item.recovery?.runId && item.recovery.messageId));
    const internals = f.runtime as unknown as { queuedMessages: { attachments: NonNullable<typeof attachment>[] }[] };
    assert.deepEqual(internals.queuedMessages[0]?.attachments, [attachment], "complete attachment bytes and reference stay owned");
    await assert.rejects(f.runtime.updateQueuedRunMessage(firstQueued.messageId, "rewrite"), /read-only/u);
    await assert.rejects(f.runtime.moveQueuedRunMessage(secondQueued.messageId, firstQueued.messageId, false), /unconfirmed/u);
    await assert.rejects(f.runtime.steerQueuedRunMessage(firstQueued.messageId), /Unconfirmed/u);
    await assert.rejects(f.runtime.sendQueuedRunMessagesNow(), /Unconfirmed/u);
    await assert.rejects(f.runtime.startDraft(), /unconfirmed/u);
    await assert.rejects(f.runtime.resumeSession(f.b), /queued messages/u);
    await f.recorder.flush();
    const before = await readSessionEvents(f.aPath);
    const canonical = before.filter(event => event.type === "user_message" && !event.auditOnly && event.content === combined);
    assert.equal(canonical.length, fault === "before-record" ? 0 : 1);
    assert.equal(f.events.some(event => event.type === "message.user" && event.content === combined), false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.requests, 1, "no timer automatically replays uncertain input");
    assert.equal((await readSessionEvents(f.aPath)).filter(event => event.type === "user_message" && !event.auditOnly && event.content === combined).length, canonical.length);
    await f.runtime.removeQueuedRunMessage(firstQueued.messageId);
    await f.runtime.removeQueuedRunMessage(secondQueued.messageId);
    assert.equal(f.runtime.getSnapshot().queuedMessages?.length, 0);
    assert.equal(f.requests, 1, "discarding recovery copies must not execute input");
    assert.deepEqual(await readAttachment(f.root, saved), attachment, "discard leaves the original saved attachment intact");
  });
}

test("successful queue admission followed by provider failure is not requeued", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const first = f.submit("Start the original task");
  await bounded(f.entered.promise, "first provider");
  await f.runtime.enqueue("Queued provider failure");
  f.failAgentRequest();
  f.release.resolve();
  await bounded(first.completion, "original completion");
  await bounded(f.runtime.waitForIdle(), "queued failure");
  assert.ok(f.requests >= 2, "real scripted provider boundary was reached");
  assert.equal(f.runtime.getSnapshot().queuedMessages?.length, 0);
  await f.recorder.flush();
  const events = await readSessionEvents(f.aPath);
  assert.equal(events.filter(event => event.type === "user_message" && !event.auditOnly && event.content === "Queued provider failure").length, 1);
});


test("queued handoff fails closed before provider when an adapter lacks durable admission", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const first = f.submit("Original task already admitted");
  await bounded(f.entered.promise, "first provider");
  const queued = await f.runtime.enqueue("Do not run through a legacy adapter");
  const descriptor = Object.getOwnPropertyDescriptor(f.agent, "admitUserMessage");
  Object.defineProperty(f.agent, "admitUserMessage", { configurable: true, value: undefined });
  try {
    f.release.resolve();
    await bounded(first.completion, "original completion");
    await bounded(f.runtime.waitForIdle(), "legacy adapter refusal");
    assert.equal(f.requests, 1, "queued provider must not be called without admission support");
    const snapshot = f.runtime.getSnapshot();
    assert.equal(snapshot.state.kind, "idle");
    assert.equal(snapshot.queuedMessages?.[0]?.messageId, queued.messageId);
    assert.ok(snapshot.queuedMessages?.[0]?.recovery);
    assert.ok(f.events.some(event => event.type === "run.failed" && /durable user admission support/u.test(event.error)));
    await f.recorder.flush();
    assert.equal((await readSessionEvents(f.aPath)).some(event => event.type === "user_message" && event.content === "Do not run through a legacy adapter"), false);
  } finally {
    if (descriptor) Object.defineProperty(f.agent, "admitUserMessage", descriptor);
    else Reflect.deleteProperty(f.agent, "admitUserMessage");
  }
});

test("new input arriving during uncertain handoff stays behind its read-only owner", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const first = f.submit("Original task waiting");
  await bounded(f.entered.promise, "first provider");
  const queued = await f.runtime.enqueue("Original queued owner");
  const admissionEntered = deferred();
  const releaseFailure = deferred();
  let armed = false;
  let injected = false;
  const originalRecord = f.recorder.record.bind(f.recorder);
  const originalFlush = f.recorder.flush.bind(f.recorder);
  t.mock.method(f.recorder, "record", (...args: Parameters<typeof f.recorder.record>) => {
    if (args[0].type === "user_message" && !args[0].auditOnly && args[0].content === "Original queued owner") armed = true;
    return originalRecord(...args);
  });
  t.mock.method(f.recorder, "flush", async () => {
    await originalFlush();
    if (armed && !injected) {
      injected = true;
      admissionEntered.resolve();
      await releaseFailure.promise;
      throw new Error("fixture deferred uncertain receipt");
    }
  });
  try {
    f.release.resolve();
    await bounded(first.completion, "original completion");
    await bounded(admissionEntered.promise, "queue admission flush");
    const later = await f.runtime.enqueue("Later independent input");
    releaseFailure.resolve();
    await bounded(f.runtime.waitForIdle(), "uncertain handoff failure");
    const pending = f.runtime.getSnapshot().queuedMessages ?? [];
    assert.deepEqual(pending.map(item => item.messageId), [queued.messageId, later.messageId]);
    assert.ok(pending[0]?.recovery);
    assert.equal(pending[1]?.recovery, undefined);
    assert.equal(f.requests, 1, "neither uncertain nor later input bypasses the recovery owner");
    await assert.rejects(f.runtime.steerQueuedRunMessage(later.messageId), /Unconfirmed/u);
    await f.runtime.updateQueuedRunMessage(later.messageId, "Later independent input edited");
    assert.equal(f.runtime.getSnapshot().queuedMessages?.[1]?.content, "Later independent input edited");
    await f.runtime.removeQueuedRunMessage(queued.messageId);
    assert.equal(f.requests, 1, "discard is not permission to execute the remaining queue");
    await f.runtime.removeQueuedRunMessage(later.messageId);
  } finally {
    releaseFailure.resolve();
  }
});
