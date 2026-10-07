/** 历史命中摘要保留查询附近的原话，不能只返回与中文查询无关的开头。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createHistoryTools } from "../src/extensions/history.js";
import { SessionSearchIndex, type SessionTranscriptHit } from "../src/session/searchIndex.js";

const chinese = '今天讨论了下周发布前的准备事项。首先检查接口兼容性，确认老客户端仍能正常登录。然后核对数据库变更，确保每次迁移都有备份。日志需要保留请求标识，错误消息也要方便排查。权限检查覆盖管理员和普通用户，缓存更新要避免读取过期内容。网络超时应该给出清晰反馈，重试次数不能无限增加。性能指标包括页面加载时间，后台任务耗时，以及内存使用情况。测试要覆盖正常流程，取消操作，失败恢复，并发请求，以及重复提交。文档应该说明安装步骤，配置方法，常见问题，以及联系方式。客服同事需要提前知道本次变更，准备好回复模板。发布时安排两个人值守，分别负责观察监控和处理反馈。遇到异常先保存日志，再确认影响范围，避免直接重启导致线索丢失。最后确认部署回滚使用蓝绿发布，负责人是小林，周五下午演练。';
const latin = 'Today we reviewed the release plan and several important operational details. We checked client compatibility and database migration backups. We also discussed request tracing, permission checks, cache invalidation, network timeouts, retry limits, performance monitoring, documentation, support replies, staffing, and preserving logs before restarting services. The agreed rollback plan uses blue green deployment. Lin owns the rehearsal on Friday afternoon.';

async function fixture(t: TestContext, content: string): Promise<{ root: string; index: SessionSearchIndex }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-history-excerpts-"));
  const directory = path.join(root, "sessions", "project");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "thread.jsonl");
  const original = `${JSON.stringify({ type: "assistant_message", messageId: "decision", content, time: "2026-10-07T00:00:00.000Z" })}\n`;
  await writeFile(file, original);
  const index = new SessionSearchIndex(root);
  t.after(async () => {
    index.close();
    try { assert.equal(await readFile(file, "utf8"), original, "search preserves the authoritative transcript"); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, index };
}

async function search(index: SessionSearchIndex, query: string): Promise<SessionTranscriptHit[]> {
  const [tool] = createHistoryTools({ getIndex: () => index });
  assert.ok(tool);
  const execution = await tool.resolveExecution({ query });
  assert.ok(!("isError" in execution));
  const result = await execution.execute({ toolCallId: "context", operationId: "context" }) as { hits: SessionTranscriptHit[] };
  return result.hits;
}

for (const entry of ["tool", "cli-json", "cli-text"] as const) {
  for (const [language, query, content, expected] of [
    ["Chinese", "部署回滚", chinese, "部署回滚使用蓝绿发布，负责人是小林，周五下午演练"],
    ["Latin", "rollback", latin, "rollback plan uses blue green deployment"]
  ] as const) {
    test(`${entry} ${language} result retains the matching decision after a long introduction`, { timeout: 30_000 }, async (t) => {
      const f = await fixture(t, content);
      let hits: SessionTranscriptHit[] | undefined;
      if (entry === "tool") hits = await search(f.index, query);
      else {
        const cli = spawnSync(process.execPath, [
          "--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"),
          "history", "search", query, ...(entry === "cli-json" ? ["--json"] : [])
        ], { cwd: f.root, env: { ...process.env, BINY_AGENT_DIR: f.root }, encoding: "utf8", timeout: 20_000 });
        assert.ifError(cli.error);
        assert.equal(cli.status, 0, cli.stderr);
        if (entry === "cli-json") hits = (JSON.parse(cli.stdout) as { hits: SessionTranscriptHit[] }).hits;
        else {
          assert.match(cli.stdout, /\[thread · 2026-10-07T00:00:00.000Z\] assistant:/u);
          assert.ok(cli.stdout.includes(expected), `Text CLI omits the matching decision: ${cli.stdout}`);
        }
      }
      if (hits) {
        assert.equal(hits.length, 1, "recall succeeds");
        assert.equal(hits[0]?.messageId, "decision");
        assert.ok(hits[0]?.excerpt.includes(expected), `Excerpt omits the matching decision: ${hits[0]?.excerpt}`);
      }
    });
  }
}

for (const [name, query, content] of [
  ["quoted Chinese", "“部署回滚”", `${"背景说明".repeat(150)}。部署回滚使用蓝绿发布。`],
  ["mixed Latin and Chinese", "Node.js 部署回滚", `${"背景说明".repeat(150)}。Node.js 部署回滚使用蓝绿发布。`],
  ["repeated partial matches", "部署回滚", `部署安排尚未确定。${"背景说明".repeat(150)}。部署回滚使用蓝绿发布。`],
  ["distant partial match before exact phrase", "部署回滚", `${"背景说明".repeat(150)}。部署安排尚未确定。${"背景说明".repeat(150)}。部署回滚使用蓝绿发布。`],
  ["distant partial match before quoted phrase", "“部署回滚”", `${"背景说明".repeat(150)}。部署安排尚未确定。${"背景说明".repeat(150)}。部署回滚使用蓝绿发布。`],
  ["distant partial match before ASCII-quoted phrase", '"部署回滚"', `${"背景说明".repeat(150)}。部署安排尚未确定。${"背景说明".repeat(150)}。部署回滚使用蓝绿发布。`],
  ["literal mixed phrase after a similar spelling", "node.js 部署回滚", `Node.js 原始说明。${"背景说明".repeat(150)}。NodeXjs 部署回滚是错误样例。${"背景说明".repeat(150)}。Node.js 部署回滚使用蓝绿发布。`],
  ["case folding preserves original offsets", "NODE.JS 部署回滚", `Node.js 原始说明。${"İ🙂背景".repeat(150)}。NodeXjs 部署回滚是错误样例。${"İ🙂背景".repeat(150)}。Node.js 部署回滚使用蓝绿发布。`],
  ["surrogate pair at window start", "部署回滚", `${"甲".repeat(420)}🙂${"乙".repeat(79)}部署回滚使用蓝绿发布。${"后续说明".repeat(150)}`],
  ["combining mark at window start", "部署回滚", `${"甲".repeat(420)}e\u0301${"乙".repeat(79)}部署回滚使用蓝绿发布。${"后续说明".repeat(150)}`],
  ["surrogate pair at window end", "部署回滚", `${"甲".repeat(600)}部署回滚使用蓝绿发布${"乙".repeat(407)}🙂${"丙".repeat(50)}`],
  ["combining mark at window end", "部署回滚", `${"甲".repeat(600)}部署回滚使用蓝绿发布${"乙".repeat(407)}e\u0301${"丙".repeat(50)}`]
] as const) {
  test(`CJK excerpt remains useful and bounded with ${name}`, async (t) => {
    const f = await fixture(t, content);
    const hits = await search(f.index, query);
    assert.equal(hits.length, 1);
    const excerpt = hits[0]!.excerpt;
    assert.ok(excerpt.includes("部署回滚使用蓝绿发布"), excerpt);
    assert.ok(excerpt.length <= 500, "the visible bound includes ellipses");
    assert.ok(content.includes(excerpt.replace(/^…|…$/gu, "")), "excerpt stays an unchanged contiguous passage of original text");
    assert.doesNotMatch(excerpt, /^…?\p{M}|e…?$/u, "window does not detach an accent from its base");
    assert.ok([...excerpt].every((character) => character.length !== 1 || !/[\uD800-\uDFFF]/u.test(character)), "window does not split a surrogate pair");
    if (query.startsWith("Node.js")) assert.ok(excerpt.includes("Node.js"));
  });
}

test("CJK search retains an already useful SQLite excerpt", async (t) => {
  const content = "部署回滚使用蓝绿发布。";
  const f = await fixture(t, content);
  assert.equal((await search(f.index, "部署回滚"))[0]?.excerpt, content);
});

test("a hidden legacy-only match cannot fabricate a visible body anchor or leak protocol", async (t) => {
  const f = await fixture(t, "公开答复。<biny_notification>部署回滚</biny_notification>");
  await f.index.refreshAll();
  const database = new DatabaseSync(path.join(f.root, "search", "sessions.sqlite"));
  try {
    // 模拟旧版本已缓存但尚未清理的协议行；权威 JSONL 不做任何修改。
    database.prepare("UPDATE session_transcripts SET body = ?, tokens = ? WHERE message_id = ?")
      .run("公开答复。<biny_notification>部署回滚</biny_notification>", "部署 署回 回滚", "decision");
    const hits = await search(f.index, "部署回滚");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.excerpt, "公开答复。");
  } finally { database.close(); }
});
