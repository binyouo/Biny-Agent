import { ipcMain, systemPreferences, type BrowserWindow } from "electron";
import { z } from "zod";
import { ComputerUseController } from "../../../computer/controller.js";
import { CuaWorkerDriver } from "../../../computer/cuaDriver.js";
import { computerActionSchema, computerIpc, cuaVersion, windowTargetSchema, type ComputerDiagnostics, type ComputerStatus } from "../../../computer/protocol.js";
import { ComputerPreviewWindow } from "./ComputerPreviewWindow.js";
import type { DesktopBrowserService } from "./DesktopBrowserService.js";
import { cuaActionLimits } from "../../../computer/nativeActionLimits.js";

export function createComputerUseService(browser: DesktopBrowserService, getWindow: () => BrowserWindow | undefined, assertWorkAllowed: () => Promise<void>) {
  const preview = new ComputerPreviewWindow(control => { void controlComputer(control).catch(() => undefined); }, () => controller.setPreview(false));
  const driver = new CuaWorkerDriver(() => controller.crashed());
  const controller = new ComputerUseController(driver, { preview: frame => preview.update(frame, controller.status()) });
  async function diagnostics(setupError?: string): Promise<ComputerDiagnostics> {
    const permission = z.enum(["granted", "denied", "unknown"]);
    const screen = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : undefined;
    const result: ComputerDiagnostics = {
      workerPath: driver.workerPath(), hostPath: process.execPath, expectedVersion: cuaVersion, sdkLoaded: false, runtimeReady: false,
      permissions: { accessibility: process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied" : "unknown", screenRecording: screen === "granted" ? "granted" : screen === "denied" || screen === "restricted" ? "denied" : "unknown" },
      approvals: [], audit: controller.audit(), error: setupError, actionLimits: cuaActionLimits(process.platform, cuaVersion)
    };
    try {
      const data = z.object({ sdkLoaded: z.boolean(), runtimeReady: z.boolean(), driverVersion: z.string().optional(), permissions: z.object({ accessibility: permission, screenRecording: permission }) }).parse((await driver.diagnostics()).data);
      return { ...result, ...data };
    } catch (error) {
      return { ...result, error: setupError ?? (error instanceof Error ? error.message : String(error)) };
    }
  }
  async function controlComputer(control: "pause" | "resume" | "takeover" | "stop"): Promise<ComputerStatus> {
    if (control === "stop") { await controller.disable(); preview.close(); }
    else controller.control(control);
    preview.update(undefined, controller.status()); return controller.status();
  }
  const assertSender = (event: Electron.IpcMainInvokeEvent): void => {
    const contents = getWindow()?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error("Untrusted computer-use IPC sender");
  };
  ipcMain.handle(computerIpc.status, event => { assertSender(event); return controller.status(); });
  ipcMain.handle(computerIpc.enable, async event => { assertSender(event); await assertWorkAllowed(); await controller.enable(); return controller.status(); });
  ipcMain.handle(computerIpc.control, async (event, value: unknown) => { assertSender(event); return await controlComputer(z.enum(["pause", "resume", "takeover", "stop"]).parse(value)); });
  ipcMain.handle(computerIpc.preview, (event, value: unknown) => { assertSender(event); const enabled = z.boolean().parse(value); controller.setPreview(enabled); if (enabled) preview.open(); else preview.close(); return controller.status(); });
  ipcMain.handle(computerIpc.foreground, (event, value: unknown) => { assertSender(event); controller.setForeground(z.boolean().parse(value)); return controller.status(); });
  ipcMain.handle(computerIpc.logging, (event, value: unknown) => { assertSender(event); controller.setLogging(z.boolean().parse(value)); return controller.status(); });
  ipcMain.handle(computerIpc.diagnostics, async event => { assertSender(event); return await diagnostics(); });
  ipcMain.handle(computerIpc.accessibility, async event => {
    assertSender(event);
    // Only this explicit button requests AX. Passive refresh never requests either grant.
    if (process.platform !== "darwin") throw new Error("Accessibility setup is available on macOS only");
    systemPreferences.isTrustedAccessibilityClient(true);
    return await diagnostics();
  });
  ipcMain.handle(computerIpc.test, async event => {
    assertSender(event); await assertWorkAllowed();
    try { await controller.enable(); return await diagnostics(); }
    catch (error) { return await diagnostics(error instanceof Error ? error.message : String(error)); }
  });
  browser.attachComputerUse(async (method, input, signal) => {
    await assertWorkAllowed();
    const session = z.string().min(1).max(240).parse(input.session);
    const args = { ...input }; delete args.session;
    if (method === "computer_list") { const parsed = z.object({ pid: windowTargetSchema.shape.pid.optional() }).strict().parse(args); return await controller.list(session, parsed.pid, signal); }
    if (method === "computer_observe") return await controller.observe(session, windowTargetSchema.parse(args), signal);
    if (method === "computer_action") return await controller.act(session, computerActionSchema.parse(args), signal);
    throw new Error("Unsupported computer method");
  });
  return { controller, close: async () => {
    // Abort input before destroying the preview; a failing surface must not keep control alive.
    try { await controller.disable(); }
    finally { try { preview.close(); } finally { try { await driver.dispose(); } finally { for (const channel of Object.values(computerIpc)) ipcMain.removeHandler(channel); } } }
  } };
}
