/** A background event's log identity must not replace the task owning a checkpoint. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { resolveContinuationPlan } from "../src/session/recoveryPlan.js";
import { replaySessionEvents } from "../src/session/replay.js";
import type { RuntimeEventSink, RuntimeHighWater } from "../src/session/runtimeEvent.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

const config = configSchema.parse({
  ...defaultConfig,
  activity: { ...defaultConfig.activity, enabled: false },
  agent: { ...defaultConfig.agent, maxConcurrentTools: 2 },
  diagnostics: { ...defaultConfig.diagnostics, enabled: false },
  permission: { ...defaultConfig.permission, mode: "full-access" },
  context: {
    ...defaultConfig.context,
    memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function provider(response: () => ModelStreamEvent[]): AgentModel & Required<Pick<AgentModel, "stream">> {
  return {
    provider: "synthetic", modelId: "checkpoint-turn-identity", supportsTools: true,
    stream: async () => (async function* () { yield* response(); })()
  };
}

function agent(root: string, recorder: SessionRecorder, model: AgentModel, toolRegistry = new ToolRegistry()): AgentSession {
  return new AgentSession({ workspaceRoot: root, recorder, model, config, toolRegistry,
    permissionManager: new PermissionManager(config.permission) });
}

for (const background of ["none", "previous-turn", "unscoped"] as const) {
  test(`partial tool checkpoint preserves its active turn with ${background} background metadata`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-identity-"));
    const slowEntered = deferred();
    const releaseSlow = deferred();
    let recorder!: SessionRecorder;
    let backgroundHighWater: RuntimeHighWater | undefined;
    const sink: RuntimeEventSink = {
      appendSessionEvent({ event }) {
        const recorded = event as SessionEvent;
        if (background === "none" || backgroundHighWater || recorded.type !== "tool_result" || recorded.toolCallId !== "fast-call") return;
        // This is the same shared-recorder path used by delayed memory/emotion work.
        const appended = recorder.recordWithRuntimeContext({
          type: "message_metadata", messageId: "old-user", metadata: { memoryExtracted: true }
        }, background === "previous-turn" ? { runId: "old-run", turnId: "old-turn" } : undefined);
        backgroundHighWater = appended.runtime;
      }
    };
    let session: AgentSession | undefined;
    let resumed: AgentSession | undefined;
    try {
      await ensureAgentDirs(root);
      const sessionId = "checkpoint-identity";
      recorder = new SessionRecorder(root, sessionId, undefined, sink);
      recorder.setRuntimeContext({ runId: "old-run", turnId: "old-turn" });
      await recorder.recordAndFlush({ type: "user_message", content: "previous task", messageId: "old-user" });
      await recorder.recordAndFlush({ type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "previous done" }] } });
      await recorder.recordAndFlush({ type: "turn_status", status: "completed", stopReason: "model_stop", steps: 1 });
      recorder.setRuntimeContext(undefined);
      const registry = new ToolRegistry();
      let toolExecutions = 0;
      for (const name of ["fast_probe", "slow_probe"]) registry.register({
        name, description: "Synthetic local read", risk: "read",
        parameters: { type: "object", properties: {}, required: [] }, schema: z.object({}),
        resolveExecution: () => ({ approvalRule: name, retrySafety: "safe", accesses: [], execute: async () => {
          toolExecutions += 1;
          if (name === "slow_probe") { slowEntered.resolve(); await releaseSlow.promise; }
          else await slowEntered.promise;
          return { ok: true };
        } })
      });
      let requests = 0;
      session = agent(root, recorder, provider(() => requests++ === 0 ? [
        { type: "tool-call", id: "fast-call", name: "fast_probe", arguments: {} },
        { type: "tool-call", id: "slow-call", name: "slow_probe", arguments: {} },
        { type: "finish", reason: "tool-calls" }
      ] : [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }]), registry);
      await session.initialize();
      const store = new TurnStore(root, sessionId);
      const checkpointPath = path.join(agentDir(root), "turns", `${sessionId}.json`);
      let snapshot: { log: string; checkpoint: string; visible: boolean } | undefined;
      for await (const event of session.prompt("current task", { runId: "new-run", turnId: "new-turn", emotionAnalysis: false })) {
        if (event.type !== "tool.completed" || event.toolCallId !== "fast-call") continue;
        try {
          snapshot = {
            log: await readFile(recorder.filePath, "utf8"),
            checkpoint: await readFile(checkpointPath, "utf8"),
            visible: await session.interruptedTurn() !== undefined
          };
        } finally { releaseSlow.resolve(); }
      }
      await session.close();
      session = undefined;
      assert.ok(snapshot, "the public prompt stream must expose the partial-step checkpoint");
      // Restore the exact durable files captured while the second tool was still running.
      await writeFile(recorder.filePath, snapshot.log);
      await writeFile(checkpointPath, snapshot.checkpoint);
      const turn = await store.load();
      assert.ok(turn);
      assert.equal(turn.turnId, "new-turn", "task identity comes from the active turn, not the newest background event");
      assert.equal(snapshot.visible, true, "a completed prior turn must not hide the current interrupted task");
      assert.equal(turn.completedSteps, 1);
      if (backgroundHighWater) assert.deepEqual(turn.runtimeHighWater, backgroundHighWater, "global log high-water must remain the unmodified background event witness");
      const events = await readSessionEvents(recorder.filePath);
      assert.ok(events.some((event) => event.type === "tool_result" && event.toolCallId === "fast-call"));
      assert.ok(!events.some((event) => event.type === "tool_result" && event.toolCallId === "slow-call"));
      const replay = replaySessionEvents(events, { sessionId, expectedRuntimeHighWater: turn.runtimeHighWater });
      assert.equal(replay.recoveredToolResults.filter((event) => event.toolCallId === "slow-call").length, 1);
      assert.equal(resolveContinuationPlan(turn, replay, 20).action, "continue");
      assert.throws(() => replaySessionEvents(events, { sessionId,
        expectedRuntimeHighWater: { ...turn.runtimeHighWater!, eventId: "missing-witness" }
      }), /high-water is not present/u, "separating turn identity must not relax witness validation");

      let resumedRequests = 0;
      const resumedProvider = provider(() => [{ type: "text-delta", text: "recovered" }, { type: "finish", reason: "stop" }]);
      resumed = agent(root, new SessionRecorder(root), {
        ...resumedProvider,
        stream: async (context, options) => {
          resumedRequests += 1;
          assert.ok(context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "fast-call"));
          assert.ok(context.messages.some((message) => message.role === "user" && message.content === "current task"));
          return await resumedProvider.stream(context, options);
        }
      }, registry);
      await resumed.initialize();
      await resumed.resume(sessionId);
      assert.equal((await resumed.interruptedTurn())?.turnId, "new-turn");
      let result;
      for await (const event of resumed.continueInterruptedTurn({ emotionAnalysis: false })) {
        if (event.type === "done") result = event.outcome;
      }
      assert.equal(result?.status, "completed");
      assert.equal(resumedRequests, 1);
      assert.equal(toolExecutions, 2, "continuation must not rerun either already dispatched tool");
      assert.equal(await resumed.interruptedTurn(), undefined);
    } finally {
      releaseSlow.resolve();
      await session?.close();
      await resumed?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("TurnStore keeps legacy high-water-derived identities and supports an explicit owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-legacy-"));
  try {
    const store = new TurnStore(root, "legacy-checkpoint");
    const messages = [{ role: "user" as const, content: "task" }];
    const witness = { eventId: "background-event", eventSeq: 7, runId: "old-run", turnId: "old-turn" };
    await store.save("task", undefined, messages, 0, undefined, undefined, undefined, witness);
    assert.equal((await store.load())?.turnId, "old-turn");
    await store.save("task", undefined, messages, 0);
    assert.equal((await store.load())?.turnId, undefined);
    await store.save("task", undefined, messages, 0, undefined, undefined, undefined, witness, "new-turn");
    const explicit = await store.load();
    assert.equal(explicit?.turnId, "new-turn");
    assert.deepEqual(explicit?.runtimeHighWater, witness);
  } finally { await rm(root, { recursive: true, force: true }); }
});
