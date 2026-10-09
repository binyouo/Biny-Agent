import { ipcMain, shell, systemPreferences, type BrowserWindow } from "electron";
import { z } from "zod";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { ComputerPermissionOverlay, type OverlayRect } from "./ComputerPermissionOverlay.js";
import { ACCESSIBILITY_SETTINGS_URL, findTargetRow, parseOcrLines, resolveOcrBinary } from "./computerPermissionGeometry.js";
import path from "node:path";
import { globalAgentDir } from "../../../config/paths.js";
import { ComputerAuditStore } from "../../../computer/auditStore.js";
import { ComputerAppApprovals } from "../../../computer/appApprovals.js";
import { ComputerUseController } from "../../../computer/controller.js";
import { NativeProcessDriver } from "../../../computer/nativeDriver.js";
import { updateConfig, type AgentConfigStore } from "../../../config/store.js";
import { computerListSchema, computerImageSchema, computerActionSchema, computerMirrorSchema, computerIpc, windowObserveSchema, windowTargetSchema, type ComputerDiagnostics, type ComputerStatus, type ComputerPreview } from "../../../computer/protocol.js";
import { ComputerPreviewWindow } from "./ComputerPreviewWindow.js";
import type { DesktopBrowserService } from "./DesktopBrowserService.js";

/** 授权引导用的浮层；停用服务时统一收掉。 */
const guideOverlays = new Set<ComputerPermissionOverlay>();
const nativeAppsSchema = z.object({ apps: z.array(z.object({
  pid: windowTargetSchema.shape.pid.optional(),
  name: z.string().min(1).max(256),
  running: z.boolean(),
  bundleId: z.string().min(1).max(256).optional()
}).passthrough().refine(app => !app.running || app.pid !== undefined, { path: ["pid"], message: "Running applications require a PID" })) }).passthrough();

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
  const auditStore = new ComputerAuditStore(path.join(configStore.configPath ? path.dirname(configStore.configPath()) : globalAgentDir(), "computer-actions.sqlite"));
  let closed = false;
  let nativeSourceEpoch = 0;
  let computerFrame: ComputerPreview | undefined; let computerError: string | undefined; let computerShown = false;
  type PreviewSource = { label: string; sessionId?: string; projectId?: string; frame?: ComputerPreview; lastUsed: number; capture(): Promise<{ frame?: ComputerPreview; diagnostic?: string; waiting?: boolean }> };
  const sources = new Map<string, PreviewSource>();
  function setSource(id: string, source: PreviewSource): void {
    if (closed) return;
    if (!sources.has(id) && sources.size >= 15) {
      const oldest = [...sources.entries()].filter(([key]) => !key.startsWith("mirror:")).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) throw new Error("preview_item_limit");
      sources.delete(oldest[0]); sourceErrors.delete(oldest[0]); preview.remove(oldest[0]);
    }
    sources.set(id, source);
  }
  const returnToChat = (sessionId?: string, projectId?: string): void => { const window = getWindow(); if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); window.webContents.send(computerIpc.navigate, { sessionId, projectId }); };
  const preview = new ComputerPreviewWindow(control => { void controlComputer(control).catch(() => undefined); }, () => controller.dismissPreview());
  const driver = createDriver(() => controller.crashed());
  const approvals = new ComputerAppApprovals(configStore);
  let approvalWrites = Promise.resolve();
  const controller = new ComputerUseController(driver, { enabled: config.computer.enabled, previewEnabled: config.computer.previewEnabled, actionLogging: config.computer.actionLogging, auditStore, authorize: async (session, target, signal) => {
    await approvalWrites; signal.throwIfAborted();
    const reply = await driver.list(session, undefined, signal);
    if (reply.errorCode) throw new Error(reply.errorCode);
    const apps = nativeAppsSchema.parse(reply.data).apps;
    const matches = apps.filter(app => app.pid === target.pid && app.running);
    const app = matches.length === 1 ? matches[0] : undefined;
    if (!app?.bundleId) throw new Error("computer_app_identity_unavailable: 无法确认目标应用身份，不截图或输入。");
    signal.throwIfAborted();
    await approvals.authorize({ bundleId: app.bundleId, appName: app.name });
    return app.bundleId;
  }, authorizeLaunch: async (bundleId, signal) => {
    await approvalWrites; signal.throwIfAborted();
    const reply = await driver.daemonCommand("app_identity", { bundle: bundleId });
    const identity = z.object({ bundleId: z.literal(bundleId), name: z.string().min(1) }).parse(reply.data);
    await approvals.authorize({ bundleId, appName: identity.name });
    signal.throwIfAborted();
  }, preview: frame => {
    computerFrame = frame; computerError = undefined;
    if (computerShown) presentComputer();
  },
  externalMirrors: true,
  onMirrorChange: (windowId, requestId) => {
    const id = `mirror:${windowId}`;
    if (!requestId) { sources.delete(id); sourceErrors.delete(id); preview.remove(id); return; }
    setSource(id, { label: `窗口 ${windowId}`, sessionId: controller.status().owner, lastUsed: Date.now(), capture: async () => {
      const reply = await driver.daemonCommand("pip_frame", { window_id: Number(windowId), request_id: requestId });
      const data = z.object({ state: z.string(), pid: z.number(), last_frame_age_ms: z.number().nullable(), image: computerImageSchema.optional(), error: z.string().optional() }).passthrough().parse(reply.data);
      return { waiting: data.state === "armed", diagnostic: data.error, frame: data.image ? { image: data.image, target: { pid: data.pid, windowId }, capturedAt: Date.now() - (data.last_frame_age_ms ?? 0) } : undefined };
    } });
  },
  onPreviewError: error => { computerError = error; if (computerShown) presentComputer(); },
  setPreviewVisible: visible => { if (closed) return; computerShown = visible; if (visible) presentComputer(); else preview.remove("computer"); },
  refreshPreview: async (target, signal) => {
    if (closed) throw new Error("Computer use service is closed");
    if (!target) throw new Error("preview_observation_unavailable");
    const reply = await driver.capturePreview(target, signal);
    const image = reply.images[0];
    if (!image) throw new Error(String(reply.data.screenshot_error ?? "preview_frame_unavailable"));
    return { image, target, capturedAt: Date.now() };
  } });
  function presentComputer(): void {
    if (closed) return;
    preview.present({ id: "computer", label: "电脑", frame: computerFrame, status: { ...controller.status(), diagnostic: computerError ?? controller.status().diagnostic }, onReturn: () => returnToChat(controller.status().owner), onClose: () => controller.dismissPreview() });
  }
  browser.attachPreviewActivity(source => {
    if (closed || !controller.status().preview) return;
    setSource(source.id, { ...source, lastUsed: Date.now(), capture: async () => ({ frame: { image: await source.capture(), target: { pid: 0, windowId: source.id }, capturedAt: Date.now() } }) });
    presentSource(source.id);
  });
  function presentSource(id: string): void {
    if (closed) return;
    const source = sources.get(id); if (!source) return;
    preview.present({ id, label: source.label, frame: source.frame, status: { ...controller.status(), diagnostic: sourceErrors.get(id) }, onReturn: () => returnToChat(source.sessionId, source.projectId), onClose: () => {
      sources.delete(id); sourceErrors.delete(id);
      if (id.startsWith("mirror:") && source.sessionId) void controller.mirror(source.sessionId, { operation: "close", windowId: id.slice(7) }).catch(() => { computerError = "computer_mirror_cleanup_failed"; });
    } });
  }
  const sourceErrors = new Map<string, string>(); let pumping = false;
  const sourceTimer = setInterval(() => {
    if (closed || pumping || !controller.status().preview || sources.size === 0) return;
    pumping = true;
    void (async () => {
      try {
        for (const [id, source] of [...sources]) {
          // A previous capture may have yielded across source removal or replacement.
          if (closed || !controller.status().preview) break;
          if (sources.get(id) !== source) continue;
          if (!id.startsWith("mirror:") && Date.now() - source.lastUsed >= 90_000) { sources.delete(id); sourceErrors.delete(id); preview.remove(id); continue; }
          if (!id.startsWith("mirror:") && preview.activeItem() !== id) continue;
          let expired = false;
          const timeout = setTimeout(() => { expired = true; if (!closed && controller.status().preview && sources.get(id) === source) { sourceErrors.set(id, "preview_capture_timeout"); presentSource(id); } }, 4000);
          try {
            const result = await source.capture();
            if (closed || expired || sources.get(id) !== source || !controller.status().preview) continue;
            if (result.waiting) continue;
            if (result.frame) source.frame = result.frame;
            sourceErrors.set(id, result.diagnostic ?? (result.frame ? "" : "preview_frame_unavailable"));
            presentSource(id);
          } catch (error) { if (!closed && controller.status().preview && sources.get(id) === source) { sourceErrors.set(id, error instanceof Error ? error.message : String(error)); presentSource(id); } }
          finally { clearTimeout(timeout); }
        }
      } finally { pumping = false; }
    })();
  }, 1000 / 3); sourceTimer.unref();

  let controlEpoch = 0;
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
  function clearNativeSources(): void {
    nativeSourceEpoch++;
    for (const id of [...sources.keys()]) if (id.startsWith("mirror:") || id.startsWith("external:")) { sources.delete(id); sourceErrors.delete(id); preview.remove(id); }
  }
  async function controlComputer(control: "pause" | "resume" | "takeover" | "stop"): Promise<ComputerStatus> {
    if (closed) throw new Error("Computer use service is closed");
    if (control !== "resume") clearNativeSources();
    if (control === "stop") {
      const epoch = ++controlEpoch;
      const results = await Promise.allSettled([
        controller.disable(),
        persistIntent(false, epoch)
      ]);
      preview.remove("computer");
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Computer use stop failed");
    }
    else controller.control(control);
    if (computerShown) presentComputer(); return controller.status();
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
  ipcMain.handle(computerIpc.preview, async (event, value: unknown) => {
    assertSender(event); const enabled = z.boolean().parse(value);
    if (!enabled) nativeSourceEpoch++;
    await updateConfig(configStore, undefined, current => ({ ...current, computer: { ...current.computer, previewEnabled: enabled } }));
    assertSender(event);
    // Also retire admissions made while the preference write was pending.
    if (!enabled) nativeSourceEpoch++;
    controller.setPreview(enabled);
    if (!enabled) { for (const id of sources.keys()) preview.remove(id); sources.clear(); sourceErrors.clear(); }
    return controller.status();
  });
  ipcMain.handle(computerIpc.foreground, (event, value: unknown) => { assertSender(event); controller.setForeground(z.boolean().parse(value)); return controller.status(); });
  ipcMain.handle(computerIpc.logging, async (event, value: unknown) => { assertSender(event); const enabled = z.boolean().parse(value); await updateConfig(configStore, undefined, current => ({ ...current, computer: { ...current.computer, actionLogging: enabled } })); assertSender(event); controller.setLogging(enabled); return controller.status(); });
  async function changeApproval(update: () => Promise<void>): Promise<ComputerDiagnostics> {
    clearNativeSources(); controller.authorizationChanged();
    const write = approvalWrites.then(update).finally(() => {
      // Invalidate sources and admissions made while the approval write was pending too.
      clearNativeSources(); controller.authorizationChanged();
    });
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
    const sourceEpoch = nativeSourceEpoch;
    const externalPreviewCurrent = (): boolean => {
      const status = controller.status();
      // Stop takes effect before its saved intent; browser previews use a separate gate.
      return !closed && sourceEpoch === nativeSourceEpoch && status.state !== "disabled" && status.preview;
    };
    if (method === "computer_release") { controller.release(z.string().min(1).max(240).parse(input.session)); return { data: { released: true }, images: [] }; }
    await assertWorkAllowed();
    if (method === "computer_external_activity") {
      if (!externalPreviewCurrent()) return { data: { visible: false }, images: [] };
      const target = windowTargetSchema.parse(input), current = await configStore.load();
      if (!externalPreviewCurrent() || !current.computer.enabled || !current.computer.previewEnabled) return { data: { visible: false }, images: [] };
      const apps = nativeAppsSchema.parse((await driver.list("external-preview", target.pid, signal)).data).apps;
      if (!externalPreviewCurrent()) return { data: { visible: false }, images: [] };
      const matches = apps.filter(app => app.pid === target.pid && app.running);
      const identity = matches.length === 1 ? matches[0] : undefined; if (!identity?.bundleId) throw new Error("computer_app_identity_unavailable");
      await approvals.authorize({ bundleId: identity.bundleId, appName: identity.name }); signal.throwIfAborted();
      if (!externalPreviewCurrent()) return { data: { visible: false }, images: [] };
      const id = `external:${target.pid}:${target.windowId}`;
      setSource(id, { label: identity.name, lastUsed: Date.now(), capture: async () => { const reply = await driver.capturePreview(target); return { frame: reply.images[0] ? { image: reply.images[0], target, capturedAt: Date.now() } : undefined, diagnostic: typeof reply.data.screenshot_error === "string" ? reply.data.screenshot_error : undefined }; } });
      presentSource(id); return { data: { visible: true }, images: [] };
    }
    const session = z.string().min(1).max(240).parse(input.session);
    const args = { ...input }; delete args.session;
    if (method === "computer_launch") return await controller.launch(session, z.object({ bundleId: z.string().min(1).max(256) }).strict().parse(args).bundleId, signal);
    if (method === "computer_list") { const parsed = computerListSchema.parse(args); return await controller.list(session, parsed.pid, signal, parsed.days); }
    if (method === "computer_observe") return await controller.observe(session, windowObserveSchema.parse(args), signal);
    if (method === "computer_action") return await controller.act(session, computerActionSchema.parse(args), signal);
    if (method === "computer_mirror") return await controller.mirror(session, computerMirrorSchema.parse(args), signal);
    throw new Error("Unsupported computer method");
  });
  return { controller, close: async () => {
    closed = true; nativeSourceEpoch++; clearInterval(sourceTimer); browser.attachPreviewActivity(undefined); sources.clear(); sourceErrors.clear();
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
    auditStore.close();
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Computer use cleanup failed");
  } };
}
