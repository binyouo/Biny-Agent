import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EnvironmentCredentialStore } from "../src/config/credentials.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { computerDesktopEndpoint } from "../src/computer/desktopActivity.js";
import { AppearancePreviewCoordinator } from "../src/desktop/appearanceCoordinator.js";
import { BrowserEnvironmentStore } from "../src/desktop/browserEnvironments.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopCommandService } from "../src/desktop/electron/main/DesktopCommandService.js";
import { DesktopPreviewService } from "../src/desktop/electron/main/DesktopPreviewService.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopTerminalManager } from "../src/desktop/electron/main/DesktopTerminalManager.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { StaticPreviewServer } from "../src/desktop/electron/main/StaticPreviewServer.js";
import { createSessionFile } from "../src/session/store.js";
import { requestBrowser } from "../src/tools/browser.js";

const cli = path.resolve("src/cli/index.ts");

class BrowserContents extends EventEmitter {
  static nextId = 1;
  static failNextReload = false;
  static instances: BrowserContents[] = [];
  static dialogOnNextEvaluation = false;
  id = BrowserContents.nextId++;
  entries: Array<{ url: string; title: string }> = [];
  cursor = -1;
  destroyed = false;
  viewport: Record<string, unknown> | undefined;
  scrollX = 0;
  scrollY = 0;
  input = new BrowserFileInput();
  resumeDialog: (() => void) | undefined;
  dialogAnswer: Record<string, unknown> | undefined;
  session = { fetch: async (url: string, options: RequestInit) => await fetch(url, options) };
  constructor() { super(); BrowserContents.instances.push(this); }
  navigationHistory = {
    canGoBack: () => this.cursor > 0, canGoForward: () => this.cursor + 1 < this.entries.length,
    getAllEntries: () => [...this.entries],
    goBack: () => { this.cursor--; queueMicrotask(() => this.emit("did-stop-loading")); },
    goForward: () => { this.cursor++; queueMicrotask(() => this.emit("did-stop-loading")); }
  };
  debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach() {}, sendCommand: async (method: string, params: Record<string, unknown>) => {
    if (method === "Page.enable") return {};
    if (method === "Emulation.setDeviceMetricsOverride") { this.viewport = params; return {}; }
    if (method === "Emulation.clearDeviceMetricsOverride") { this.viewport = undefined; return {}; }
    if (method === "Page.captureSnapshot") return { data: "MIME-Version: 1.0\nContent-Type: text/html\n\n<p>CLI page export</p>" };
    if (method === "Page.handleJavaScriptDialog") { this.dialogAnswer = params; this.resumeDialog?.(); this.resumeDialog = undefined; this.debugger.emit("message", {}, "Page.javascriptDialogClosed", {}); return {}; }
    if (method === "Runtime.evaluate") {
      if (BrowserContents.dialogOnNextEvaluation) {
        BrowserContents.dialogOnNextEvaluation = false;
        const answer = new Promise<void>(resolve => { this.resumeDialog = resolve; });
        this.debugger.emit("message", {}, "Page.javascriptDialogOpening", { type: "prompt", message: "CLI dialog", url: this.getURL() });
        await answer;
      }
      const context = {
        location: { href: this.getURL() },
        document: { title: this.getTitle(), documentElement: { outerHTML: "<html><body><article><h1>CLI page export</h1><p>Readable page body.</p></article></body></html>" }, querySelector: () => this.input },
        File, Event, atob, Uint8Array, HTMLInputElement: BrowserFileInput,
        DataTransfer: class { files: File[] = []; items = { add: (file: File) => this.files.push(file) }; },
        scrollX: this.scrollX, scrollY: this.scrollY,
        window: { scrollBy: (x: number, y: number) => { context.scrollX = this.scrollX += x; context.scrollY = this.scrollY += y; } }
      };
      try { return { result: { value: await runInNewContext(String(params.expression), context) } }; }
      catch (error) { return { exceptionDetails: { text: (error as Error).message } }; }
    }
    throw new Error(`Unexpected CDP method: ${method}`);
  } });
  async loadURL(url: string) { this.entries.splice(this.cursor + 1); this.entries.push({ url, title: "CLI page" }); this.cursor++; this.emit("did-stop-loading"); }
  reload() { queueMicrotask(() => {
    if (BrowserContents.failNextReload) { BrowserContents.failNextReload = false; this.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", this.getURL(), true); }
    this.emit("did-stop-loading");
  }); }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.entries[this.cursor]?.url ?? ""; }
  getTitle() { return "CLI page"; }
  isLoading() { return false; }
  setWindowOpenHandler() {}
  send() {}
  stop() {}
  close() { this.destroyed = true; this.resumeDialog?.(); this.emit("destroyed"); }
  async capturePage() { return { toPNG: () => Buffer.from("89504e470d0a1a0a", "hex") }; }
  async printToPDF() { return Buffer.from("%PDF-1.7\nCLI page export"); }
}
class BrowserFileInput {
  type = "file";
  files: File[] = [];
  events: string[] = [];
  dispatchEvent(event: Event) { this.events.push(event.type); }
}
class BrowserView {
  webContents = new BrowserContents();
  setVisible() {}
  setBounds() {}
}
class BrowserHost extends EventEmitter {
  webContents = new BrowserContents();
  contentView = { addChildView() {}, removeChildView() {} };
  isDestroyed() { return false; }
  async loadURL(url: string) { await this.webContents.loadURL(url); }
  show() {}
  focus() {}
  destroy() { this.webContents.close(); this.emit("closed"); }
}

test("Desktop CLI shares project, session, preference, preview and terminal owners", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-desktop-cli-")));
  const originalAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const inputs: string[] = [];
  let emitOutput: ((data: string) => void) | undefined;
  let stopped = 0;
  Object.assign(globalThis, { __desktopCliPty: { spawn: () => ({
    onData(listener: (data: string) => void) { emitOutput = listener; }, onExit() {},
    resize() {}, write(text: string) { inputs.push(text); }, kill() { stopped++; }
  }) } });
  const clearedPartitions: string[] = [];
  let clipboardText = "";
  Object.assign(globalThis, { __desktopCliElectron: {
    BrowserWindow: BrowserHost, WebContentsView: BrowserView, clipboard: { readText: () => clipboardText, writeText: (value: string) => { clipboardText = value; } }, session: { fromPartition: (partition: string) => ({
      setProxy: async () => {}, closeAllConnections: async () => {},
      clearStorageData: async () => { clearedPartitions.push(partition); }, clearAuthCache: async () => {}, clearCache: async () => {},
      webRequest: { onBeforeRequest() {} }, cookies: { on() {}, get: async () => [], set: async () => {}, remove: async () => {} }
    }) }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    if (/\/electron\/index\.js$/u.test(url)) return { format: "module", shortCircuit: true, source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__desktopCliElectron;" };
    if (/\/node-pty\/lib\/index\.js$/u.test(url)) return { format: "module", shortCircuit: true, source: "export const {spawn} = globalThis.__desktopCliPty;" };
    return next(url, context);
  } });
  const configStore = createFileConfigStore(root, { globalDir: process.env.BINY_AGENT_DIR, credentialStore: new EnvironmentCredentialStore() });
  const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const terminals = new DesktopTerminalManager(() => {});
  const staticPreview = new StaticPreviewServer();
  let browser: { dispose(): Promise<void> } | undefined;
  let manager: DesktopAgentManager | undefined;
  const downloadServer = createServer((request, response) => {
    if (request.url === "/missing") { response.writeHead(404); response.end(); return; }
    if (request.url === "/large") { response.end(Buffer.alloc(8 * 1024 * 1024 + 1)); return; }
    response.setHeader("content-type", "application/octet-stream"); response.end(Buffer.from([0, 255, 17, 18]));
  });
  try {
    await new Promise<void>(resolve => downloadServer.listen(0, "127.0.0.1", resolve));
    const config = structuredClone(defaultConfig);
    config.defaultModel = "fixture";
    config.providers = { fixture: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
    config.models = { fixture: { provider: "fixture", model: "fixture" } };
    await configStore.save(config);
    await state.load(); await storage.initialize();
    const projects = new DesktopProjectService(state, storage, configStore);
    manager = new DesktopAgentManager(state, projects, configStore, () => {});
    let publications = 0;
    const appearance = new AppearancePreviewCoordinator({ read: () => state.settingsPreferences(), publish: () => { publications++; } });
    const preview = new DesktopPreviewService(projects, terminals, staticPreview);
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const environmentStore = new BrowserEnvironmentStore(path.join(root, "browser-environments.json"));
    const service = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, undefined, environmentStore);
    const browserHost = new BrowserHost();
    service.attachDesktopWindow(browserHost as never);
    const commands = new DesktopCommandService({ state, projects, agents: manager, terminals, preview, appearance, configStore, browser: service });
    browser = service;
    service.attachDesktopCommands(async args => await commands.execute(args));
    const endpoint = await service.startAutomationServer(path.join(root, "control.sock"));
    await writeFile(computerDesktopEndpoint(), JSON.stringify(endpoint));

    const workspace = path.join(root, "workspace");
    const created = await run(root, ["project", "create", workspace, "--json"]);
    const project = JSON.parse(created.stdout) as { id: string; path: string };
    assert.equal(project.path, workspace);
    assert.ok((await stat(workspace)).isDirectory());
    const listed = await run(root, ["project", "list", "--json"]);
    assert.equal(JSON.parse(listed.stdout).projects[0].id, project.id);
    await run(root, ["project", "rename", project.id, "CLI 项目", "--json"]);
    assert.equal(state.project(project.id)?.name, "CLI 项目");
    assert.equal(JSON.parse(await readFile(path.join(root, "desktop-state.json"), "utf8")).projects[0].name, "CLI 项目");
    await assert.rejects(requestBrowser({ ...endpoint, token: "invalid-token" }, "desktop_command", { action: "project.remove", projectId: project.id }), /authentication/u);
    assert.ok(state.project(project.id));

    assert.deepEqual(JSON.parse((await run(workspace, ["iab", "status", "--json"])).stdout), { running: true, page: null });
    const environmentFile = path.join(root, "browser-env.json");
    await writeFile(environmentFile, JSON.stringify({ name: "Work", proxy: { mode: "direct" } }));
    const environment = JSON.parse((await run(workspace, ["iab", "env", "create", "--file", environmentFile, "--json"])).stdout);
    assert.equal(environmentStore.get(environment.id)?.name, "Work");
    await writeFile(environmentFile, JSON.stringify({ name: "Work renamed", proxy: { mode: "system" } }));
    await run(workspace, ["iab", "env", "update", environment.id, "--file", environmentFile, "--json"]);
    assert.equal(environmentStore.get(environment.id)?.name, "Work renamed");
    await run(workspace, ["iab", "env", "clear", environment.id, "--json"]);
    assert.ok(clearedPartitions.includes(`persist:biny-browser-env-${environment.id}`));
    const tab = JSON.parse((await run(workspace, ["iab", "tab", "new", "https://example.test/first", "--env", environment.id, "--json"])).stdout);
    assert.equal(tab.tabs[0].environmentId, environment.id);
    assert.equal(JSON.parse((await run(workspace, ["iab", "tab", "list", "--json"])).stdout).activeId, tab.activeId);
    await run(workspace, ["iab", "tab", "select", tab.activeId, "--json"]);
    await run(workspace, ["iab", "goto", "https://example.test/second", "--env", "Work renamed", "--json"]);
    assert.equal(JSON.parse((await run(workspace, ["iab", "status", "--json"])).stdout).page.url, "https://example.test/second");
    assert.equal(JSON.parse((await run(workspace, ["iab", "back", "--json"])).stdout).url, "https://example.test/first");
    assert.equal(JSON.parse((await run(workspace, ["iab", "forward", "--json"])).stdout).url, "https://example.test/second");
    const png = path.join(workspace, "browser.png");
    await run(workspace, ["iab", "screenshot", "--out", png, "--json"]);
    assert.equal((await readFile(png)).toString("hex"), "89504e470d0a1a0a");
    await run(workspace, ["iab", "reload", "--json"]);
    BrowserContents.failNextReload = true;
    const failedReload = await run(workspace, ["iab", "reload", "--json"], 1);
    assert.match(JSON.parse(failedReload.stdout).error, /NAME_NOT_RESOLVED/u);
    const history = JSON.parse((await run(workspace, ["iab", "history", "--json"])).stdout);
    assert.equal(history[0].url, "https://example.test/first");
    assert.equal(history[1].url, "https://example.test/second");
    const nativePage = BrowserContents.instances.at(-1)!;
    assert.equal(JSON.parse((await run(workspace, ["iab", "eval", "2 + 3", "--json"])).stdout), 5);
    assert.equal(JSON.parse((await run(workspace, ["iab", "cdp", "Runtime.evaluate", '{"expression":"6 * 7"}', "--json"])).stdout).result.value, 42);
    await run(workspace, ["iab", "viewport", "set", "390", "844", "--mobile", "--json"]);
    assert.deepEqual(nativePage.viewport, { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 });
    await run(workspace, ["iab", "viewport", "reset", "--json"]);
    assert.equal(nativePage.viewport, undefined);
    await run(workspace, ["iab", "scroll", "600", "--x", "20", "--json"]);
    assert.equal(nativePage.scrollY, 600); assert.equal(nativePage.scrollX, 20);
    await run(workspace, ["iab", "clipboard", "write", "CLI clipboard", "--json"]);
    assert.equal(JSON.parse((await run(workspace, ["iab", "clipboard", "read", "--json"])).stdout).text, "CLI clipboard");
    const upload = Buffer.alloc(300 * 1024, 66);
    await writeFile(path.join(workspace, "upload.txt"), upload);
    const uploaded = JSON.parse((await run(workspace, ["iab", "upload", "#file", "upload.txt", "--json"])).stdout);
    assert.deepEqual(uploaded, { count: 1, names: ["upload.txt"] });
    assert.deepEqual(Buffer.from(await nativePage.input.files[0]!.arrayBuffer()), upload);
    assert.deepEqual(nativePage.input.events, ["input", "change"]);
    const uploadOutside = await run(workspace, ["iab", "upload", "#file", "../browser-env.json", "--json"], 1);
    assert.equal(JSON.parse(uploadOutside.stdout).ok, false);
    const address = downloadServer.address(); assert.ok(address && typeof address !== "string");
    await run(workspace, ["iab", "download", `http://127.0.0.1:${address.port}/file`, "--out", "download.bin", "--json"]);
    assert.deepEqual(await readFile(path.join(workspace, "download.bin")), Buffer.from([0, 255, 17, 18]));
    await run(workspace, ["iab", "download", `http://127.0.0.1:${address.port}/missing`, "--out", "missing.bin", "--json"], 1);
    await assert.rejects(stat(path.join(workspace, "missing.bin")), { code: "ENOENT" });
    await run(workspace, ["iab", "download", `http://127.0.0.1:${address.port}/large`, "--out", "large.bin", "--json"], 1);
    await assert.rejects(stat(path.join(workspace, "large.bin")), { code: "ENOENT" });
    for (const format of ["html", "pdf", "mhtml", "md"]) {
      await run(workspace, ["iab", "export", format, "--out", `page.${format}`, "--json"]);
      assert.match(await readFile(path.join(workspace, `page.${format}`), "utf8"), /CLI page export/u);
    }
    const baselineListeners = nativePage.debugger.listenerCount("message");
    await run(workspace, ["iab", "dialog", "watch", "--json"]);
    assert.equal(nativePage.debugger.listenerCount("message"), baselineListeners + 1);
    BrowserContents.dialogOnNextEvaluation = true;
    const dialogOpening = once(nativePage.debugger, "message", { signal: AbortSignal.timeout(10_000) });
    const evaluating = run(workspace, ["iab", "eval", "10 + 20", "--json"]);
    await dialogOpening;
    assert.equal(JSON.parse((await run(workspace, ["iab", "dialog", "get", "--json"])).stdout).dialog.message, "CLI dialog");
    await run(workspace, ["iab", "dialog", "accept", "reply", "--json"]);
    assert.deepEqual(nativePage.dialogAnswer, { accept: true, promptText: "reply" });
    assert.equal(JSON.parse((await evaluating).stdout), 30);
    await run(workspace, ["iab", "dialog", "stop", "--json"]);
    assert.equal(nativePage.debugger.listenerCount("message"), baselineListeners);
    await run(workspace, ["iab", "tab", "close", tab.activeId, "--json"]);
    assert.deepEqual(JSON.parse((await run(workspace, ["iab", "tab", "list", "--json"])).stdout).tabs, []);
    await run(workspace, ["iab", "env", "delete", environment.id, "--json"]);
    assert.equal(environmentStore.get(environment.id), undefined);
    const defaultDelete = await run(workspace, ["iab", "env", "delete", "default", "--json"], 1);
    assert.equal(JSON.parse(defaultDelete.stdout).ok, false);

    await writeFile(path.join(process.env.BINY_AGENT_DIR!, "credentials.enc"), "owner-store-marker");
    await run(root, ["config", "set", "heartbeat.intervalMinutes", "65", "--json"]);
    assert.equal((await configStore.load(root)).heartbeat.intervalMinutes, 65);
    assert.equal(JSON.parse((await run(root, ["model", "list", "--json"])).stdout).models[0].alias, "fixture");
    await rm(path.join(process.env.BINY_AGENT_DIR!, "credentials.enc"));

    await run(workspace, ["config", "set", "appearancePreference.darkTheme", "tokyonight", "--json"]);
    assert.equal(state.appearancePreference().darkTheme, "tokyonight");
    assert.equal(publications, 1);
    const preference = await run(workspace, ["config", "get", "appearancePreference.darkTheme", "--json"]);
    assert.equal(JSON.parse(preference.stdout), "tokyonight");

    await createSessionFile(workspace, "cli-session", Buffer.from('{"type":"user_message","content":"CLI fixture","time":"2026-01-01T00:00:00.000Z"}\n'));
    await projects.listSessions(projects.requireProject(project.id), undefined, new Map());
    await run(workspace, ["session", "rename", "cli-session", "新的会话标题", "--json"]);
    assert.equal((await projects.listSessions(projects.requireProject(project.id), undefined, new Map()))[0]?.title, "新的会话标题");
    await run(workspace, ["session", "pin", "cli-session", "--json"]);
    assert.equal((await projects.listSessions(projects.requireProject(project.id), undefined, new Map()))[0]?.pinned, true);
    await run(workspace, ["session", "unpin", "cli-session", "--json"]);
    assert.equal((await projects.listSessions(projects.requireProject(project.id), undefined, new Map()))[0]?.pinned, false);
    await run(workspace, ["session", "archive", "cli-session", "--json"]);
    assert.equal((await projects.listSessions(projects.requireProject(project.id), undefined, new Map()))[0]?.archived, true);
    await run(workspace, ["session", "unarchive", "cli-session", "--json"]);
    assert.equal((await projects.listSessions(projects.requireProject(project.id), undefined, new Map()))[0]?.archived, false);
    await run(workspace, ["session", "duplicate", "cli-session", "--json"]);
    const duplicate = (await projects.listSessions(projects.requireProject(project.id), undefined, new Map())).find(item => item.id !== "cli-session");
    assert.ok(duplicate);
    await run(workspace, ["session", "delete", duplicate.id, "--json"]);
    await run(workspace, ["session", "delete", "cli-session", "--json"]);
    assert.equal((await projects.listSessions(projects.requireProject(project.id), undefined, new Map())).length, 0);

    await writeFile(path.join(workspace, "index.html"), "<!doctype html><title>CLI preview</title>");
    const detected = await run(workspace, ["preview", "detect", "--json"]);
    assert.equal(JSON.parse(detected.stdout).available, true);
    const started = await run(workspace, ["preview", "start", "--json"]);
    const url = JSON.parse(started.stdout).url as string;
    assert.match(await (await fetch(url)).text(), /CLI preview/u);
    assert.equal(JSON.parse((await run(workspace, ["preview", "status", "--json"])).stdout).url, url);
    await run(workspace, ["preview", "stop", "--json"]);
    assert.equal(staticPreview.status(project.id), undefined);

    const opened = await run(workspace, ["terminal", "create", "--name", "work", "--json"]);
    const terminalId = JSON.parse(opened.stdout).terminalId as string;
    emitOutput!("测试终端输出\r\n");
    await run(workspace, ["terminal", "write", terminalId, "pwd\n", "--json"]);
    assert.deepEqual(inputs, ["pwd\n"]);
    const read = await run(workspace, ["terminal", "read", terminalId, "--json"]);
    assert.equal(JSON.parse(read.stdout).replay, "测试终端输出\r\n");
    const other = path.join(root, "other"); await mkdir(other);
    const added = JSON.parse((await run(root, ["project", "add", other, "--json"])).stdout) as { id: string };
    const wrongProject = await run(other, ["terminal", "read", terminalId, "--json"], 1);
    assert.match(wrongProject.stderr, /does not belong/u);
    await run(workspace, ["terminal", "close", terminalId, "--json"]);
    assert.equal(stopped, 1);
    assert.deepEqual(terminals.list(project.id), []);
    await run(root, ["project", "remove", added.id, "--json"]);
    await run(root, ["project", "remove", project.id, "--json"]);
    assert.equal(state.projects().length, 0);
    assert.ok((await stat(workspace)).isDirectory());
  } finally {
    downloadServer.closeAllConnections(); await new Promise<void>(resolve => downloadServer.close(() => resolve()));
    await browser?.dispose();
    terminals.disposeAll();
    await staticPreview.disposeAll();
    await manager?.closeAll();
    hooks.deregister(); Reflect.deleteProperty(globalThis, "__desktopCliPty"); Reflect.deleteProperty(globalThis, "__desktopCliElectron");
    if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

async function run(cwd: string, args: string[], expectedCode = 0): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [...process.execArgv, cli, ...args], { cwd, env: process.env, signal: AbortSignal.timeout(20_000) });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, expectedCode, stderr || stdout);
  return { code, stdout, stderr };
}
