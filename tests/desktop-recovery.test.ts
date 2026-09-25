/** 真实 Desktop Manager → Host → Agent → 磁盘，模型由本地 HTTP 屏障控制。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-recovery-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
let providerReached = false;
let resumeRequested = false;
let completedRunId: string | undefined;
let holdResponse = false;
let releaseHeldResponse: (() => void) | undefined;
const providerRequestBodies: string[] = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  providerRequestBodies.push(body);
  providerReached = true;
  if (!resumeRequested) return;
  if (holdResponse) await new Promise<void>((resolve) => { releaseHeldResponse = resolve; });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "resumed task complete" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
let manager: DesktopAgentManager | undefined;
try {
  const configStore = new DesktopConfigStore(path.join(root, "config"), {
    persistent: true, get: async () => undefined, set: async () => undefined, delete: async () => undefined
  });
  await configStore.save(configSchema.parse({
    ...defaultConfig,
    activity: { ...defaultConfig.activity, enabled: false },
    defaultModel: "local-test",
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "local-test": { provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
    thinking: { ...defaultConfig.thinking, enabled: false },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context,
      emotion: { ...defaultConfig.context.emotion, enabled: false },
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  }));
  const storage = new DesktopUserDataStore(path.join(root, "desktop"));
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createProject(root);
  const createManager = (): DesktopAgentManager => new DesktopAgentManager(state, projects, configStore, (_projectId, update) => {
    if (update.event?.type === "run.completed") completedRunId = update.event.runId;
    if (update.event?.type === "run.failed") console.error(update.event);
  });
  manager = createManager();
  const original = await manager.sendPrompt(project.id, undefined, "preserve this unfinished task", []);
  await waitFor(() => providerReached);
  // 窗口关闭调用相同的公开入口，不能把任务作为用户放弃来清理。
  await manager.pauseAllForExit();
  await manager.closeAll();
  const file = sessionFilePath(root, original.sessionId);
  const paused = await readSessionEvents(file);
  const terminal = paused.find((event) => event.type === "turn_status");
  assert.ok(terminal?.type === "turn_status");
  assert.equal(terminal.stopReason, "paused");
  assert.equal(terminal.resumable, true);

  manager = createManager();
  const reopened = await manager.openSession(project.id, original.sessionId);
  assert.equal(reopened.recovery?.canContinue, true);
  assert.equal(manager.hasRunningTasks(), false, "重新打开只能恢复展示，不能自动启动任务");
  resumeRequested = true;
  const resumed = await manager.resumeInterruptedTurn(project.id, original.sessionId);
  assert.ok(resumed);
  assert.notEqual(resumed.runId, original.runId);
  assert.equal(resumed.sessionId, original.sessionId);
  await waitFor(() => completedRunId === resumed.runId);
  assert.equal(providerRequestBodies.at(-1)?.includes("<turn_paused>") ?? false, true,
    "空输入继续应让模型看到上次任务暂停的事实");
  const emptyRequest = JSON.parse(providerRequestBodies.at(-1) ?? "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
  assert.equal(JSON.stringify(emptyRequest.messages).includes("preserve this unfinished task"), true,
    "空输入新回合应沿用之前的会话任务");
  assert.equal(emptyRequest.messages?.some((message) => message.role === "user" && message.content === ""), false,
    "空输入按钮不能伪造一条空白用户消息给模型");
  const facts = await readSessionEvents(file);
  assert.equal(facts.filter((event) => event.type === "user_message" && !event.auditOnly).length, 1, "继续不创建重复用户任务");
  assert.equal(facts.filter((event) => event.type === "user_message" && event.auditOnly && event.metadata?.turnTrigger === "resume_interrupted_task").length, 1,
    "空输入新回合必须留下可辨认的持久边界");
  const terminals = facts.filter((event) => event.type === "turn_status");
  assert.equal(terminals.length, 2);
  assert.notEqual(terminals[0]?.runtime?.turnId, terminals[1]?.runtime?.turnId, "空输入继续应开始新 turn");
  assert.equal(terminals[1]?.status, "completed");
  assert.equal((await manager.openSession(project.id, original.sessionId)).recovery, undefined);
  assert.equal(await manager.resumeInterruptedTurn(project.id, original.sessionId), undefined, "重复点击不能重开已完成任务");
  // Composer 的暂停按钮走 cancelRun；暂停后也必须保留同一任务供继续。
  providerReached = false;
  resumeRequested = false;
  const buttonTask = await manager.sendPrompt(project.id, undefined, "pause from composer", []);
  await waitFor(() => providerReached);
  await manager.cancelRun(project.id, buttonTask.runId);
  await waitFor(() => !manager!.hasRunningTasks());
  const buttonPaused = await manager.openSession(project.id, buttonTask.sessionId);
  assert.equal(buttonPaused.recovery?.canContinue, true, "点击暂停后必须可继续");
  resumeRequested = true;
  holdResponse = true;
  const buttonResumed = await manager.resumeInterruptedTurn(project.id, buttonTask.sessionId);
  assert.ok(buttonResumed);
  await waitFor(() => releaseHeldResponse !== undefined);
  const requestCount = providerRequestBodies.length;
  await assert.rejects(manager.resumeInterruptedTurn(project.id, buttonTask.sessionId), /busy|正在运行/u,
    "重复点击不能并发执行第二次回合");
  assert.equal(providerRequestBodies.length, requestCount);
  holdResponse = false;
  releaseHeldResponse?.();
  releaseHeldResponse = undefined;
  await waitFor(() => completedRunId === buttonResumed.runId);
  const buttonFacts = await readSessionEvents(sessionFilePath(root, buttonTask.sessionId));
  assert.equal(buttonFacts.filter((event) => event.type === "user_message" && !event.auditOnly).length, 1);
  const buttonTerminals = buttonFacts.filter((event) => event.type === "turn_status");
  assert.equal(buttonTerminals[0]?.stopReason, "paused");
  assert.notEqual(buttonTerminals[0]?.runtime?.turnId, buttonTerminals[1]?.runtime?.turnId);
  // 暂停后输入自由文本应成为同一会话的新回合；模型仍能理解刚被暂停的工作。
  providerReached = false;
  resumeRequested = false;
  const naturalTask = await manager.sendPrompt(project.id, undefined, "inspect old task", []);
  await waitFor(() => providerReached);
  await manager.cancelRun(project.id, naturalTask.runId);
  await waitFor(() => !manager!.hasRunningTasks());
  assert.equal((await manager.openSession(project.id, naturalTask.sessionId)).recovery?.canContinue, true);
  resumeRequested = true;
  const naturalFollowup = await manager.sendPrompt(project.id, naturalTask.sessionId, "继续", []);
  await waitFor(() => completedRunId === naturalFollowup.runId);
  const naturalFacts = await readSessionEvents(sessionFilePath(root, naturalTask.sessionId));
  const naturalMessages = naturalFacts.filter((event) => event.type === "user_message");
  assert.deepEqual(naturalMessages.map((event) => event.content), ["inspect old task", "继续"]);
  assert.notEqual(naturalMessages[0]?.runtime?.turnId, naturalMessages[1]?.runtime?.turnId);
  assert.equal(naturalFacts.filter((event) => event.type === "turn_status" && event.stopReason === "paused").length, 1);
  const lastRequest = providerRequestBodies.at(-1) ?? "";
  assert.equal(lastRequest.includes("inspect old task"), true, "新回合模型请求保留先前工作");
  assert.equal(lastRequest.includes("继续"), true, "自由输入原样交给模型");
  assert.equal(lastRequest.includes("<turn_paused>"), true, "模型能区分暂停事实，不能误以为旧任务已完成");
  assert.equal((await manager.openSession(project.id, naturalTask.sessionId)).recovery, undefined,
    "新输入受理后不能重新唤起被替代的旧断点");
  console.log("desktop recovery tests passed (pause, new turn follow-up, natural input)");
} finally {
  releaseHeldResponse?.();
  await manager?.closeAll();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

async function waitFor(condition: () => boolean): Promise<void> {
  // HTTP/Host 的进程调度需要真实轮询；条件满足即返回，15 秒仅作硬超时。
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Desktop recovery condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
