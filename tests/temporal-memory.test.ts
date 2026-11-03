/** 原始会话按日期检索的持久化、来源和失败边界。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TemporalMemoryIndex } from "../src/session/temporalMemory.js";

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
  // 工作事实必须有连续原文引文，计划不能伪装完成。
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
  const factsForSource = (source: { text: string }) => [{ title: source.text, quote: source.text,
    state: "planned", eventDate: source.text.slice(0, 10), dueDate: null, completedDate: null }];
  await writeFile(file, line(message("m1", "2026-10-09取消中的提取")));
  const abort = new AbortController();
  const cancelled = new TemporalMemoryIndex(root, { extractFacts: async () => {
    abort.abort(new DOMException("Cancelled", "AbortError"));
    return [];
  } });
  await assert.rejects(cancelled.refreshAll(abort.signal), /Cancelled/u);
  assert.equal(cancelled.queryFacts({ startDate: "2026-10-09", endDate: "2026-10-10" }).facts.length, 0);
  cancelled.close();
  const oldVersion = message("version-old", "2026-10-10旧安排", { slotId: "slot-1" });
  const newVersion = message("version-new", "2026-10-11新安排", { slotId: "slot-1" });
  await writeFile(file, [line(oldVersion), line(newVersion), line({ type: "message_version_selected", slotId: "slot-1", messageId: "version-new" })].join(""));
  const selectedVersion = new TemporalMemoryIndex(root, { extractFacts: async source => factsForSource(source) });
  await selectedVersion.refreshAll();
  assert.equal(selectedVersion.queryFacts({ startDate: "2026-10-10", endDate: "2026-10-11" }).facts.length, 0);
  assert.equal(selectedVersion.queryFacts({ startDate: "2026-10-11", endDate: "2026-10-12" }).facts.length, 1);
  await writeFile(file, [line(oldVersion), line(newVersion), line({ type: "message_version_selected", slotId: "slot-1", messageId: "version-old" })].join(""));
  await selectedVersion.refreshAll();
  assert.equal(selectedVersion.queryFacts({ startDate: "2026-10-10", endDate: "2026-10-11" }).facts.length, 1);
  assert.equal(selectedVersion.queryFacts({ startDate: "2026-10-11", endDate: "2026-10-12" }).facts.length, 0);
  selectedVersion.close();
  await writeFile(file, [line(oldVersion), line(newVersion), line({ type: "message_version_selected", slotId: "slot-1", messageId: "version-new" })].join(""));
  const changedSelection = new TemporalMemoryIndex(root, { extractFacts: async (source) => {
    if (source.messageId === "version-new") {
      await writeFile(file, [line(oldVersion), line(newVersion), line({ type: "message_version_selected", slotId: "slot-1", messageId: "version-old" })].join(""));
    }
    return factsForSource(source);
  } });
  await changedSelection.refreshAll();
  assert.equal(changedSelection.queryFacts({ startDate: "2026-10-11", endDate: "2026-10-12" }).facts.length, 0,
    "switching the selected version during extraction invalidates the obsolete result");
  changedSelection.close();
  await writeFile(file, line(message("m1", "2026-10-12原始安排")));
  const changedText = new TemporalMemoryIndex(root, { extractFacts: async source => {
    await writeFile(file, line(message("m1", "2026-10-13修改后的安排")));
    return factsForSource(source);
  } });
  try {
    await changedText.refreshAll();
    assert.deepEqual(changedText.queryFacts({ startDate: "2026-10-12", endDate: "2026-10-13" }).facts, [],
      "source edits during extraction must not persist the old work facts");
  } finally { changedText.close(); }
  await rm(file);
  const afterDelete = new TemporalMemoryIndex(root);
  await afterDelete.refreshAll();
  assert.equal(afterDelete.queryFacts({ startDate: "2026-09-01", endDate: "2026-11-01" }).facts.length, 0);
  afterDelete.close();
  const escaped = path.join(root, "victim.sqlite");
  const hostileRoot = path.join(root, "hostile");
  await mkdir(hostileRoot);
  await writeFile(escaped, "untouched");
  await symlink(escaped, path.join(hostileRoot, "temporal-memory.sqlite"));
  const hostile = new TemporalMemoryIndex(hostileRoot);
  assert.throws(() => hostile.queryFacts({ startDate: "2026-09-01", endDate: "2026-11-01" }), /symlink/u);
  assert.equal(await readFile(escaped, "utf8"), "untouched");
  console.log("temporal memory tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
