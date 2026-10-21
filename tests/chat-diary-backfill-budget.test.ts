/**
 * Repeated diary refreshes must advance beyond previously written
 * turns without removing the existing 500-new-turn per-refresh budget.
 *
 * The final newly completed turn uses the real AgentSession public entry. The
 * historical prefix uses SessionRecorder, with real JSONL reads and note writes.
 * Only the model/network boundary and Date are controlled; no domain method is
 * replaced.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const localNoon = new Date(2026, 9, 19, 12, 0, 0);
const dateKey = "2026-10-19";

async function withFixture(
  work: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-diary-backfill-budget-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  const unexpectedFetches: string[] = [];
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  globalThis.fetch = async (input) => {
    unexpectedFetches.push(String(input));
    throw new Error("Unexpected external request in diary backfill regression.");
  };
  try {
    const fixture = await createFixture(root);
    await work(fixture);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    try {
      assert.deepEqual(unexpectedFetches, [], "no model or service network is permitted, including failed cases");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function createFixture(root: string) {
  // Import production modules only after the isolated global root is installed.
  const [diary, notes, sessions, recorderModule, eventModule, agentModule, configModule, permissions, tools] = await Promise.all([
    import("../src/agent/context/chatDiary.js"),
    import("../src/activity/dailyNotes.js"),
    import("../src/session/store.js"),
    import("../src/session/recorder.js"),
    import("../src/session/events.js"),
    import("../src/agent/AgentSession.js"),
    import("../src/config/schema.js"),
    import("../src/permission/PermissionManager.js"),
    import("../src/tools/registry.js")
  ]);
  const workspaceRoot = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const notePath = path.join(stateRoot, "memory", `${dateKey}.md`);
  await mkdir(workspaceRoot);
  await sessions.ensureAgentDirs(workspaceRoot);

  const readNote = async (): Promise<string> => await readFile(notePath, "utf8");
  const chatBody = (note: string): string => notes.readDailyMemorySection(note, "聊天摘要") ?? "";
  const entryMarkers = (note: string): string[] => [...chatBody(note).matchAll(/<!-- biny-daily-entry:([0-9a-f]+) -->/gu)].map(match => match[1]!);
  const refresh = async (force = false) => await diary.refreshChatDailyDiary(dateKey, {
    agentDir: stateRoot,
    configDir: stateRoot,
    allowActivity: false,
    force
  });

  const seedCompletedTurns = async (count: number): Promise<void> => {
    const recorder = new recorderModule.SessionRecorder(workspaceRoot, "a-diary-prefix");
    try {
      for (let index = 1; index <= count; index += 1) {
        recorder.setRuntimeContext({ runId: `seed-run-${String(index)}`, turnId: `seed-turn-${String(index)}` });
        recorder.record({ type: "user_message", content: `PREFIX_REQUEST_${String(index)}`, time: localNoon.toISOString() });
        recorder.record({ type: "assistant_message", content: `PREFIX_RESULT_${String(index)}`, time: localNoon.toISOString() });
        recorder.record({ type: "turn_status", status: "completed", stopReason: "model_stop", steps: 1, time: localNoon.toISOString() });
      }
      await recorder.flush();
    } finally {
      await recorder.close();
    }
  };

  const completeOrdinaryTurn = async (marker: string): Promise<void> => {
    const config = structuredClone(configModule.defaultConfig);
    config.context.memory.enabled = false;
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    config.activity.enabled = false;
    config.crystal.passiveEnabled = false;
    config.checkpoints.enabled = false;
    config.agent.toolExecutionMode = "direct";
    const validatedConfig = configModule.configSchema.parse(config);
    const model: AgentModel = {
      provider: "test",
      modelId: "diary-new-completed-turn",
      async stream() {
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: `Finished ${marker}.` };
          yield { type: "finish", reason: "stop" };
        })();
      }
    };
    const recorder = new recorderModule.SessionRecorder(workspaceRoot, "z-diary-ordinary-tail");
    let agent: InstanceType<typeof agentModule.AgentSession> | undefined;
    try {
      agent = new agentModule.AgentSession({
        workspaceRoot,
        config: validatedConfig,
        model,
        recorder,
        toolRegistry: new tools.ToolRegistry(),
        permissionManager: new permissions.PermissionManager(validatedConfig.permission)
      });
      await agent.initialize();
      const outcome = await agent.runTask(`Complete this ordinary request: ${marker}`, { emotionAnalysis: false });
      assert.equal(outcome.status, "completed", outcome.error);
      assert.equal(outcome.output, `Finished ${marker}.`);
    } finally {
      if (agent) await agent.close();
      else await recorder.close();
    }
    // These assertions establish an eligible, durable source before refreshing.
    const events = await eventModule.readSessionEvents(recorder.filePath);
    const user = events.find(event => event.type === "user_message" && !event.auditOnly && event.content.trim() && event.content.includes(marker));
    const assistant = events.find(event => event.type === "assistant_message" && !event.auditOnly && event.content.trim() && event.content.includes(marker));
    assert.ok(user);
    assert.ok(assistant);
    const completed = events.filter(event => event.type === "turn_status" && event.status === "completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.time, localNoon.toISOString());
    const turnId = completed[0]!.runtime?.turnId;
    assert.ok(typeof turnId === "string" && turnId.length > 0);
    assert.equal(user.runtime?.turnId, turnId);
    assert.equal(assistant.runtime?.turnId, turnId);
    assert.equal(events.some(event => event.type === "message_metadata" && event.metadata.diaryPath), false);
  };

  return { readNote, chatBody, entryMarkers, refresh, seedCompletedTurns, completeOrdinaryTurn };
}

for (const force of [false, true]) {
  await test(`refresh advances beyond 500 existing entries after a real completed turn (force=${String(force)})`, { timeout: 60_000 }, async (t) => {
    await withFixture(async (f) => {
      await f.seedCompletedTurns(500);
      const initial = await f.refresh();
      assert.equal(initial.written, true);
      assert.equal(initial.backfilled, 500);
      const before = await f.readNote();
      assert.equal(f.entryMarkers(before).length, 500);

      const marker = `ORDINARY_TURN_AFTER_BUDGET_${String(force)}`;
      t.mock.timers.enable({ apis: ["Date"], now: localNoon.getTime() });
      try {
        await f.completeOrdinaryTurn(marker);
      } finally {
        t.mock.timers.reset();
      }
      assert.equal(await f.readNote(), before,
        "ordinary completion and close must not secretly append this diary entry");

      const refreshed = await f.refresh(force);
      const after = await f.readNote();
      assert.ok(f.chatBody(after).includes(marker), "the newly completed turn must be backfilled after the existing prefix");
      assert.equal(refreshed.written, true);
      assert.equal(refreshed.backfilled, 1, "already-written markers must not consume the new-entry budget");
      const markers = f.entryMarkers(after);
      assert.equal(markers.length, 501);
      assert.equal(new Set(markers).size, 501);
      const repeat = await f.refresh();
      assert.equal(repeat.written, false);
      assert.equal(repeat.reason, "up_to_date");
      assert.equal(repeat.backfilled, 0);
      assert.equal(await f.readNote(), after);
    });
  });
}

await test("each refresh remains bounded to 500 new entries while retries eventually finish", { timeout: 60_000 }, async () => {
  await withFixture(async (f) => {
    await f.seedCompletedTurns(1_001);
    for (const [expectedAdded, expectedTotal] of [[500, 500], [500, 1_000], [1, 1_001]] as const) {
      const refreshed = await f.refresh();
      const markers = f.entryMarkers(await f.readNote());
      assert.equal(refreshed.backfilled, expectedAdded);
      assert.equal(markers.length, expectedTotal, "bounded retries must advance rather than revisit the same prefix forever");
      assert.equal(new Set(markers).size, expectedTotal);
    }
    const finishedNote = await f.readNote();
    assert.ok(f.chatBody(finishedNote).includes("PREFIX_REQUEST_1001"));
    const repeat = await f.refresh();
    assert.equal(repeat.backfilled, 0);
    assert.equal(repeat.written, false);
    assert.equal(repeat.reason, "up_to_date");
    assert.equal(await f.readNote(), finishedNote);
  });
});
