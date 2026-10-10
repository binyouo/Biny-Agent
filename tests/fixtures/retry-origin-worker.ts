/** Public retry/process-crash fixture; all providers and tools are isolated local stand-ins. */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildSessionTimeline } from "../../src/desktop/renderer/src/sessionTimeline.js";
import { AgentSession } from "../../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../../src/agent/core/types.js";
import type { AgentSessionEvent } from "../../src/agent/types.js";
import { defaultConfig, configSchema } from "../../src/config/schema.js";
import { PermissionManager } from "../../src/permission/PermissionManager.js";
import { readSessionEvents } from "../../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../../src/session/recorder.js";
import { replaySessionEvents } from "../../src/session/replay.js";
import { ensureAgentDirs, agentDir } from "../../src/session/store.js";
import { TurnStore, type InterruptedTurn } from "../../src/session/turnStore.js";
import { createCommandRuntime } from "../../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../../src/runtime/InteractiveAgentRuntime.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const [mode, root, sessionId, scenario, boundary, marker] = process.argv.slice(2);
assert.ok(mode && root && sessionId && scenario && boundary && marker);
await ensureAgentDirs(root);
const checkpointPath = path.join(agentDir(root), "turns", `${sessionId}.json`);
const effectPath = path.join(root, "executions.jsonl");
const config = configSchema.parse({ ...defaultConfig,
  activity: { ...defaultConfig.activity, enabled: false }, diagnostics: { ...defaultConfig.diagnostics, enabled: false },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }, crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
  permission: { ...defaultConfig.permission, mode: "full-access" }, agent: { ...defaultConfig.agent, maxConcurrentTools: 2 },
  context: { ...defaultConfig.context, maxInputTokens: 1_000_000,
    memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }, identity: { ...defaultConfig.context.identity, enabled: false } }
});
let phase = "original";
let finalPath = "";
let owner: string | undefined;
const requests: Array<{ phase: string; messages: AgentMessage[]; step?: number }> = [];
const sink = { appendSessionEvent({ event: raw }: { event: unknown }) {
  if (mode !== "capture" || phase !== "retry" || !existsSync(checkpointPath)) return;
  const event = raw as SessionEvent;
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as { turn: InterruptedTurn };
  owner = checkpoint.turn.retryOrigin?.ownerTurnId ?? checkpoint.turn.turnId;
  if (event.runtime?.turnId !== owner) return;
  const final = event.type === "agent_message" && event.retryOfMessageId !== undefined;
  if ((boundary === "final" || boundary === "phase-prefix" || boundary === "phase-no-audit") && final || boundary === "selection" && event.type === "message_version_selected"
    || boundary === "audit" && event.type === "assistant_message" && event.messageId === "reserved-retry-final"
    || boundary === "terminal" && event.type === "turn_status" && event.status === "completed") capture();
} };
function capture(): never {
  const checkpoint = existsSync(checkpointPath) ? readFileSync(checkpointPath, "utf8") : undefined;
  writeFileSync(marker!, JSON.stringify({ log: readFileSync(finalPath, "utf8"), checkpoint, requests, owner, finalPath, checkpointPath }));
  // Final/selection/terminal sinks run after recordAndFlush fsync. Public admission,
  // provider and tool callbacks explicitly flush before they invoke this helper.
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL returned");
}
const registry = new ToolRegistry();
let entered!: () => void;
const slowEntered = new Promise<void>(resolve => { entered = resolve; });
for (const name of ["original_probe", "primer_probe", "fast_probe", "slow_probe", "retry_probe"]) registry.register({
  name, description: "Synthetic retry recovery fixture", risk: scenario.includes("unsafe") && name === "slow_probe" ? "write" : "read",
  schema: z.object({}), parameters: { type: "object", properties: {}, required: [] },
  resolveExecution: () => ({ approvalRule: name, retrySafety: scenario.includes("unsafe") && name === "slow_probe" ? "unsafe" : "safe", accesses: [], execute: async () => {
    appendFileSync(effectPath, `${JSON.stringify({ mode, phase, name })}\n`);
    if (mode === "capture" && boundary === "partial") {
      if (name === "slow_probe") { entered(); await new Promise<void>(() => {}); }
      if (name === "fast_probe") await slowEntered;
    }
    return { marker: `${name}-durable-result` };
  } })
});
const answer = (text: string): ModelStreamEvent[] => [{ type: "text-delta", text }, { type: "finish", reason: "stop" }];
const call = (id: string, name = `${id}_probe`): ModelStreamEvent[] => [{ type: "tool-call", id, name, arguments: {} }, { type: "finish", reason: "tool-calls" }];
let responses: ModelStreamEvent[][] = scenario.includes("originaltools") ? [call("original"), answer("ORIGINAL_ANSWER")] : [answer("ORIGINAL_ANSWER")];
const model: AgentModel = { provider: "synthetic", modelId: "retry-origin", runtime: "builtin-llama.cpp", dataResidency: "local", supportsTools: true,
  stream: async (context, options) => {
    assert.equal(options?.requestContext?.operation, "agent");
    requests.push({ phase, messages: structuredClone(context.messages), step: options?.requestContext?.step });
    if (mode === "capture" && phase === "retry" && boundary === "dispatch") { await recorder.flush(); capture(); }
    return (async function* () { yield* responses.shift() ?? answer("RECOVERED_ANSWER"); })();
  }
};
const recorder = new SessionRecorder(root, mode === "capture" ? sessionId : undefined, undefined, sink);
const session = new AgentSession({ workspaceRoot: root, recorder, runtimeEventSink: sink, config, model, toolRegistry: registry,
  permissionManager: new PermissionManager(config.permission) });
const drain = async (stream: AsyncGenerator<AgentSessionEvent>): Promise<AgentSessionEvent[]> => {
  const events: AgentSessionEvent[] = []; for await (const event of stream) events.push(event); return events;
};
const keepAlive = setInterval(() => {}, 1000);
try {
  await session.initialize();
  if (mode === "capture") {
    finalPath = recorder.filePath;
    const initial = await drain(session.prompt("ORIGINAL_REQUEST", { emotionAnalysis: false }));
    assert.equal(initial.findLast(event => event.type === "done")?.outcome.status, "completed");
    await recorder.flush();
    const original = (await readSessionEvents(finalPath)).findLast(event => event.type === "agent_message" && event.message.role === "assistant");
    assert.ok(original?.type === "agent_message" && original.messageId);
    if (scenario.includes("older")) {
      responses = [answer("NEWER_ANSWER")];
      await drain(session.retry(original.messageId, { emotionAnalysis: false }));
      await recorder.flush();
      const newer = (await readSessionEvents(finalPath)).findLast(event => event.type === "agent_message" && event.message.role === "assistant");
      assert.ok(newer?.type === "agent_message" && newer.messageId);
      await session.switchMessageVersion(newer.messageId, "prev");
    }
    phase = "retry";
    responses = boundary === "partial" ? [
      ...Array.from({ length: scenario.includes("multistep") ? 2 : scenario.includes("primer") ? 1 : 0 }, (_, index) => call(`primer-${index}`, "primer_probe")),
      [{ type: "tool-call", id: "fast", name: "fast_probe", arguments: {} },
        { type: "tool-call", id: "slow", name: "slow_probe", arguments: {} }, { type: "finish", reason: "tool-calls" }]
    ] : [call("retry"), scenario.includes("tool-calls-phase")
      ? [{ type: "text-delta", text: "TOOL_FREE_INCOMPLETE_REPLY" }, { type: "finish", reason: "tool-calls" }]
      : scenario.includes("incomplete-phase")
      ? [{ type: "text-delta", text: "INCOMPLETE_REPLY" }, { type: "finish", reason: "length" }]
      : scenario.includes("empty-phase") ? [{ type: "finish", reason: "stop" }] : answer("RETRY_ANSWER")];
    const stream = scenario.includes("ordinary") ? session.prompt("NEW_USER_REQUEST", { emotionAnalysis: false })
      : session.retry(original.messageId, { emotionAnalysis: false, messageId: "reserved-retry-final" });
    for await (const event of stream) {
      if (event.type === "error") assert.fail(event.message);
      if (boundary === "admission" && event.type === "preparation.updated") {
        const checkpoint = await new TurnStore(root, sessionId).load();
        if (checkpoint?.retryOrigin) { assert.ok(checkpoint.systemPrompt); owner = checkpoint.turnId; await recorder.flush(); capture(); }
      }
      if (boundary === "partial" && event.type === "tool.completed" && event.toolCallId === "fast") {
        await recorder.flush(); owner = (await new TurnStore(root, sessionId).load())?.turnId; capture();
      }
      if (boundary === "clear" && event.type === "done") { assert.equal(await new TurnStore(root, sessionId).load(), undefined); await recorder.flush(); capture(); }
    }
    assert.fail(`Crash boundary ${boundary} not reached`);
  } else {
    assert.equal(mode, "recover");
    const captured = JSON.parse(await readFile(marker, "utf8")) as { log: string; checkpoint?: string; finalPath: string; owner?: string };
    finalPath = captured.finalPath; owner = captured.owner;
    assert.equal(await readFile(finalPath, "utf8"), captured.log);
    assert.equal(existsSync(checkpointPath) ? await readFile(checkpointPath, "utf8") : undefined, captured.checkpoint);
    const executions = existsSync(effectPath) ? await readFile(effectPath, "utf8") : "";
    phase = "recover"; responses = [answer("RECOVERED_ANSWER")];
    const cold = await session.resume(sessionId);
    if (scenario.includes("runtime")) {
      let fetchCalls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { fetchCalls += 1; throw new Error("No network is allowed in phase completion"); };
      const runtimeConfig = configSchema.parse({ ...config, defaultModel: "synthetic", toolModel: undefined,
        providers: { fixture: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "fixture-key" } },
        models: { synthetic: { ...defaultConfig.models["deepseek-v4-flash"], provider: "fixture", model: "synthetic", displayName: "Synthetic" } },
        checkpoints: { enabled: false } });
      const commands = await createCommandRuntime(root, { sessionId: "runtime-reader", configStore: {
        load: async () => runtimeConfig, save: async () => undefined
      } });
      const runtime = new InteractiveAgentRuntime(commands);
      try {
        await runtime.resumeSession(sessionId);
        const submission = await runtime.startInterruptedTurn({ runId: "host-continuation-run", messageId: "host-new-window-id" });
        assert.ok(submission);
        const result = await submission.completion;
        assert.equal(result.status, "completed", JSON.stringify(result));
        const facts = await readSessionEvents(finalPath);
        assert.equal(fetchCalls, 0);
        assert.equal(facts.filter(event => event.type === "agent_message" && event.messageId === "reserved-retry-final").length, 1);
        assert.equal(facts.filter(event => event.type === "agent_message" && event.messageId === "host-new-window-id").length, 0,
          "finishing the already recorded window retains its original reply ID");
        assert.equal(facts.filter(event => event.type === "message_version_selected" && event.messageId === "reserved-retry-final").length, 1);
        const phase = JSON.parse(captured.checkpoint!).turn.retryCommit;
        assert.equal(facts.filter(event => event.type === "turn_status" && event.runtime?.runId === phase.runId).length, 1);
        assert.equal(facts.filter(event => event.type === "turn_status" && event.runtime?.runId === "host-continuation-run").length, 1);
        assert.equal(commands.runtimeAuthority.getRun("host-continuation-run")?.terminalStatus, "completed");
        assert.equal(await new TurnStore(root, sessionId).load(), undefined);
        await writeFile(`${marker}.result`, JSON.stringify({ cold: cold.messages, firstRequests: [], requests: [], events: [
          { type: "done", outcome: { status: "completed" } }], facts, canonical: replaySessionEvents(facts).messages, owner, executions,
          runtimeResult: result, fetchCalls }));
      } finally { await runtime.close(); globalThis.fetch = originalFetch; }
      clearInterval(keepAlive);
      await session.close();
      process.exit(0);
    }
    let error: string | undefined;
    let events: AgentSessionEvent[] = [];
    try { events = await drain(session.continueInterruptedTurn({ emotionAnalysis: false })); } catch (cause) { error = String(cause); }
    const firstRequests = [...requests];
    let firstOutcome: unknown;
    if (scenario.includes("incomplete-phase") || scenario.includes("empty-phase") || scenario.includes("tool-calls-phase")) {
      firstOutcome = events.findLast(event => event.type === "done")?.outcome;
      assert.equal((firstOutcome as { status?: string })?.status, "incomplete");
      assert.equal(buildSessionTimeline(await readSessionEvents(finalPath), []).at(-1)?.status, "incomplete", "cold phase recovery preserves its actual historical status");
      assert.equal(requests.length, 0, "phase recovery finishes its actual incomplete outcome without a provider request");
      assert.ok((await new TurnStore(root, sessionId).load())?.terminal);
      responses = [answer("NEXT_WINDOW_REPLY")];
      events = await drain(session.continueInterruptedTurn({ emotionAnalysis: false, messageId: "next-window-reply" }));
      assert.equal(events.findLast(event => event.type === "done")?.outcome.status, "completed");
    }
    const after = await readSessionEvents(finalPath);
    if (!scenario.includes("unsafe")) assert.equal(buildSessionTimeline(after, []).at(-1)?.status, "completed",
      "cold completed reply history keeps its actual terminal status");
    const checkpoint = await new TurnStore(root, sessionId).load();
    let repeatError: string | undefined;
    if (!scenario.includes("unsafe")) {
      try { await drain(session.continueInterruptedTurn({ emotionAnalysis: false })); } catch (cause) { repeatError = String(cause); }
      assert.match(repeatError ?? "", /no interrupted turn/u);
      phase = "next"; responses = [answer("NEXT_ANSWER")];
      await session.resume(sessionId);
      await drain(session.prompt("NEXT_INPUT", { emotionAnalysis: false }));
    }
    assert.equal(existsSync(effectPath) ? await readFile(effectPath, "utf8") : "", executions, "no executed tool is rerun");
    await writeFile(`${marker}.result`, JSON.stringify({ cold: cold.messages, firstRequests, requests, events, error, repeatError,
      checkpoint, firstOutcome, facts: after, canonical: replaySessionEvents(after).messages, owner, executions }));
  }
} finally { clearInterval(keepAlive); await session.close(); }
