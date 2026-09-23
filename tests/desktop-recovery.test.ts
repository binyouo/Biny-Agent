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
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* 消费请求体后再设置屏障。 */ }
  providerReached = true;
  if (!resumeRequested) return;
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
  const facts = await readSessionEvents(file);
  assert.equal(facts.filter((event) => event.type === "user_message").length, 1, "继续不创建重复用户任务");
  const terminals = facts.filter((event) => event.type === "turn_status");
  assert.equal(terminals.length, 2);
  assert.equal(terminals[0]?.runtime?.turnId, terminals[1]?.runtime?.turnId, "恢复必须续接同一 turn");
  assert.equal(terminals[1]?.status, "completed");
  assert.equal((await manager.openSession(project.id, original.sessionId)).recovery, undefined);
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
  const buttonResumed = await manager.resumeInterruptedTurn(project.id, buttonTask.sessionId);
  assert.ok(buttonResumed);
  await waitFor(() => completedRunId === buttonResumed.runId);
  const buttonFacts = await readSessionEvents(sessionFilePath(root, buttonTask.sessionId));
  assert.equal(buttonFacts.filter((event) => event.type === "user_message").length, 1);
  const buttonTerminals = buttonFacts.filter((event) => event.type === "turn_status");
  assert.equal(buttonTerminals[0]?.stopReason, "paused");
  assert.equal(buttonTerminals[0]?.runtime?.turnId, buttonTerminals[1]?.runtime?.turnId);
  console.log("desktop recovery tests passed (close and composer pause, explicit resume, same task)");
} finally {
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
