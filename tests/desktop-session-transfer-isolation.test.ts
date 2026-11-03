import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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

// Real IPC, manager, project service and file output; Electron dialogs are controlled locally.
test("session transfer cancellation does not read source or workspace; accepted export writes once", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-transfer-isolation-")));
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
  let savePath: string | undefined;
  Object.assign(globalThis, { __transferIpcElectron: {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: !savePath, filePath: savePath }) },
    contextBridge: { exposeInMainWorld(key: string, value: unknown) { exposed[key] = value; } },
    ipcMain: {
      on() {}, removeHandler(channel: string) { handlers.delete(channel); },
      handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, handler); }
    },
    ipcRenderer: { on() {}, invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel); assert.ok(handler, channel); return await handler({}, ...args);
    } }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
      source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,dialog,ipcMain,nativeTheme,shell,systemPreferences,desktopCapturer,screen,nativeImage,Menu,contextBridge,ipcRenderer,webUtils}=globalThis.__transferIpcElectron;"
    } : next(url, context);
  } });
  try {
    const { registerDesktopIpc } = await import("../src/desktop/electron/main/ipc.js");
    registerDesktopIpc({ agents: manager, projects, settings: {}, getWindow: () => undefined } as unknown as Parameters<typeof registerDesktopIpc>[0]);
    await import("../src/desktop/electron/preload/index.js");
    const api = exposed.biny as DesktopApi;
    const projections = t.mock.method(manager, "workspaceSnapshot", async () => { throw new Error("unrelated workspace unavailable"); });
    const sourceReads = t.mock.method(projects, "buildSessionExport", projects.buildSessionExport.bind(projects));
    const roots = t.mock.method(projects, "dataRoot", projects.dataRoot.bind(projects));
    assert.equal(await api.importSession(project.id), undefined);
    assert.equal(await api.exportSession(project.id, "missing-session", "biny"), undefined);
    assert.equal(await api.exportSession(project.id, "missing-session", "claude"), undefined);
    assert.equal(projections.mock.callCount(), 0);
    assert.equal(sourceReads.mock.callCount(), 0);
    assert.equal(roots.mock.callCount(), 0, "cancel does not inspect session storage before showing the dialog");
    await createSessionFile(project.path, "session-export", Buffer.from('{"type":"user_message","content":"portable content","time":"2026-10-31T00:00:00.000Z"}\n'));
    savePath = path.join(root, "session-export.biny.json");
    assert.equal(await api.exportSession(project.id, "session-export", "biny"), undefined);
    assert.match(await readFile(savePath, "utf8"), /portable content/);
    assert.equal(sourceReads.mock.callCount(), 1);
    assert.equal(projections.mock.callCount(), 0);
  } finally {
    await manager.closeAll(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__transferIpcElectron");
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
