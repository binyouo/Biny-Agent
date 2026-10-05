import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import { Appshots } from "../../../computer/appshots.js";
import { appshotsIpc, appshotsSettingsSchema } from "../../../computer/appshotsProtocol.js";
import { NativeProcessDriver } from "../../../computer/nativeDriver.js";
import type { AgentConfigStore } from "../../../config/store.js";
import type { DesktopProjectService } from "./DesktopProjectService.js";

export async function createAppshotsService(store: AgentConfigStore, projects: DesktopProjectService, getWindow: () => BrowserWindow | undefined) {
  const driver = new NativeProcessDriver(() => undefined);
  let closed = false;
  const appshots = new Appshots(driver, store, event => {
    const window = getWindow(); if (!window || window.isDestroyed()) return;
    window.webContents.send(appshotsIpc.event, event);
    if (event.type !== "starting") {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    }
  });
  const assertSender = (event: Electron.IpcMainInvokeEvent): void => {
    const contents = getWindow()?.webContents;
    if (closed || !contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error("Untrusted Appshots IPC sender");
  };
  ipcMain.handle(appshotsIpc.state, event => { assertSender(event); return appshots.state(); });
  ipcMain.handle(appshotsIpc.settings, (event, value: unknown) => { assertSender(event); return appshots.settings(appshotsSettingsSchema.parse(value)); });
  ipcMain.handle(appshotsIpc.prewarm, event => { assertSender(event); return appshots.prewarm(); });
  ipcMain.handle(appshotsIpc.capture, async event => {
    assertSender(event); const window = getWindow(); window?.hide();
    try { return await appshots.capture(); } finally { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
  });
  ipcMain.handle(appshotsIpc.attach, async (event, projectId: unknown, id: unknown) => {
    assertSender(event); const project = projects.requireProject(z.string().min(1).parse(projectId));
    const capture = await appshots.take(z.string().uuid().parse(id));
    try { return await projects.saveAttachment(project, capture.name, "image/jpeg", capture.bytes, capture.context); }
    finally { capture.bytes.fill(0); }
  });
  if ((await store.load()).appshots.hotkey) await appshots.prewarm();
  return { close: async () => { closed = true; for (const channel of Object.values(appshotsIpc)) if (channel !== appshotsIpc.event) ipcMain.removeHandler(channel); await appshots.close(); } };
}
