/** 分析与记忆投影的调度边界：慢投影不能占住后续待分析会话，退出前须收齐投影。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzePendingActivitySessions } from "../src/activity/analyzer.js";
import { ActivityStore } from "../src/activity/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-projection-"));
const store = new ActivityStore();
const release = Promise.withResolvers<void>();
try {
  await store.open(root, root);
  const first = addSession("2026-09-10T11:00:00.000Z", "2026-09-10T12:00:00.000Z");
  const second = addSession("2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z");
  const model: AgentModel = {
    provider: "test", modelId: "activity-projection-test", runtime: "provider", dataResidency: "local",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: JSON.stringify({
        worth: true, title: "项目活动", summary: "维护项目活动", project: "project",
        memoryCandidates: [{ type: "project", content: "项目采用稳定的发布流程。", why: "持续约束" }]
      }) };
      yield { type: "finish", reason: "stop" };
    })()
  };
  const projectionStarted = Promise.withResolvers<void>();
  const writes: string[] = [];
  const sweep = analyzePendingActivitySessions({
    store, model,
    writeMemories: async (_candidates, context) => {
      if (context.sessionId === first) {
        projectionStarted.resolve();
        await release.promise;
      }
      writes.push(context.sessionId);
    }
  }, 2);
  try {
    await projectionStarted.promise;
    // sweep 有固定的 3s 让步间隔；硬超时只限制测试，成功条件是第二条实际落库。
    const deadline = Date.now() + 3_800;
    while (!store.getAnalysis(second) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(store.getAnalysis(second), "首条记忆投影仍在等待时，下一条分析应已保存");
    assert.deepEqual(writes, [second], "未放行的投影尚未完成");
  } finally {
    release.resolve();
  }
  const outcome = await sweep;
  assert.equal(outcome.analyzed, 2);
  assert.deepEqual(writes.sort(), [first, second].sort(), "sweep 返回前已收齐所有投影");
} finally {
  release.resolve();
  await store.close();
  await rm(root, { recursive: true, force: true });
}

function addSession(startedAt: string, endedAt: string): string {
  const id = store.startSession(startedAt);
  store.recordEvent({ sessionId: id, occurredAt: startedAt, eventType: "focus_changed", application: "Editor", rawText: "工作" });
  store.endSession(id, endedAt);
  return id;
}
