import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
/** 技能提取只有一处会话素材预算，超限保留最新内容与独立的提取元数据。 */
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSkillExtraction } from "../src/agent/skillExtraction.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { SessionEvent } from "../src/session/recorder.js";

const requests: string[] = [];
const systems: string[] = [];
const model: AgentModel = testModel({ provider: "test", modelId: "material", async stream(context) {
  requests.push(JSON.stringify(context.messages));
  systems.push(context.systemPrompt);
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: '{"worthy":false,"skillName":"","skillDescription":""}' };
    yield { type: "finish", reason: "stop" };
  })();
} });
const events: SessionEvent[] = [{ type: "user_message", messageId: "target", content: `OLDEST_CONTEXT${"x".repeat(3_000)}` }];
for (let index = 0; index < 7; index++) events.push({ type: "assistant_message", content: `EARLIER_MESSAGE${"y".repeat(3_000)}` });
events.push({ type: "assistant_message", content: `LATEST_MESSAGE${"z".repeat(3_000)}FINAL_CONSTRAINT` });
events.push({ type: "tool_call", tool: "Read", toolCallId: "read", args: {} });
events.push({ type: "user_message", messageId: "future", content: "FUTURE_TURN" });
await runSkillExtraction({ messageId: "target", events, installedSkills: [{ name: "existing", description: `${"d".repeat(200)}EXISTING_ROUTE` }], minToolCalls: 1, model });
assert.equal(requests.length, 1);
assert.match(requests[0]!, /LATEST_MESSAGE/u);
assert.match(requests[0]!, /FINAL_CONSTRAINT/u, "the end of the newest message must survive the material budget");
assert.match(requests[0]!, /累计工具调用：1/u);
assert.doesNotMatch(requests[0]!, /OLDEST_CONTEXT|FUTURE_TURN/u);
assert.match(systems[0]!, /EXISTING_ROUTE/u, "existing skill routing descriptions are not independently truncated");
const root = await mkdtemp(path.join(os.tmpdir(), "biny-extraction-material-"));
const authorRequests: string[] = [];
const answers = [
  '{"worthy":true,"skillName":"material-fixture","skillDescription":"Preserve the latest task constraints"}',
  "---\nname: material-fixture\ndescription: Preserve the latest task constraints\n---\n1. Inspect the task.\n2. Preserve its final constraints."
];
const authorModel: AgentModel = testModel({ provider: "test", modelId: "author-material", async stream(context) {
  const answer = answers[authorRequests.length]!;
  authorRequests.push(JSON.stringify(context.messages));
  return (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: answer };
    yield { type: "finish", reason: "stop" };
  })();
} });
try {
  await runSkillExtraction({ messageId: "target", events, installedSkills: [], minToolCalls: 1, model: authorModel, homeDir: root });
  assert.equal(authorRequests.length, 2);
  assert.match(authorRequests[1]!, /FINAL_CONSTRAINT/u);
  assert.match(authorRequests[1]!, /拟提取技能：material-fixture — Preserve the latest task constraints/u, "author metadata must not be clipped after the conversation budget");
} finally { await rm(root, { recursive: true, force: true }); }
console.log("skill extraction material tests passed");
