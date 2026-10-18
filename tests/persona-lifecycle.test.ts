/** 疲劳与人格命令使用真实文件，并保留跨实例状态。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FatigueService } from "../src/agent/context/fatigue.js";
import { SoulStorage } from "../src/agent/context/soulStorage.js";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { renderEmotionPrompt } from "../src/agent/context/emotionPrompt.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-persona-lifecycle-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
try {
  let now = new Date(2026, 8, 11, 9);
  const fatigue = new FatigueService({ agentDir: path.join(root, "fatigue"), now: () => now });
  await fatigue.change("sleep");
  const fatigueEmotions = new EmotionStorage({ configDir: path.join(root, "fatigue") });
  assert.equal((await fatigueEmotions.readBase())?.energy, 2);
  const other = new FatigueService({ agentDir: path.join(root, "fatigue"), now: () => now });
  assert.equal((await other.currentStatus()).level, "sleeping", "manual sleep overrides a zero fatigue value");
  now = new Date(2026, 8, 11, 11, 1);
  assert.equal((await other.currentStatus()).level, "awake", "daytime auto-wake is persisted");
  assert.equal((await fatigueEmotions.readBase())?.energy, 7, "auto-wake restores base energy too");
  assert.equal((await fatigue.currentStatus()).manualSleep, false);
  await Promise.all(Array.from({ length: 4 }, () => other.recordMessage()));
  assert.equal((await fatigue.currentStatus()).messageCount, 4, "concurrent increments must not be lost");
  now = new Date(2026, 8, 12, 2);
  assert.equal((await fatigue.change("wake")).level, "tired", "manual wake cannot override the 01-06 circadian tier");
  await fatigue.change("sleep");
  assert.match(renderEmotionPrompt({ mood: "困", energy: 2, valence: 5, fatigue: 0, source: "base", updatedAt: "" }, await fatigue.currentStatus()), /level: sleeping/u);
  assert.equal((await fatigue.change("rest")).manualSleep, false);

  now = new Date(2026, 8, 11, 23);
  const soul = new SoulStorage({ configDir: path.join(root, "soul"), now: () => now });
  await soul.set("# Biny\n\nCore must stay exactly here.\n\n## Evolved Traits\n");
  await soul.appendTrait("更喜欢从具体经历说起。");
  const grown = await soul.read();
  assert.ok(grown.content.startsWith("# Biny\n\nCore must stay exactly here.\n\n"));
  assert.equal((await soul.appendTrait("更喜欢从具体经历说起。")).content, grown.content);
  await soul.reset();
  assert.equal((await soul.read()).source, "builtin");

} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("persona lifecycle tests passed");
