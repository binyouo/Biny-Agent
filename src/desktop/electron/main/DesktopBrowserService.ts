/**
 * 桌面端内嵌浏览器与 cookie 管理。
 *
 * 浏览器窗口跑在独立的持久 partition 上，用户在里面登录网站（Google、小红书……），登录态
 * 由 Electron 自己保存；同时这里把 cookie 同步写进共享 jar，`WebSearch` 的 Google provider
 * 和 `WebFetch` 就能读到同一份登录态 —— 登录一次，agent 侧直接可用。
 *
 * 几个刻意的选择：
 * - 用独立 partition 而不是默认 session：浏览的是任意站点，不能和应用自身的 session 混在一起；
 * - 浏览器窗口不挂应用 preload：那座桥是给渲染层用的，网页拿到就等于拿到主进程能力；
 * - cookie 变化后延迟合并再落盘：一次登录会连着触发几十次 changed 事件，逐次写盘没有意义。
 *
 * 导入导出用 Cookie-Editor 的 JSON 格式，用户可以和浏览器扩展互相搬运登录态。
 */
import { promises as fs } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { assertFetchableUrl, type HostnameResolver } from "../../../tools/web/addressPolicy.js";
import { promisify } from "node:util";
import { BrowserWindow, WebContentsView, clipboard, session, type WebContents, type Cookie, type CookiesSetDetails } from "electron";
import { desktopIpc, type DesktopCookieJarStatus, type DesktopBrowserSnapshot, type DesktopBrowserTab, type DesktopBrowserAction, type DesktopBrowserBounds } from "../../protocol.js";
import type { BrowserAutomationEndpoint } from "../../../tools/browser.js";
import { BrowserRelay } from "../../../browser/BrowserRelay.js";
import { browserRelayFile } from "../../../browser/relayClient.js";
import { prepareBrowserExtension } from "../../../browser/extensionAssets.js";
import type { RelayStatus } from "../../../browser/relayProtocol.js";
import {
  parseCookieJar,
  serializeCookieJar,
  summarizeCookieJar,
  writeCookieJar,
  type StoredCookie
} from "../../../tools/web/cookieJar.js";
import { listBrowserProfiles, readBrowserProfileCookies } from "./browserProfileCookies.js";

const execFileAsync = promisify(execFile);

/** 独立的持久 partition：登录态跨重启保留，且与应用自身 session 完全隔离。 */
const browserPartition = "persist:biny-browser";
const xiaohongshuPartition = "persist:biny-xiaohongshu";
const homeUrl = "https://www.google.com";
/** 一次登录会连续触发大量 cookie 变化，攒一下再落盘。 */
const syncDebounceMs = 800;

interface EmbeddedTab { view: WebContentsView; state: DesktopBrowserTab; navigation: number; inspection: number; popup?: BrowserWindow }
interface EmbeddedProject { revision: number; tabs: Map<string, EmbeddedTab>; activeId?: string }

export class DesktopBrowserService {
  private relay?: BrowserRelay;
  private relayStarting?: Promise<void>;

  async startRelay(): Promise<void> {
    if (this.relay) return;
    if (!this.relayStarting) this.relayStarting = (async () => {
      const relay = new BrowserRelay(browserRelayFile());
      await relay.start();
      this.relay = relay;
    })().finally(() => { this.relayStarting = undefined; });
    await this.relayStarting;
  }

  relayStatus(): RelayStatus { return this.relay?.status() ?? { running: false, connected: false, browsers: [] }; }

  async setupRelay(): Promise<{ extensionPath: string }> {
    await this.startRelay();
    const extensionPath = await prepareBrowserExtension();
    // 密钥只经用户明确点击进入系统剪贴板，不发给 renderer 或模型。
    clipboard.writeText(this.relay!.pairingUrl());
    return { extensionPath };
  }

  async disconnectRelay(): Promise<void> { await this.relay?.disconnect(); }
  private window: BrowserWindow | undefined;
  private desktopWindow: BrowserWindow | undefined;
  private readonly embeddedProjects = new Map<string, EmbeddedProject>();
  private shownBrowser: { projectId: string; tabId: string } | undefined;
  private readonly guardedPages = new Map<number, { allowPrivateNetwork: boolean; reject(error: Error): void }>();
  private readonly guardedPartitions = new Set<string>();
  private automationServer: net.Server | undefined;
  private automationCredentials: BrowserAutomationEndpoint | undefined;
  /** 一个可见 BrowserWindow 对应一个上下文；来自不同 Runtime Host 的请求也必须在这里串行。 */
  private automationTail: Promise<void> = Promise.resolve();
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTail = Promise.resolve();
  private cookieListenerAttached = false;
  /** 仅在本进程真的使用过这个 session 后才在退出时覆盖 jar，避免覆盖 CLI 新导入的内容。 */
  private browserSessionManaged = false;

  constructor(
    private readonly getJarPath: () => Promise<string>,
    private readonly assertCookieMutationAllowed: () => void = () => undefined,
    private readonly resolveWebHostname?: HostnameResolver
  ) {}

  /** 网页由主进程创建，不注入应用 preload；隐藏标签不销毁页面，关窗时统一释放。 */
  attachDesktopWindow(host: BrowserWindow): void {
    if (this.desktopWindow === host) return;
    this.desktopWindow = host;
    host.once("closed", () => {
      for (const group of this.embeddedProjects.values()) for (const tab of group.tabs.values()) {
        tab.popup?.close();
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
      this.embeddedProjects.clear(); this.shownBrowser = undefined;
      if (this.desktopWindow === host) this.desktopWindow = undefined;
    });
  }

  browserSnapshot(projectId: string): DesktopBrowserSnapshot {
    const group = this.embeddedProjects.get(projectId);
    return { projectId, revision: group?.revision ?? 0, activeId: group?.activeId, tabs: [...(group?.tabs.values() ?? [])].map((tab) => ({ ...tab.state })) };
  }

  browserAction(projectId: string, action: DesktopBrowserAction, partition = browserPartition): DesktopBrowserSnapshot {
    const host = this.desktopWindow;
    if (!host || host.isDestroyed()) throw new Error("浏览器主窗口不可用。");
    if ((action.type === "new" || action.type === "navigate") && action.url !== undefined && !isHttpUrl(action.url)) throw new Error("浏览器仅支持 HTTP 和 HTTPS 地址。");
    let group = this.embeddedProjects.get(projectId);
    if (!group) { group = { revision: 0, tabs: new Map() }; this.embeddedProjects.set(projectId, group); }
    if (action.type === "new") {
      if (group.tabs.size >= 20) throw new Error("最多打开 20 个浏览器标签，请先关闭部分标签。");
      this.hideEmbeddedBrowser();
      this.attachCookieListener();
      const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      view.setVisible(false); host.contentView.addChildView(view);
      const id = randomUUID();
      const tab: EmbeddedTab = { view, navigation: 0, inspection: 0, state: { id, title: "新标签页", url: "", loading: false, canGoBack: false, canGoForward: false } };
      group.tabs.set(id, tab); group.activeId = id;
      const contents = view.webContents;
      const update = (): void => {
        if (contents.isDestroyed() || !group?.tabs.has(id)) return;
        const url = contents.getURL();
        tab.state = { ...tab.state, url: url === "about:blank" ? "" : url || tab.state.url, title: contents.getTitle() || "新标签页", loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
        this.emitBrowserState(projectId);
      };
      contents.on("did-start-loading", update); contents.on("did-stop-loading", update);
      contents.on("did-navigate", update); contents.on("did-navigate-in-page", update); contents.on("page-title-updated", update);
      contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (!mainFrame || inPlace) return;
        tab.inspection++;
        tab.state.selection = undefined;
        tab.state.inspecting = false;
        tab.state.inspectionError = undefined;
        this.emitBrowserState(projectId);
      });
      contents.debugger.on("message", (_event, method, params, sessionId) => {
        if (method !== "Overlay.inspectNodeRequested" || !tab.state.inspecting) return;
        const inspection = tab.inspection;
        void this.captureInspectedElement(projectId, tab, params.backendNodeId, sessionId).catch((error: unknown) => {
          if (tab.inspection !== inspection) return;
          tab.state.inspecting = false; tab.state.inspectionError = String(error); this.emitBrowserState(projectId);
        });
      });
      contents.debugger.on("detach", () => { tab.inspection++; tab.state.inspecting = false; this.emitBrowserState(projectId); });
      const restrict = (event: Electron.Event, url: string): void => { if (!isHttpUrl(url) && url !== "about:blank") event.preventDefault(); };
      contents.on("will-navigate", restrict); contents.on("will-redirect", restrict);
      contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
        if (!mainFrame || code === -3) return;
        tab.state = { ...tab.state, error: description, loading: false };
        if (this.shownBrowser?.tabId === id) this.hideEmbeddedBrowser();
        this.emitBrowserState(projectId);
      });
      contents.on("render-process-gone", () => { tab.state = { ...tab.state, error: "网页进程已退出，请重新加载。", loading: false }; this.emitBrowserState(projectId); });
      contents.setWindowOpenHandler(({ url }) => {
        if (isHttpUrl(url) && this.shownBrowser?.tabId === id) {
          try { this.browserAction(projectId, { type: "new", url }); }
          catch (error) { tab.state.error = String(error); this.emitBrowserState(projectId); }
        }
        return { action: "deny" };
      });
      if (action.url) this.navigateEmbedded(projectId, tab, action.url);
    } else {
      const tab = group.tabs.get(action.tabId);
      if (!tab) throw new Error("浏览器标签不存在或不属于此项目。");
      const contents = tab.view.webContents;
      if (action.type === "close") {
        tab.popup?.close();
        group.tabs.delete(action.tabId); host.contentView.removeChildView(tab.view); contents.close();
        if (group.activeId === action.tabId) group.activeId = group.tabs.keys().next().value;
        if (this.shownBrowser?.tabId === action.tabId) this.shownBrowser = undefined;
      } else if (action.type === "select") {
        this.hideEmbeddedBrowser(); group.activeId = action.tabId;
      } else if (action.type === "float") {
        if (tab.popup) tab.popup.close();
        else {
          if (!tab.state.url) throw new Error("请先打开网页。");
          this.hideEmbeddedBrowser();
          host.contentView.removeChildView(tab.view);
          const popup = new BrowserWindow({ width: 960, height: 680, minWidth: 320, minHeight: 240, title: tab.state.title, alwaysOnTop: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
          tab.popup = popup; tab.state.floating = true;
          popup.contentView.addChildView(tab.view);
          const resize = (): void => { const bounds = popup.getContentBounds(); tab.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height }); };
          popup.on("resize", resize);
          popup.once("close", () => {
            popup.contentView.removeChildView(tab.view); tab.popup = undefined; tab.state.floating = false;
            tab.view.setVisible(false);
            if (!host.isDestroyed() && !contents.isDestroyed()) host.contentView.addChildView(tab.view);
            this.emitBrowserState(projectId);
          });
          resize(); tab.view.setVisible(true); popup.show();
        }
      } else if (action.type === "navigate") this.navigateEmbedded(projectId, tab, action.url);
      else if (action.type === "reload") { tab.state.error = undefined; contents.reload(); }
      else if (action.type === "stop") contents.stop();
      else if (action.type === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      else if (action.type === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    }
    this.emitBrowserState(projectId);
    return this.browserSnapshot(projectId);
  }

  async inspectEmbeddedPage(projectId: string, tabId: string, enabled: boolean): Promise<void> {
    const tab = this.embeddedProjects.get(projectId)?.tabs.get(tabId);
    if (!tab || !isHttpUrl(tab.state.url)) throw new Error("浏览器标签不可用。");
    const inspection = ++tab.inspection;
    const current = (): boolean => tab.inspection === inspection && this.embeddedProjects.get(projectId)?.tabs.get(tabId) === tab && !tab.view.webContents.isDestroyed();
    const debug = tab.view.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    await debug.sendCommand("DOM.enable");
    if (!current()) return;
    await debug.sendCommand("Overlay.enable");
    if (!current()) return;
    await debug.sendCommand("Overlay.setInspectMode", { mode: enabled ? "searchForNode" : "none", highlightConfig: { showInfo: true, contentColor: { r: 80, g: 160, b: 240, a: 0.25 }, borderColor: { r: 80, g: 160, b: 240, a: 0.8 } } });
    if (!current()) return;
    tab.state.inspecting = enabled; tab.state.inspectionError = undefined; this.emitBrowserState(projectId);
  }

  private async captureInspectedElement(projectId: string, tab: EmbeddedTab, backendNodeId: number, sessionId?: string): Promise<void> {
    // 取消、重新选取或同 URL 重载都会使旧结果失效。
    const inspection = tab.inspection;
    const contents = tab.view.webContents; const url = contents.getURL();
    const remote = await contents.debugger.sendCommand("DOM.resolveNode", { backendNodeId }, sessionId);
    try {
      const result = await contents.debugger.sendCommand("Runtime.callFunctionOn", { objectId: remote.object.objectId, returnByValue: true, functionDeclaration: `function() {
        const parts = []; for (let node = this; node && node.nodeType === 1; node = node.parentElement) {
          if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
          const siblings = [...(node.parentNode?.children || [])].filter(child => child.tagName === node.tagName);
          parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''));
        }
        return { tag: this.tagName?.toLowerCase() || '', selector: parts.join(' > ').slice(0, 2000), text: (this.innerText || this.textContent || '').slice(0, 2500) };
      }` }, sessionId);
      if (tab.inspection !== inspection || contents.isDestroyed() || contents.getURL() !== url || !this.embeddedProjects.get(projectId)?.tabs.has(tab.state.id)) return;
      if (result.exceptionDetails || !result.result?.value) throw new Error("无法读取选中元素，请重试。");
      tab.state.selection = result.result.value;
    } finally {
      await contents.debugger.sendCommand("Runtime.releaseObject", { objectId: remote.object.objectId }, sessionId);
      if (tab.inspection === inspection && !contents.isDestroyed()) {
        await contents.debugger.sendCommand("Overlay.setInspectMode", { mode: "none" });
        if (tab.inspection === inspection) { tab.state.inspecting = false; this.emitBrowserState(projectId); }
      }
    }
  }

  async captureEmbeddedPage(projectId: string, tabId: string, selection = false): Promise<string> {
    const tab = this.embeddedProjects.get(projectId)?.tabs.get(tabId);
    if (!tab || !isHttpUrl(tab.state.url)) throw new Error("浏览器标签不可用。");
    const url = tab.state.url;
    if (selection) {
      if (!tab.state.selection) throw new Error("请先选取页面元素。");
      return `${tab.state.title}\n${url}\n\n元素：${tab.state.selection.selector}\n${tab.state.selection.text}`.slice(0, 4000);
    }
    const page = await tab.view.webContents.executeJavaScript("({url:location.href,title:document.title.slice(0,300),text:(document.body?.innerText||'').slice(0,3500)})");
    if (tab.view.webContents.isDestroyed() || tab.view.webContents.getURL() !== url || page.url !== url) throw new Error("页面已导航，请重新附加。");
    return `${String(page.title)}\n${url}\n\n${String(page.text)}`.slice(0, 4000);
  }

  /** 主进程再次裁切到窗口范围，旧标签的迟到尺寸不能重新盖住新标签或其他项目。 */
  showEmbeddedBrowser(projectId: string, tabId: string, bounds?: DesktopBrowserBounds): void {
    if (!bounds) {
      if (this.shownBrowser?.projectId === projectId && this.shownBrowser.tabId === tabId) this.hideEmbeddedBrowser();
      return;
    }
    const host = this.desktopWindow;
    const group = this.embeddedProjects.get(projectId);
    const tab = group?.tabs.get(tabId);
    if (!host || host.isDestroyed() || !tab || tab.popup || group?.activeId !== tabId || !tab.state.url || tab.state.error) return;
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error("浏览器区域尺寸无效。");
    const available = host.getContentBounds();
    const scale = host.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(available.width, Math.round(bounds.x * scale)));
    const y = Math.max(0, Math.min(available.height, Math.round(bounds.y * scale)));
    const width = Math.max(0, Math.min(available.width - x, Math.round(bounds.width * scale)));
    const height = Math.max(0, Math.min(available.height - y, Math.round(bounds.height * scale)));
    if (this.shownBrowser?.tabId !== tabId) this.hideEmbeddedBrowser();
    tab.view.setBounds({ x, y, width, height }); tab.view.setVisible(width > 0 && height > 0);
    this.shownBrowser = { projectId, tabId };
  }

  private hideEmbeddedBrowser(): void {
    const shown = this.shownBrowser;
    const tab = shown && this.embeddedProjects.get(shown.projectId)?.tabs.get(shown.tabId);
    if (tab && !tab.popup && !tab.view.webContents.isDestroyed()) tab.view.setVisible(false);
    this.shownBrowser = undefined;
  }

  private navigateEmbedded(projectId: string, tab: EmbeddedTab, url: string): void {
    const navigation = ++tab.navigation;
    tab.state = { ...tab.state, url, error: undefined, loading: true };
    this.browserSessionManaged = true;
    void tab.view.webContents.loadURL(url).catch((error: unknown) => {
      if (navigation !== tab.navigation || tab.view.webContents.isDestroyed() || String(error).includes("ERR_ABORTED")) return;
      tab.state = { ...tab.state, error: String(error), loading: false }; this.emitBrowserState(projectId);
    });
  }

  private emitBrowserState(projectId: string): void {
    const group = this.embeddedProjects.get(projectId);
    if (group) group.revision++;
    if (this.desktopWindow && !this.desktopWindow.isDestroyed()) this.desktopWindow.webContents.send(desktopIpc.browserState, this.browserSnapshot(projectId));
  }

  /** 启动给 Runtime Host 使用的本地控制面；Unix socket 权限和随机令牌双重限制访问。 */
  async startAutomationServer(endpoint: string): Promise<BrowserAutomationEndpoint> {
    if (this.automationCredentials) return this.automationCredentials;
    try {
      await fs.unlink(endpoint);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const credentials = { endpoint, token: randomBytes(32).toString("hex") };
    const server = net.createServer((socket) => this.handleAutomationConnection(socket, credentials.token));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint);
    });
    await fs.chmod(endpoint, 0o600);
    this.automationServer = server;
    this.automationCredentials = credentials;
    return credentials;
  }

  /**
   * 打开浏览器窗口并导航到目标地址；窗口已存在则复用（再开一个只会让登录态看起来分裂）。
   * `url` 省略时打开首页。
   */
  async open(url?: string): Promise<void> {
    const target = url ?? homeUrl;
    if (!isHttpUrl(target)) throw new Error("Browser navigation only supports HTTP and HTTPS URLs.");
    const shown = this.shownBrowser;
    const embedded = shown && this.embeddedProjects.get(shown.projectId)?.tabs.get(shown.tabId);
    if (embedded && !embedded.view.webContents.isDestroyed()) {
      await embedded.view.webContents.loadURL(target);
      this.browserSessionManaged = true;
      return;
    }
    this.attachCookieListener();
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      await this.window.loadURL(target);
      this.browserSessionManaged = true;
      return;
    }
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 480,
      minHeight: 400,
      title: "Biny 浏览器",
      show: false,
      webPreferences: {
        partition: browserPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.window = window;
    // 站内弹窗（OAuth 登录常用）留在同一个 partition 里开新窗口，否则登录流程会走不完。
    window.webContents.setWindowOpenHandler(({ url: requested }) => {
      if (!isHttpUrl(requested)) return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 620,
          height: 760,
          webPreferences: { partition: browserPartition, contextIsolation: true, nodeIntegration: false, sandbox: true }
        }
      };
    });
    window.on("closed", () => {
      this.window = undefined;
      // 关窗时兜底同步一次：期间的 changed 事件可能还压在防抖窗口里没落盘。
      if (this.browserSessionManaged) void this.syncToJar();
    });
    window.once("ready-to-show", () => window.show());
    await window.loadURL(target);
    this.browserSessionManaged = true;
  }

  /** 小红书凭据仅在主进程与系统剪贴板之间流动，不进入 renderer 快照。 */
  async exportXiaohongshuCookies(): Promise<DesktopCookieJarStatus> {
    this.assertCookieMutationAllowed();
    const cookies = (await session.fromPartition(xiaohongshuPartition).cookies.get({})).filter((cookie) => isXiaohongshuDomain(cookie.domain));
    if (!cookies.length) throw new Error("没有可导出的小红书 Cookie，请先登录。");
    clipboard.writeText(serializeCookieJar(cookies.map(toStoredCookie)));
    return await this.xiaohongshuCookieStatus();
  }

  async importXiaohongshuCookies(): Promise<DesktopCookieJarStatus> {
    this.assertCookieMutationAllowed();
    const text = clipboard.readText();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Cookie 内容超过 1 MB。");
    const cookies = parseCookieJar(text);
    if (!cookies.length || cookies.some((cookie) => !isXiaohongshuDomain(cookie.domain))) throw new Error("请提供仅包含小红书域名的 Cookie-Editor JSON。");
    const store = session.fromPartition(xiaohongshuPartition).cookies;
    let imported = 0;
    try { for (const cookie of cookies) { await store.set(toCookiesSetDetails(cookie)); imported++; } }
    catch { throw new Error(`已导入 ${imported} 个小红书 Cookie，后续写入失败，请检查登录状态。`); }
    return await this.xiaohongshuCookieStatus();
  }

  async clearXiaohongshuCookies(): Promise<DesktopCookieJarStatus> {
    this.assertCookieMutationAllowed();
    const store = session.fromPartition(xiaohongshuPartition).cookies;
    for (const cookie of await store.get({})) {
      if (isXiaohongshuDomain(cookie.domain)) await store.remove(toCookiesSetDetails(toStoredCookie(cookie)).url, cookie.name);
    }
    return await this.xiaohongshuCookieStatus();
  }

  async xiaohongshuCookieStatus(): Promise<DesktopCookieJarStatus> {
    const cookies = (await session.fromPartition(xiaohongshuPartition).cookies.get({})).filter((cookie) => isXiaohongshuDomain(cookie.domain));
    return summarizeCookieJar(cookies.map(toStoredCookie));
  }

  async openSettings(url: string, purpose: "google" | "xiaohongshu" | "webfetch"): Promise<void> {
    if (!isHttpUrl(url)) throw new Error("浏览器仅支持 HTTP 和 HTTPS 地址。");
    const partition = purpose === "xiaohongshu" ? xiaohongshuPartition : browserPartition;
    // 登录页使用独立原生窗口，沿用当前窗口的尺寸和位置，网页加载后接管窗口标题。
    const bounds = (BrowserWindow.getFocusedWindow() ?? this.desktopWindow)?.getBounds();
    const title = purpose === "xiaohongshu" ? "小红书" : purpose === "google" ? "Google 搜索设置" : "WebFetch 浏览器";
    const window = new BrowserWindow({
      width: bounds?.width ?? 1280,
      height: bounds?.height ?? 800,
      x: bounds?.x,
      y: bounds?.y,
      show: true,
      title,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    window.webContents.setWindowOpenHandler(({ url: target }) => isHttpUrl(target) ? { action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } } } : { action: "deny" });
    try { await window.loadURL(url); } catch (error) { window.destroy(); throw error; }
  }

  async listProfiles(): Promise<Array<{ id: string; appName: string; profileName: string; userName?: string }>> {
    if (process.platform !== "darwin") return [];
    return (await listBrowserProfiles()).map(({ id, appName, profileName, userName }) => ({ id, appName, profileName, userName }));
  }

  /** 配置 ID 必须重新匹配主进程实际发现的路径，渲染层不得指定任意 SQLite 文件。 */
  async importProfile(profileId: string): Promise<{ imported: number; failed: number; appName: string }> {
    if (process.platform !== "darwin") throw new Error("浏览器配置导入目前仅支持 macOS。");
    const profile = (await listBrowserProfiles()).find((item) => item.id === profileId);
    if (!profile) throw new Error("浏览器配置已不存在，请刷新列表。");
    let secret: string | undefined;
    for (const args of [
      ["find-generic-password", "-w", "-s", profile.keychainService, "-a", profile.keychainAccount],
      ["find-generic-password", "-w", "-s", profile.keychainService]
    ]) {
      try { secret = (await execFileAsync("security", args, { timeout: 15_000, maxBuffer: 4_096, windowsHide: true })).stdout.trim(); }
      catch { /* 浏览器的钥匙串记录可能不带 account，继续尝试 service。 */ }
      if (secret) break;
    }
    if (!secret) throw new Error(`无法读取 ${profile.appName} 的钥匙串凭据，请在 macOS 提示中授权后重试。`);
    const { cookies, failed: failedToDecrypt } = await readBrowserProfileCookies(profile, secret);
    if (!cookies.length) throw new Error("该配置没有可导入的 Cookie，或 Cookie 无法解密。");
    this.assertCookieMutationAllowed();
    const browserSession = session.fromPartition(browserPartition);
    let imported = 0;
    let failed = failedToDecrypt;
    for (const cookie of cookies) {
      try { await browserSession.cookies.set(toCookiesSetDetails(cookie)); imported++; }
      catch { failed++; }
    }
    if (!imported) throw new Error("Cookie 导入失败，未改变浏览器登录态。");
    this.browserSessionManaged = true;
    try { await this.syncToJar(); }
    catch { throw new Error(`已有 ${imported} 个 Cookie 写入浏览器，但同步到共享存储失败；请检查 Cookie 状态后决定是否重试。`); }
    return { imported, failed, appName: profile.appName };
  }

  async status(): Promise<DesktopCookieJarStatus> {
    const cookies = await this.readSessionCookies();
    let updatedAt: string | undefined;
    try {
      updatedAt = (await fs.stat(await this.getJarPath())).mtime.toISOString();
    } catch {
      updatedAt = undefined;
    }
    const summary = summarizeCookieJar(cookies, updatedAt);
    return { total: summary.total, domains: summary.domains.slice(0, 8), updatedAt: summary.updatedAt };
  }

  /** 退出前先把内存里的最新登录态落盘，再销毁浏览器窗口。 */
  async dispose(): Promise<void> {
    await this.relayStarting?.catch(() => undefined);
    await this.relay?.close();
    this.relay = undefined;
    await this.stopAutomationServer();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    if (this.browserSessionManaged) await this.syncToJar();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
    this.hideEmbeddedBrowser();
    for (const group of this.embeddedProjects.values()) for (const tab of group.tabs.values()) {
      tab.popup?.close();
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.embeddedProjects.clear();
  }

  private async stopAutomationServer(): Promise<void> {
    const server = this.automationServer;
    this.automationServer = undefined;
    this.automationCredentials = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleAutomationConnection(socket: net.Socket, token: string): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 256 * 1024) {
        socket.destroy(new Error("Browser automation request is too large."));
        return;
      }
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.handleAutomationRequest(line, token, socket);
      }
    });
  }

  private async handleAutomationRequest(line: string, token: string, socket: net.Socket): Promise<void> {
    let id = "unknown";
    try {
      const request = asRecord(JSON.parse(line));
      id = readString(request.id, "id");
      if (request.token !== token) throw new Error("Browser automation authentication failed.");
      const method = readString(request.method, "method");
      const args = asRecord(request.args);
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      socket.once("close", abort);
      let result: unknown;
      try {
        result = await this.enqueueAutomation(() => {
          controller.signal.throwIfAborted();
          return method === "web_read" ? this.readWebPage(args, controller.signal) : this.executeAutomation(method, args);
        });
      } finally { socket.off("close", abort); }
      socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }

  private enqueueAutomation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const run = this.automationTail.then(operation, operation);
    this.automationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 网页任务拥有独立页面；关闭侧栏时走隐藏窗口，避免改写用户当前标签。 */
  private async readWebPage(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const target = new URL(readString(args.url, "url"));
    const allowPrivateNetwork = args.allowPrivateNetwork === true;
    const timeoutMs = readNumber(args.timeoutMs, 15_000, 60_000);
    const maxBytes = Math.min(readNumber(args.maxBytes, 524_288, 20 * 1024 * 1024), 524_288);
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("网页读取已取消。"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("网页读取超时，请重试。")), timeoutMs);
    let window: BrowserWindow | undefined;
    let contents: WebContents | undefined;
    let projectId: string | undefined;
    let tabId: string | undefined;
    let completed = false;
    const interrupted = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    try {
      await Promise.race([assertFetchableUrl(target, { allowPrivateNetwork, resolveHostname: this.resolveWebHostname }), interrupted]);
      controller.signal.throwIfAborted();
      const partition = args.engine === "xiaohongshu" ? xiaohongshuPartition : browserPartition;
      this.guardWebPartition(partition);
      const visible = args.visible === true && typeof args.projectId === "string" && this.shownBrowser?.projectId === args.projectId;
      if (visible) {
        projectId = args.projectId as string;
        const state = this.browserAction(projectId, { type: "new" }, partition);
        tabId = state.activeId!;
        const tab = this.embeddedProjects.get(projectId)!.tabs.get(tabId)!;
        tab.state.url = target.href;
        contents = tab.view.webContents;
        this.emitBrowserState(projectId);
      } else {
        window = new BrowserWindow({ show: false, webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        contents = window.webContents;
      }
      const page = contents;
      let status = 200;
      let redirects = 0;
      const maxRedirects = args.maxRedirects === 0 ? 0 : readNumber(args.maxRedirects, 5, 20);
      page.on("did-navigate", (_event, _url, code: number) => { if (typeof code === "number") status = code; });
      page.on("will-redirect", (event) => { if (++redirects > maxRedirects) { event.preventDefault(); controller.abort(new Error("网页跳转次数超过限制。")); } });
      page.once("destroyed", () => { this.guardedPages.delete(page.id); controller.abort(new Error("网页已关闭。")); });
      page.setWindowOpenHandler(() => ({ action: "deny" }));
      this.guardedPages.set(page.id, { allowPrivateNetwork, reject: (error) => controller.abort(error) });
      const work = async (): Promise<unknown> => {
        await page.loadURL(target.href);
        let result: { html: string; body: string; finalUrl: string; title: string; contentType: string; ready: boolean; truncatedAtByteLimit: boolean };
        // 搜索站点在导航完成后异步渲染；以 DOM 条件完成，超时有硬上限。
        do {
          controller.signal.throwIfAborted();
          result = await page.executeJavaScript(`(() => {
            const engine = ${JSON.stringify(args.engine ?? null)};
            const emptyOrChallenge = /没有找到|暂无搜索结果|did not match any documents|unusual traffic|登录后查看/i.test(document.body?.innerText || "");
            const ready = emptyOrChallenge || (engine === "google" ? !!document.querySelector('a h3, #captcha-form, form[action*="consent"]') : engine === "xiaohongshu" ? !!document.querySelector('section.note-item, .login-container, .login-modal') : true);
            const encoder = new TextEncoder();
            const content = document.documentElement.cloneNode(true);
            content.querySelectorAll('script, style, noscript, template, svg, img, link, meta').forEach(node => node.remove());
            const htmlBytes = encoder.encode(content.outerHTML);
            const textBytes = encoder.encode(document.body?.innerText || '');
            const decoder = new TextDecoder();
            return { html: decoder.decode(htmlBytes.subarray(0, ${maxBytes})), body: decoder.decode(textBytes.subarray(0, ${maxBytes})), finalUrl: location.href, title: document.title, contentType: document.contentType, ready, truncatedAtByteLimit: (document.contentType === 'text/html' ? htmlBytes : textBytes).length > ${maxBytes} };
          })()`) as typeof result;
          if (!result.ready) await delay(200, undefined, { signal: controller.signal });
        } while (!result.ready);
        await assertFetchableUrl(new URL(result.finalUrl), { allowPrivateNetwork, resolveHostname: this.resolveWebHostname });
        if (status >= 400) throw new Error(`网页返回 HTTP ${status}。`);
        const body = result.contentType === "text/html" ? result.html : result.body;
        return { ...result, body, status, truncatedAtByteLimit: result.truncatedAtByteLimit === true };
      };
      const result = await Promise.race([work(), interrupted]);
      completed = true;
      return result;
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (contents) {
        if (window || !completed) this.guardedPages.delete(contents.id);
        if (!contents.isDestroyed()) contents.stop();
      }
      if (window && !window.isDestroyed()) window.destroy();
      // 成功的可见标签保留供用户查看；失败或取消的任务页释放，避免继续发起请求。
      if (!completed && projectId && tabId && this.embeddedProjects.get(projectId)?.tabs.has(tabId)) this.browserAction(projectId, { type: "close", tabId });
    }
  }

  private guardWebPartition(partition: string): void {
    if (this.guardedPartitions.has(partition)) return;
    this.guardedPartitions.add(partition);
    session.fromPartition(partition).webRequest.onBeforeRequest((details, callback) => {
      const policy = details.webContentsId === undefined ? undefined : this.guardedPages.get(details.webContentsId);
      if (!policy || !/^https?:/i.test(details.url)) { callback({ cancel: Boolean(policy && !/^(https?:|data:|blob:)/i.test(details.url)) }); return; }
      void assertFetchableUrl(new URL(details.url), { allowPrivateNetwork: policy.allowPrivateNetwork, resolveHostname: this.resolveWebHostname }).then(
        () => callback({ cancel: false }),
        (error: unknown) => { callback({ cancel: true }); if (details.resourceType === "mainFrame") policy.reject(error instanceof Error ? error : new Error("网页地址不可访问。")); }
      );
    });
  }

  private async executeAutomation(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === "navigate") {
      const url = readString(args.url, "url");
      if (!isHttpUrl(url)) throw new Error("Browser navigation only supports HTTP and HTTPS URLs.");
      await this.open(url);
      return await this.pageState();
    }
    await this.ensureContents();
    if (method === "read_dom") return await this.readDom(readNumber(args.maxCharacters, 24_000, 100_000));
    if (method === "click") return await this.click(readString(args.selector, "selector"));
    if (method === "fill") return await this.fill(readString(args.selector, "selector"), readString(args.value, "value"));
    if (method === "press") return await this.press(args.selector === undefined ? undefined : readString(args.selector, "selector"), readString(args.key, "key"));
    throw new Error(`Unsupported browser automation method: ${method}`);
  }

  private async ensureContents(): Promise<WebContents> {
    const shown = this.shownBrowser;
    const embedded = shown && this.embeddedProjects.get(shown.projectId)?.tabs.get(shown.tabId);
    if (embedded && !embedded.view.webContents.isDestroyed()) return embedded.view.webContents;
    if (!this.window || this.window.isDestroyed()) throw new Error("Biny 内置浏览器未打开页面。读取日常浏览器请使用 ChromeRelayListTabs；不会自动打开首页。");
    return this.window.webContents;
  }

  private async pageState(): Promise<{ url: string; title: string }> {
    const result = await this.evaluate("({ url: location.href, title: document.title })");
    const state = asRecord(result);
    return { url: readString(state.url, "url"), title: typeof state.title === "string" ? state.title : "" };
  }

  private async readDom(maxCharacters: number): Promise<unknown> {
    return await this.evaluate(`(() => {
      const cssPath = (element) => {
        if (element.id) return '#' + CSS.escape(element.id);
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && parts.length < 6) {
          let part = current.tagName.toLowerCase();
          if (current.parentElement) {
            const siblings = Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')).slice(0, 200);
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, ${String(maxCharacters)}),
        interactive: nodes.map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || undefined,
          name: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.innerText?.trim().slice(0, 120) || undefined,
          selector: cssPath(element)
        }))
      };
    })()`);
  }

  private async click(selector: string): Promise<unknown> {
    return await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('No visible HTML element matched the selector.');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return { tag: element.tagName.toLowerCase(), text: element.innerText?.trim().slice(0, 200) || '' };
    })()`);
  }

  private async fill(selector: string, value: string): Promise<unknown> {
    return await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('No visible HTML element matched the selector.');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus();
      if (element.isContentEditable) element.textContent = ${JSON.stringify(value)};
      else if ('value' in element) {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) descriptor.set.call(element, ${JSON.stringify(value)});
        else element.value = ${JSON.stringify(value)};
      } else throw new Error('The matched element is not an editable field.');
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { tag: element.tagName.toLowerCase() };
    })()`);
  }

  private async press(selector: string | undefined, key: string): Promise<unknown> {
    if (selector) await this.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error('No visible HTML element matched the selector.'); element.focus(); })()`);
    await this.sendDebuggerCommand("Input.dispatchKeyEvent", { type: "keyDown", key, text: key.length === 1 ? key : undefined });
    await this.sendDebuggerCommand("Input.dispatchKeyEvent", { type: "keyUp", key });
    return await this.pageState();
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = asRecord(await this.sendDebuggerCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }));
    const exception = asRecord(result.exceptionDetails);
    if (Object.keys(exception).length) throw new Error(typeof exception.text === "string" ? exception.text : "Browser page evaluation failed.");
    const remote = asRecord(result.result);
    return remote.value;
  }

  private async sendDebuggerCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
    const contents = await this.ensureContents();
    const debuggerSession = contents.debugger;
    if (!debuggerSession.isAttached()) debuggerSession.attach("1.3");
    return await debuggerSession.sendCommand(method, params);
  }

  private async readSessionCookies(): Promise<StoredCookie[]> {
    const cookies = await session.fromPartition(browserPartition).cookies.get({});
    return cookies.map(toStoredCookie);
  }

  /**
   * 监听 cookie 变化，防抖后把整份 session cookie 覆盖写进 jar。
   * 只在首次打开浏览器时挂载，避免重复注册监听器。
   */
  private attachCookieListener(): void {
    if (this.cookieListenerAttached) return;
    this.cookieListenerAttached = true;
    session.fromPartition(browserPartition).cookies.on("changed", () => {
      this.browserSessionManaged = true;
      this.scheduleSyncToJar();
    });
  }

  private scheduleSyncToJar(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.syncToJar();
    }, syncDebounceMs);
  }

  /** 覆盖写 jar。串行化是因为防抖兜底和关窗兜底可能同时触发，并发写会互相截断。 */
  private async syncToJar(): Promise<void> {
    const run = this.syncTail.then(async () => {
      try {
        this.assertCookieMutationAllowed();
      } catch {
        // 浏览器 session 可以继续登录，但共享 jar 必须保持本次 Agent 回合开始时的版本；
        // 等所有项目空闲后再同步最新整份 cookie，避免落下部分登录态。
        this.scheduleSyncToJar();
        return;
      }
      await writeCookieJar(await this.getJarPath(), await this.readSessionCookies());
    });
    this.syncTail = run.catch(() => undefined);
    await run.catch(() => undefined);
  }
}

function toStoredCookie(cookie: Cookie): StoredCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: toStoredSameSite(cookie.sameSite),
    expirationDate: cookie.expirationDate,
    hostOnly: cookie.hostOnly,
    session: cookie.session ?? cookie.expirationDate === undefined
  };
}

/**
 * 还原成 `cookies.set` 需要的形状。它要的是 URL 而不是 domain，所以按 domain 反推一个：
 * 前导点表示包含子域名，去掉点即可；secure 决定用 https 还是 http。
 */
function toCookiesSetDetails(cookie: StoredCookie): CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    // hostOnly 的 cookie 不能带 domain，否则 Electron 会把它变成包含子域名的形式。
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate,
    sameSite: toElectronSameSite(cookie.sameSite)
  };
}

function toStoredSameSite(value: Cookie["sameSite"]): StoredCookie["sameSite"] {
  if (value === "no_restriction") return "no_restriction";
  if (value === "lax") return "lax";
  if (value === "strict") return "strict";
  return "unspecified";
}

function toElectronSameSite(value: StoredCookie["sameSite"]): CookiesSetDetails["sameSite"] {
  if (value === "no_restriction") return "no_restriction";
  if (value === "lax") return "lax";
  if (value === "strict") return "strict";
  return "unspecified";
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Browser automation requires ${name}.`);
  return value;
}

function readNumber(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Browser automation ${String(value)} is outside the supported range.`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isXiaohongshuDomain(domain: string | undefined): boolean {
  const host = domain?.replace(/^\./, "").toLowerCase() ?? "";
  return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
}
