/** 真实 session/catalog 文件切换无痕后，跨会话索引须立即撤销并可在恢复普通后重建。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeSessionCatalogRecord, type SessionCatalogRecord } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { TemporalMemoryIndex } from "../src/session/temporalMemory.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-incognito-derived-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const workspace = path.join(root, "workspace");
const range = { startDate: "2026-09-25", endDate: "2026-09-27" };
const index = new TemporalMemoryIndex(process.env.BINY_AGENT_DIR);
const factIndex = new TemporalMemoryIndex(process.env.BINY_AGENT_DIR, { extractFacts: async (source) => [{
  title: "交付", quote: source.text, state: "planned", eventDate: "2026-09-25", dueDate: null, completedDate: null
}] });
try {
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  const sessions: SessionRecorder[] = [];
  for (const text of ["2026-09-25交付普通项目", "2026-09-25交付私密项目"]) {
    const recorder = new SessionRecorder(workspace);
    recorder.record({ type: "user_message", content: text, time: "2026-09-24T03:00:00.000Z", metadata: { sentAtTimeZone: "Asia/Shanghai" } });
    await recorder.close();
    sessions.push(recorder);
  }
  const privateSession = sessions[1]!;
  const catalog = (isIncognito: boolean) => ({
    version: 1, sessionId: privateSession.sessionId, rootSessionId: privateSession.sessionId,
    createdAt: "2026-09-24T03:00:00.000Z", updatedAt: new Date().toISOString(), isIncognito
  }) as SessionCatalogRecord;
  const sessionClues = () => index.queryClues(range).clues.map((hit) => hit.sessionId);
  const sessionFacts = () => factIndex.queryFacts(range).facts.map((hit) => hit.sessionId);

  await index.refreshAll();
  await index.refreshAll(); // 命中未变化 JSONL 的扫描缓存。
  await factIndex.refreshAll();
  assert.deepEqual(new Set(sessionClues()), new Set(sessions.map((session) => session.sessionId)));
  assert.deepEqual(new Set(sessionFacts()), new Set(sessions.map((session) => session.sessionId)));

  await writeSessionCatalogRecord(workspace, catalog(true));
  assert.deepEqual(sessionClues(), [sessions[0]!.sessionId], "已建索引在未刷新时也不能泄露无痕日期线索");
  assert.deepEqual(sessionFacts(), [sessions[0]!.sessionId], "已建索引在未刷新时也不能泄露无痕工作事实");
  await index.refreshAll();
  await factIndex.refreshAll();
  assert.deepEqual(sessionClues(), [sessions[0]!.sessionId], "catalog flag 翻转须使未变的 JSONL 缓存失效");
  assert.deepEqual(sessionFacts(), [sessions[0]!.sessionId], "旧工作事实不能保留");
  assert.deepEqual(await index.indexSessionFile(privateSession.sessionId, privateSession.filePath), [], "显式单文件索引也不能绕过门禁");
  assert.deepEqual(sessionClues(), [sessions[0]!.sessionId]);

  await writeSessionCatalogRecord(workspace, catalog(false));
  await index.refreshAll();
  await factIndex.refreshAll();
  assert.deepEqual(new Set(sessionClues()), new Set(sessions.map((session) => session.sessionId)));
  assert.deepEqual(new Set(sessionFacts()), new Set(sessions.map((session) => session.sessionId)));

  let extractionStarted!: () => void;
  let releaseExtraction!: () => void;
  const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseExtraction = resolve; });
  const delayed = new TemporalMemoryIndex(process.env.BINY_AGENT_DIR, { extractClues: async (source) => {
    if (source.sessionId === privateSession.sessionId) { extractionStarted(); await released; }
    return [];
  } });
  try {
    const pending = delayed.refreshAll();
    await Promise.race([started, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("提取未启动")), 2000))]);
    await writeSessionCatalogRecord(workspace, catalog(true));
    releaseExtraction();
    await pending;
    assert.ok(!delayed.queryClues(range).clues.some((hit) => hit.sessionId === privateSession.sessionId),
      "模型处理期间变成无痕的来源不能迟到落库");
  } finally { releaseExtraction(); delayed.close(); }
  console.log("incognito derived memory tests passed");
} finally {
  index.close();
  factIndex.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
