import { ipcMain, systemPreferences, type BrowserWindow } from "electron";
import { z } from "zod";
import { ComputerAppApprovals } from "../../../computer/appApprovals.js";
import { ComputerUseController } from "../../../computer/controller.js";
import { CuaProcessDriver } from "../../../computer/cuaDriver.js";
import { updateConfig, type AgentConfigStore } from "../../../config/store.js";
import { computerActionSchema, computerIpc, cuaVersion, windowTargetSchema, type ComputerDiagnostics, type ComputerStatus } from "../../../computer/protocol.js";
import { ComputerPreviewWindow } from "./ComputerPreviewWindow.js";
import type { DesktopBrowserService } from "./DesktopBrowserService.js";
import { cuaActionLimits } from "../../../computer/nativeActionLimits.js";

export async function createComputerUseService(browser: DesktopBrowserService, getWindow: () => BrowserWindow | undefined, assertWorkAllowed: () => Promise<void>, configStore: AgentConfigStore, createDriver = (onExit: () => void) => new CuaProcessDriver(onExit)) {
  const config = await configStore.load();
  const preview = new ComputerPreviewWindow(control => { void controlComputer(control).catch(() => undefined); }, () => controller.setPreview(false));
  const driver = createDriver(() => controller.crashed());
  const approvals = new ComputerAppApprovals(configStore);
  let approvalWrites = Promise.resolve();
  const controller = new ComputerUseController(driver, { enabled: config.computer.enabled, authorize: async (session, target, signal) => {
    await approvalWrites; signal.throwIfAborted();
    const reply = await driver.list(session, undefined, signal);
    if (reply.errorCode) throw new Error(reply.errorCode);
    const apps = z.object({ apps: z.array(z.object({ pid: z.number().int().positive(), name: z.string().min(1).max(256), running: z.boolean(), bundleId: z.string().min(1).max(256).optional() }).passthrough()) }).passthrough().parse(reply.data).apps;
    const matches = apps.filter(app => app.pid === target.pid && app.running);
    const app = matches.length === 1 ? matches[0] : undefined;
    if (!app?.bundleId) throw new Error("computer_app_identity_unavailable: 无法确认目标应用身份，不截图或输入。");
    signal.throwIfAborted();
    await approvals.authorize({ bundleId: app.bundleId, appName: app.name });
    return app.bundleId;
  }, preview: frame => preview.update(frame, controller.status()) });
  let controlEpoch = 0;
  let closed = false;
  let setupTest: Promise<ComputerDiagnostics> | undefined;
  const probes = new Set<CuaProcessDriver>();
  const intentWrites = new Set<Promise<unknown>>();
  async function persistIntent(enabled: boolean, epoch: number): Promise<void> {
    const write = updateConfig(configStore, undefined, current => epoch === controlEpoch && (!enabled || !closed) ? { ...current, computer: { ...current.computer, enabled } } : current);
    intentWrites.add(write);
    try { await write; } finally { intentWrites.delete(write); }
  }
  async function diagnostics(setupError?: string, source = driver): Promise<ComputerDiagnostics> {
    const permission = z.enum(["granted", "denied", "unknown"]);
    const screen = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : undefined;
    const policy = await approvals.read();
    const result: ComputerDiagnostics = {
      workerPath: driver.workerPath(), hostPath: process.execPath, expectedVersion: cuaVersion, sdkLoaded: false, runtimeReady: false,
      permissions: { accessibility: process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied" : "unknown", screenRecording: screen === "granted" ? "granted" : screen === "denied" || screen === "restricted" ? "denied" : "unknown" },
      strictApproval: policy.strictApproval, approvals: policy.apps, audit: controller.audit(), error: setupError, actionLimits: cuaActionLimits(process.platform, cuaVersion)
    };
    try {
      const data = z.object({ sdkLoaded: z.boolean(), runtimeReady: z.boolean(), driverVersion: z.string().optional(), permissions: z.object({ accessibility: permission, screenRecording: permission }) }).parse((await source.diagnostics()).data);
      return { ...result, ...data };
    } catch (error) {
      return { ...result, error: setupError ?? (error instanceof Error ? error.message : String(error)) };
    }
  }
  async function controlComputer(control: "pause" | "resume" | "takeover" | "stop"): Promise<ComputerStatus> {
    if (closed) throw new Error("Computer use service is closed");
    if (control === "stop") {
      const epoch = ++controlEpoch;
      const results = await Promise.allSettled([
        controller.disable(),
        persistIntent(false, epoch)
      ]);
      preview.close();
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Computer use stop failed");
    }
    else controller.control(control);
    preview.update(undefined, controller.status()); return controller.status();
  }
  const assertSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (closed) throw new Error("Computer use service is closed");
    const contents = getWindow()?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error("Untrusted computer-use IPC sender");
  };
  ipcMain.handle(computerIpc.status, event => { assertSender(event); return controller.status(); });
  ipcMain.handle(computerIpc.enable, async event => {
    assertSender(event);
    const epoch = ++controlEpoch;
    await assertWorkAllowed();
    if (closed || epoch !== controlEpoch) return controller.status();
    await persistIntent(true, epoch);
    if (!closed && epoch === controlEpoch) await controller.enable();
    return controller.status();
  });
  ipcMain.handle(computerIpc.control, async (event, value: unknown) => { assertSender(event); return await controlComputer(z.enum(["pause", "resume", "takeover", "stop"]).parse(value)); });
  ipcMain.handle(computerIpc.preview, (event, value: unknown) => { assertSender(event); const enabled = z.boolean().parse(value); controller.setPreview(enabled); if (enabled) preview.open(); else preview.close(); return controller.status(); });
  ipcMain.handle(computerIpc.foreground, (event, value: unknown) => { assertSender(event); controller.setForeground(z.boolean().parse(value)); return controller.status(); });
  ipcMain.handle(computerIpc.logging, (event, value: unknown) => { assertSender(event); controller.setLogging(z.boolean().parse(value)); return controller.status(); });
  async function changeApproval(update: () => Promise<void>): Promise<ComputerDiagnostics> {
    controller.authorizationChanged();
    const write = approvalWrites.then(update).finally(() => controller.authorizationChanged());
    approvalWrites = write.catch(() => undefined);
    intentWrites.add(write);
    try { await write; } finally { intentWrites.delete(write); }
    return await diagnostics();
  }
  ipcMain.handle(computerIpc.strict, async (event, value: unknown) => {
    assertSender(event); const enabled = z.boolean().parse(value);
    return await changeApproval(async () => await approvals.setStrict(enabled));
  });
  for (const operation of ["approve", "revoke"] as const) ipcMain.handle(computerIpc[operation], async (event, value: unknown) => {
    assertSender(event); const bundle = z.string().min(1).max(256).parse(value);
    return await changeApproval(async () => await approvals[operation](bundle));
  });
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
    assertSender(event);
    if (!setupTest) {
      const probe = createDriver(() => undefined); probes.add(probe);
      setupTest = (async () => {
        try { await probe.start(); return await diagnostics(undefined, probe); }
        catch (error) { return await diagnostics(error instanceof Error ? error.message : String(error), probe); }
        finally { try { await probe.dispose(); } finally { probes.delete(probe); setupTest = undefined; } }
      })();
    }
    return await setupTest;
  });
  browser.attachComputerUse(async (method, input, signal) => {
    if (closed) throw new Error("Computer use service is closed");
    await assertWorkAllowed();
    const session = z.string().min(1).max(240).parse(input.session);
    const args = { ...input }; delete args.session;
    if (method === "computer_list") { const parsed = z.object({ pid: windowTargetSchema.shape.pid.optional() }).strict().parse(args); return await controller.list(session, parsed.pid, signal); }
    if (method === "computer_observe") return await controller.observe(session, windowTargetSchema.parse(args), signal);
    if (method === "computer_action") return await controller.act(session, computerActionSchema.parse(args), signal);
    throw new Error("Unsupported computer method");
  });
  return { controller, close: async () => {
    closed = true;
    // Abort input before destroying the preview; a failing surface must not keep control alive.
    const cleanup: Promise<unknown>[] = [controller.disable()];
    try { preview.close(); } catch (error) { cleanup.push(Promise.reject(error)); }
    cleanup.push(driver.dispose(), ...[...probes].map(probe => probe.dispose()), ...intentWrites);
    const results = await Promise.allSettled(cleanup);
    for (const channel of Object.values(computerIpc)) ipcMain.removeHandler(channel);
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Computer use cleanup failed");
  } };
}
