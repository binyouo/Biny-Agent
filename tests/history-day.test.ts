import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConversationDay } from "../src/session/searchHistory.js";
import { historyDayCommand } from "../src/cli/commands/localCapabilities.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-history-day-"));
const old = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
const log = console.log;
try {
  for (const sessionId of ["morning", "evening"]) {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root, sessionId);
    try {
      await recorder.recordAndFlush({ type: "user_message", content: `${"全天原文".repeat(1000)}${sessionId}`, time: new Date(2026, 9, 18, 10).toISOString() });
      await recorder.recordAndFlush({ type: "assistant_message", content: "保存好这个细节。", time: new Date(2026, 9, 18, 11).toISOString() });
      await recorder.recordAndFlush({ type: "user_message", content: "其他日期不应混入", time: new Date(2026, 9, 17, 10).toISOString() });
      await recorder.recordAndFlush({ type: "user_message", content: "内部审计不应混入", auditOnly: true, time: new Date(2026, 9, 18, 10).toISOString() });
    } finally { await recorder.close(); }
  }
  const result = await readConversationDay("2026-10-18");
  assert.deepEqual(result.conversations.map(item => item.sessionId).sort(), ["evening", "morning"]);
  for (const conversation of result.conversations) {
    assert.equal(conversation.messages.length, 2);
    assert.equal(conversation.messages[0]?.content, `${"全天原文".repeat(1000)}${conversation.sessionId}`);
    assert.equal(conversation.messages[1]?.role, "assistant");
    assert.ok(conversation.sourcePath.endsWith(".jsonl"));
  }
  assert.equal((await readConversationDay("2026-10-16")).conversations.length, 0);
  await assert.rejects(readConversationDay("2026-02-30"), /Invalid conversation date/u);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readConversationDay("2026-10-18", { signal: abort.signal }));
  let output = "";
  console.log = value => { output += String(value); };
  await historyDayCommand("2026-10-18", { json: true });
  assert.deepEqual(JSON.parse(output), result);
} finally {
  console.log = log;
  if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
  await rm(root, { recursive: true, force: true });
}
console.log("history day tests passed");
