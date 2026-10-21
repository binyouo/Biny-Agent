import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSkillExtraction } from "../src/agent/skillExtraction.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { SessionEvent } from "../src/session/recorder.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-extraction-incremental-"));
let calls = 0;
let material = "";
const model: AgentModel = testModel({ provider: "test", modelId: "analyst", async stream(context) {
  calls++;
  material = JSON.stringify(context.messages);
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: '{"worthy":false,"skillName":"","skillDescription":""}' };
    yield { type: "finish", reason: "stop" };
  })();
} });
const user = (id: string): SessionEvent => ({ type: "user_message", messageId: id, content: id });
const tool = (id: string, parentToolCallId?: string): SessionEvent => ({ type: "tool_call", toolCallId: id, tool: "Read", args: {}, parentToolCallId });
try {
  // Three outer invocations across turns count; nested calls cannot inflate that count.
  const events = [user("one"), tool("a"), tool("b"), user("two"), tool("c"), tool("nested", "c")];
  await runSkillExtraction({ messageId: "two", events, installedSkills: [], model, minToolCalls: 3, homeDir: root });
  assert.equal(calls, 1, "threshold accumulates across turns");
  assert.match(material, /one/);
  calls = 0;
  await runSkillExtraction({ messageId: "two", events, installedSkills: [], model, minToolCalls: 4, homeDir: root });
  assert.equal(calls, 0, "nested calls do not inflate the threshold");
  const analyzed: SessionEvent = { type: "message_metadata", messageId: "two", metadata: { skillExtractionAnalyzed: true, skillExtractionToolCallCount: 3 } };
  await runSkillExtraction({ messageId: "two", events: [...events, analyzed], installedSkills: [], model, minToolCalls: 3, homeDir: root });
  assert.equal(calls, 0, "reopening an analyzed snapshot does not analyze twice");
  await runSkillExtraction({ messageId: "three", events: [...events, analyzed, user("three"), tool("d"), tool("e")], installedSkills: [], model, minToolCalls: 3, homeDir: root });
  assert.equal(calls, 0, "only new outer calls count after analysis");
  await runSkillExtraction({ messageId: "three", events: [...events, user("three"), tool("d"), user("four"), analyzed], installedSkills: [], model, minToolCalls: 3, homeDir: root });
  assert.equal(calls, 0, "late progress remains bound to its source message, not its append position");
  await runSkillExtraction({ messageId: "three", events: [...events, analyzed, user("three"), tool("d"), tool("e"), tool("f"), user("future-secret"), tool("later")], installedSkills: [], model, minToolCalls: 3, homeDir: root });
  assert.equal(calls, 1);
  assert.doesNotMatch(material, /future-secret|later/);
  const analyzedCounts: number[] = [];
  const notices: string[] = [];
  await runSkillExtraction({ messageId: "two", events, installedSkills: [], model, minToolCalls: 3, homeDir: root,
    onAnalyzed: async count => { analyzedCounts.push(count); },
    onNotice: notice => notices.push(notice.stage) });
  assert.deepEqual(analyzedCounts, [3], "negative analysis still advances progress");
  assert.deepEqual(notices, ["analyzing", "skipped"]);
  const failingModel: AgentModel = testModel({ provider: "test", modelId: "failure", async stream() { throw new Error("analyst unavailable"); } });
  notices.length = 0;
  await assert.rejects(runSkillExtraction({ messageId: "two", events, installedSkills: [], model: failingModel, minToolCalls: 3, homeDir: root,
    onAnalyzed: async count => { analyzedCounts.push(count); },
    onNotice: notice => notices.push(notice.stage) }), /analyst unavailable/);
  assert.deepEqual(analyzedCounts, [3, 3], "failed analysis also advances progress");
  assert.deepEqual(notices, ["analyzing", "skipped"], "failed analysis cannot leave a running card");
  console.log("incremental skill extraction passed");
} finally { await rm(root, { recursive: true, force: true }); }
