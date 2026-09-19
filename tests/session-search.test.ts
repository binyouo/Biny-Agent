/**
 * 会话原文检索索引的增量推进与全文检索行为。
 *
 * Given：一个按 JSONL 追加写入的会话文件和空的派生索引；
 * When：重复增量索引、追加新消息、写入半行、截断文件、删除会话；
 * Then：只有新增完整消息被索引，检索命中可按会话/角色/摘要读回，索引可整会话丢弃。
 */
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionSearchIndex } from "../src/session/searchIndex.js";

const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-session-search-"));
process.env.BINY_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "biny-session-search-agent-"));
try {
  const index = new SessionSearchIndex();
  const sessionFile = path.join(persistenceRoot, "s-1.jsonl");
  const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
  await writeFile(sessionFile, [
    line({ type: "user_message", content: "帮我修复 login 页面的空指针异常", messageId: "m1", time: "2026-09-17T10:00:00.000Z" }),
    line({ type: "assistant_message", content: "已定位到 LoginController 的空指针，补上了判空。", messageId: "m2", time: "2026-09-17T10:00:05.000Z" }),
    line({ type: "tool_result", tool: "read_file", content: "工具输出不进入检索索引" })
  ].join(""), "utf8");

  // 首次索引：只收 user/assistant 消息。
  const first = await index.indexSessionFile("s-1", sessionFile);
  assert.equal(first, 2, "first indexing should store both messages");
  const again = await index.indexSessionFile("s-1", sessionFile);
  assert.equal(again, 0, "re-indexing an unchanged file is a no-op");

  // 中文 bigram 分词下按片段检索，命中带会话与角色。
  const cjkHits = index.search("空指针");
  assert.equal(cjkHits.length, 2, "both messages mentioning the bug are recalled");
  assert.ok(cjkHits.every((hit) => hit.sessionId === "s-1"));
  assert.deepEqual(cjkHits.map((hit) => hit.role).sort(), ["assistant", "user"]);

  const asciiHits = index.search("LoginController");
  assert.equal(asciiHits.length, 1);
  assert.equal(asciiHits[0].role, "assistant");
  assert.ok(asciiHits[0].excerpt.includes("LoginController"));

  // 无关查询不命中。
  assert.equal(index.search("完全不相关的内容").length, 0);

  // 追加新消息后只索引增量。
  await appendFile(sessionFile, line({
    type: "user_message",
    content: "顺便把 deploy 脚本也检查一下",
    messageId: "m3",
    time: "2026-09-17T10:05:00.000Z"
  }), "utf8");
  const incremental = await index.indexSessionFile("s-1", sessionFile);
  assert.equal(incremental, 1, "only the appended message is indexed");
  assert.equal(index.search("deploy").length, 1);

  // 半行（正在写入）不索引、不推进偏移；补全后可检索。
  const partial = line({ type: "user_message", content: "半行消息", messageId: "m4" });
  await appendFile(sessionFile, partial.slice(0, 10), "utf8");
  assert.equal(await index.indexSessionFile("s-1", sessionFile), 0, "partial trailing line is not indexed");
  await appendFile(sessionFile, partial.slice(10), "utf8");
  assert.equal(await index.indexSessionFile("s-1", sessionFile), 1, "completed line is indexed after flush");
  assert.equal(index.search("半行消息").length, 1);

  // 文件被截断/重写时丢弃旧索引从头重建。
  const current = await readFile(sessionFile, "utf8");
  const rewritten = current.split("\n").filter(Boolean).slice(-1).join("\n") + "\n";
  await writeFile(sessionFile, rewritten, "utf8");
  assert.equal(await index.indexSessionFile("s-1", sessionFile), 1, "rebuild after truncation re-indexes the surviving row");
  const status = index.status();
  assert.equal(status.indexedSessions, 1);
  assert.equal(status.indexedMessages, 1, "stale rows from before the truncation are dropped");

  // forgetSession 清空该会话的全部索引行。
  index.forgetSession("s-1");
  assert.equal(index.search("deploy").length, 0);
  assert.equal(index.status().indexedMessages, 0);
  index.close();

  console.log("session search index tests passed");
} finally {
  await rm(persistenceRoot, { recursive: true, force: true });
  await rm(process.env.BINY_AGENT_DIR, { recursive: true, force: true }).catch(() => undefined);
}
