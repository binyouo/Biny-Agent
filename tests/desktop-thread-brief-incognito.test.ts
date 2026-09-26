/** Desktop 真实会话和 catalog：无痕线程不能进入摘要历史或旧派生快照。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopThreadBriefService } from "../src/desktop/electron/main/DesktopThreadBriefService.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { writeSessionCatalogRecord, type SessionCatalogRecord } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ThreadBriefStore } from "../src/session/threadBriefStore.js";
import type { BriefThreadReference } from "../src/session/threadBriefTypes.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-incognito-brief-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const workspace = path.join(root, "workspace");
let currentConfig = defaultConfig;
const configStore = { load: async () => currentConfig, save: async () => undefined };
const state = new DesktopStateStore(path.join(root, "state.json"));
const projects = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "desktop")), configStore);
const store = new ThreadBriefStore(path.join(root, "briefs"));
const service = new DesktopThreadBriefService({ configStore, state, projects, store, chooseProjectDirectory: async () => undefined });
try {
  await state.load();
  await mkdir(workspace);
  const project = await projects.createProject(workspace);
  await ensureAgentDirs(workspace);
  await service.initialize();
  const references: BriefThreadReference[] = [];
  for (const text of ["普通项目计划", "无痕项目计划"]) {
    const recorder = new SessionRecorder(workspace);
    recorder.record({ type: "user_message", content: text, time: "2026-09-24T03:00:00.000Z" });
    recorder.record({ type: "assistant_message", content: "收到", time: "2026-09-24T03:00:00.000Z" });
    await recorder.close();
    references.push({ sessionId: recorder.sessionId, projectId: project.id, title: text, createdAt: "2026-09-24T03:00:00.000Z" });
  }
  const privateThread = references[1]!;
  store.putBrief({ ...references[0]!, brief: { topic: "普通", goal: "", objects: [], conclusions: [], followUp: null },
    contentHash: "normal", materialLength: 20, userTurns: 1, updatedAt: "2026-09-25T00:00:00Z", status: "inbox", statusManual: false });
  store.putBrief({ ...privateThread, brief: { topic: "私密内容", goal: "", objects: [], conclusions: [], followUp: null },
    contentHash: "private", materialLength: 20, userTurns: 1, updatedAt: "2026-09-25T00:00:00Z", status: "inbox", statusManual: false });
  store.putSuggestion({ id: "private-suggestion", signature: "private-suggestion", kind: "create", status: "open", name: "私密内容",
    brief: "私密建议", focus: "", reason: "来自无痕线程", threads: references, createdAt: "2026-09-25T00:00:00Z" });
  const before = await service.request({ action: "overview" });
  assert.equal(before.briefs.length, 2);
  assert.equal(before.suggestions.length, 1);
  assert.equal((await service.request({ action: "history" })).history?.length, 2);

  await writeSessionCatalogRecord(workspace, { version: 1, sessionId: privateThread.sessionId, rootSessionId: privateThread.sessionId,
    createdAt: privateThread.createdAt, updatedAt: new Date().toISOString(), isIncognito: true } as SessionCatalogRecord);
  const after = await service.request({ action: "overview" });
  assert.deepEqual(after.briefs.map((brief) => brief.sessionId), [references[0]!.sessionId]);
  assert.equal(after.suggestions.length, 0, "引用无痕线程的旧建议含派生内容，整体隐藏");
  assert.deepEqual((await service.request({ action: "history" })).history?.map((thread) => thread.sessionId), [references[0]!.sessionId]);
  await assert.rejects(service.request({ action: "backfill", sessionId: privateThread.sessionId }), /找不到对话/u);
  await assert.rejects(service.request({ action: "accept", id: "private-suggestion" }), /项目建议已处理或不存在/u);
  await writeSessionCatalogRecord(workspace, { version: 1, sessionId: privateThread.sessionId, rootSessionId: privateThread.sessionId,
    createdAt: privateThread.createdAt, updatedAt: new Date().toISOString(), isIncognito: false } as SessionCatalogRecord);
  assert.equal((await service.request({ action: "overview" })).briefs.length, 2, "恢复普通后历史派生摘要可重新显示");

  // Given 模型已经收到普通会话，When 中途改为无痕，Then 迟到结果不得入库。
  let modelStarted!: () => void;
  let releaseModel!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseModel = resolve; });
  const server = createServer((_request, response) => {
    modelStarted();
    void released.then(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({
        topic: "私密计划", goal: "完成项目", objects: [], conclusions: [], followUp: null
      }) }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    currentConfig = configSchema.parse({ ...defaultConfig, defaultModel: "brief", toolModel: "brief",
      providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { brief: { provider: "local", model: "brief-test", api: "chat-completions" } }
    });
    const late = new SessionRecorder(workspace);
    late.record({ type: "user_message", content: "帮我规划私密项目", time: "2026-09-25T00:00:00.000Z" });
    late.record({ type: "assistant_message", content: "先整理需求", time: "2026-09-25T00:00:00.000Z" });
    await late.close();
    const pending = service.engine.enqueue(late.sessionId, true);
    await Promise.race([started, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("摘要模型未启动")), 2000))]);
    await writeSessionCatalogRecord(workspace, { version: 1, sessionId: late.sessionId, rootSessionId: late.sessionId,
      createdAt: "2026-09-25T00:00:00.000Z", updatedAt: new Date().toISOString(), isIncognito: true } as SessionCatalogRecord);
    releaseModel();
    await pending;
    assert.equal(store.brief(late.sessionId), undefined, "迟到模型结果不能持久化无痕摘要");
  } finally {
    releaseModel();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("desktop thread brief incognito tests passed");
} finally {
  await service.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
