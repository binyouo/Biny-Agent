import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { BrowserEnvironmentStore, browserPartitionForEnvironment } from "../src/desktop/browserEnvironments.js";
import { registerInAppBrowserCommands } from "../src/cli/commands/iab.js";
import { requestBrowser, type BrowserAutomationEndpoint } from "../src/tools/browser.js";

test("browser environments persist user entries and keep default partition stable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-environments-"));
  const file = path.join(root, "browser-environments.json");
  try {
    const store = new BrowserEnvironmentStore(file);
    await store.load();
    assert.deepEqual(store.list().map(({ id, name }) => ({ id, name })), [{ id: "default", name: "默认" }]);
    await assert.rejects(store.delete("default"), /默认环境/);

    const created = await store.create({ name: "Work", proxy: { mode: "fixed_servers", proxyRules: "http=127.0.0.1:7890" } });
    assert.match(created.id, /^[0-9a-f-]{36}$/iu);
    assert.equal(browserPartitionForEnvironment("default"), "persist:biny-browser");
    assert.equal(browserPartitionForEnvironment(created.id), `persist:biny-browser-env-${created.id}`);
    await assert.rejects(store.create({ name: "work", proxy: { mode: "system" } }), /名称已存在/);
    await assert.rejects(store.create({ name: "Invalid proxy", proxy: { mode: "fixed_servers" } }), /代理规则/);
    await assert.rejects(store.create({ name: "Secret proxy", proxy: { mode: "fixed_servers", proxyRules: "http://user:pass@127.0.0.1:7890" } }), /用户名或密码/);

    const reloaded = new BrowserEnvironmentStore(file);
    await reloaded.load();
    assert.deepEqual(reloaded.get("work"), created);
    const updated = await reloaded.update(created.id, { name: "Work Account", proxy: { mode: "direct" } });
    assert.deepEqual(updated.proxy, { mode: "direct" });
    await reloaded.delete(created.id);
    assert.deepEqual(reloaded.list().map(({ id }) => id), ["default"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Electron is the only substituted browser boundary. No real browser, account,
// network page, or profile is opened; the real CLI, socket and service choose it.
interface BrowserOptions { webPreferences: { partition: string } }
class EnvironmentContents extends EventEmitter {
  url = "about:blank";
  destroyed = false;
  navigations: string[] = [];
  constructor(readonly partition: string) { super(); }
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach() {},
    sendCommand: async (method: string) => {
      assert.equal(method, "Runtime.evaluate");
      return { result: { value: { url: this.url, title: this.partition } } };
    }
  });
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  async loadURL(url: string): Promise<void> {
    this.navigations.push(url);
    this.url = url;
    this.emit("did-navigate", {}, url);
    this.emit("did-stop-loading");
  }
  getURL(): string { return this.url; }
  getTitle(): string { return this.partition; }
  isLoading(): boolean { return false; }
  isDestroyed(): boolean { return this.destroyed; }
  setWindowOpenHandler(): void {}
  stop(): void {}
  close(): void { this.destroyed = true; this.emit("destroyed"); }
}
class EnvironmentView {
  static instances: EnvironmentView[] = [];
  webContents: EnvironmentContents;
  constructor(options: BrowserOptions) {
    this.webContents = new EnvironmentContents(options.webPreferences.partition);
    EnvironmentView.instances.push(this);
  }
  setVisible(): void {}
  setBounds(): void {}
}
class EnvironmentWindow extends EventEmitter {
  static instances: EnvironmentWindow[] = [];
  webContents: EnvironmentContents;
  destroyed = false;
  constructor(readonly options: BrowserOptions) {
    super();
    this.webContents = new EnvironmentContents(options.webPreferences.partition);
    EnvironmentWindow.instances.push(this);
  }
  async loadURL(url: string): Promise<void> {
    await this.webContents.loadURL(url);
    this.emit("ready-to-show");
  }
  isDestroyed(): boolean { return this.destroyed; }
  show(): void {}
  focus(): void {}
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.close();
    this.emit("closed");
  }
}

test("browser environment navigation keeps explicit CLI targets separate from the visible account", async (t) => {
  const fakeElectron = {
    BrowserWindow: EnvironmentWindow,
    WebContentsView: EnvironmentView,
    clipboard: {},
    session: { fromPartition: () => ({
      cookies: { on() {}, get: async () => [] },
      setProxy: async () => {},
      closeAllConnections: async () => {}
    }) }
  };
  Object.assign(globalThis, { __environmentNavigationElectron: fakeElectron });
  const hooks = registerHooks({
    load(url, context, next) {
      return /\/electron\/index\.js$/u.test(url)
        ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__environmentNavigationElectron;", shortCircuit: true }
        : next(url, context);
    }
  });
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const withBrowser = async (run: (fixture: {
      browser: InstanceType<typeof DesktopBrowserService>;
      endpoint: BrowserAutomationEndpoint;
      workId: string;
      show(environmentId: string, partition?: string): EnvironmentContents;
      goto(url: string, environment?: string): Promise<{ url: string; title: string }>;
    }) => Promise<void>): Promise<void> => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-env-navigation-"));
      EnvironmentWindow.instances = [];
      EnvironmentView.instances = [];
      const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, undefined, new BrowserEnvironmentStore());
      const host = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        getContentBounds: () => ({ width: 1200, height: 800 }),
        contentView: { addChildView() {}, removeChildView() {} },
        webContents: { send() {}, getZoomFactor: () => 1 }
      });
      browser.attachDesktopWindow(host as unknown as Electron.BrowserWindow);
      try {
        const work = await browser.createBrowserEnvironment({ name: "Work", proxy: { mode: "direct" } });
        const endpoint = await browser.startAutomationServer(path.join(root, "browser.sock"));
        const show = (environmentId: string, partition?: string): EnvironmentContents => {
          const snapshot = browser.browserAction("project", { type: "new", url: "https://example.invalid/original", environmentId }, partition);
          browser.showEmbeddedBrowser("project", snapshot.activeId!, { x: 0, y: 0, width: 600, height: 400 });
          return EnvironmentView.instances.at(-1)!.webContents;
        };
        const goto = async (url: string, environment?: string): Promise<{ url: string; title: string }> => {
          const output: string[] = [];
          const originalLog = console.log;
          const originalExitCode = process.exitCode;
          const requests: Array<{ method: string; args: Record<string, unknown> }> = [];
          const program = new Command();
          registerInAppBrowserCommands(program, {
            connection: async () => endpoint,
            request: async (connection, method, args) => {
              requests.push({ method, args });
              return await requestBrowser(connection, method, args);
            }
          });
          console.log = (value: unknown): void => { output.push(String(value)); };
          process.exitCode = undefined;
          try {
            await program.parseAsync(["node", "biny", "iab", "goto", url, ...(environment === undefined ? [] : ["--env", environment]), "--json"]);
            assert.equal(process.exitCode, undefined);
            assert.deepEqual(requests, [{ method: "navigate", args: { url, environment } }], "CLI target must reach the actual service without a project binding");
            assert.equal(output.length, 1);
            return JSON.parse(output[0]!) as { url: string; title: string };
          } finally {
            console.log = originalLog;
            process.exitCode = originalExitCode;
          }
        };
        await run({ browser, endpoint, workId: work.id, show, goto });
      } finally {
        // A default-window close queues cookie-jar sync. Close it before dispose,
        // so dispose joins those temporary-file writes before removing the root.
        for (const window of EnvironmentWindow.instances) window.destroy();
        try { await browser.dispose(); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
    };

    for (const environment of ["default", "默认"]) {
      await t.test(`CLI explicitly selecting ${environment} does not navigate the shown Work account`, async () => {
        await withBrowser(async ({ endpoint, workId, show, goto }) => {
          const work = show(workId);
          const result = await goto("https://example.invalid/default-account", environment);
          assert.equal(result.title, "persist:biny-browser", "explicit default must use the default partition, not the shown Work account");
          assert.equal(result.url, "https://example.invalid/default-account");
          assert.deepEqual(await requestBrowser(endpoint, "read_dom", {}), result, "subsequent automation must stay on the explicitly selected default page");
          assert.deepEqual(work.navigations, ["https://example.invalid/original"]);
          assert.equal(work.isDestroyed(), false);
          assert.equal(EnvironmentWindow.instances.length, 1);
          assert.equal(EnvironmentWindow.instances[0]!.webContents.partition, "persist:biny-browser");
        });
      });
    }

    await t.test("explicit default does not reuse the unlabelled special-purpose partition", async () => {
      await withBrowser(async ({ show, goto }) => {
        const special = show("default", "persist:biny-xiaohongshu");
        const result = await goto("https://example.invalid/default-account", "default");
        assert.equal(result.title, "persist:biny-browser");
        assert.deepEqual(special.navigations, ["https://example.invalid/original"]);
      });
    });

    await t.test("omitted environment and legacy open still reuse the shown Work tab", async () => {
      await withBrowser(async ({ browser, workId, show, goto }) => {
        const work = show(workId);
        const result = await goto("https://example.invalid/implicit");
        assert.equal(result.title, browserPartitionForEnvironment(workId));
        await browser.open("https://example.invalid/legacy");
        assert.deepEqual(work.navigations, ["https://example.invalid/original", "https://example.invalid/implicit", "https://example.invalid/legacy"]);
        assert.equal(EnvironmentWindow.instances.length, 0);
      });
    });

    await t.test("explicit default reuses a shown default tab", async () => {
      await withBrowser(async ({ show, goto }) => {
        const current = show("default");
        const result = await goto("https://example.invalid/default-tab", "默认");
        assert.equal(result.title, "persist:biny-browser");
        assert.deepEqual(current.navigations, ["https://example.invalid/original", "https://example.invalid/default-tab"]);
        assert.equal(EnvironmentWindow.instances.length, 0);
      });
    });

    await t.test("explicit default opens and reuses its default window when no tab is shown", async () => {
      await withBrowser(async ({ goto }) => {
        for (const suffix of ["first", "second"]) {
          assert.deepEqual(await goto(`https://example.invalid/${suffix}`, "default"), {
            url: `https://example.invalid/${suffix}`, title: "persist:biny-browser"
          });
        }
        assert.equal(EnvironmentWindow.instances.length, 1);
        assert.deepEqual(EnvironmentWindow.instances[0]!.webContents.navigations, ["https://example.invalid/first", "https://example.invalid/second"]);
      });
    });

    await t.test("explicit custom environment still uses its isolated window", async () => {
      await withBrowser(async ({ workId, show, goto }) => {
        const current = show("default");
        const result = await goto("https://example.invalid/work", "Work");
        assert.equal(result.title, browserPartitionForEnvironment(workId));
        assert.deepEqual(current.navigations, ["https://example.invalid/original"]);
        assert.equal(EnvironmentWindow.instances.length, 1);
      });
    });

    await t.test("project-bound navigation keeps explicit and inherited environment selection", async () => {
      await withBrowser(async ({ browser, endpoint, workId, show }) => {
        const work = show(workId);
        const inherited = await requestBrowser(endpoint, "navigate", { projectId: "project", url: "https://example.invalid/inherited" });
        assert.deepEqual(inherited, { url: "https://example.invalid/inherited", title: browserPartitionForEnvironment(workId) });
        const result = await requestBrowser(endpoint, "navigate", { projectId: "project", url: "https://example.invalid/project-default", environment: "default" });
        assert.deepEqual(result, { url: "https://example.invalid/project-default", title: "persist:biny-browser" });
        assert.equal(browser.browserSnapshot("project").tabs.length, 2);
        assert.deepEqual(work.navigations, ["https://example.invalid/original", "https://example.invalid/inherited"]);
        assert.equal(EnvironmentWindow.instances.length, 0);
      });
    });

    await t.test("unknown explicit environment rejects without navigating any account", async () => {
      await withBrowser(async ({ endpoint, workId, show }) => {
        const work = show(workId);
        await assert.rejects(requestBrowser(endpoint, "navigate", { url: "https://example.invalid/rejected", environment: "Missing" }), /浏览器环境不存在/u);
        assert.deepEqual(work.navigations, ["https://example.invalid/original"]);
        assert.equal(EnvironmentWindow.instances.length, 0);
      });
    });
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__environmentNavigationElectron");
  }
});
