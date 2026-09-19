import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertDailyMemorySection, readDailyMemorySection, readDailyMemoryNote } from "../src/activity/dailyNotes.js";
import { FileMemoryStorage, readFileMemoryPrompt } from "../src/agent/context/fileMemory.js";
import { refreshSelfReflection } from "../src/agent/context/selfReflection.js";
import type { SelfReflectionActionCandidate, SelfReflectionMemoryCandidate } from "../src/agent/context/selfReflection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

const reflectionModel: AgentModel = {
  provider: "test",
  modelId: "reflection-test",
  runtime: "builtin-llama.cpp",
  dataResidency: "local",
  stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: "今天完成了闭环验证，并应继续保持证据驱动的整理。" };
    yield { type: "finish", reason: "stop" };
  })()
};

const promotionModel: AgentModel = {
  provider: "test",
  modelId: "reflection-promotion-test",
  runtime: "builtin-llama.cpp",
  dataResidency: "local",
  stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield {
      type: "text-delta",
      text: JSON.stringify({
        reflection: "今天完成了日报闭环。后续应继续保持可追溯的整理。",
        memories: [{
          content: "日报整理应保留可追溯的来源和结果。",
          evidence: "聊天摘要明确记录了这项工作方式。"
        }],
        actions: [{
          title: "补齐日报验收记录",
          description: "完成日报闭环后补齐验收记录。",
          explicit: true,
          evidence: "聊天摘要记录该项工作尚未完成。"
        }]
      })
    };
    yield { type: "finish", reason: "stop" };
  })()
};

const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-memory-"));
const previous = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = root;

try {
  const storage = new FileMemoryStorage({ configDir: root });
  await storage.append("用户偏好简洁的日报。", { entryKey: "preference:daily" });
  await storage.append("用户偏好简洁的日报。", { entryKey: "preference:daily" });
  await upsertDailyMemorySection("2026-09-05", "聊天摘要", "完成了记忆链路测试。", { configDir: root });
  await upsertDailyMemorySection("2026-09-05", "活动记录", "查看了项目面板并完成 OCR。", { configDir: root });
  const prompt = await readFileMemoryPrompt(new Date("2026-09-05T12:00:00.000Z"), { configDir: root });
  assert.match(prompt ?? "", /简洁的日报/u);
  assert.match(prompt ?? "", /记忆链路测试/u);

  const reflection = await refreshSelfReflection("2026-09-05", {
    configDir: root,
    model: reflectionModel,
    now: () => new Date("2026-09-05T23:00:00.000Z")
  });
  assert.equal(reflection.written, true);
  const note = await readDailyMemoryNote("2026-09-05", { configDir: root });
  assert.match(readDailyMemorySection(note ?? "", "自我反思") ?? "", /今天完成了闭环验证/u);

  const second = await refreshSelfReflection("2026-09-05", {
    configDir: root,
    model: reflectionModel,
    now: () => new Date("2026-09-05T23:00:00.000Z")
  });
  assert.equal(second.reason, "up_to_date");

  await upsertDailyMemorySection("2026-09-06", "聊天摘要", "完成日报闭环；补齐日报验收记录尚未完成。", { configDir: root });
  const promotedMemories: SelfReflectionMemoryCandidate[] = [];
  const promotedActions: SelfReflectionActionCandidate[] = [];
  const promoted = await refreshSelfReflection("2026-09-06", {
    configDir: root,
    model: promotionModel,
    promoteMemory: async (candidate) => {
      promotedMemories.push(candidate);
      return true;
    },
    createTask: async (candidate) => {
      promotedActions.push(candidate);
      return true;
    }
  });
  assert.equal(promoted.written, true);
  assert.equal(promoted.memoriesCreated, 1);
  assert.equal(promoted.tasksCreated, 1);
  assert.equal(promotedMemories[0]?.content, "日报整理应保留可追溯的来源和结果。");
  assert.equal(promotedMemories[0]?.evidence, "聊天摘要明确记录了这项工作方式。");
  assert.equal(promotedActions[0]?.taskRunId.startsWith("reflection-"), true);
  const promotedNote = await readDailyMemoryNote("2026-09-06", { configDir: root });
  assert.match(readDailyMemorySection(promotedNote ?? "", "自我反思") ?? "", /biny-reflection-promoted/u);
  const promotedAgain = await refreshSelfReflection("2026-09-06", {
    configDir: root,
    model: promotionModel,
    promoteMemory: async () => true,
    createTask: async () => true
  });
  assert.equal(promotedAgain.reason, "up_to_date");
} finally {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
  await rm(root, { recursive: true, force: true });
}

console.log("file memory reflection tests passed");
