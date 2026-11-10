import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopSkillService } from "../src/desktop/electron/main/DesktopSkillService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { desktopIpc, type DesktopPluginSummary } from "../src/desktop/protocol.js";
import { BINY_PLUGIN_REGISTRY_URL, readGlobalPluginManifest, readProjectPluginManifest } from "../src/extensions/pluginRegistry.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { RuntimeHostClient } from "../src/runtime/host/client.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the actual Host snapshot");
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

test("Plugin IPC gates project writes by their own initializing or busy Host and global writes by every project", { timeout: 30_000 }, async context => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-plugin-admission-")));
  const priorAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const initializationEntered = deferred(), releaseInitialization = deferred();
  const maintenanceEntered = deferred(), releaseMaintenance = deferred();
  let preparing: Promise<void> | undefined, maintenance: Promise<unknown> | undefined;
  let manager: DesktopAgentManager | undefined;
  let hooks: ReturnType<typeof registerHooks> | undefined;
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  try {
    const paths = [path.join(root, "a"), path.join(root, "b")];
    await Promise.all(paths.map(directory => mkdir(directory)));
    const store = createFileConfigStore(paths[0]!, { globalDir: process.env.BINY_AGENT_DIR,
      credentialStore: { persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {} } });
    store.supportsDetachedRuntimeHost = false;
    await store.save({ ...structuredClone(defaultConfig), defaultModel: "local-test",
      providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
      models: { "local-test": { provider: "local", model: "local-test" } },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, enabled: false, sleepEnabled: false } }
    });
    const state = new DesktopStateStore(path.join(root, "desktop.json")); await state.load();
    const storage = new DesktopUserDataStore(path.join(root, "desktop")); await storage.initialize();
    const projects = new DesktopProjectService(state, storage, store);
    const [a, b] = await Promise.all(paths.map(directory => projects.createProject(directory)));
    assert.ok(a && b);
    manager = new DesktopAgentManager(state, projects, store, () => {});
    const plugin = { id: "inert-plugin", name: "Inert", version: "1", category: "Tools", description: "Synthetic scope test", repository: "https://github.com/example/inert", path: "plugin", entry: "index.mjs" };
    const packageJson = JSON.stringify({ configuration: { properties: { serverName: { type: "string", default: "" } } } });
    const fetcher: typeof fetch = async input => {
      const url = String(input);
      if (url === BINY_PLUGIN_REGISTRY_URL) return new Response(JSON.stringify({ format: 1, plugins: [plugin] }));
      if (url.includes("api.github.com") && url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: [
          { path: "plugin/index.mjs", type: "blob", size: 39 },
          { path: "plugin/biny-plugin.json", type: "blob", size: packageJson.length }
        ] }));
      }
      if (url.includes("raw.githubusercontent.com") && url.endsWith("/plugin/index.mjs")) return new Response("export default function register() {}\n");
      if (url.includes("raw.githubusercontent.com") && url.endsWith("/plugin/biny-plugin.json")) return new Response(packageJson);
      throw new Error(`Unexpected plugin network request: ${url}`);
    };
    const skills = new DesktopSkillService(state, store, fetcher);
    Object.assign(globalThis, { __pluginAdmissionElectron: { ipcMain: {
      on() {}, removeHandler(channel: string) { handlers.delete(channel); },
      handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, listener); }
    } } });
    hooks = registerHooks({ load(url, hookContext, next) {
      return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
        source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,dialog,ipcMain,nativeTheme,shell,systemPreferences,desktopCapturer,screen,nativeImage,Menu}=globalThis.__pluginAdmissionElectron;"
      } : next(url, hookContext);
    } });
    const { registerDesktopIpc } = await import("../src/desktop/electron/main/ipc.js");
    registerDesktopIpc({ state, projects, agents: manager, skills,
      settings: new DesktopSettingsTransaction(state, manager),
      applicationImports: { withRuntimeAdmission: async (execute: () => Promise<unknown>) => await execute() }
    } as unknown as Parameters<typeof registerDesktopIpc>[0]);
    const invoke = async (channel: string, projectId: string, scope: "project" | "global") => await handlers.get(channel)!({}, projectId, plugin.id,
      ...(channel === desktopIpc.pluginSetEnabled ? [true, scope]
        : channel === desktopIpc.pluginSetSettings ? [{ serverName: "fixture-mem" }, scope]
        : [scope]));
    const channels = [desktopIpc.pluginInstall, desktopIpc.pluginSetEnabled, desktopIpc.pluginSetSettings, desktopIpc.pluginUninstall];
    const rejectTargetAndGlobal = async () => {
      for (const channel of channels) {
        await assert.rejects(invoke(channel, b.id, "project"), /任务运行期间/u);
        await assert.rejects(invoke(channel, a.id, "global"), /任务运行期间/u);
      }
      assert.deepEqual((await readProjectPluginManifest(b.path)).plugins, []);
      assert.deepEqual((await readGlobalPluginManifest()).plugins, []);
    };
    const lifecycle = async (scope: "project" | "global") => {
      const installed = await invoke(desktopIpc.pluginInstall, a.id, scope) as DesktopPluginSummary;
      assert.equal(installed.enabled, false);
      const enabled = await invoke(desktopIpc.pluginSetEnabled, a.id, scope) as DesktopPluginSummary;
      assert.equal(enabled.enabled, true);
      const manifest = scope === "project" ? await readProjectPluginManifest(a.path) : await readGlobalPluginManifest();
      assert.equal(manifest.plugins[0]?.enabled, true);
      const configured = await invoke(desktopIpc.pluginSetSettings, a.id, scope) as DesktopPluginSummary;
      assert.deepEqual(configured.settings, { serverName: "fixture-mem" });
      const manifestWithSettings = scope === "project" ? await readProjectPluginManifest(a.path) : await readGlobalPluginManifest();
      assert.deepEqual(manifestWithSettings.plugins[0]?.settings, { serverName: "fixture-mem" });
      await invoke(desktopIpc.pluginUninstall, a.id, scope);
      assert.deepEqual((scope === "project" ? await readProjectPluginManifest(a.path) : await readGlobalPluginManifest()).plugins, []);
    };
    const load = store.load.bind(store); let holdInitialization = true;
    context.mock.method(store, "load", async workspaceRoot => {
      if (holdInitialization && workspaceRoot === b.path) { initializationEntered.resolve(); await releaseInitialization.promise; }
      return await load(workspaceRoot);
    });
    preparing = manager.preparePrompt(b.id); void preparing.catch(() => undefined);
    await initializationEntered.promise;
    await rejectTargetAndGlobal();
    await lifecycle("project");
    holdInitialization = false; releaseInitialization.resolve(); await preparing;
    const managed = (manager as unknown as { runtimes: Map<string, { runtime: RuntimeHostClient; host: { commands: CommandRuntime } }> }).runtimes.get(b.id)!;
    context.mock.method(managed.host.commands.mcp, "reconnectServer", async () => { maintenanceEntered.resolve(); await releaseMaintenance.promise; throw new Error("Controlled MCP completion"); });
    maintenance = managed.runtime.mcpReconnect("controlled").catch(() => undefined);
    await maintenanceEntered.promise;
    await until(() => manager!.isProjectRunning(b.id));
    await rejectTargetAndGlobal();
    await lifecycle("project");
    releaseMaintenance.resolve(); await maintenance;
    await until(() => !manager!.isProjectRunning(b.id));
    await lifecycle("global");
  } finally {
    releaseInitialization.resolve(); releaseMaintenance.resolve();
    await Promise.allSettled([preparing, maintenance]);
    await manager?.closeAll();
    hooks?.deregister(); Reflect.deleteProperty(globalThis, "__pluginAdmissionElectron");
    context.mock.restoreAll();
    await removeTestRoot(root, { recursive: true, force: true });
    if (priorAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = priorAgentDir;
  }
});
