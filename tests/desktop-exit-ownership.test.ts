/** Desktop 全进程退出只断开客户端；常驻 Host 上的任务继续运行。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { connectRuntimeHost } from "../src/runtime/host/connection.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { isProcessAlive, terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-exit-ownership-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
let providerRequests = 0;
const requestPrompts: string[] = [];
const releaseResponses: Array<() => void> = [];
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ content: unknown }> };
  requestPrompts.push(JSON.stringify(payload.messages?.at(-1)?.content));
  providerRequests += 1;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      response.off("close", finish);
      resolve();
    };
    response.once("close", finish);
    releaseResponses.push(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: [DONE]\n\n");
      }
      finish();
    });
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");

let manager: DesktopAgentManager | undefined;
let owner: Awaited<ReturnType<typeof spawnRuntimeHost>> | undefined;
let peer: Awaited<ReturnType<typeof connectRuntimeHost>>;
try {
  const configStore = new DesktopConfigStore(path.join(root, "config"), {
    persistent: true,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  });
  await configStore.save(configSchema.parse({
    ...defaultConfig,
    activity: { ...defaultConfig.activity, enabled: false },
    defaultModel: "local-test",
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "local-test": { provider: "local", model: "local-test", contextWindow: 128_000, capabilities: { tools: true, reasoning: false, streaming: true } } },
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
  const dataRoot = await projects.dataRoot(project);
  owner = await spawnRuntimeHost(dataRoot, {
    workspaceRoot: root,
    configDir: path.join(root, "config"),
    lifecycleMode: "ephemeral",
    idleGraceMs: 150,
    keepAlive: false,
    surface: "tui"
  });
  manager = new DesktopAgentManager(state, projects, configStore, () => undefined);

  const desktopRun = await manager.sendPrompt(project.id, undefined, "Desktop task to pause", []);
  peer = await connectRuntimeHost(dataRoot, {
    configDir: path.join(root, "config"),
    clientId: "tui-peer",
    surface: "tui"
  });
  assert.ok(peer, "the second surface should attach to the same Host");
  const peerSession = await peer.ensureSession({ writeIntent: true, focus: false });
  const peerRun = await peer.submitRunForSession(peerSession.sessionId, "TUI task that must keep running", []);
  assert.equal(peerRun.accepted, true);
  await waitFor(() => providerRequests === 2);
  // Opening a shared Session makes its snapshot visible to Desktop without transferring writer ownership.
  await manager.openSession(project.id, peerSession.sessionId);

  await manager.closeAll();
  assert.equal(peer.getSnapshot(desktopRun.sessionId).state.kind, "runs", "Desktop client shutdown must leave the background Host run active");
  assert.equal(peer.getSnapshot(desktopRun.sessionId).state.kind === "runs"
    ? peer.getSnapshot(desktopRun.sessionId).state.activeRun.runId
    : undefined, desktopRun.runId);
  const desktopEvents = await readSessionEvents(sessionFilePath(dataRoot, desktopRun.sessionId));
  assert.ok(!desktopEvents.some((event) => event.type === "turn_status" && event.stopReason === "paused"), "Desktop shutdown must not persist a pause");
  assert.equal(peer.getSnapshot(peerSession.sessionId).state.kind, "runs",
    "a Desktop exit action must not pause a TUI-owned run on the shared Host");
  assert.equal(peer.getSnapshot(peerSession.sessionId).state.kind === "runs"
    ? peer.getSnapshot(peerSession.sessionId).state.activeRun.runId
    : undefined, peerRun.result?.runId);

  await peer.cancelRunRequest(peerRun.result!.runId, "cancelled", peerSession.sessionId);
  await peer.waitForIdle(peerSession.sessionId);
  await peer.cancelRunRequest(desktopRun.runId, "cancelled", desktopRun.sessionId);
  await peer.waitForIdle(desktopRun.sessionId);

  // 同一个 Desktop manager 保持观察连接，空闲 owner 仍应回收；再次发送才创建执行者。
  manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  await manager.toolCatalog(project.id);
  await peer.close();
  peer = undefined;
  await waitFor(() => !isProcessAlive(owner!.process.pid!));
  const draft = await manager.startDraft(project.id);
  assert.equal(draft.runtime, undefined, "回收后的新聊天只准备草稿，不启动 Host");
  const cold = await manager.workspaceSnapshot(project.id, false);
  assert.equal(cold.runtime, undefined);
  const nextRun = await manager.sendPrompt(project.id, desktopRun.sessionId, "Continue after idle retirement", []);
  await waitFor(() => requestPrompts.some((prompt) => prompt.includes("Continue after idle retirement")));
  const continuedEvents = await readSessionEvents(sessionFilePath(dataRoot, desktopRun.sessionId));
  assert.equal(continuedEvents.filter((event) => event.type === "user_message" && event.content === "Desktop task to pause").length, 1);
  assert.equal(continuedEvents.filter((event) => event.type === "user_message" && event.content === "Continue after idle retirement").length, 1);
  assert.notEqual(nextRun.runId, desktopRun.runId);
  assert.equal(nextRun.sessionId, desktopRun.sessionId, "回收后继续原会话，不另建或重放历史请求");
  manager.cancelAll();
  console.log("desktop exit ownership tests passed");
} finally {
  for (const release of releaseResponses) release();
  await peer?.close().catch(() => undefined);
  await manager?.closeAll();
  await owner?.client.close().catch(() => undefined);
  if (owner) await terminateSpawnedHost(owner.process);
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Desktop exit ownership condition timed out.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
