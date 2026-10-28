/**
 * Public cancellation must retain turn ownership until admitted native tools drain.
 * Real Runtime -> AgentSession -> AI SDK -> coordinator/scheduler -> Read/Bash.
 * The provider transport is synthetic. Only the unique fixture FileHandle.read
 * has controlled settlement timing; it still performs the real read and close.
 * Bash is never approved, and a pre-spawn guard makes accidental dispatch fail.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentModel } from "../src/agent/core/types.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";

// Isolation precedes all production imports, including the native model SDK.
const suiteRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-native-tool-drain-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
const previousFetch = globalThis.fetch;
const unexpectedNetwork: string[] = [];
const workspaces = new Set<string>();
const catalogCleanup: { refresh?: (workspace: string) => Promise<void> } = {};
process.env.BINY_AGENT_DIR = path.join(suiteRoot, "agent");
globalThis.fetch = async (input: string | URL | Request) => {
  unexpectedNetwork.push(input instanceof Request ? input.url : String(input));
  throw new Error("Unexpected network request");
};
after(async () => {
  try {
    if (catalogCleanup.refresh) await Promise.all([...workspaces].map(workspace => catalogCleanup.refresh!(workspace)));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await fs.rm(suiteRoot, { recursive: true, force: true });
  }
  assert.deepEqual(unexpectedNetwork, [], "background work must not swallow attempted network access");
});
const [agentModule, coordinatorModule, configModule, permissionModule, runtimeModule,
  recorderModule, storeModule, registryModule, catalogModule, readModule, bashModule] = await Promise.all([
  import("../src/agent/AgentSession.js"), import("../src/agent/toolExecutionCoordinator.js"),
  import("../src/config/schema.js"), import("../src/permission/PermissionManager.js"),
  import("../src/runtime/InteractiveAgentRuntime.js"), import("../src/session/recorder.js"),
  import("../src/session/store.js"), import("../src/tools/registry.js"),
  import("../src/session/catalog.js"), import("../src/tools/file/readFile.js"),
  import("../src/tools/shell/runCommand.js")
]);
const { AgentSession } = agentModule;
const { ToolExecutionCoordinator } = coordinatorModule;
const { defaultConfig } = configModule;
const { PermissionManager } = permissionModule;
const { InteractiveAgentRuntime } = runtimeModule;
const { SessionRecorder } = recorderModule;
const { ensureAgentDirs } = storeModule;
const { ToolRegistry } = registryModule;
const { refreshSessionIndex } = catalogModule;
const { createReadFileTool } = readModule;
const { createRunCommandTool } = bashModule;
catalogCleanup.refresh = refreshSessionIndex;
type Session = InstanceType<typeof AgentSession>;
type Runtime = InstanceType<typeof InteractiveAgentRuntime>;
type Coordinator = InstanceType<typeof ToolExecutionCoordinator>;

const readId = "native-held-read";
const bashId = "native-unapproved-bash";
const fileContent = "A real native read\n";
const observationMs = 1_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture did not reach ${label}`)), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function pendingFor(promise: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => false, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), observationMs); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fixture(t: TestContext, includeRead = true) {
  const root = await fs.mkdtemp(path.join(suiteRoot, "case-"));
  const workspace = path.join(root, "workspace");
  const target = path.join(workspace, "only-held-native-read.txt");
  const entered = deferred();
  const release = deferred();
  const closed = deferred();
  const io = { opened: 0, readCalls: 0, realReads: 0, closed: 0 };
  const order: string[] = [];
  const events: AgentHostEvent[] = [];
  const waiters = new Set<(event: AgentHostEvent) => void>();
  const coordinators = new Set<Coordinator>();
  const completions: Promise<unknown>[] = [];
  const resources: { agent?: Session; runtime?: Runtime; unsubscribe?: () => void } = {};
  const restore: Array<() => void> = [];
  let bashDispatches = 0;
  workspaces.add(workspace);
  t.after(async () => {
    // Baseline may finish its public stream before its coordinator. Release the
    // I/O gate first, then explicitly join captured real coordinators for cleanup
    // only. This cannot repair the assertions made by the test body.
    release.resolve();
    resources.runtime?.cancelCurrentRun("cancelled");
    try {
      await Promise.allSettled(completions);
      await Promise.all([...coordinators].map(value => value.waitForIdle()));
      if (io.opened > 0) await closed.promise;
      if (resources.runtime) await resources.runtime.close();
      else await resources.agent?.close();
    } finally {
      resources.unsubscribe?.();
      for (const restoreMock of restore.reverse()) restoreMock();
      try { await refreshSessionIndex(workspace); }
      finally {
        workspaces.delete(workspace);
        await fs.rm(root, { recursive: true, force: true });
      }
    }
    assert.equal(bashDispatches, 0, "an unapproved Bash must never reach its execution scope");
  });
  await fs.mkdir(workspace);
  await ensureAgentDirs(workspace);
  await fs.writeFile(target, fileContent);

  // Synchronous, return-identity-preserving observer. No tool or Promise is
  // wrapped. Captured instances are used solely by the teardown above.
  const originalCreateTools = ToolExecutionCoordinator.prototype.createAgentTools;
  const coordinatorObserver = t.mock.method(ToolExecutionCoordinator.prototype, "createAgentTools",
    function (this: Coordinator, ...args: Parameters<Coordinator["createAgentTools"]>) {
      const result = originalCreateTools.apply(this, args);
      coordinators.add(this);
      return result;
    });
  restore.push(() => coordinatorObserver.mock.restore());

  const originalOpen = fs.open;
  const openObserver = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    // Never gate session files, turn storage, the recorder, or another fixture.
    if (args[0] !== target) return handle;
    io.opened++;
    const originalRead = handle.read.bind(handle);
    const originalClose = handle.close.bind(handle);
    const readObserver = t.mock.method(handle, "read", (async (...readArgs: Parameters<FileHandle["read"]>) => {
      io.readCalls++;
      const result = await originalRead(...readArgs);
      io.realReads++;
      if (io.readCalls === 1) {
        entered.resolve();
        // Hold delivery of the real read result, not a fake tool result. This
        // models pending lower-level I/O settlement, not actual slow disk I/O.
        await release.promise;
      }
      return result;
    }) as FileHandle["read"]);
    const closeObserver = t.mock.method(handle, "close", async () => {
      await originalClose();
      io.closed++;
      order.push("read.closed");
      closed.resolve();
    });
    restore.push(() => readObserver.mock.restore(), () => closeObserver.mock.restore());
    return handle;
  });
  restore.push(() => openObserver.mock.restore());

  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "direct";
  config.agent.maxConcurrentTools = 2;
  config.permission.mode = "ask";
  config.permission.allowTools = ["Read"];
  config.permission.allowPaths = [];
  config.hooks.beforeTool = [];
  config.hooks.afterTool = [];
  config.context.maxInputTokens = 1_000_000;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.activity.enabled = false;
  config.diagnostics.enabled = false;
  config.chat.skillExtraction.enabled = false;
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createReadFileTool({ workspaceRoot: workspace, ignore: [] }));
  registry.registerBuiltinTool(createRunCommandTool({ workspaceRoot: workspace, ignore: [] }, undefined, {
    executionScope: () => {
      bashDispatches++;
      throw new Error("Fixture forbids executing Bash; its permission must never be approved");
    }
  }));

  const requests: LanguageModelV4CallOptions[] = [];
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  };
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "fixture", modelId: "native-tool-drain", supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: "text", text: "Auxiliary title" }],
      finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
    async doStream(options) {
      const primary = options.headers?.["x-biny-operation"] === "agent";
      if (primary) requests.push(options);
      const toolBatch = primary && requests.length === 1;
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (toolBatch) {
        if (includeRead) parts.push({ type: "tool-call", toolCallId: readId, toolName: "Read",
          input: JSON.stringify({ path: path.basename(target) }) });
        parts.push({ type: "tool-call", toolCallId: bashId, toolName: "Bash",
          input: JSON.stringify({ command: "echo native-permission-fixture", description: "Never approve this fixture command" }) });
      } else {
        parts.push({ type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: primary ? "Done." : "Auxiliary title" },
          { type: "text-end", id: "answer" });
      }
      parts.push({ type: "finish", finishReason: { unified: toolBatch ? "tool-calls" : "stop", raw: undefined }, usage });
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); }
      }) };
    }
  };
  const model: AgentModel = { provider: "fixture", modelId: "native-tool-drain",
    runtime: "builtin-llama.cpp", dataResidency: "local", supportsTools: true, vercelModel: provider };
  const recorder = new SessionRecorder(workspace);
  const agent = new AgentSession({ workspaceRoot: workspace, config, model, recorder,
    toolRegistry: registry, permissionManager: new PermissionManager(config.permission) });
  resources.agent = agent;
  await agent.initialize();
  // Only unrelated surrounding CommandRuntime services are adapters.
  const runtime = new InteractiveAgentRuntime({ agent, persistenceRoot: workspace,
    refreshSkills: async () => {}, setSubagentParentRunId: () => {}, close: async () => await agent.close()
  } as unknown as ConstructorParameters<typeof InteractiveAgentRuntime>[0]);
  resources.runtime = runtime;
  resources.unsubscribe = runtime.subscribe(update => {
    const event = update.event;
    if (!event) return;
    events.push(event);
    if (event.type === "tool.completed" || event.type === "tool.failed") order.push(`tool:${event.toolCallId}`);
    if (event.type === "run.cancelled" || event.type === "run.completed") order.push(event.type);
    for (const notify of waiters) notify(event);
  });
  async function eventWhere(predicate: (event: AgentHostEvent) => boolean): Promise<AgentHostEvent> {
    const existing = events.find(predicate);
    if (existing) return existing;
    let notify!: (event: AgentHostEvent) => void;
    const pending = new Promise<AgentHostEvent>(resolve => {
      notify = event => { if (predicate(event)) resolve(event); };
      waiters.add(notify);
    });
    try { return await bounded(pending, "public event"); }
    finally { waiters.delete(notify); }
  }
  function submit(input: string) {
    const submitted = runtime.submitPrompt(input);
    completions.push(submitted.completion);
    void submitted.completion.then(() => order.push(`completion:${submitted.runId}`), () => undefined);
    return submitted;
  }
  return { runtime, recorder, submit, eventWhere, requests, events, order, io, entered, release, closed,
    get bashDispatches() { return bashDispatches; } };
}

test("cancelled native turn stays owned until its real Read settles and closes", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const run = f.submit("Read the fixture and request the unapproved command together");
  await bounded(f.entered.promise, "real read entry");
  const permission = await f.eventWhere(event => event.type === "permission.requested" && event.toolCallId === bashId);
  assert.equal(permission.type, "permission.requested");
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.io, { opened: 1, readCalls: 1, realReads: 1, closed: 0 });
  f.runtime.cancelCurrentRun("interrupted");
  await f.eventWhere(event => event.type === "tool.completed" && event.toolCallId === bashId
    && event.executionStatus === "cancelled");
  const idle = f.runtime.waitForIdle();
  // Give real turn/recorder I/O a bounded observation window. On baseline this
  // fails by ordinary early completion, not by waiting forever for the gate.
  assert.equal(await pendingFor(run.completion), true,
    `cancelled run completed before its admitted Read closed: ${f.order.join(", ")}`);
  assert.equal(await pendingFor(idle), true, "waitForIdle must include admitted native I/O");
  assert.equal(f.io.closed, 0);
  assert.equal(f.runtime.getSnapshot().state.kind, "runs");
  assert.throws(() => f.submit("Must stay excluded while old Read drains"), /runtime is busy/u);
  assert.equal(f.events.filter(event => event.type === "run.cancelled" && event.runId === run.runId).length, 0);
  f.release.resolve();
  const outcome = await bounded(run.completion, "cancelled run after read release");
  await bounded(idle, "public idle after read release");
  assert.equal(outcome.status, "cancelled", JSON.stringify(outcome));
  assert.equal(f.io.closed, 1);
  assert.equal(f.io.readCalls, 1, "cancelled read must not start another chunk");
  const readDone = f.events.filter(event => event.type === "tool.completed" && event.toolCallId === readId);
  assert.equal(readDone.length, 1);
  assert.equal(readDone[0]?.type === "tool.completed" ? readDone[0].executionStatus : undefined, "cancelled");
  assert.equal(readDone[0]?.runId, run.runId, "the draining Read belongs to its original run");
  assert.ok(f.order.indexOf("read.closed") < f.order.indexOf(`tool:${readId}`));
  assert.ok(f.order.indexOf(`tool:${readId}`) < f.order.indexOf("run.cancelled"),
    "late native tool terminal must be forwarded before the turn terminal");
  assert.ok(f.order.indexOf("run.cancelled") < f.order.indexOf(`completion:${run.runId}`));
  assert.equal(f.events.filter(event => event.type === "run.cancelled" && event.runId === run.runId).length, 1);
  assert.equal(f.bashDispatches, 0);
  const next = f.submit("A normal next turn");
  const nextOutcome = await bounded(next.completion, "next normal turn");
  assert.equal(nextOutcome.status, "completed");
  assert.equal(nextOutcome.output, "Done.");
  await f.runtime.waitForIdle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.events.filter(event => event.runId === next.runId && event.type.startsWith("tool.")).length, 0);
  assert.equal(f.io.closed, 1);
  assert.equal(f.runtime.getSnapshot().state.kind, "idle");
});

test("normal native Read returns its real contents after gate release", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const run = f.submit("Read with a separate denied command");
  await bounded(f.entered.promise, "normal real read entry");
  const permission = await f.eventWhere(event => event.type === "permission.requested" && event.toolCallId === bashId);
  assert.ok(permission.type === "permission.requested");
  f.runtime.answerPermission(permission.requestId, { approved: false, action: "deny", scope: "once", message: "Fixture denies all shell execution" });
  await f.eventWhere(event => (event.type === "tool.completed" || event.type === "tool.failed") && event.toolCallId === bashId);
  assert.equal(await pendingFor(run.completion), true);
  assert.equal(f.io.closed, 0);
  f.release.resolve();
  assert.equal((await bounded(run.completion, "normal run after read release")).status, "completed");
  await f.runtime.waitForIdle();
  const readDone = f.events.find(event => event.type === "tool.completed" && event.toolCallId === readId);
  assert.ok(readDone?.type === "tool.completed");
  assert.equal(readDone.executionStatus, "succeeded");
  assert.equal((readDone.result as { content?: unknown }).content, fileContent.trimEnd());
  assert.equal(f.io.opened, 1);
  assert.equal(f.io.closed, 1);
  assert.ok(f.io.realReads >= 1);
  assert.equal(f.bashDispatches, 0);
});

test("permission-only native cancellation releases approval and admits the next turn", { timeout: 30_000 }, async t => {
  const f = await fixture(t, false);
  const run = f.submit("Request the unapproved command");
  await f.eventWhere(event => event.type === "permission.requested" && event.toolCallId === bashId);
  f.runtime.cancelCurrentRun("interrupted");
  assert.equal((await bounded(run.completion, "permission-only cancellation")).status, "cancelled");
  await f.runtime.waitForIdle();
  assert.equal(f.io.opened, 0);
  assert.equal(f.bashDispatches, 0);
  const resolved = f.events.filter(event => event.type === "permission.resolved" && event.toolCallId === bashId);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.type === "permission.resolved" ? resolved[0].approved : undefined, false);
  const next = f.submit("Continue normally after cancelled permission");
  const nextOutcome = await bounded(next.completion, "turn after cancelled permission");
  assert.equal(nextOutcome.status, "completed");
  assert.equal(nextOutcome.output, "Done.");
  await f.runtime.waitForIdle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.events.filter(event => event.runId === next.runId && event.type.startsWith("tool.")).length, 0);
  assert.equal(f.runtime.getSnapshot().state.kind, "idle");
});
