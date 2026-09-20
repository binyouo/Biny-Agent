/** 镜像的公开行为：补写、更新、半行重试、失败隔离、并发与关闭收尾。 */
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { archiveConversationMarkdown, ConversationMarkdownMirror, conversationMirrorIntervalMs } from "../src/session/markdownArchive.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-markdown-mirror-"));
const sessions = path.join(root, "sessions", "project");
const target = path.join(root, "threads", "chat.md");
const line = (content: string) => JSON.stringify({ type: "user_message", time: "2026-09-21T01:00:00Z", content }) + "\n";
try {
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, "chat.jsonl"), line("启动前的原文"));
  const mirror = new ConversationMarkdownMirror(root);
  await mirror.start();
  assert.match(await readFile(target, "utf8"), /启动前的原文/u);
  const before = await stat(target);
  assert.equal((await archiveConversationMarkdown(root)).exported, 0);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs, "相同内容不重写");
  const partial = line("完整后才导出");
  await appendFile(path.join(sessions, "chat.jsonl"), partial.slice(0, -2));
  await mirror.refresh();
  assert.doesNotMatch(await readFile(target, "utf8"), /完整后才导出/u);
  await appendFile(path.join(sessions, "chat.jsonl"), partial.slice(-2));
  await Promise.all([mirror.refresh(), archiveConversationMarkdown(root)]);
  assert.match(await readFile(target, "utf8"), /完整后才导出/u);
  await writeFile(path.join(sessions, "broken.jsonl"), line("重试成功"));
  await mkdir(path.join(root, "threads", "broken.md"));
  const failed = await archiveConversationMarkdown(root);
  assert.equal(failed.failed.length, 1, "一个目标不可写不影响其他会话");
  await rm(path.join(root, "threads", "broken.md"), { recursive: true });
  assert.equal((await archiveConversationMarkdown(root)).exported, 1);
  await appendFile(path.join(sessions, "chat.jsonl"), line("退出时补写"));
  await mirror.close();
  assert.match(await readFile(target, "utf8"), /退出时补写/u);
  await mirror.close();
  await appendFile(path.join(sessions, "chat.jsonl"), line("下次启动补写"));
  const restarted = new ConversationMarkdownMirror(root);
  await restarted.start();
  assert.match(await readFile(target, "utf8"), /下次启动补写/u);
  await restarted.close();
  // 时间只推进调度器；等待真实文件结果，不把等待时长当作成功条件。
  mock.timers.enable({ apis: ["setInterval"] });
  const scheduled = new ConversationMarkdownMirror(root);
  try {
    await scheduled.start();
    await appendFile(path.join(sessions, "chat.jsonl"), line("定时更新"));
    mock.timers.tick(conversationMirrorIntervalMs);
    const deadline = Date.now() + 2_000;
    while (!/定时更新/u.test(await readFile(target, "utf8")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(await readFile(target, "utf8"), /定时更新/u);
    await scheduled.close();
    await appendFile(path.join(sessions, "chat.jsonl"), line("关闭后不再调度"));
    mock.timers.tick(conversationMirrorIntervalMs * 2);
    assert.doesNotMatch(await readFile(target, "utf8"), /关闭后不再调度/u);
  } finally { await scheduled.close(); mock.timers.reset(); }
  await rm(path.join(sessions, "chat.jsonl"));
  await writeFile(path.join(root, "threads", "personal.md"), "用户自己的文件");
  await archiveConversationMarkdown(root);
  await assert.rejects(stat(target), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "threads", "personal.md"), "utf8"), "用户自己的文件");
  // 导出目录不能用符号链接把对话带出 agent root。
  await rm(path.join(root, "threads"), { recursive: true });
  await symlink(sessions, path.join(root, "threads"));
  await assert.rejects(archiveConversationMarkdown(root), /real directory/u);
  console.log("markdown archive tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
