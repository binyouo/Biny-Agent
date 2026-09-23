import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backfillDailyChatDiaryEntries, refreshChatDailyDiary } from "../src/agent/context/chatDiary.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

const previousAgentDir = process.env.BINY_AGENT_DIR;
const root = await mkdtemp(path.join(os.tmpdir(), "biny-chat-diary-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-chat-diary-workspace-"));
process.env.BINY_AGENT_DIR = root;

async function testBackfillAndFallbackSummary(): Promise<void> {
  await ensureAgentDirs(workspace);
  const recorder = new SessionRecorder(workspace, "chat-diary-session");
  recorder.setRuntimeContext({ runId: "chat-diary-run", turnId: "chat-diary-turn" });
  recorder.record({ type: "user_message", content: "完成每日摘要功能", time: "2026-09-04T08:00:00.000Z" });
  recorder.record({ type: "assistant_message", content: "已完成聊天日志写入与上下文读取。", time: "2026-09-04T08:01:00.000Z" });
  await recorder.recordAndFlush({
    type: "turn_status",
    status: "completed",
    stopReason: "model_stop",
    steps: 1,
    time: "2026-09-04T08:01:00.000Z"
  });
  await recorder.close();

  const backfilled = await backfillDailyChatDiaryEntries("2026-09-04", { agentDir: root, configDir: root });
  assert.equal(backfilled, 1);
  const result = await refreshChatDailyDiary("2026-09-04", { agentDir: root, configDir: root });
  assert.equal(result.written, true);
  const note = await readFile(path.join(root, "memory", "2026-09-04.md"), "utf8");
  assert.match(note, /## 聊天摘要/u);
  assert.match(note, /## 每日总结/u);
  assert.match(note, /完成每日摘要功能/u);
  assert.match(note, /完成了 1 个聊天回合/u);

  let modelCalls = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "daily-diary-test",
    stream: async function* () {
      modelCalls += 1;
      yield { type: "text-delta", text: "模型生成的整体回顾。" };
      yield { type: "finish", reason: "stop" };
    }
  };
  const generated = await refreshChatDailyDiary("2026-09-04", { agentDir: root, configDir: root, model });
  assert.equal(generated.model, "daily-diary-test");
  assert.equal(modelCalls, 1, "fallback 生成后模型可用时应重试一次整体回顾");
  const generatedNote = await readFile(path.join(root, "memory", "2026-09-04.md"), "utf8");
  assert.match(generatedNote, /模型生成的整体回顾/u);
}

try {
  await testBackfillAndFallbackSummary();
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
console.log("chat diary tests passed");
