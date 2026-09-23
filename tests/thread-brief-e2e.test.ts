/** 非界面端到端：真实会话文件 → Desktop 服务 → 本地 SSE Provider → SQLite → 人工确认项目。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopThreadBriefService } from "../src/desktop/electron/main/DesktopThreadBriefService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { resolveSessionFile } from "../src/session/store.js";
import { ThreadBriefStore } from "../src/session/threadBriefStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-brief-e2e-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
let sameThing = true;
let invalidRevision = false;
let providerRequests = 0;
const server = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream: boolean; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
    assert.equal(body.stream, true);
    providerRequests += 1;
    const system = body.messages.map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n")).join("\n");
    const result = system.includes('"drop"') ? { name: "Canvas", brief: "修订后的编辑器发布目标", focus: "确认上线范围", drop: invalidRevision ? ["unknown-session"] : [], reason: "根据用户反馈修订" }
      : system.includes('"sameThing"') ? { sameThing, members: [1, 2, 3], name: "Canvas", brief: "Canvas 编辑器发布", focus: "准备发布", reason: "连续推进同一个编辑器的上线" }
      : system.includes('"belongs"') ? { belongs: true, reason: "继续推进 Canvas 发布" }
        : { topic: "Canvas 发布", goal: "上线编辑器", objects: ["Canvas"], conclusions: ["完成检查"], followUp: { what: "发布编辑器", quote: "明天我会发布编辑器" } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      { choices: [{ index: 0, delta: { content: JSON.stringify(result) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"
    ].map((part) => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
  })().catch((error: unknown) => { response.statusCode = 500; response.end(String(error)); });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const config = configSchema.parse({ ...defaultConfig, defaultModel: "brief", toolModel: "brief",
  providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
  models: { brief: { provider: "local", model: "brief-test", api: "chat-completions" } }
});
const configStore = { load: async () => config, save: async () => undefined };
const state = new DesktopStateStore(path.join(root, "state.json"));
const storage = new DesktopUserDataStore(path.join(root, "desktop"));
const projects = new DesktopProjectService(state, storage, configStore);
let chosenDirectory: string | undefined;
const createService = () => new DesktopThreadBriefService({ configStore, state, projects,
  store: new ThreadBriefStore(path.join(root, "briefs"), () => new Date("2026-09-20T00:00:00Z")),
  chooseProjectDirectory: async () => chosenDirectory
});
let service = createService();
try {
  await state.load();
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const project = await projects.createProject(workspace);
  await service.initialize();
  const sessionIds: string[] = [];
  const originalFiles = new Map<string, string>();
  for (let index = 0; index < 3; index += 1) {
    const recorder = new SessionRecorder(workspace);
    const time = `2026-09-${21 + index}T08:00:00.000Z`;
    recorder.record({ type: "user_message", content: `请检查 Canvas 的发布项 ${index}`, time });
    recorder.record({ type: "assistant_message", content: "完成检查", time });
    recorder.record({ type: "user_message", content: "明天我会发布编辑器", time });
    recorder.record({ type: "assistant_message", content: "好的", time });
    await recorder.close();
    sessionIds.push(recorder.sessionId);
    const file = await resolveSessionFile(workspace, recorder.sessionId);
    originalFiles.set(file, await readFile(file, "utf8"));
    await service.engine.enqueue(recorder.sessionId);
    if (index < 2) assert.equal((await service.request({ action: "overview" })).suggestions.length, 0, "不足三段对话不产生建议");
  }
  const overview = await service.request({ action: "overview" });
  assert.equal(overview.briefs.length, 3);
  assert.ok(overview.briefs.every((brief) => brief.status === "todo"));
  assert.equal(overview.suggestions.length, 1);
  assert.equal(state.projects().length, 1, "模型建议不能自动创建项目");
  const suggestion = overview.suggestions[0]!;
  const unchanged = providerRequests;
  await service.request({ action: "backfill", sessionId: sessionIds[0]! });
  assert.equal(providerRequests, unchanged, "同材料不再次调用 SSE Provider");
  await service.request({ action: "status", sessionId: sessionIds[0]!, status: "done" });
  await service.request({ action: "accept", id: suggestion.id });
  assert.equal(state.projects().length, 1, "取消原生目录选择不写项目");
  await assert.rejects(service.request({ action: "backfill", sessionId: "../../secret" }));
  await assert.rejects(service.request({ action: "configure", config: { ...overview.config, cluster: { threads: 1, spread: 0 } } }));
  chosenDirectory = path.join(root, "Canvas");
  const located = await service.request({ action: "choose-location", id: suggestion.id });
  assert.equal(located.suggestions[0]?.location, chosenDirectory);
  await assert.rejects(stat(chosenDirectory), { code: "ENOENT" });
  assert.equal(state.projects().length, 1, "选择目录只更新草稿，不创建项目");
  invalidRevision = true;
  await assert.rejects(service.request({ action: "rewrite", id: suggestion.id, feedback: "修正目标" }), /建议之外/u);
  assert.equal((await service.request({ action: "overview" })).suggestions[0]?.brief, suggestion.brief, "失败的改写不污染草稿");
  invalidRevision = false;
  const rewritten = await service.request({ action: "rewrite", id: suggestion.id, feedback: "重点是编辑器发布，请修正目标" });
  assert.equal(rewritten.suggestions[0]?.brief, "修订后的编辑器发布目标");
  assert.equal(rewritten.suggestions[0]?.threads.length, 3);
  await assert.rejects(service.request({ action: "rewrite", id: suggestion.id, feedback: "" }));
  const accepted = await service.request({ action: "accept", id: suggestion.id });
  assert.equal(accepted.suggestions.length, 0);
  assert.equal(accepted.projects[0]?.threads.length, 3);
  assert.equal(state.projects().length, 2);
  assert.ok((await stat(chosenDirectory)).isDirectory());
  await assert.rejects(service.request({ action: "accept", id: suggestion.id }));
  for (const [file, content] of originalFiles) assert.equal(await readFile(file, "utf8"), content, "项目关联不改原会话");

  // 后续对话归属到已确认的真实项目，仍然必须二次确认。
  const next = new SessionRecorder(workspace);
  next.record({ type: "user_message", content: "继续 Canvas 发布", time: "2026-09-25T00:00:00Z" });
  next.record({ type: "assistant_message", content: "已处理", time: "2026-09-25T00:00:00Z" });
  next.record({ type: "user_message", content: "明天我会发布编辑器", time: "2026-09-25T00:00:00Z" });
  await next.close();
  await service.engine.enqueue(next.sessionId);
  const linked = await service.request({ action: "overview" });
  assert.equal(linked.suggestions[0]?.kind, "link");
  assert.equal(linked.projects[0]?.threads.length, 3);
  await service.request({ action: "dismiss", id: linked.suggestions[0]!.id });
  await service.close();
  service = createService();
  await service.initialize();
  const reopened = await service.request({ action: "overview" });
  assert.equal(reopened.briefs.find((brief) => brief.sessionId === sessionIds[0])?.status, "done");
  assert.equal(reopened.projects[0]?.projectId, accepted.projects[0]?.projectId);
  assert.equal(reopened.suggestions.length, 0);
  const history = await service.request({ action: "history" });
  assert.ok(history.history?.some((thread) => thread.projectId === project.id && thread.sessionId === next.sessionId));

  // 另一个索引用同一批真实会话：只有词相同而模型判为不同目标，不产生项目草稿。
  await service.close();
  sameThing = false;
  service = new DesktopThreadBriefService({ configStore, state, projects,
    store: new ThreadBriefStore(path.join(root, "unrelated")), chooseProjectDirectory: async () => undefined });
  await service.initialize();
  for (const sessionId of sessionIds) await service.request({ action: "backfill", sessionId });
  assert.equal((await service.request({ action: "overview" })).suggestions.length, 0);
  console.log("thread brief e2e tests passed");
} finally {
  await service.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
