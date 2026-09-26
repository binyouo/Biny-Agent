/** 截图会话的已保存应用名单须进入公开分析入口的模型输入。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeActivitySession } from "../src/activity/analyzer.js";
import { ActivityStore } from "../src/activity/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-analysis-apps-"));
const store = new ActivityStore();
try {
  await store.open(root, root);
  const startedAt = "2026-08-26T09:00:00.000Z";
  const sessionId = store.startSession(startedAt);
  for (let index = 0; index < 3; index += 1) {
    await store.recordFallbackCapture({
      sessionId,
      occurredAt: new Date(Date.parse(startedAt) + index * 1_000).toISOString(),
      eventType: "screenshot",
      source: "screenshot_fallback",
      application: "Editor",
      jpeg: new Uint8Array([1, 2, 3])
    });
  }
  store.endSession(sessionId, "2026-08-26T09:00:20.000Z");
  assert.deepEqual(store.getHttpSessionDetail(sessionId)?.session.appNames, ["Editor"]);
  assert.deepEqual(store.getEndedSession(sessionId)?.appNames, ["Editor"]);
  assert.deepEqual(store.listSessionsPendingAnalysis()[0]?.appNames, ["Editor"]);
  assert.deepEqual(store.listSessionsPendingAnalysisForDateRange(
    "2026-08-26T00:00:00.000Z", "2026-08-27T00:00:00.000Z"
  )[0]?.appNames, ["Editor"]);
  assert.equal(store.listSessionEventSummaries(sessionId).length, 0, "截图不伪装成语义事件");

  let prompt = "";
  const model: AgentModel = {
    provider: "test",
    modelId: "analysis-apps-fixture",
    runtime: "builtin-llama.cpp",
    dataResidency: "local",
    stream: async (context) => {
      prompt = JSON.stringify(context.messages);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: JSON.stringify({ worth: true, title: "编辑工作", summary: "在 Editor 中工作", confidence: 0.8 }) };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const result = await analyzeActivitySession({ store, model }, sessionId);
  assert.equal(result.status, "analyzed");
  assert.match(prompt, /Apps: Editor/u);
  assert.doesNotMatch(prompt, /Apps: \(unknown\)/u);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
