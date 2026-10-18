import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertDailyMemorySection } from "../src/activity/dailyNotes.js";
import { FileMemoryStorage, readFileMemoryPrompt } from "../src/agent/context/fileMemory.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

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

} finally {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
  await rm(root, { recursive: true, force: true });
}

console.log("file memory notes tests passed");
