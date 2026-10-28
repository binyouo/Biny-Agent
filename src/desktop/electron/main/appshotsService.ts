import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import { Appshots } from "../../../computer/appshots.js";
import { appshotsIpc, appshotsSettingsSchema } from "../../../computer/appshotsProtocol.js";
import { NativeProcessDriver } from "../../../computer/nativeDriver.js";
import { AppshotFeedback } from "./AppshotFeedback.js";
import type { AgentConfigStore } from "../../../config/store.js";
import type { DesktopProjectService } from "./DesktopProjectService.js";

export async function createAppshotsService(store: AgentConfigStore, projects: DesktopProjectService, getWindow: () => BrowserWindow | undefined) {
  const driver = new NativeProcessDriver(() => undefined);
  const feedback = new AppshotFeedback();
  const deliveries = new Set<{ abort: AbortController; timer?: ReturnType<typeof setTimeout>; cancelWait?: () => void }>();
  let closed = false;
  const appshots = new Appshots(driver, store, (event, cue) => {
    if (cue?.type === "hotkey") feedback.sound();
    const window = getWindow(); if (!window || window.isDestroyed()) return;
    if (event.type !== "starting") {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    }
    const deliver = (): void => { if (!closed && getWindow() === window && !window.isDestroyed()) window.webContents.send(appshotsIpc.event, event); };
    if (event.type !== "captured" || cue?.type !== "captured") { deliver(); return; }
    const job: { abort: AbortController; timer?: ReturnType<typeof setTimeout>; cancelWait?: () => void } = { abort: new AbortController() };
    deliveries.add(job);
    const wait = (ms: number): Promise<boolean> => new Promise(resolve => {
      job.cancelWait = () => resolve(false);
      job.timer = setTimeout(() => { job.timer = undefined; job.cancelWait = undefined; resolve(true); }, ms);
    });
    void (async () => {
      try {
        const started = await Promise.race([feedback.animate(window, cue.frame, cue.bytes, cue.icon, job.abort.signal).catch(() => false), wait(700).then(() => false)]);
        if (job.timer) clearTimeout(job.timer); job.timer = undefined; job.cancelWait = undefined;
        if (!started) job.abort.abort();
        if (started) await wait(715);
        deliver();
      } catch (error) { console.error("Appshot delivery failed", error instanceof Error ? error.name : "Error"); }
      finally { if (job.timer) clearTimeout(job.timer); deliveries.delete(job); }
    })();
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
    try {
      const initial = capture.context, pending = capture.contextPending === true;
      const attachment = await projects.saveAttachment(project, capture.name, "image/jpeg", capture.bytes, initial, pending);
      if (pending) {
        const update = (context: string): void => {
          if (!closed) void projects.updateAppshotAttachmentContext(project, attachment.path, context).catch(error => console.error("Appshot context update failed", error instanceof Error ? error.name : "Error"));
        };
        if (capture.contextPending) capture.onContext = update;
        else if (capture.context !== initial) await projects.updateAppshotAttachmentContext(project, attachment.path, capture.context);
      }
      return attachment;
    }
    finally { capture.bytes.fill(0); }
  });
  if ((await store.load()).appshots.hotkey) await appshots.prewarm();
  return { close: async () => {
    closed = true;
    for (const job of deliveries) { job.abort.abort(); if (job.timer) clearTimeout(job.timer); job.cancelWait?.(); }
    let feedbackError: unknown;
    try { feedback.close(); } catch (error) { feedbackError = error; }
    for (const channel of Object.values(appshotsIpc)) if (channel !== appshotsIpc.event) ipcMain.removeHandler(channel);
    try { await appshots.close(); } catch (error) { if (feedbackError) throw new AggregateError([feedbackError, error], "Appshots cleanup failed"); throw error; }
    if (feedbackError) throw feedbackError;
  } };
}
