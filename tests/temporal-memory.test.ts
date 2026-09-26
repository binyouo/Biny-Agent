/** 原始会话按日期检索的持久化、来源和失败边界。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TemporalMemoryIndex, parseTemporalClues } from "../src/session/temporalMemory.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-temporal-"));
const sessionDirectory = path.join(root, "sessions", "project");
const file = path.join(sessionDirectory, "thread-1.jsonl");
const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
const runCli = async (...args: string[]): Promise<string> => (await promisify(execFile)(process.execPath,
  ["--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"), "memory", ...args], {
  cwd: root, env: { ...process.env, BINY_AGENT_DIR: root, DEEPSEEK_API_KEY: "" }, timeout: 30_000
})).stdout;
const message = (id: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "user_message", messageId: id, content, time: "2026-09-24T03:00:00.000Z",
  metadata: { sentAtTimeZone: "Asia/Shanghai" }, ...extra
});
await mkdir(sessionDirectory, { recursive: true });
try {
  // 第一阶段：只从原始用户消息取日期，使用发送时的时区。
  assert.equal(parseTemporalClues("明天交报告", "2026-09-24T03:00:00.000Z", "Asia/Shanghai")[0]?.date, "2026-09-25");
  assert.equal(parseTemporalClues("明天交报告", "2026-09-24T03:00:00.000Z", undefined)[0]?.date, null);
  assert.equal(parseTemporalClues("2026-10-03交报告", undefined, undefined)[0]?.date, "2026-10-03");
  assert.deepEqual(parseTemporalClues("2026-10-03 至 2026-10-05", undefined, undefined).map((clue) => [clue.date, clue.endDate]),
    [["2026-10-03", "2026-10-05"]]);
  assert.equal(parseTemporalClues("明天下午3点交报告", "2026-09-24T03:00:00.000Z", "Asia/Shanghai")[0]?.time, "15:00");
  assert.equal(parseTemporalClues("下个月复盘", "2026-09-24T03:00:00.000Z", "Asia/Shanghai")[0]?.date, "2026-10-01");
  assert.equal(parseTemporalClues("明年复盘", "2026-09-24T03:00:00.000Z", "Asia/Shanghai")[0]?.date, "2027-01-01");
  await writeFile(file, [
    line(message("m1", "明天交报告，2026-10-03复盘")),
    line(message("m2", "明天自动提醒", { metadata: { source: "cron", sentAtTimeZone: "Asia/Shanghai" } })),
    line(message("m3", "后天审计记录", { auditOnly: true })),
    line({ type: "assistant_message", content: "后天交付", time: "2026-09-24T03:00:00.000Z" }),
    line({ type: "tool_result", content: "明天工具输出" })
  ].join(""));
  const index = new TemporalMemoryIndex(root);
  await index.refreshAll();
  const tomorrow = index.queryClues({ startDate: "2026-09-25", endDate: "2026-09-26" });
  assert.equal(tomorrow.clues.length, 1);
  assert.equal(tomorrow.clues[0]?.messageId, "m1");
  assert.equal(tomorrow.clues[0]?.expression, "明天");
  assert.equal(tomorrow.clues[0]?.sourceUri, "session://thread-1/m1");
  assert.equal(index.queryClues({ startDate: "2026-09-25", endDate: "2026-09-26", sessionId: "other" }).clues.length, 0);
  const cli = JSON.parse(await runCli("timeline", "--from", "2026-09-25", "--to", "2026-09-26", "--json")) as { clues: Array<{ messageId: string }> };
  assert.equal(cli.clues[0]?.messageId, "m1", "CLI JSON must read the same original session index");
  assert.match(await runCli("timeline", "--from", "2026-09-25", "--to", "2026-09-26"), /明天/u);
  await assert.rejects(runCli("index-facts", "thread-1", "--json"), /No configured tool model/u,
    "explicit work-fact indexing must report an unavailable model without inventing facts");

  // 第二阶段：重复刷新、分页、忽略、当天已读和来源重写。
  await index.refreshAll();
  assert.equal(index.queryClues({ startDate: "2026-09-01", endDate: "2026-11-01" }).clues.length, 2);
  const page = index.queryClues({ startDate: "2026-09-01", endDate: "2026-11-01", limit: 1 });
  assert.equal(page.clues.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(index.queryClues({ startDate: "2026-09-01", endDate: "2026-11-01", limit: 1, offset: 1 }).clues.length, 1);
  const clueId = tomorrow.clues[0]!.id;
  index.markSeen([clueId], "2026-09-25", "Asia/Shanghai", new Date("2026-09-25T02:00:00.000Z"));
  assert.equal(index.queryClues({ startDate: "2026-09-25", endDate: "2026-09-26", today: "2026-09-25" }).clues[0]?.seen, true);
  assert.equal(index.queryClues({ startDate: "2026-09-25", endDate: "2026-09-26", today: "2026-09-26" }).clues[0]?.seen, false);
  assert.throws(() => index.markSeen([clueId], "2026-09-24", "Asia/Shanghai", new Date("2026-09-25T02:00:00.000Z")));
  index.ignoreClue(clueId);
  assert.equal(index.queryClues({ startDate: "2026-09-25", endDate: "2026-09-26" }).clues.length, 0);
  const sameSourceUpgrade = new TemporalMemoryIndex(root, { extractClues: async (source) =>
    parseTemporalClues(source.text, source.sentAt, source.timeZone) });
  await sameSourceUpgrade.refreshAll();
  assert.equal(sameSourceUpgrade.queryClues({ startDate: "2026-09-25", endDate: "2026-09-26" }).clues.length, 0,
    "model upgrade of the same original message preserves an ignored clue");
  sameSourceUpgrade.close();
  await writeFile(file, line(message("m1", "2026-10-04改为复盘")));
  await index.refreshAll();
  assert.equal(index.queryClues({ startDate: "2026-09-25", endDate: "2026-09-26" }).clues.length, 0);
  assert.equal(index.queryClues({ startDate: "2026-10-04", endDate: "2026-10-05" }).clues.length, 1);
  index.close();

  // 第三阶段：模型升级、无效片段/失败回退、来源变化不落旧提取结果。
  const model = new TemporalMemoryIndex(root, {
    extractClues: async () => [{ expression: "复盘", date: "2026-10-04", endDate: null, time: null, offset: 10, quote: "复盘" }]
  });
  await model.refreshAll();
  assert.equal(model.queryClues({ startDate: "2026-10-04", endDate: "2026-10-05" }).clues.length, 1, "invalid model offsets must fall back to grammar");
  model.close();
  const failedModel = new TemporalMemoryIndex(root, { extractClues: async () => { throw new Error("model offline"); } });
  await failedModel.refreshAll();
  assert.equal(failedModel.queryClues({ startDate: "2026-10-04", endDate: "2026-10-05" }).clues.length, 1);
  failedModel.close();
  await writeFile(file, line(message("m1", "明天开会", { metadata: {} })));
  const untrustedRelative = new TemporalMemoryIndex(root, { extractClues: async () => [
    { expression: "明天", date: "2026-09-25", endDate: null, time: null, offset: 0, quote: "明天开会" }
  ] });
  await untrustedRelative.refreshAll();
  assert.equal(untrustedRelative.queryClues({ startDate: "2026-09-25", endDate: "2026-09-26" }).clues.length, 0,
    "the model cannot invent a resolved relative date when the original timezone is unknown");
  untrustedRelative.close();
  await writeFile(file, line(message("m1", "明天复盘")));
  const tooMany = new TemporalMemoryIndex(root, { extractClues: async () => [
    ...Array.from({ length: 50 }, () => ({ expression: "明天", date: "2026-09-25", endDate: null, time: null, offset: 0, quote: "明天复盘" })),
    { expression: "复盘", date: "2026-10-05", endDate: null, time: null, offset: 2, quote: "明天复盘" }
  ] });
  await tooMany.refreshAll();
  assert.equal(tooMany.queryClues({ startDate: "2026-10-05", endDate: "2026-10-06" }).clues.length, 0,
    "model output beyond the clue cap must fall back to local grammar");
  tooMany.close();
  await writeFile(file, line(message("m1", "计划复盘")));
  const upgraded = new TemporalMemoryIndex(root, { extractClues: async () => [
    { expression: "复盘", date: "2026-10-05", endDate: null, time: null, offset: 2, quote: "计划复盘" }
  ] });
  await upgraded.refreshAll();
  assert.equal(upgraded.queryClues({ startDate: "2026-10-05", endDate: "2026-10-06" }).clues[0]?.expression, "复盘");
  await upgraded.refreshAll();
  assert.equal(upgraded.queryClues({ startDate: "2026-10-05", endDate: "2026-10-06" }).clues.length, 1);
  upgraded.close();
  await writeFile(file, line(message("m1", "2026-10-06开始讨论")));
  const changedDuringExtraction = new TemporalMemoryIndex(root, { extractClues: async () => {
    await writeFile(file, line(message("m1", "2026-10-07改期讨论")));
    return [];
  } });
  await changedDuringExtraction.refreshAll();
  assert.equal(changedDuringExtraction.queryClues({ startDate: "2026-10-05", endDate: "2026-10-06" }).clues.length, 0,
    "outdated model results must not be committed after the source changes");
  changedDuringExtraction.close();

  // 第四阶段：工作事实必须有连续原文引文，计划不能伪装完成。
  await writeFile(file, line(message("m1", "周五计划交报告。2026-09-26已经提交报告。")));
  const facts = new TemporalMemoryIndex(root, {
    extractFacts: async () => [
      { title: "报告计划", quote: "周五计划交报告", state: "planned", eventDate: null, dueDate: "2026-09-25", completedDate: null },
      { title: "报告提交", quote: "2026-09-26已经提交报告", state: "completed", eventDate: "2026-09-26", dueDate: null, completedDate: "2026-09-26" }
    ]
  });
  await facts.refreshAll();
  const completed = facts.queryFacts({ startDate: "2026-09-26", endDate: "2026-09-27" });
  assert.equal(completed.facts.length, 1);
  assert.equal(completed.facts[0]?.state, "completed");
  assert.equal(completed.facts[0]?.messageId, "m1");
  const factPage = facts.queryFacts({ startDate: "2026-09-25", endDate: "2026-09-27", limit: 1 });
  assert.equal(factPage.hasMore, true);
  assert.equal(facts.queryFacts({ startDate: "2026-09-25", endDate: "2026-09-27", limit: 1, offset: 1 }).facts.length, 1);
  const cliFacts = JSON.parse(await runCli("facts", "--from", "2026-09-26", "--to", "2026-09-27", "--json")) as { facts: Array<{ state: string }> };
  assert.equal(cliFacts.facts[0]?.state, "completed");
  assert.equal(facts.queryFacts({ startDate: "2026-09-25", endDate: "2026-09-26" }).facts[0]?.state, "planned");
  facts.close();
  await writeFile(file, line(message("m1", "2026-09-27只讨论报告计划")));
  const invalid = new TemporalMemoryIndex(root, {
    extractFacts: async () => [{ title: "虚构完成", quote: "不存在的引文", state: "completed", eventDate: null, dueDate: null, completedDate: "2026-09-25" }]
  });
  await invalid.refreshAll();
  assert.equal(invalid.queryFacts({ startDate: "2026-09-25", endDate: "2026-09-26" }).facts.length, 0);
  invalid.close();
  await writeFile(file, line(message("m1", "明天计划交付", { metadata: {} })));
  const unresolvedFact = new TemporalMemoryIndex(root, { extractFacts: async () => [
    { title: "交付计划", quote: "明天计划交付", state: "planned", eventDate: null, dueDate: "2026-09-25", completedDate: null }
  ] });
  await unresolvedFact.refreshAll();
  assert.equal(unresolvedFact.queryFacts({ startDate: "2026-09-25", endDate: "2026-09-26" }).facts.length, 0,
    "relative deadlines need the original timezone");
  unresolvedFact.close();
  await writeFile(file, line(message("m1", "明天计划交付")));
  const falseCompletion = new TemporalMemoryIndex(root, { extractFacts: async () => [
    { title: "交付完成", quote: "明天计划交付", state: "completed", eventDate: null, dueDate: null, completedDate: "2026-09-25" }
  ] });
  await falseCompletion.refreshAll();
  assert.equal(falseCompletion.queryFacts({ startDate: "2026-09-25", endDate: "2026-09-26" }).facts.length, 0,
    "a plan cannot become a completed fact merely because a model labels it completed");
  falseCompletion.close();
  await writeFile(file, line(message("m1", `${"x".repeat(12_000)}2026-10-08已提交报告`)));
  const chunked = new TemporalMemoryIndex(root, { extractFacts: async (_source, chunk, chunkOffset) =>
    chunkOffset === 12_000 ? [{ title: "提交报告", quote: "2026-10-08已提交报告", state: "completed", eventDate: "2026-10-08", dueDate: null, completedDate: "2026-10-08" }] : [] });
  await chunked.refreshAll();
  assert.equal(chunked.queryFacts({ startDate: "2026-10-08", endDate: "2026-10-09" }).facts.length, 1,
    "dated facts from a later original-text chunk remain queryable");
  chunked.close();
  await writeFile(file, line(message("m1", "2026-10-09取消中的提取")));
  const abort = new AbortController();
  const cancelled = new TemporalMemoryIndex(root, { extractClues: async () => {
    abort.abort(new DOMException("Cancelled", "AbortError"));
    return [];
  } });
  await assert.rejects(cancelled.refreshAll(abort.signal), /Cancelled/u);
  assert.equal(cancelled.queryClues({ startDate: "2026-10-09", endDate: "2026-10-10" }).clues.length, 0);
  cancelled.close();
  const oldVersion = message("version-old", "2026-10-10旧安排", { slotId: "slot-1" });
  const newVersion = message("version-new", "2026-10-11新安排", { slotId: "slot-1" });
  await writeFile(file, [line(oldVersion), line(newVersion), line({ type: "message_version_selected", slotId: "slot-1", messageId: "version-new" })].join(""));
  const selectedVersion = new TemporalMemoryIndex(root);
  await selectedVersion.refreshAll();
  assert.equal(selectedVersion.queryClues({ startDate: "2026-10-10", endDate: "2026-10-11" }).clues.length, 0);
  assert.equal(selectedVersion.queryClues({ startDate: "2026-10-11", endDate: "2026-10-12" }).clues.length, 1);
  await writeFile(file, [line(oldVersion), line(newVersion), line({ type: "message_version_selected", slotId: "slot-1", messageId: "version-old" })].join(""));
  await selectedVersion.refreshAll();
  assert.equal(selectedVersion.queryClues({ startDate: "2026-10-10", endDate: "2026-10-11" }).clues.length, 1);
  assert.equal(selectedVersion.queryClues({ startDate: "2026-10-11", endDate: "2026-10-12" }).clues.length, 0);
  selectedVersion.close();
  await writeFile(file, [line(oldVersion), line(newVersion), line({ type: "message_version_selected", slotId: "slot-1", messageId: "version-new" })].join(""));
  const changedSelection = new TemporalMemoryIndex(root, { extractClues: async (source) => {
    if (source.messageId === "version-new") {
      await writeFile(file, [line(oldVersion), line(newVersion), line({ type: "message_version_selected", slotId: "slot-1", messageId: "version-old" })].join(""));
    }
    return parseTemporalClues(source.text, source.sentAt, source.timeZone);
  } });
  await changedSelection.refreshAll();
  assert.equal(changedSelection.queryClues({ startDate: "2026-10-11", endDate: "2026-10-12" }).clues.length, 0,
    "switching the selected version during extraction invalidates the obsolete result");
  changedSelection.close();
  await rm(file);
  const afterDelete = new TemporalMemoryIndex(root);
  await afterDelete.refreshAll();
  assert.equal(afterDelete.queryClues({ startDate: "2026-09-01", endDate: "2026-11-01" }).clues.length, 0);
  assert.equal(afterDelete.queryFacts({ startDate: "2026-09-01", endDate: "2026-11-01" }).facts.length, 0);
  afterDelete.close();
  const escaped = path.join(root, "victim.sqlite");
  const hostileRoot = path.join(root, "hostile");
  await mkdir(hostileRoot);
  await writeFile(escaped, "untouched");
  await symlink(escaped, path.join(hostileRoot, "temporal-memory.sqlite"));
  const hostile = new TemporalMemoryIndex(hostileRoot);
  assert.throws(() => hostile.queryClues({ startDate: "2026-09-01", endDate: "2026-11-01" }), /symlink/u);
  assert.equal(await readFile(escaped, "utf8"), "untouched");
  console.log("temporal memory tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
