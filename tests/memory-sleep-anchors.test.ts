import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel } from "../src/agent/core/types.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { memoryTimeAnchorInstruction } from "../src/agent/context/memoryExtraction.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sleep-anchors-agent-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-sleep-anchors-workspace-"));
const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = agentRoot;

const prompts: string[] = [];
const systemPrompts: string[] = [];
const model: AgentModel = {
  provider: "test",
  modelId: "sleep-anchors",
  async stream(context) {
    systemPrompts.push(context.systemPrompt ?? "");
    const prompt = context.messages.flatMap((message) => typeof message.content === "string"
      ? [message.content]
      : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
    prompts.push(prompt);
    return (async function* () {
      yield { type: "text_delta" as const, text: '{"delete":[],"synthesize":[]}' };
      yield { type: "finish" as const, reason: "stop" as const };
    })();
  }
};

const memory = new LocalMemory(workspace, () => model);
try {
  const sourceAnchor = { messageId: "message-1", sentAt: "2026-08-01T09:10:00.000Z", timeZone: "Asia/Shanghai" };
  const first = await memory.writeEntry({
    content: "Project release is scheduled for Thursday.",
    originAnchors: [sourceAnchor]
  }, { now: new Date("2026-08-02T01:02:03.000Z") });
  const second = await memory.writeEntry({
    content: "Project release depends on final review."
  }, { now: new Date("2026-08-03T04:05:06.000Z") });
  assert.ok(first.entry && second.entry);
  const index = {
    findSimilarPairs: async () => ({ examined: 2, pairs: [{ leftId: first.entry!.id, rightId: second.entry!.id, similarity: 0.8 }] })
  };

  await memory.previewMaintenance({}, index);
  assert.equal(prompts.length, 1);
  assert.match(memoryTimeAnchorInstruction, /time-sensitive.*original.*sent-at.*timezone.*content/iu);
  assert.match(memoryTimeAnchorInstruction, /promise.*completion/iu);
  assert.match(memoryTimeAnchorInstruction, /import.*old.*recent/iu);
  assert.ok(systemPrompts[0]?.includes(memoryTimeAnchorInstruction), "Sleep 合成必须接收原始事件时间约束");
  assert.ok(prompts[0]?.includes(`id: "${first.entry.id}", content: "${first.entry.content}" [Memory saved-at: 2026-08-02T01:02:03.000Z; source-message anchors: ${JSON.stringify([sourceAnchor])}; saved-at is NOT event/due/completion time.]`));
  assert.ok(prompts[0]?.includes(`id: "${second.entry.id}", content: "${second.entry.content}" [Memory saved-at: 2026-08-03T04:05:06.000Z; original message time/timezone unknown; saved-at is NOT event/due/completion time.]`));

  await memory.runMemoryMaintenance({}, index);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1], prompts[0]);
} finally {
  memory.close();
  if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
  await rm(agentRoot, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory Sleep anchor tests passed");
