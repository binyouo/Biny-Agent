import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EnvironmentCredentialStore } from "../src/config/credentials.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopApi } from "../src/desktop/protocol.js";
import { createSessionFile } from "../src/session/store.js";

// Exercise preload, schema, confirmation and real session storage; renderer fakes cannot prove deletion boundaries.
test("batch-delete IPC confirms once, cancels without side effects, validates targets, and isolates failures", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-child-pin-ipc-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const configStore = createFileConfigStore(root, {
    globalDir: path.join(root, "config"), credentialStore: new EnvironmentCredentialStore()
  });
  const alias = `pin-fixture-${randomUUID()}`;
  await configStore.save({
    ...structuredClone(defaultConfig), defaultModel: alias,
    providers: { [alias]: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { [alias]: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: alias, model: alias } }
  });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await state.load(); await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const exposed: Record<string, unknown> = {};
  let response = 1;
  let confirmations = 0;
  const phases: string[] = [];
  Object.assign(globalThis, { __deleteIpcElectron: {
    dialog: { showMessageBox: async () => { confirmations++; return { response }; } },
    contextBridge: { exposeInMainWorld(key: string, value: unknown) { exposed[key] = value; } },
    ipcMain: {
      on() {}, removeHandler(channel: string) { handlers.delete(channel); },
      handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, handler); }
    },
    ipcRenderer: { on() {}, invoke: async (channel: string, ...args: unknown[]) => {
      phases.push(channel);
      const handler = handlers.get(channel); assert.ok(handler, channel); return await handler({}, ...args);
    } }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
      source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,dialog,ipcMain,nativeTheme,shell,systemPreferences,desktopCapturer,screen,nativeImage,Menu,contextBridge,ipcRenderer,webUtils}=globalThis.__deleteIpcElectron;"
    } : next(url, context);
  } });
  try {
    for (const id of ["keep", "remove-a", "remove-b"]) {
      await createSessionFile(project.path, id, Buffer.from('{"type":"user_message","content":"fixture","time":"2026-01-01T00:00:00.000Z"}\n'));
    }
    const { registerDesktopIpc } = await import("../src/desktop/electron/main/ipc.js");
    registerDesktopIpc({ agents: manager, settings: {}, getWindow: () => undefined } as unknown as Parameters<typeof registerDesktopIpc>[0]);
    await import("../src/desktop/electron/preload/index.js");
    const api = exposed.biny as DesktopApi;
    const target = (sessionId: string) => ({ projectId: project.id, sessionId });
    let started = 0;
    assert.equal((await api.deleteSessions([target("keep")], true, () => { started++; })).cancelled, true);
    assert.equal(started, 0, "cancellation never starts a visual deletion");
    assert.equal(confirmations, 1);
    assert.equal((await manager.openSession(project.id, "keep")).session.id, "keep");
    await assert.rejects(api.deleteSessions([]));
    await assert.rejects(api.deleteSessions([target("keep")], "yes" as unknown as boolean));
    assert.equal(confirmations, 1, "invalid requests cannot open dialogs or delete records");
    response = 0;
    const batch = await api.deleteSessions([target("remove-a"), target("remove-a"), { projectId: "missing", sessionId: "missing" }, target("remove-b")], true, () => { phases.push("started"); started++; });
    assert.equal(started, 1, "confirmation signals the visual exit before storage work");
    assert.deepEqual(phases.slice(-3), ["desktop:sessions:confirm-delete", "started", "desktop:sessions:delete-confirmed"]);
    assert.equal(confirmations, 2, "one dialog covers the whole batch");
    assert.deepEqual(batch.deleted, [target("remove-a"), target("remove-b")], true, () => { phases.push("started"); started++; });
    assert.equal(batch.failures.length, 1);
    for (const id of ["remove-a", "remove-b"]) await assert.rejects(manager.openSession(project.id, id), /not found/i);
    const inline = await api.deleteSessions([target("keep")], false);
    assert.equal(confirmations, 2, "inline confirmation does not trigger a second modal");
    assert.deepEqual(inline.deleted, [target("keep")]);
    assert.ok((await stat(project.path)).isDirectory());
  } finally {
    await manager.closeAll(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__deleteIpcElectron");
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
