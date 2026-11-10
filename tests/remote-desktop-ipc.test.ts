import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { RemoteAccess } from "../src/remote/access.js";
import type { DesktopApi } from "../src/desktop/protocol.js";

test("native pairing IPC and preload reject untrusted frames and validate scope before starting access", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const host = { webContents: { mainFrame: {} } };
  let sender = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
  let api: DesktopApi;
  let attachments = 0;
  const access = new RemoteAccess({ list: async () => [], attach: async () => { attachments++; throw new Error("No test Host"); } }, () => undefined);
  Object.assign(globalThis, { __remoteIpcElectron: {
    ipcMain: { on() {}, removeHandler(channel: string) { handlers.delete(channel); }, handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, handler); } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async (channel: string, ...args: unknown[]) => { const handler = handlers.get(channel); assert.ok(handler, channel); return await handler(sender, ...args); } },
    contextBridge: { exposeInMainWorld(key: string, value: DesktopApi) { if (key === "biny") api = value; } }
  } });
  const hooks = registerHooks({ load(url, context, next) { return /\/electron\/index\.js$/u.test(url) ? { format: "module", shortCircuit: true,
    source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,dialog,ipcMain,nativeTheme,shell,systemPreferences,desktopCapturer,screen,nativeImage,Menu,contextBridge,ipcRenderer,webUtils}=globalThis.__remoteIpcElectron;"
  } : next(url, context); } });
  try {
    const { registerDesktopIpc } = await import("../src/desktop/electron/main/ipc.js");
    registerDesktopIpc({ remoteAccess: access, getWindow: () => host, settings: { assertRuntimeReady: async () => undefined }, applicationImports: { withRuntimeAdmission: async (work: () => Promise<unknown>) => await work() } } as unknown as Parameters<typeof registerDesktopIpc>[0]);
    await import("../src/desktop/electron/preload/index.js");
    assert.equal((await api!.remoteAccessStatus()).state, "disabled");
    sender = { sender: host.webContents, senderFrame: {} };
    for (const operation of [() => api!.remoteAccessStatus(), () => api!.remoteAccessStart({ relay: "https://relay.test" }), () => api!.remoteAccessStop(), () => api!.remoteAccessRegenerate()]) await assert.rejects(operation(), /只接受主窗口/u);
    assert.equal(attachments, 0);
    sender = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
    await assert.rejects(api!.remoteAccessStart({ projectId: "other", relay: "https://relay.test" } as never), /Unrecognized key/u);
    await assert.rejects(api!.remoteAccessStart({ relay: "http://relay.test" }), /HTTPS/u);
    await assert.rejects(api!.remoteAccessStart({ relay: "https://relay.test", extra: true } as never));
    assert.equal(attachments, 0);
    const started = await api!.remoteAccessStart({ relay: "https://relay.test" });
    assert.equal(started.state, "connecting");
    assert.equal(attachments, 0, "pairing no longer eagerly attaches a project Host");
    await api!.remoteAccessStop();
    assert.equal((await api!.remoteAccessStatus()).pairingUrl, undefined);
  } finally { await access.stop(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__remoteIpcElectron"); }
});
