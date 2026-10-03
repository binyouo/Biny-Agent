import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileConfigStore } from "../src/config/store.js";
import { CuaProcessDriver } from "../src/computer/cuaDriver.js";
import type { ComputerDesktopApi } from "../src/computer/protocol.js";
import { createComputerUseTools } from "../src/tools/computerUse.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

test("desktop enablement stays cold and persists through restart; trusted IPC to tool execution uses a disposable native process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-computer-ipc-"));
  const logPath = path.join(root, "native.jsonl");
  await writeFile(logPath, "");
  const previousLog = process.env.BINY_CUA_FIXTURE_LOG;
  process.env.BINY_CUA_FIXTURE_LOG = logPath;
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const exposed: Record<string, unknown> = {};
  const host = { webContents: { mainFrame: {} } };
  let sender = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
  let grants = 0;
  Object.assign(globalThis, { __computerIpcElectron: {
    BrowserWindow: class { constructor() { throw new Error("unexpected UI surface"); } },
    systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: (request: boolean) => { if (request) grants++; return true; } },
    ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
    contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { exposed[key] = value; } },
    ipcRenderer: { invoke: async (channel: string, ...args: unknown[]) => { const handler = handlers.get(channel); assert.ok(handler, channel); return await handler(sender, ...args); } }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
      source: "export const {BrowserWindow,WebContentsView,clipboard,session,ipcMain,systemPreferences,contextBridge,ipcRenderer}=globalThis.__computerIpcElectron;"
    } : next(url, context);
  } });
  let cleanupService: (() => Promise<void>) | undefined;
  let cleanupBrowser: (() => Promise<void>) | undefined;
  let recorder: SessionRecorder | undefined;
  const credentialStore = { persistent: false, get: async () => undefined, set: async () => undefined, delete: async () => undefined };
  const entries = async (): Promise<Array<{ method: string; pid: number }>> => (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const { createComputerUseService } = await import("../src/desktop/electron/main/computerUseService.js");
    const store = createFileConfigStore(root, { globalDir: root, credentialStore });
    let configReadGate: (() => Promise<void>) | undefined;
    const serviceStore = { ...store, loadVersioned: async (workspaceRoot?: string) => { await configReadGate?.(); return await store.loadVersioned!(workspaceRoot); } };
    const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"));
    cleanupBrowser = () => browser.dispose();
    let failNextStop = false;
    let onDispose = (): void => undefined;
    const factory = (onExit: () => void) => new class extends CuaProcessDriver {
      override async stop(): Promise<void> {
        await super.stop();
        if (failNextStop) { failNextStop = false; throw new Error("driver_process_did_not_exit"); }
      }
      override async dispose(): Promise<void> { await super.dispose(); onDispose(); }
    }(onExit, new URL("./fixtures/cua-service-fixture.mjs", import.meta.url));
    let gate = async (): Promise<void> => undefined;
    const create = async () => await createComputerUseService(browser, () => host as never, () => gate(), serviceStore, factory);
    let service = await create(); cleanupService = service.close;
    await import("../src/desktop/electron/preload/computerUse.js");
    const api = exposed.binyComputer as ComputerDesktopApi;
    assert.equal((await api.status()).state, "disabled");
    assert.equal((await api.enable()).state, "ready");
    assert.equal((await store.load()).computer.enabled, true);
    assert.deepEqual(await entries(), [], "enabling grants intent only, not OS access or native startup");
    await service.close();
    service = await create(); cleanupService = service.close;
    assert.equal((await api.status()).state, "ready");
    assert.deepEqual(await entries(), [], "restart must remain cold");
    const endpoint = await browser.startAutomationServer(path.join(root, "computer.sock"));
    await ensureAgentDirs(root);
    recorder = new SessionRecorder(root, "computer-ipc-fixture");
    const config = await store.load();
    const registry = new ToolRegistry();
    for (const tool of createComputerUseTools(endpoint)) registry.registerBuiltinTool(tool);
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
    const list = coordinator.createAgentTools().find(tool => tool.name === "ComputerList")!;
    assert.equal((await list.execute("list-first", {})).isError, false);
    await recorder.flush();
    const native = await entries();
    assert.deepEqual(native.map(entry => entry.method), ["start", "list"]);
    const pid = native[0]!.pid;
    process.kill(pid, 0);
    assert.match(await readFile(recorder.filePath, "utf8"), /"type":"tool_call"/);
    assert.match(await readFile(recorder.filePath, "utf8"), /"type":"tool_result"/);
    await api.control("pause");
    assert.equal((await list.execute("list-paused", {})).isError, true);
    assert.deepEqual((await entries()).map(entry => entry.method), ["start", "list"]);
    await api.control("stop");
    assert.equal((await store.load()).computer.enabled, false);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    await api.testSetup();
    assert.equal((await api.status()).state, "disabled", "testing configuration never grants control");
    assert.equal((await store.load()).computer.enabled, false);
    for (const entry of await entries()) assert.throws(() => process.kill(entry.pid, 0), /ESRCH/);
    sender = { sender: host.webContents, senderFrame: {} };
    await assert.rejects(api.enable(), /Untrusted/);
    assert.equal((await store.load()).computer.enabled, false);
    sender = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
    await api.enable(); failNextStop = true;
    await assert.rejects(api.control("stop"), /driver_process_did_not_exit/);
    assert.equal((await api.status()).state, "disabled");
    assert.equal((await store.load()).computer.enabled, false, "stop intent must persist even if process cleanup fails");
    let releaseGate!: () => void;
    let enterGate!: () => void;
    let entered = new Promise<void>(resolve => { enterGate = resolve; });
    gate = async () => { enterGate(); await new Promise<void>(resolve => { releaseGate = resolve; }); };
    const lateEnable = api.enable(); await entered;
    await api.control("stop"); releaseGate(); await lateEnable;
    const enabledAfterStop = (await store.load()).computer.enabled;
    await api.control("stop");
    entered = new Promise<void>(resolve => { enterGate = resolve; });
    const beforeLateProbe = await entries();
    const lateProbe = api.testSetup(); await entered;
    await service.close(); cleanupService = undefined;
    releaseGate();
    let probeError: unknown;
    try { await lateProbe; } catch (error) { probeError = error; }
    assert.equal(enabledAfterStop, false, "an earlier enable waiting on a gate cannot undo a later stop");
    assert.ok(probeError instanceof Error, "a test waiting on a gate must reject after service close");
    assert.deepEqual(await entries(), beforeLateProbe, "closed service must not create a late probe process");
    gate = async () => undefined;
    service = await create(); cleanupService = service.close;
    await api.enable();
    let releaseConfig!: () => void;
    const configEntered = new Promise<void>(resolve => { configReadGate = async () => { resolve(); await new Promise<void>(release => { releaseConfig = release; }); }; });
    const disposed = new Promise<void>(resolve => { onDispose = resolve; });
    const pendingStop = api.control("stop"); await configEntered;
    let closeCompleted = false;
    const closing = service.close().then(() => { closeCompleted = true; });
    await disposed;
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedBeforePersistence = closeCompleted;
    configReadGate = undefined; releaseConfig();
    await Promise.all([pendingStop, closing]); cleanupService = undefined;
    assert.equal(completedBeforePersistence, false, "close must drain a stop persistence already in progress");
    assert.equal((await store.load()).computer.enabled, false, "close cannot revoke an earlier stop intent");
    assert.equal(grants, 0, "configuration and tools must never request OS grants");
  } finally {
    await recorder?.close(); await cleanupService?.(); await cleanupBrowser?.(); hooks.deregister();
    Reflect.deleteProperty(globalThis, "__computerIpcElectron");
    if (previousLog === undefined) delete process.env.BINY_CUA_FIXTURE_LOG; else process.env.BINY_CUA_FIXTURE_LOG = previousLog;
    await rm(root, { recursive: true, force: true });
  }
});
