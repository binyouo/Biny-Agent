import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
import { refreshSessionIndex, registerSessionBranch, updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { createSessionFile } from "../src/session/store.js";

// The real preload/schema/manager/service chain must carry the optional reset projection;
// App callback tests alone cannot detect IPC stripping the new request flag.
test("tree-page IPC carries authoritative pins only when requested without starting a runtime", async () => {
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
  Object.assign(globalThis, { __pinIpcElectron: {
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
      source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,dialog,ipcMain,nativeTheme,shell,systemPreferences,desktopCapturer,screen,nativeImage,Menu,contextBridge,ipcRenderer,webUtils}=globalThis.__pinIpcElectron;"
    } : next(url, context);
  } });
  try {
    await createSessionFile(project.path, "parent", Buffer.from('{"type":"user_message","content":"parent","time":"2025-12-31T00:00:00.000Z"}\n'));
    for (let index = 0; index < 33; index += 1) {
      const id = `child-${String(index).padStart(2, "0")}`;
      await createSessionFile(project.path, id, Buffer.from(`${JSON.stringify({
        type: "user_message", content: id, time: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
      })}\n`));
      await registerSessionBranch(project.path, { sessionId: id, parentSessionId: "parent", branchPoint: { kind: "event", index: 1 } });
    }
    await updateSessionCatalogMetadata(project.path, "child-00", { pinned: true });
    const { registerDesktopIpc } = await import("../src/desktop/electron/main/ipc.js");
    registerDesktopIpc({ agents: manager, settings: {} } as unknown as Parameters<typeof registerDesktopIpc>[0]);
    await import("../src/desktop/electron/preload/index.js");
    const api = exposed.biny as DesktopApi;
    const options = { parentSessionId: "parent", limit: 32, includeArchived: true };
    const plain = await api.listSessionTreePage(project.id, options);
    const withPins = await api.listSessionTreePage(project.id, { ...options, includePinnedSessions: true });
    assert.equal(plain.pinnedSessions, undefined);
    assert.deepEqual(withPins.sessions, plain.sessions);
    assert.equal(withPins.nextCursor, plain.nextCursor);
    assert.equal(withPins.revision, plain.revision);
    assert.deepEqual(withPins.pinnedSessions?.map((row) => row.id), ["child-00"]);
    assert.equal(withPins.sessions.some((row) => row.id === "child-00"), false);
    const targeted = await api.listSessionTreePage(project.id, { ...options, sessionIds: ["child-00", "child-00", "deleted-child"] });
    assert.deepEqual(targeted.sessions, plain.sessions, "supplemental rows must not change pagination");
    assert.equal(targeted.nextCursor, plain.nextCursor);
    assert.deepEqual(targeted.supplementalSessions?.map(row => row.id), ["child-00"]);
    assert.equal(targeted.supplementalSessions?.[0]?.pinned, true);
    await updateSessionCatalogMetadata(project.path, "child-00", { pinned: false });
    const invalid = await api.listSessionTreePage(project.id, { ...options, cursor: plain.nextCursor, includePinnedSessions: true, sessionIds: ["child-00"] });
    assert.equal(invalid.revisionChanged, true);
    assert.deepEqual(invalid.sessions, []);
    assert.equal(invalid.pinnedSessions, undefined);
    assert.equal(invalid.supplementalSessions, undefined, "a stale page cannot confirm requested rows were removed");
    const fresh = await api.listSessionTreePage(project.id, { ...options, includePinnedSessions: true });
    assert.deepEqual(fresh.pinnedSessions, []);
    await assert.rejects(api.listSessionTreePage(project.id, { ...options, includePinnedSessions: "yes" as unknown as boolean }), /boolean/);
    await assert.rejects(api.listSessionTreePage(project.id, { sessionIds: [""] }));
    await assert.rejects(api.listSessionTreePage(project.id, { sessionIds: ["x".repeat(241)] }));
    const many = await api.listSessionTreePage(project.id, { sessionIds: ["child-00", ...Array.from({ length: 501 }, (_, index) => `missing-${index}`)] });
    assert.deepEqual(many.supplementalSessions?.map(row => row.id), ["child-00"], "loaded rows are not capped at a single page or mutation batch");
    assert.equal((await manager.workspaceSnapshot(project.id, false)).runtime, undefined);
  } finally {
    await manager.closeAll(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__pinIpcElectron");
    await refreshSessionIndex(project.path);
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
