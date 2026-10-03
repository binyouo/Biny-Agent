/** 真实 preload、IPC、安装资源和 Relay 服务；仅系统窗口、剪贴板和启动进程使用 fake。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopApi } from "../src/desktop/protocol.js";
import { desktopIpc } from "../src/desktop/protocol.js";
import { requestBrowserRelay } from "../src/browser/relayClient.js";

test("安装配对从 preload 到主进程实际生效，拒绝其他发送者、错误参数和凭据泄漏", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const exposed: Record<string, unknown> = {};
  const host = { webContents: { mainFrame: {} } };
  let sender = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
  let clipboard = "", folderError = "";
  const folders: string[] = [];
  const launches: unknown[] = [];
  const originalExec = childProcess.execFile;
  const execute = ((command: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(command, "/usr/bin/open");
    launches.push({ command, args, timeout: options.timeout });
    queueMicrotask(() => callback(null, "", ""));
  }) as typeof childProcess.execFile;
  childProcess.execFile = execute;
  syncBuiltinESMExports();
  Object.assign(globalThis, { __relayIpcElectron: {
    clipboard: { writeText(value: string) { clipboard = value; } },
    shell: { openPath: async (value: string) => { folders.push(value); return folderError; } },
    contextBridge: { exposeInMainWorld(key: string, value: unknown) { exposed[key] = value; } },
    ipcMain: { on() {}, removeHandler(channel: string) { handlers.delete(channel); }, handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, handler); } },
    ipcRenderer: { on() {}, invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel); assert.ok(handler, channel); return await handler(sender, ...args);
    } }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
      source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,dialog,ipcMain,nativeTheme,shell,systemPreferences,desktopCapturer,screen,nativeImage,Menu,contextBridge,ipcRenderer,webUtils}=globalThis.__relayIpcElectron;"
    } : next(url, context);
  } });
  let browser: { dispose(): Promise<void> } | undefined;
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const { registerDesktopIpc } = await import("../src/desktop/electron/main/ipc.js");
    const service = new DesktopBrowserService(async () => "/unused"); browser = service;
    registerDesktopIpc({ browser: service, getWindow: () => host, settings: {} } as unknown as Parameters<typeof registerDesktopIpc>[0]);
    await import("../src/desktop/electron/preload/index.js");
    const api = exposed.biny as DesktopApi;
    assert.deepEqual(await api.browserRelayStatus(), { running: false, connected: false, browsers: [] });
    const installed = await api.browserRelayInstall();
    assert.deepEqual(Object.keys(installed), ["extensionPath"]);
    assert.equal(folders[0], installed.extensionPath);
    assert.equal(JSON.parse(await readFile(path.join(installed.extensionPath, "manifest.json"), "utf8")).manifest_version, 3);
    assert.equal(clipboard, "");
    folderError = "system error";
    await assert.rejects(api.browserRelayInstall(), /扩展目录无法打开/);
    assert.equal(clipboard, "");
    folderError = "";
    if (process.platform === "darwin") {
      await api.browserRelayOpenChrome();
      assert.deepEqual(launches, [{ command: "/usr/bin/open", args: ["-a", "Google Chrome", "chrome://extensions/"], timeout: 5000 }]);
    } else await assert.rejects(api.browserRelayOpenChrome(), /macOS/);
    const paired = await api.browserRelaySetup();
    assert.deepEqual(paired, installed);
    assert.match(clipboard, /^ws:\/\/127\.0\.0\.1:\d+\/relay\?token=[a-f0-9]{64}$/);
    const previous = clipboard;
    await api.browserRelaySetup();
    assert.ok(clipboard === previous, "重复复制不轮换凭据");
    await assert.rejects(Promise.resolve().then(() => handlers.get(desktopIpc.browserRelaySetup)!(sender, "true")), /boolean/);
    assert.ok(clipboard === previous, "错误参数不修改配对");
    await api.browserRelaySetup(true);
    assert.ok(clipboard !== previous, "重新生成已生效");
    assert.deepEqual(await requestBrowserRelay("status"), { running: true, connected: false, browsers: [] });
    assert.ok(!JSON.stringify(paired).includes(new URL(clipboard).searchParams.get("token")!), "preload 响应不含配对凭据");
    sender = { sender: host.webContents, senderFrame: {} };
    for (const action of [() => api.browserRelayInstall(), () => api.browserRelayOpenChrome(), () => api.browserRelaySetup(true), () => api.browserRelayDisconnect()]) {
      await assert.rejects(action(), /只接受主窗口请求/);
    }
    sender = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
    await api.browserRelayDisconnect();
    assert.deepEqual(await api.browserRelayStatus(), { running: true, connected: false, browsers: [] });
  } finally {
    await browser?.dispose(); hooks.deregister();
    childProcess.execFile = originalExec; syncBuiltinESMExports();
    Reflect.deleteProperty(globalThis, "__relayIpcElectron");
  }
});
