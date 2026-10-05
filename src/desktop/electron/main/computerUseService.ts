import { ipcMain, shell, systemPreferences, type BrowserWindow } from "electron";
import { z } from "zod";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { ComputerPermissionOverlay, type OverlayRect } from "./ComputerPermissionOverlay.js";
import { ACCESSIBILITY_SETTINGS_URL, findTargetRow, parseOcrLines, resolveOcrBinary } from "./computerPermissionGeometry.js";
import { ComputerAppApprovals } from "../../../computer/appApprovals.js";
import { ComputerUseController } from "../../../computer/controller.js";
import { NativeProcessDriver } from "../../../computer/nativeDriver.js";
import { updateConfig, type AgentConfigStore } from "../../../config/store.js";
import { computerActionSchema, computerIpc, windowObserveSchema, windowTargetSchema, type ComputerDiagnostics, type ComputerStatus } from "../../../computer/protocol.js";
import { ComputerPreviewWindow } from "./ComputerPreviewWindow.js";
import type { DesktopBrowserService } from "./DesktopBrowserService.js";

/** 授权引导用的浮层；停用服务时统一收掉。 */
const guideOverlays = new Set<ComputerPermissionOverlay>();

function runOcr(imagePath: string, workerPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const binary = resolveOcrBinary(workerPath);
    if (!binary) { reject(new Error("ocr_unavailable")); return; }
    execFile(binary, [imagePath, "zh-Hans", "en-US", "--coords"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

export async function createComputerUseService(browser: DesktopBrowserService, getWindow: () => BrowserWindow | undefined, assertWorkAllowed: () => Promise<void>, configStore: AgentConfigStore, createDriver = (onExit: () => void) => new NativeProcessDriver(onExit)) {
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
  }, preview: frame => preview.update(frame, controller.status()),
  // 窗口的显示/隐藏由 controller 的「偏好 × 活动」模型驱动：
  // 用户开着 PiP 时，操控期间亮着、停手 90s 自动收起，而偏好本身不变。
  setPreviewVisible: visible => { if (visible) preview.open(); else preview.close(); },
  // PiP 3fps 帧泵：重新观察当前 capture 的窗口，把最新帧推给预览窗。
  // Alma 的帧泵独立于操控会话：有观察目标就抓它，没有就回落整屏，
  // 这样面板一打开就有画面，而不是空等到第一次操控。
  refreshPreview: async () => {
    const capture = controller.currentCapture();
    try {
      // 有活跃目标就抓它；否则回落整屏——面板开着就该有画面，
      // 而且目标窗口本身可能无法被单独捕获（Electron 系应用实测如此）。
      const target = capture?.target;
      const reply = target
        ? await driver.observe("preview", target, new AbortController().signal)
        : await driver.captureScreen();
      const image = (reply.images ?? [])[0];
      if (image) preview.update({ image, target: target ?? { pid: 0, windowId: "screen" }, capturedAt: Date.now() }, controller.status());
    } catch {
      // 目标不可达时不打断面板：下一拍再试。
    }
  } });
  let controlEpoch = 0;
  let closed = false;
  let setupTest: Promise<ComputerDiagnostics> | undefined;
  const probes = new Set<NativeProcessDriver>();
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
    // 「文件不在」和「还没启动」是两回事，别让用户去重装一个已经在的组件。
    let helperPresent = false;
    try { helperPresent = existsSync(driver.workerPath()); } catch { helperPresent = false; }
    const result: ComputerDiagnostics = {
      workerPath: driver.workerPath(), helperPresent, hostPath: process.execPath, expectedVersion: "native", sdkLoaded: false, runtimeReady: false,
      permissions: { accessibility: process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied" : "unknown", screenRecording: screen === "granted" ? "granted" : screen === "denied" || screen === "restricted" ? "denied" : "unknown" },
      strictApproval: policy.strictApproval, approvals: policy.apps, audit: controller.audit(), error: setupError, actionLimits: []
    };
    try {
      // daemon 的 doctor 返回的是扁平字段（accessibility / screenRecording），
      // 不是嵌套的 permissions 对象。之前这里要求嵌套形状，导致每次 parse 都抛，
      // 于是 helper 明明在跑也一律报「组件不可用」。
      const data = z.object({
        version: z.string().optional(), uptime: z.number().optional(),
        focusGuard: z.enum(["armed", "unavailable"]).optional(),
        accessibility: permission.optional(), screenRecording: permission.optional()
      }).passthrough().parse((await source.diagnostics()).data);
      return {
        ...result,
        sdkLoaded: true, runtimeReady: true,
        driverVersion: data.version, uptimeSeconds: data.uptime, focusGuard: data.focusGuard,
        // daemon 自己的权限判断优先；它没报就沿用宿主进程的。
        permissions: {
          accessibility: data.accessibility ?? result.permissions.accessibility,
          screenRecording: data.screenRecording ?? result.permissions.screenRecording
        }
      };
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
  ipcMain.handle(computerIpc.preview, (event, value: unknown) => { assertSender(event); const enabled = z.boolean().parse(value); controller.setPreview(enabled); return controller.status(); });
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
    // 弹窗必须由守护进程发起：TCC 授的是发起调用的那个进程。在宿主里调
    // isTrustedAccessibilityClient(true) 会把辅助功能授给 Electron 宿主，
    // 而真正需要它的是独立签名的 helper —— 用户授完仍然不能用。
    await driver.grantAccessibility().catch(() => undefined);
    const result = await diagnostics();
    // 系统弹窗被关掉、或用户在设置里找不到那一行时，把引导浮层指过去。
    // 只在用户明确点了这个按钮之后才发生，不主动弹。
    if (result.permissions.accessibility !== "granted") {
      const overlay = new ComputerPermissionOverlay(undefined, { intervalMs: 1200 });
      guideOverlays.add(overlay);
      void (async () => {
        try {
          await shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
          await new Promise(resolve => setTimeout(resolve, 1500));
          const locate = async (): Promise<OverlayRect | undefined> => {
            const shot = await driver.captureScreen();
            const path = (shot.data as { path?: string }).path;
            if (!path) return undefined;
            const output = await runOcr(path, driver.workerPath());
            return findTargetRow(parseOcrLines(output), "Biny");
          };
          const rect = await locate();
          if (!rect) { overlay.close(); guideOverlays.delete(overlay); return; }
          overlay.track(locate);
        } catch {
          overlay.close(); guideOverlays.delete(overlay);
        }
      })();
    }
    return result;
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
    if (method === "computer_observe") return await controller.observe(session, windowObserveSchema.parse(args), signal);
    if (method === "computer_action") return await controller.act(session, computerActionSchema.parse(args), signal);
    throw new Error("Unsupported computer method");
  });
  return { controller, close: async () => {
    closed = true;
    // Abort input before destroying the preview; a failing surface must not keep control alive.
    const cleanup: Promise<unknown>[] = [controller.disable()];
    try { preview.close(); } catch (error) { cleanup.push(Promise.reject(error)); }
    // 授权引导浮层是「点一下才出现」的临时窗口，服务停用时必须一起收掉，
    // 否则会一直浮在用户屏幕上。
    for (const overlay of guideOverlays) { try { overlay.close(); } catch { /* 已经关掉了 */ } }
    guideOverlays.clear();
    cleanup.push(driver.dispose(), ...[...probes].map(probe => probe.dispose()), ...intentWrites);
    const results = await Promise.allSettled(cleanup);
    for (const channel of Object.values(computerIpc)) ipcMain.removeHandler(channel);
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Computer use cleanup failed");
  } };
}
