import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";

// Real AgentSession, replay, Read tool and SDK boundary with scripted provider
// responses. Persistence-failure cases explicitly intercept recorder.flush or
// recorder.record; they do not replace AgentSession or replay control flow.
async function fixture(afterTool: boolean, failRequest: boolean | number[] = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-failed-history-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  await ensureAgentDirs(root);
  await writeFile(path.join(root, "evidence.txt"), "shipment-reference-7391");
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "fixture",
    providers: { fixture: { type: "openai", apiKey: "fixture-placeholder" } },
    models: { fixture: { provider: "fixture", model: "fixture", contextWindow: 1_000_000 } },
    agent: { ...defaultConfig.agent, toolExecutionMode: "direct" },
    permission: { ...defaultConfig.permission, mode: "full-access" },
    activity: { ...defaultConfig.activity, enabled: false },
    diagnostics: { ...defaultConfig.diagnostics, enabled: false },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false },
    context: { ...defaultConfig.context,
      identity: { ...defaultConfig.context.identity, enabled: false },
      compaction: { ...defaultConfig.context.compaction, enabled: false },
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
  const requests: AgentMessage[][] = [];
  const model = testModel({
    provider: "openai", providerAlias: "fixture", modelId: "fixture", supportsTools: true,
    vercelOptions: { maxRetries: 0 },
    async stream(context: ModelStreamContext) {
      requests.push(structuredClone(context.messages));
      const request = requests.length;
      if (Array.isArray(failRequest) ? failRequest.includes(request) : failRequest && request === (afterTool ? 2 : 1)) throw new Error("fixture gateway unavailable");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (afterTool && request === 1) {
          yield { type: "tool-call", id: "read-evidence", name: "Read", arguments: { path: "evidence.txt" } };
          yield { type: "finish", reason: "tool-calls" };
        } else {
          yield { type: "text-delta", text: "finished" };
          yield { type: "finish", reason: "stop" };
        }
      })();
    }
  });
  let recorder: SessionRecorder;
  const create = () => {
    const registry = new ToolRegistry();
    registry.registerBuiltinTool(createReadFileTool({ workspaceRoot: root, ignore: [] }));
    recorder = new SessionRecorder(root);
    return new AgentSession({ workspaceRoot: root, config, model, toolRegistry: registry,
      permissionManager: new PermissionManager(config.permission), recorder });
  };
  const agent = create();
  await agent.initialize();
  return { root, agent, create, requests, get recorder() { return recorder; }, close: async (current = agent) => {
    await current.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  } };
}

function assertPriorFacts(messages: AgentMessage[], afterTool: boolean): void {
  assert.match(JSON.stringify(messages), /Read evidence.txt for order north-42/u);
  const calls = messages.flatMap(message => message.role === "assistant"
    ? message.content.filter(part => part.type === "toolCall" && part.id === "read-evidence") : []);
  const results = messages.filter(message => message.role === "toolResult" && message.toolCallId === "read-evidence");
  assert.equal(calls.length, afterTool ? 1 : 0);
  assert.equal(results.length, afterTool ? 1 : 0);
  if (afterTool) assert.match(JSON.stringify(results), /shipment-reference-7391/u);
}

for (const afterTool of [false, true]) {
  for (const admission of ["direct", "runtime-admission", "cold"] as const) {
    test(`failed request retains prior facts: tool=${afterTool}, entry=${admission}`, { timeout: 20_000 }, async () => {
      const f = await fixture(afterTool);
      let agent = f.agent;
      try {
        const failed = await agent.runTask("Read evidence.txt for order north-42", { emotionAnalysis: false });
        assert.equal(failed.status, "failed");
        assert.equal(f.requests.length, afterTool ? 2 : 1);
        if (admission === "cold") {
          const id = agent.getInfo().sessionId;
          await agent.close();
          agent = f.create();
          await agent.initialize();
          await agent.resume(id);
        }
        const options = { runId: "followup-run", turnId: "followup-turn", messageId: "followup-message", emotionAnalysis: false };
        if (admission === "runtime-admission") await agent.admitUserMessage("Continue the previous task", options);
        const outcome = await agent.runTask("Continue the previous task", options);
        assert.equal(outcome.status, "completed");
        assertPriorFacts(f.requests.at(-1)!, afterTool);
        assert.equal(f.requests.length, afterTool ? 3 : 2, "recovery cannot replay the old model or tool step");
        // A completed follow-up clears its checkpoint; the recovery marker must
        // not strand the next ordinary input waiting for the old checkpoint.
        assert.equal((await agent.runTask("Thanks", { emotionAnalysis: false })).status, "completed");
      } finally { await f.close(agent); }
    });
  }
}

for (const admission of ["direct", "runtime-admission"] as const) {
  test(`missing failed-run checkpoint refuses new input before admission: ${admission}`, { timeout: 20_000 }, async () => {
    const f = await fixture(true);
    try {
      assert.equal((await f.agent.runTask("Read evidence.txt for order north-42", { emotionAnalysis: false })).status, "failed");
      const info = f.agent.getInfo();
      const checkpoint = path.join(agentDir(f.root), "turns", `${info.sessionId}.json`);
      const saved = await readFile(checkpoint);
      const log = await readFile(info.sessionFile);
      await rm(checkpoint);
      const options = { runId: "followup-run", turnId: "followup-turn", messageId: "followup-message", emotionAnalysis: false };
      const submit = async () => {
        if (admission === "runtime-admission") await f.agent.admitUserMessage("Continue the previous task", options);
        else for await (const _event of f.agent.prompt("Continue the previous task", options)) { /* drain */ }
      };
      await assert.rejects(submit(), /original checkpoint is unavailable/u);
      assert.equal(f.requests.length, 2);
      assert.deepEqual(await readFile(info.sessionFile), log, "refused follow-up must not replace canonical input or checkpoint");
      await writeFile(checkpoint, saved);
      if (admission === "runtime-admission") await f.agent.admitUserMessage("Continue the previous task", options);
      assert.equal((await f.agent.runTask("Continue the previous task", options)).status, "completed");
      assertPriorFacts(f.requests.at(-1)!, true);
    } finally { await f.close(); }
  });
}

for (const recovery of ["continue", "retry"] as const) {
  test(`explicit ${recovery} after failure does not leave a stale warm-recovery marker`, { timeout: 20_000 }, async () => {
    const f = await fixture(true);
    try {
      assert.equal((await f.agent.runTask("Read evidence.txt for order north-42", {
        messageId: "original-message", emotionAnalysis: false
      })).status, "failed");
      let status: string | undefined;
      const stream = recovery === "continue"
        ? f.agent.continueInterruptedTurn({ emotionAnalysis: false })
        : f.agent.retry("original-message", { emotionAnalysis: false });
      for await (const event of stream) if (event.type === "done") status = event.outcome.status;
      assert.equal(status, "completed");
      assert.equal((await f.agent.runTask("Continue the previous task", { emotionAnalysis: false })).status, "completed");
      assert.match(JSON.stringify(f.requests.at(-1)), /Read evidence.txt for order north-42/u);
      if (recovery === "continue") assertPriorFacts(f.requests.at(-1)!, true);
    } finally { await f.close(); }
  });
}

for (const admission of ["direct", "runtime-admission"] as const) {
  test(`failed recorder barrier cannot admit a new input: ${admission}`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(true);
    try {
      assert.equal((await f.agent.runTask("Read evidence.txt for order north-42", { emotionAnalysis: false })).status, "failed");
      const info = f.agent.getInfo();
      const checkpoint = path.join(agentDir(f.root), "turns", `${info.sessionId}.json`);
      const saved = await readFile(checkpoint);
      const log = await readFile(info.sessionFile);
      const boundary = t.mock.method(f.recorder, "flush", async () => { throw new Error("fixture recorder barrier refused"); });
      const options = { runId: "followup-run", turnId: "followup-turn", messageId: "followup-message", emotionAnalysis: false };
      try {
        await assert.rejects(async () => {
          if (admission === "runtime-admission") await f.agent.admitUserMessage("Continue the previous task", options);
          else for await (const _event of f.agent.prompt("Continue the previous task", options)) { /* drain */ }
        }, /fixture recorder barrier refused/u);
      } finally { boundary.mock.restore(); }
      assert.deepEqual(await readFile(info.sessionFile), log);
      assert.deepEqual(await readFile(checkpoint), saved);
      assert.equal(f.requests.length, 2);
      if (admission === "runtime-admission") await f.agent.admitUserMessage("Continue the previous task", options);
      assert.equal((await f.agent.runTask("Continue the previous task", options)).status, "completed");
      assertPriorFacts(f.requests.at(-1)!, true);
    } finally { await f.close(); }
  });
}

test("late audit failure does not demand a checkpoint for already-installed warm history", { timeout: 20_000 }, async (t) => {
  const f = await fixture(false, false);
  try {
    const record = f.recorder.record.bind(f.recorder);
    let refused = false;
    const boundary = t.mock.method(f.recorder, "record", (...args: Parameters<SessionRecorder["record"]>) => {
      if (!refused && args[0].type === "assistant_message") {
        refused = true;
        throw new Error("fixture assistant audit refused");
      }
      return record(...args);
    });
    try {
      assert.equal((await f.agent.runTask("Read evidence.txt for order north-42", { emotionAnalysis: false })).status, "failed");
    } finally { boundary.mock.restore(); }
    assert.equal(refused, true);
    const info = f.agent.getInfo();
    // Already-installed history needs no recovery checkpoint, even if cleanup
    // has removed it. The injected audit boundary does not simulate a provider failure.
    await rm(path.join(agentDir(f.root), "turns", `${info.sessionId}.json`), { force: true });
    assert.equal((await f.agent.runTask("Continue the previous task", { emotionAnalysis: false })).status, "completed");
    assertPriorFacts(f.requests.at(-1)!, false);
    assert.match(JSON.stringify(f.requests.at(-1)), /finished/u);
  } finally { await f.close(); }
});

for (const mismatch of ["different-turn", "missing-high-water"] as const) {
  test(`failed history rejects checkpoint ${mismatch} before new admission`, { timeout: 20_000 }, async () => {
    const f = await fixture(true);
    try {
      assert.equal((await f.agent.runTask("Read evidence.txt for order north-42", { emotionAnalysis: false })).status, "failed");
      const info = f.agent.getInfo();
      const checkpoint = path.join(agentDir(f.root), "turns", `${info.sessionId}.json`);
      const saved = await readFile(checkpoint);
      const changed = JSON.parse(saved.toString("utf8")) as { version: number; turn: Record<string, unknown> };
      if (mismatch === "different-turn") changed.turn.turnId = "unrelated-turn";
      else delete changed.turn.runtimeHighWater;
      await writeFile(checkpoint, JSON.stringify(changed));
      const corrupted = await readFile(checkpoint);
      const log = await readFile(info.sessionFile);
      const options = { runId: "followup-run", turnId: "followup-turn", messageId: "followup-message", emotionAnalysis: false };
      await assert.rejects(f.agent.admitUserMessage("Continue the previous task", options), /checkpoint identity|original checkpoint is unavailable/u);
      assert.deepEqual(await readFile(info.sessionFile), log);
      assert.deepEqual(await readFile(checkpoint), corrupted);
      assert.equal(f.requests.length, 2);
      await writeFile(checkpoint, saved);
      await f.agent.admitUserMessage("Continue the previous task", options);
      assert.equal((await f.agent.runTask("Continue the previous task", options)).status, "completed");
      assertPriorFacts(f.requests.at(-1)!, true);
    } finally { await f.close(); }
  });
}

for (const replaceLegacy of [false, true]) {
  test(`legacy continuation failure retains history with exact admitted checkpoint; replaced=${replaceLegacy}`, { timeout: 20_000 }, async () => {
    const f = await fixture(true, [2, 3]);
    try {
      assert.equal((await f.agent.runTask("Read evidence.txt for order north-42", { emotionAnalysis: false })).status, "failed");
      const info = f.agent.getInfo();
      const checkpoint = path.join(agentDir(f.root), "turns", `${info.sessionId}.json`);
      const legacy = JSON.parse(await readFile(checkpoint, "utf8")) as { version: number; turn: Record<string, unknown> };
      legacy.version = 4;
      delete legacy.turn.turnId;
      delete legacy.turn.runtimeHighWater;
      await writeFile(checkpoint, JSON.stringify(legacy));
      let status: string | undefined;
      for await (const event of f.agent.continueInterruptedTurn({ emotionAnalysis: false })) {
        if (event.type === "done") status = event.outcome.status;
      }
      assert.equal(status, "failed");
      assert.equal(f.requests.length, 3);
      const admitted = await readFile(checkpoint);
      const options = { runId: "followup-run", turnId: "followup-turn", messageId: "followup-message", emotionAnalysis: false };
      if (replaceLegacy) {
        const replacement = JSON.parse(admitted.toString("utf8")) as { turn: Record<string, unknown> };
        replacement.turn.prompt = "different legacy task";
        await writeFile(checkpoint, JSON.stringify(replacement));
        const log = await readFile(info.sessionFile);
        await assert.rejects(f.agent.admitUserMessage("Continue the previous task", options), /checkpoint identity/u);
        assert.deepEqual(await readFile(info.sessionFile), log);
        assert.equal(f.requests.length, 3);
        await writeFile(checkpoint, admitted);
      }
      await f.agent.admitUserMessage("Continue the previous task", options);
      assert.equal((await f.agent.runTask("Continue the previous task", options)).status, "completed");
      assertPriorFacts(f.requests.at(-1)!, true);
      assert.equal(f.requests.length, 4);
    } finally { await f.close(); }
  });
}
