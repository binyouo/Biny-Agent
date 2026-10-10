import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
function assertPairs(messages: readonly AgentMessage[], expected: readonly string[]): void {
  const seen = new Set<string>();
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      assert.ok(!seen.has(part.id), `duplicate call ${part.id}`);
      seen.add(part.id); calls.push(part.id);
    }
    if (message.role === "toolResult") {
      assert.ok(seen.has(message.toolCallId), `orphan result ${message.toolCallId}`);
      assert.ok(!results.includes(message.toolCallId), `duplicate result ${message.toolCallId}`);
      results.push(message.toolCallId);
    }
  }
  assert.deepEqual(calls, expected);
  assert.deepEqual([...results].sort(), [...expected].sort());
}

for (const priorSteps of [0, 1, 2]) {
  test(`public completion and next cold provider retain recovered partial tool step after ${priorSteps} canonical steps`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-partial-step-"));
    await ensureAgentDirs(root);
    const sessionId = `partial-after-${priorSteps}`;
    const recorder = new SessionRecorder(root, sessionId);
    const registry = new ToolRegistry();
    const entered = deferred();
    const release = deferred();
    let executions = 0;
    for (const name of ["primer_probe", "fast_probe", "slow_probe"]) registry.register({
      name, description: "Synthetic local read", risk: "read", parameters: { type: "object", properties: {}, required: [] }, schema: z.object({}),
      resolveExecution: () => ({ approvalRule: name, retrySafety: "safe", accesses: [], execute: async () => {
        executions += 1;
        if (name === "slow_probe") { entered.resolve(); await release.promise; }
        else if (name === "fast_probe") await entered.promise;
        return { marker: `${name}-durable-result` };
      } })
    });
    let requests = 0;
    const config = configSchema.parse({
      ...defaultConfig,
      activity: { ...defaultConfig.activity, enabled: false },
      diagnostics: { ...defaultConfig.diagnostics, enabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false },
      permission: { ...defaultConfig.permission, mode: "full-access" },
      agent: { ...defaultConfig.agent, maxConcurrentTools: 2 },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
    });
    const model: AgentModel = { provider: "synthetic", modelId: "partial-step", supportsTools: true, stream: async () => {
      const index = requests++;
      const events: ModelStreamEvent[] = index < priorSteps
        ? [{ type: "tool-call", id: `primer-${index}`, name: "primer_probe", arguments: {} }, { type: "finish", reason: "tool-calls" }]
        : index === priorSteps ? [
          { type: "tool-call", id: "fast", name: "fast_probe", arguments: {} },
          { type: "tool-call", id: "slow", name: "slow_probe", arguments: {} }, { type: "finish", reason: "tool-calls" }
        ] : [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }];
      return (async function* () { yield* events; })();
    } };
    const createSession = (nextRecorder: SessionRecorder, nextModel: AgentModel) => new AgentSession({ workspaceRoot: root, recorder: nextRecorder, config,
      model: nextModel, toolRegistry: registry, permissionManager: new PermissionManager(config.permission) });
    const session = createSession(recorder, model);
    const checkpointPath = path.join(agentDir(root), "turns", `${sessionId}.json`);
    let snapshot: { log: string; checkpoint: string } | undefined;
    try {
      try {
        await session.initialize();
        for await (const event of session.prompt("Perform synthetic reads", { runId: "run", turnId: "turn", emotionAnalysis: false })) {
          if (event.type === "tool.completed" && event.toolCallId === "fast") {
            try {
              await recorder.flush();
              snapshot = { log: await readFile(recorder.filePath, "utf8"), checkpoint: await readFile(checkpointPath, "utf8") };
            } finally { release.resolve(); }
          }
        }
      } finally { release.resolve(); await session.close(); }
      assert.ok(snapshot);
      const expected = [...Array.from({ length: priorSteps }, (_, index) => `primer-${index}`), "fast", "slow"];
      assertPairs(replaySessionEvents(await readSessionEvents(recorder.filePath)).messages, expected);
      await writeFile(recorder.filePath, snapshot.log);
      await writeFile(checkpointPath, snapshot.checkpoint);
      if (priorSteps === 1) {
        for (const boundary of [1, 2, 3]) {
          await writeFile(recorder.filePath, snapshot.log);
          await writeFile(checkpointPath, snapshot.checkpoint);
          const marker = path.join(root, `crash-${boundary}.json`);
          const killed = await recoveryWorker(root, sessionId, boundary, marker);
          assert.equal(killed.signal, "SIGKILL");
          const crash = JSON.parse(await readFile(marker, "utf8")) as { persisted: number; providerCalls: number };
          assert.equal(crash.persisted, boundary);
          assert.equal(crash.providerCalls, 0, "materialization precedes provider dispatch");
          const completed = await recoveryWorker(root, sessionId, 0, marker);
          assert.equal(completed.code, 0, completed.output);
          const result = JSON.parse(await readFile(marker, "utf8")) as {
            providerCalls: number; messages: AgentMessage[]; outcomes: Array<{ status: string }>; events: import("../src/session/recorder.js").SessionEvent[];
          };
          assert.equal(result.providerCalls, 1);
          assert.equal(result.outcomes.at(-1)?.status, "completed");
          assertPairs(result.messages, expected);
          assertPairs(result.events.filter(event => event.type === "agent_message").map(event => event.message), expected);
          assertPairs(replaySessionEvents(result.events).messages, expected);
          assert.equal(await new TurnStore(root, sessionId).load(), undefined);
        }
        await writeFile(recorder.filePath, snapshot.log);
        await writeFile(checkpointPath, snapshot.checkpoint);
      }
      const saved = await new TurnStore(root, sessionId).load();
      assert.ok(saved);
      const facts = await readSessionEvents(recorder.filePath);
      assert.ok(facts.some((event) => event.type === "tool_result" && event.toolCallId === "fast"));
      assert.ok(!facts.some((event) => event.type === "tool_result" && event.toolCallId === "slow"));
      assert.equal(saved.completedSteps, priorSteps + 1);
      const replay = replaySessionEvents(facts, { sessionId, expectedRuntimeHighWater: saved.runtimeHighWater });
      const before = executions;
      let actual: AgentMessage[] = [];
      const resumed = createSession(new SessionRecorder(root), { provider: "synthetic", modelId: "recovery", supportsTools: true, stream: async (context) => {
        actual = structuredClone(context.messages);
        return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "recovered" }; yield { type: "finish", reason: "stop" }; })();
      } });
      try {
        await resumed.initialize(); await resumed.resume(sessionId);
        let status: string | undefined;
        for await (const event of resumed.continueInterruptedTurn({ emotionAnalysis: false })) if (event.type === "done") status = event.outcome.status;
        assert.equal(status, "completed");
        assert.equal(executions, before, "recovery must not reexecute dispatched tools");
        assertPairs(actual, expected);
        assertPairs(saved.messages, expected);
        assertPairs(replay.messages, expected);
        assert.ok(actual.some((message) => message.role === "toolResult" && message.toolCallId === "fast"
          && JSON.stringify(message).includes("fast_probe-durable-result")));
        assert.equal(replay.recoveredToolResults.length, 1);
        assert.equal(replay.recoveredToolResults[0]?.toolCallId, "slow");
        assertPairs(replaySessionEvents(replay.events).messages, expected);
        const completed = await readSessionEvents(resumed.getInfo().sessionFile);
        assertPairs(replaySessionEvents(completed).messages, expected);
        const canonicalPairs = completed.filter(event => event.type === "agent_message").map(event => event.message);
        assertPairs(canonicalPairs, expected);
        assert.equal(await new TurnStore(root, sessionId).load(), undefined);
      } finally { await resumed.close(); }
      let nextRequest: AgentMessage[] = [];
      const reopened = createSession(new SessionRecorder(root), { provider: "synthetic", modelId: "cold-next", supportsTools: true, stream: async context => {
        nextRequest = structuredClone(context.messages);
        return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "next" }; yield { type: "finish", reason: "stop" }; })();
      } });
      try {
        await reopened.initialize();
        const cold = await reopened.resume(sessionId);
        assertPairs(cold.messages, expected);
        await assert.rejects(async () => { for await (const event of reopened.continueInterruptedTurn()) void event; }, /no interrupted turn/u);
        const next = await reopened.runTask("Next task", { emotionAnalysis: false });
        assert.equal(next.status, "completed");
        assertPairs(nextRequest, expected);
        assert.equal(executions, before);
      } finally { await reopened.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function recoveryWorker(root: string, sessionId: string, boundary: number, marker: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
      new URL("./fixtures/recovery-materialization-worker.ts", import.meta.url).pathname, root, sessionId, String(boundary), marker], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        BINY_AGENT_DIR: process.env.BINY_AGENT_DIR, BINY_TEST_PROCESS: "1", TZ: "UTC", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Recovery worker timed out: ${output}`)); }, 30_000);
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}
