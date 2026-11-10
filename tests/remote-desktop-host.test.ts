import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createRemotePeerApi, type RemoteView } from "../src/remote/api.js";
import type { RuntimeHostClient } from "../src/runtime/host/client.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";
import { readSessionMessages } from "../src/session/inspection.js";

test("Desktop pairing lets a phone pick its project Host and keeps working when Desktop changes project", { timeout: 15000 }, async t => {
  const provider = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Scoped mobile reply" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-remote-desktop-host-"));
  t.after(async () => { await removeTestRoot(root, { recursive: true, force: true }); });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  configStore.supportsDetachedRuntimeHost = false;
  const config = structuredClone(defaultConfig);
  config.defaultModel = "local-test";
  config.providers = { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false } };
  config.models = { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } };
  config.context.memory.enabled = false;
  config.context.memory.generateMemories = false;
  config.context.memory.useMemories = false;
  config.context.identity.enabled = false;
  config.heartbeat.enabled = false;
  config.extensions.mcp = {};
  config.chat.defaultToolSelection = "none";
  config.chat.defaultSkillSelection = "none";
  config.chat.skillExtraction.enabled = false;
  config.thinking.enabled = false;
  await configStore.save(config);
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
  let attachedEntry: { workspaceRoot: string; client: RuntimeHostClient } | undefined;
  let peer: ReturnType<typeof createRemotePeerApi> | undefined;
  try {
    const first = await projects.createEmptyProject(path.join(root, "first"));
    const second = await projects.createEmptyProject(path.join(root, "second"));
    peer = createRemotePeerApi({
      list: () => projects.remoteWorkspaces(),
      attach: async projectId => (attachedEntry = await agents.attachRemoteClient(projectId))
    }, () => undefined);
    const listed = await peer.handle({ id: crypto.randomUUID(), method: "projects" }) as { items: Array<{ id: string; name: string }> };
    assert.deepEqual(listed.items.map(item => item.id).sort(), [first.id, second.id].sort());
    const created = await peer.handle({ id: crypto.randomUUID(), method: "create", projectId: first.id }) as RemoteView;
    assert.equal(attachedEntry!.workspaceRoot, await projects.dataRoot(first));
    const sent = await peer.handle({ id: crypto.randomUUID(), method: "send", sessionId: created.sessionId, text: "Persist this mobile conversation" }) as { accepted: boolean };
    assert.equal(sent.accepted, true);
    const deadline = Date.now() + 5000;
    while (!(await readSessionMessages(attachedEntry!.workspaceRoot, created.sessionId, { offset: 0, limit: 20, full: true })).messages.some(message => message.content.includes("Scoped mobile reply"))) {
      assert.ok(Date.now() < deadline, "Mobile message was not persisted by the Desktop Host");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await agents.startDraft(second.id);
    const opened = await peer.handle({ id: crypto.randomUUID(), method: "open", projectId: first.id, sessionId: created.sessionId }) as RemoteView;
    assert.equal(opened.sessionId, created.sessionId);
    const foreign = await peer.handle({ id: crypto.randomUUID(), method: "sessions", projectId: second.id }) as { items: Array<{ id: string }> };
    assert.ok(!foreign.items.some(item => item.id === created.sessionId), "session catalog stays scoped to the requested project");
    const local = await agents.openSession(first.id, created.sessionId);
    assert.equal(local.session.id, created.sessionId, "Desktop reads the session created through the mobile protocol");
    const remote = await attachedEntry!.client.ensureSession({ sessionId: created.sessionId, focus: false });
    assert.equal(remote.snapshot.info.workspaceRoot, first.path);
    await peer.close(); peer = undefined;
    const remaining = await agents.openSession(first.id, created.sessionId);
    assert.equal(remaining.session.id, created.sessionId, "closing mobile access leaves the local Host session usable");
  } finally {
    await peer?.close();
    await agents.closeAll();
  }
});
