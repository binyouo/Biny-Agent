/** 人格闭环回归：真实文件、跨实例状态、重试幂等和活动派生内容撤回。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FatigueService } from "../src/agent/context/fatigue.js";
import { SoulStorage } from "../src/agent/context/soulStorage.js";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { refreshSelfReflection } from "../src/agent/context/selfReflection.js";
import { renderEmotionPrompt } from "../src/agent/context/emotionPrompt.js";
import { upsertDailyMemorySection, readDailyMemoryNote } from "../src/activity/dailyNotes.js";
import { dailyNoteForModel, activityDerivedMarker } from "../src/activity/modelContext.js";
import { createActivitySessionsTool } from "../src/tools/activity/sessions.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentModel } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-persona-lifecycle-"));
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
  assert.match(renderEmotionPrompt({ mood: "困", energy: 2, valence: 5, fatigue: 0, source: "base", updatedAt: "" }, await fatigue.currentStatus()), /level=sleeping/u);
  assert.equal((await fatigue.change("rest")).manualSleep, false);

  now = new Date(2026, 8, 11, 23);
  const soul = new SoulStorage({ configDir: path.join(root, "soul"), now: () => now });
  const initial = await soul.set("# Biny\n\nCore must stay exactly here.\n\n## Evolved Traits\n");
  assert.equal(await soul.applyEvolution({ add: "更喜欢从具体经历说起。", evidence: "两次交流" }, initial.revision), "applied");
  const grown = await soul.read();
  assert.ok(grown.content.startsWith("# Biny\n\nCore must stay exactly here.\n\n"));
  assert.equal(await soul.applyEvolution({ add: "又一个特征", evidence: "经历" }, grown.revision), "daily_limit");
  assert.equal(await soul.applyEvolution({ add: "过期写入", evidence: "经历" }, initial.revision), "conflict");
  await assert.rejects(soul.appendTrait("命令也不能绕过每日额度"), /每天/u);
  await soul.reset();
  assert.equal(await soul.applyEvolution({ add: "不得重建", evidence: "经历" }, grown.revision), "missing");

  const directory = path.join(root, "reflection");
  const reflectionSoul = new SoulStorage({ configDir: directory, now: () => now });
  await reflectionSoul.set("# Biny\n\nWarm, curious and direct.\n\n## Evolved Traits\n");
  const emotions = new EmotionStorage({ configDir: directory, now: () => now });
  await upsertDailyMemorySection("2026-09-11", "聊天摘要", "用户说长期喜欢短句。今天我们共同解决了难题，仍需补完验收记录。", { configDir: directory });
  await upsertDailyMemorySection("2026-09-11", "活动记录", "在仓库整理了发布说明。", { configDir: directory });
  let calls = 0;
  let writes = 0;
  let fail = true;
  const output = {
    reflection: "今天一起解开难题，心里很踏实。我更愿意从具体经历出发，少说空话。",
    memories: [{ content: "用户长期偏好简短句子。", evidence: "用户明确说明长期偏好。" }],
    actions: [],
    soul: { add: "更愿意用具体经历表达自己的看法。", evidence: "今天一起解决难题。" },
    baseEmotion: { mood: "踏实", valence: 8, energy: 6, trigger: "一起解决难题" }
  };
  const model: AgentModel = { provider: "test", modelId: "reflection", runtime: "provider", stream: async () => (async function* () {
    calls += 1; yield { type: "text-delta", text: JSON.stringify(output) }; yield { type: "finish", reason: "stop" };
  })() };
  const options = {
    configDir: directory, model, soulStorage: reflectionSoul, emotionStorage: emotions,
    allowActivity: true, now: () => now,
    promoteMemory: async () => { if (fail) throw Error("transient failure"); writes += 1; return true; }
  };
  const first = await refreshSelfReflection("2026-09-11", options);
  assert.equal(first.soul, "applied");
  assert.equal(first.emotionUpdated, true);
  assert.equal(first.errors?.length, 1);
  const afterFirst = await reflectionSoul.read();
  fail = false;
  const second = await refreshSelfReflection("2026-09-11", options);
  assert.equal(second.memoriesCreated, 1);
  assert.equal(calls, 1, "retry uses the saved structured result");
  assert.equal(writes, 1);
  assert.equal((await reflectionSoul.read()).revision, afterFirst.revision, "retry does not reapply persona");
  assert.equal((await refreshSelfReflection("2026-09-11", options)).reason, "up_to_date");
  const note = await readDailyMemoryNote("2026-09-11", { configDir: directory });
  assert.ok(note?.includes(activityDerivedMarker));
  const privateProjection = dailyNoteForModel(note!, false);
  assert.ok(!privateProjection.includes("发布说明"));
  assert.ok(!privateProjection.includes("心里很踏实"));
  assert.ok(privateProjection.includes("用户说长期喜欢短句"));
  assert.ok(!dailyNoteForModel(note!, true).includes("biny-reflection-draft"));
  now = new Date(2026, 8, 12, 23);
  const previousBase = await emotions.readBase();
  await refreshSelfReflection("2026-09-11", { ...options, force: true });
  assert.equal((await reflectionSoul.read()).revision, afterFirst.revision, "catch-up cannot grow today's persona");
  assert.deepEqual(await emotions.readBase(), previousBase, "catch-up cannot overwrite current mood");

  const activity = createActivitySessionsTool({ getChatModel: () => model, loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: path.join(root, "activity") }) });
  const execution = await activity.resolveExecution({});
  assert.ok(!("isError" in execution));
  assert.match(await execution.execute({ toolCallId: "test", operationId: "test" }), /还没有录到/u, "云聊天模型可直接查询 Activity，无额外授权");
  assert.ok((await readFile(path.join(root, "activity", "activity.sqlite"))).length > 0);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("persona lifecycle tests passed");
