import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentTurnCancellationError, type AgentSessionEvent } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { replaySessionEvents, replayStoredSession } from "../src/session/replay.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

type Entry = "direct" | "host";
type Failure = "preflight-abort" | "initial-save";
const answer = (text: string): ModelStreamEvent[] => [{ type: "text-delta", text }, { type: "finish", reason: "stop" }];
async function drain(stream: AsyncGenerator<AgentSessionEvent>) {
  const events: AgentSessionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events.reverse().find(event => event.type === "done")?.outcome;
}
async function readCheckpoint(file: string) {
  try { return await fs.readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function containsOnce(messages: readonly AgentMessage[], marker: string) {
  assert.equal(messages.filter(message => JSON.stringify(message).includes(marker)).length, 1, marker);
}
async function fixture(t: TestContext, oldCheckpoint = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-retry-preflight-"));
  await ensureAgentDirs(root);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const config = configSchema.parse({ ...defaultConfig,
    activity: { ...defaultConfig.activity, enabled: false }, diagnostics: { ...defaultConfig.diagnostics, enabled: false },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    permission: { ...defaultConfig.permission, mode: "full-access" },
    context: { ...defaultConfig.context, maxInputTokens: 1_000_000,
      identity: { ...defaultConfig.context.identity, enabled: false },
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const requests: AgentMessage[][] = [];
  let tools = 0;
  let response: () => Promise<ModelStreamEvent[]> = async () => answer("ORIGINAL_ANSWER");
  const registry = new ToolRegistry();
  registry.register({ name: "prior_probe", description: "Synthetic local read", risk: "read", schema: z.object({}),
    parameters: { type: "object", properties: {}, required: [] },
    resolveExecution: () => ({ approvalRule: "prior_probe", retrySafety: "safe", accesses: [],
      execute: async () => { tools += 1; return { marker: "PRIOR_TOOL_FACT" }; } }) });
  const agent = new AgentSession({ workspaceRoot: root, config, recorder: new SessionRecorder(root),
    permissionManager: new PermissionManager(config.permission), toolRegistry: registry,
    model: { provider: "synthetic", modelId: "preflight-context-retention", supportsTools: true,
      stream: async (context, options) => {
        const events = options?.requestContext?.operation === "agent"
          ? (requests.push(structuredClone(context.messages)), await response()) : answer("AUXILIARY");
        return (async function* () { yield* events; })();
      } } });
  const runtime = new InteractiveAgentRuntime({ agent, persistenceRoot: root, refreshSkills: async () => {},
    setSubagentParentRunId: () => {}, close: async () => await agent.close()
  } as unknown as ConstructorParameters<typeof InteractiveAgentRuntime>[0]);
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  await agent.initialize();
  let step = 0;
  response = async () => ++step === 1
    ? [{ type: "tool-call", id: "prior-call", name: "prior_probe", arguments: {} }, { type: "finish", reason: "tool-calls" }]
    : answer("ORIGINAL_ANSWER");
  assert.equal((await drain(agent.prompt("ORIGINAL_REQUEST", { emotionAnalysis: false })))?.status, "completed");
  const info = agent.getInfo();
  const original = [...await readSessionEvents(info.sessionFile)].reverse().find(event => event.type === "agent_message")!.messageId!;
  response = async () => answer("LATER_ANSWER");
  assert.equal((await drain(agent.prompt("LATER_CONSTRAINT_DO_NOT_REPEAT", { emotionAnalysis: false })))?.status, "completed");
  const markers = ["ORIGINAL_REQUEST", "PRIOR_TOOL_FACT", "ORIGINAL_ANSWER", "LATER_CONSTRAINT_DO_NOT_REPEAT", "LATER_ANSWER"];
  if (oldCheckpoint) {
    response = async () => [{ type: "text-delta", text: "OLD_CHECKPOINT_ANSWER" }, { type: "finish", reason: "length" }];
    assert.equal((await drain(agent.prompt("OLD_CHECKPOINT_INPUT", { emotionAnalysis: false })))?.status, "incomplete");
    markers.push("OLD_CHECKPOINT_INPUT", "OLD_CHECKPOINT_ANSWER");
  }
  const selected = replaySessionEvents(await readSessionEvents(info.sessionFile));
  const latest = selected.messageReferences.at(-1)!.id!;
  const checkpointPath = path.join(agentDir(root), "turns", `${info.sessionId}.json`);
  const run = async (entry: Entry, input: string) => entry === "host"
    ? await runtime.submitPrompt(input).completion : await drain(agent.prompt(input, { emotionAnalysis: false }));
  return { root, agent, runtime, config, info, original, latest, markers, checkpointPath, requests, run,
    toolCount: () => tools, setResponse(value: typeof response) { response = value; },
    assertHistory(messages: readonly AgentMessage[]) { for (const marker of markers) containsOnce(messages, marker); } };
}
async function failRetry(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, entry: Entry, failure: Failure, target: string) {
  const checkpointBefore = await readCheckpoint(f.checkpointPath);
  const calls = f.requests.length;
  const rename = fs.rename;
  let injected = false;
  const mocked = failure === "initial-save" ? t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!injected && String(args[1]) === f.checkpointPath) {
      injected = true;
      throw Object.assign(new Error("Synthetic ENOSPC before checkpoint rename"), { code: "ENOSPC" });
    }
    return await rename(...args);
  }) : undefined;
  try {
    if (entry === "host") {
      const submitted = f.runtime.submitPrompt("ORIGINAL_REQUEST", [], { retryOfMessageId: target });
      if (failure === "preflight-abort") assert.equal(f.runtime.cancelRun(submitted.runId, "cancelled"), true);
      assert.equal((await submitted.completion).status, failure === "preflight-abort" ? "cancelled" : "failed");
    } else if (failure === "preflight-abort") {
      const controller = new AbortController(); controller.abort(new AgentTurnCancellationError("cancelled"));
      await assert.rejects(drain(f.agent.retry(target, { abortSignal: controller.signal, emotionAnalysis: false })), AgentTurnCancellationError);
    } else assert.equal((await drain(f.agent.retry(target, { emotionAnalysis: false })))?.status, "failed");
  } finally { mocked?.mock.restore(); }
  assert.equal(injected, failure === "initial-save");
  assert.equal(f.requests.length, calls, "failed retry must not dispatch a provider request");
  assert.equal(f.toolCount(), 1);
  assert.deepEqual(await readCheckpoint(f.checkpointPath), checkpointBefore, "old checkpoint bytes or absence remain untouched");
  f.assertHistory((await replayStoredSession(f.root, f.info.sessionId)).messages);
}

for (const entry of ["direct", "host"] as const) for (const failure of ["preflight-abort", "initial-save"] as const) {
  for (const [target, oldCheckpoint] of [["latest", false], ["original", true]] as const) {
    test(`${entry} ${failure} ${target} retry preserves two fresh contexts with ${oldCheckpoint ? "old" : "missing"} checkpoint`, async t => {
      const f = await fixture(t, oldCheckpoint);
      await failRetry(t, f, entry, failure, f[target]);
      f.setResponse(async () => answer("FRESH_ANSWER"));
      assert.equal((await f.run(entry, "FRESH_INPUT"))?.status, "completed");
      f.assertHistory(f.requests.at(-1)!);
      const fresh = (await readSessionEvents(f.info.sessionFile)).find((event): event is Extract<SessionEvent, { type: "user_message" }> =>
        event.type === "user_message" && !event.auditOnly && event.content === "FRESH_INPUT");
      assert.equal(fresh?.parentMessageId, f.latest);
      assert.equal((await f.run(entry, "FOLLOWING_INPUT"))?.status, "completed");
      f.assertHistory(f.requests.at(-1)!); containsOnce(f.requests.at(-1)!, "FRESH_INPUT"); containsOnce(f.requests.at(-1)!, "FRESH_ANSWER");
      const cold = await f.agent.resume(f.info.sessionId);
      f.assertHistory(cold.messages); containsOnce(cold.messages, "FRESH_INPUT"); containsOnce(cold.messages, "FOLLOWING_INPUT");
      assert.equal(f.toolCount(), 1);
    });
  }
  for (const nextFailure of ["provider-error", "provider-cancel"] as const) {
    if (failure !== "preflight-abort" || nextFailure !== (entry === "direct" ? "provider-error" : "provider-cancel")) continue;
    test(`${entry} ${failure} retry retains selected context after fresh ${nextFailure}`, async t => {
      const f = await fixture(t, true); await failRetry(t, f, entry, failure, f.original);
      const controller = new AbortController();
      f.setResponse(async () => {
        if (nextFailure === "provider-cancel") {
          if (entry === "host") f.runtime.cancelCurrentRun("cancelled");
          else controller.abort(new AgentTurnCancellationError("cancelled"));
        }
        throw new Error("Synthetic next-provider failure");
      });
      const outcome = entry === "host" ? await f.runtime.submitPrompt("FAILED_FRESH_INPUT").completion
        : await drain(f.agent.prompt("FAILED_FRESH_INPUT", { abortSignal: controller.signal, emotionAnalysis: false }));
      assert.equal(outcome?.status, nextFailure === "provider-cancel" ? "cancelled" : "failed");
      f.assertHistory(f.requests.at(-1)!);
      f.setResponse(async () => answer("AFTER_FAILURE_ANSWER"));
      assert.equal((await f.run(entry, "AFTER_FAILURE_INPUT"))?.status, "completed");
      f.assertHistory(f.requests.at(-1)!); assert.equal(f.toolCount(), 1);
    });
  }
  if (failure === (entry === "direct" ? "preflight-abort" : "initial-save")) test(`${entry} ${failure} leaves explicit exact retry prefix semantics unchanged`, async t => {
    const f = await fixture(t, true); await failRetry(t, f, entry, failure, f.original);
    f.setResponse(async () => answer("REPLACEMENT_ANSWER"));
    const outcome = entry === "host" ? await f.runtime.submitPrompt("ORIGINAL_REQUEST", [], { retryOfMessageId: f.original }).completion
      : await drain(f.agent.retry(f.original, { emotionAnalysis: false }));
    assert.equal(outcome?.status, "completed");
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /ORIGINAL_ANSWER|LATER_CONSTRAINT|LATER_ANSWER|OLD_CHECKPOINT/u);
    containsOnce(f.requests.at(-1)!, "PRIOR_TOOL_FACT");
    assert.equal((await f.run(entry, "AFTER_RETRY_INPUT"))?.status, "completed");
    containsOnce(f.requests.at(-1)!, "REPLACEMENT_ANSWER");
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /ORIGINAL_ANSWER|LATER_CONSTRAINT|LATER_ANSWER|OLD_CHECKPOINT/u);
    assert.equal(f.toolCount(), 1);
  });
}
for (const entry of ["direct", "host"] as const) {
  test(`${entry} successful retry leaves the following ordinary admission on its fast path`, async t => {
    const f = await fixture(t); f.setResponse(async () => answer("SUCCESSFUL_RETRY_ANSWER"));
    const outcome = entry === "host" ? await f.runtime.submitPrompt("ORIGINAL_REQUEST", [], { retryOfMessageId: f.original }).completion
      : await drain(f.agent.retry(f.original, { emotionAnalysis: false }));
    assert.equal(outcome?.status, "completed");
    const readFile = fs.readFile; let checkpointReads = 0;
    const mocked = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === f.checkpointPath) { checkpointReads += 1; throw new Error("ordinary fast path must not read replacement witness"); }
      return await readFile(...args);
    });
    try { assert.equal((await f.run(entry, "AFTER_SUCCESS_INPUT"))?.status, "completed"); }
    finally { mocked.mock.restore(); }
    assert.equal(checkpointReads, 0); containsOnce(f.requests.at(-1)!, "SUCCESSFUL_RETRY_ANSWER");
  });
  test(`${entry} ordinary admission without retry retains its checkpoint-read-free path`, async t => {
    const f = await fixture(t, true); f.setResponse(async () => answer("ORDINARY_ANSWER"));
    const readFile = fs.readFile; let checkpointReads = 0;
    const mocked = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === f.checkpointPath) { checkpointReads += 1; throw new Error("ordinary fast path must not read replacement witness"); }
      return await readFile(...args);
    });
    try { assert.equal((await f.run(entry, "ORDINARY_INPUT"))?.status, "completed"); }
    finally { mocked.mock.restore(); }
    assert.equal(checkpointReads, 0); f.assertHistory(f.requests.at(-1)!);
  });
}
for (const failure of ["initial-save"] as const) {
  test(`${failure} preserves old interrupted task for explicit continuation`, async t => {
    const f = await fixture(t, true); await failRetry(t, f, "direct", failure, f.original);
    const saved = await new TurnStore(f.root, f.info.sessionId).load(); assert.ok(saved && !saved.retryOrigin);
    f.setResponse(async () => answer("CONTINUED_ANSWER"));
    assert.equal((await drain(f.agent.continueInterruptedTurn({ emotionAnalysis: false })))?.status, "completed");
    f.assertHistory(f.requests.at(-1)!); assert.equal(f.toolCount(), 1);
  });
}

// User-target IDs are the actual Desktop edit contract. Assistant-target cases
// retain a small compatibility witness for the lower-level public API.
const editScenarios = [
  { priorFailure: undefined, editTarget: "user", editResult: "completed" },
  { priorFailure: "initial-save", editTarget: "user", editResult: "completed" },
  ...(["completed", "incomplete", "preflight-abort", "initial-save", "provider-error", "provider-cancel"] as const)
    .map(editResult => ({ priorFailure: "preflight-abort", editTarget: "user", editResult } as const)),
  { priorFailure: "preflight-abort", editTarget: "assistant", editResult: "completed" }
] as const;
for (const entry of ["direct", "host"] as const) for (const { priorFailure, editTarget, editResult } of editScenarios) {
    test(`${entry} ${String(priorFailure)} retry then ${editResult} ${editTarget}-target edit replaces the installed view hint`, async t => {
      const f = await fixture(t);
      if (priorFailure) await failRetry(t, f, entry, priorFailure, f.original);
      const source = (await readSessionEvents(f.info.sessionFile)).find((event): event is Extract<SessionEvent, { type: "user_message" }> =>
        event.type === "user_message" && !event.auditOnly && event.content === "ORIGINAL_REQUEST");
      assert.ok(source?.messageId);
      const editTargetId = editTarget === "user" ? source.messageId : f.original;
      const controller = new AbortController();
      if (editResult === "preflight-abort") controller.abort(new AgentTurnCancellationError("cancelled"));
      f.setResponse(async () => {
        if (editResult === "provider-cancel") {
          if (entry === "host") f.runtime.cancelCurrentRun("cancelled");
          else controller.abort(new AgentTurnCancellationError("cancelled"));
        }
        if (editResult.startsWith("provider-")) throw new Error("Synthetic edit provider error");
        return editResult === "incomplete" ? [{ type: "text-delta", text: "EDIT_ANSWER" }, { type: "finish", reason: "length" }] : answer("EDIT_ANSWER");
      });
      const rename = fs.rename; let checkpointSaves = 0; let injected = false;
      const mocked = editResult === "initial-save" ? t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === f.checkpointPath && ++checkpointSaves === (entry === "host" ? 2 : 1)) {
          injected = true; throw Object.assign(new Error("Synthetic post-prefix edit checkpoint failure"), { code: "ENOSPC" });
        }
        return await rename(...args);
      }) : undefined;
      let outcome;
      try {
        if (entry === "host") {
          const run = f.runtime.submitPrompt("EDIT_REPLACEMENT_INPUT", [], { retryOfMessageId: editTargetId, replaceUserMessageId: source.messageId });
          if (editResult === "preflight-abort") assert.equal(f.runtime.cancelRun(run.runId, "cancelled"), true);
          outcome = await run.completion;
        } else {
          const stream = f.agent.retry(editTargetId, { replaceUserMessageId: source.messageId, replacementInput: "EDIT_REPLACEMENT_INPUT",
            abortSignal: controller.signal, emotionAnalysis: false });
          if (editResult === "preflight-abort") await assert.rejects(drain(stream), AgentTurnCancellationError);
          else outcome = await drain(stream);
        }
      } finally { mocked?.mock.restore(); }
      if (outcome) assert.equal(outcome.status, editResult === "completed" || editResult === "incomplete" ? editResult
        : editResult === "provider-cancel" || editResult === "preflight-abort" ? "cancelled" : "failed");
      assert.equal(injected, editResult === "initial-save");
      f.setResponse(async () => answer("AFTER_EDIT_ANSWER"));
      assert.equal((await f.run(entry, "AFTER_EDIT_INPUT"))?.status, "completed");
      if (editTarget === "assistant") containsOnce(f.requests.at(-1)!, "PRIOR_TOOL_FACT");
      else assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /PRIOR_TOOL_FACT/u);
      assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /ORIGINAL_ANSWER|LATER_CONSTRAINT_DO_NOT_REPEAT|LATER_ANSWER/u,
        "The next ordinary request must not resurrect the branch abandoned by the installed edit view");
      if (editResult === "completed" || editResult === "incomplete" || editResult === "provider-cancel") containsOnce(f.requests.at(-1)!, "EDIT_REPLACEMENT_INPUT");
      if (editResult === "completed" || editResult === "incomplete") containsOnce(f.requests.at(-1)!, "EDIT_ANSWER");
      assert.equal(f.toolCount(), 1);
    });
}
for (const entry of ["direct", "host"] as const) {
  test(`${entry} rejected edit before prefix installation keeps the pending retry-view hint`, async t => {
    const f = await fixture(t, true); await failRetry(t, f, entry, "preflight-abort", f.original);
    const before = await readCheckpoint(f.checkpointPath); const requests = f.requests.length;
    if (entry === "host") assert.equal((await f.runtime.submitPrompt("INVALID_EDIT", [], {
      retryOfMessageId: "missing-target", replaceUserMessageId: "missing-user"
    }).completion).status, "failed");
    else await assert.rejects(drain(f.agent.retry("missing-target", { replaceUserMessageId: "missing-user", replacementInput: "INVALID_EDIT", emotionAnalysis: false })), /not on the active/u);
    assert.deepEqual(await readCheckpoint(f.checkpointPath), before); assert.equal(f.requests.length, requests);
    f.setResponse(async () => answer("AFTER_REJECTED_EDIT_ANSWER"));
    assert.equal((await f.run(entry, "AFTER_REJECTED_EDIT_INPUT"))?.status, "completed");
    f.assertHistory(f.requests.at(-1)!);
  });
}
for (const [entry, editStatus] of [["direct", "incomplete"], ["host", "paused"]] as const) {
  test(`${entry} ${editStatus} user-target edit after failed retry remains explicitly continuable`, async t => {
    const f = await fixture(t); await failRetry(t, f, entry, "preflight-abort", f.original);
    const source = (await readSessionEvents(f.info.sessionFile)).find((event): event is Extract<SessionEvent, { type: "user_message" }> =>
      event.type === "user_message" && !event.auditOnly && event.content === "ORIGINAL_REQUEST");
    assert.ok(source?.messageId); const controller = new AbortController();
    f.setResponse(async () => {
      if (editStatus === "paused") {
        if (entry === "host") f.runtime.cancelCurrentRun("paused");
        else controller.abort(new AgentTurnCancellationError("paused"));
        throw new AgentTurnCancellationError("paused");
      }
      return [{ type: "text-delta", text: "EDIT_PARTIAL_ANSWER" }, { type: "finish", reason: "length" }];
    });
    const edit = entry === "host" ? await f.runtime.submitPrompt("EDIT_TASK_TO_CONTINUE", [], {
      retryOfMessageId: source.messageId, replaceUserMessageId: source.messageId
    }).completion : await drain(f.agent.retry(source.messageId, { replaceUserMessageId: source.messageId,
      replacementInput: "EDIT_TASK_TO_CONTINUE", abortSignal: controller.signal, emotionAnalysis: false }));
    assert.equal(edit?.status, editStatus === "paused" ? "cancelled" : "incomplete");
    f.setResponse(async () => answer("EDIT_CONTINUED_ANSWER"));
    const continued = entry === "host" ? await f.runtime.continueInterruptedTurn()
      : await drain(f.agent.continueInterruptedTurn({ emotionAnalysis: false }));
    assert.equal(continued?.status, "completed");
    containsOnce(f.requests.at(-1)!, "EDIT_TASK_TO_CONTINUE");
    if (editStatus === "incomplete") containsOnce(f.requests.at(-1)!, "EDIT_PARTIAL_ANSWER");
    assert.equal(f.toolCount(), 1);
  });
}
for (const kind of ["legacy-assistant", "tool-result"] as const) for (const entry of ["direct", "host"] as const) {
  test(`${entry} successful ${kind} retry retires its hint without a typed origin`, async t => {
    const f = await fixture(t);
    let agent = f.agent; let runtime = f.runtime;
    let target = (await readSessionEvents(f.info.sessionFile)).find((event): event is Extract<SessionEvent, { type: "agent_message" }> => event.type === "agent_message" && event.message.role === "toolResult")?.messageId;
    let response: () => Promise<ModelStreamEvent[]>;
    if (kind === "legacy-assistant") {
      await f.runtime.close();
      // A valid legacy log has the same canonical messages without runtime IDs.
      // Reopen it through the public API; no live domain state is fabricated.
      const events: SessionEvent[] = (await fs.readFile(f.info.sessionFile, "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as SessionEvent);
      for (const event of events) delete event.runtime;
      await fs.writeFile(f.info.sessionFile, events.map(event => JSON.stringify(event)).join("\n") + "\n");
      agent = new AgentSession({ workspaceRoot: f.root, config: f.config, recorder: new SessionRecorder(f.root),
        toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(f.config.permission),
        model: { provider: "synthetic", modelId: "legacy-preflight-retirement", supportsTools: true,
          stream: async (context, options) => {
            const output = options?.requestContext?.operation === "agent"
              ? (f.requests.push(structuredClone(context.messages)), await response()) : answer("AUXILIARY");
            return (async function* () { yield* output; })();
          } } });
      await agent.initialize(); await agent.resume(f.info.sessionId);
      runtime = new InteractiveAgentRuntime({ agent, persistenceRoot: f.root, refreshSkills: async () => {},
        setSubagentParentRunId: () => {}, close: async () => await agent.close()
      } as unknown as ConstructorParameters<typeof InteractiveAgentRuntime>[0]);
      target = f.original;
    }
    assert.ok(target);
    response = async () => {
      const saved = await new TurnStore(f.root, f.info.sessionId).load();
      assert.ok(saved); assert.equal(saved.retryOrigin, undefined);
      return answer("ORIGINLESS_RETRY_ANSWER");
    };
    f.setResponse(async () => await response());
    try {
      const retried = entry === "host" ? await runtime.submitPrompt("ORIGINAL_REQUEST", [], { retryOfMessageId: target }).completion
        : await drain(agent.retry(target, { emotionAnalysis: false }));
      assert.equal(retried?.status, "completed");
      response = async () => answer("AFTER_ORIGINLESS_ANSWER");
      const readFile = fs.readFile; let checkpointReads = 0;
      const mocked = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === f.checkpointPath) checkpointReads += 1;
        return await readFile(...args);
      });
      try {
        const next = entry === "host" ? await runtime.submitPrompt("AFTER_ORIGINLESS_INPUT").completion
          : await drain(agent.prompt("AFTER_ORIGINLESS_INPUT", { emotionAnalysis: false }));
        assert.equal(next?.status, "completed");
      } finally { mocked.mock.restore(); }
      assert.equal(checkpointReads, 0, "a successful retry must not leave a stale rebind hint");
      containsOnce(f.requests.at(-1)!, "ORIGINLESS_RETRY_ANSWER");
      assert.equal(f.toolCount(), 1);
    } finally { if (runtime !== f.runtime) await runtime.close(); }
  });
}
