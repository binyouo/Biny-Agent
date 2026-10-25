/**
 * 桌面端内嵌浏览器、隔离环境与 Cookie 管理。
 *
 * 默认环境沿用原有持久 partition，Cookie 会同步到共享 jar，供 `WebSearch` 和默认 `WebFetch`
 * 读取。自定义环境各用独立的持久 partition 保存登录态，不把 Cookie 写进共享 jar。
 *
 * 几个刻意的选择：
 * - 用隔离 partition 而不是默认 session：网页站点不能和应用自身的 session 混在一起；
 * - 保留既有默认 partition，让原来的浏览器登录态继续可用；
 * - 浏览器窗口不挂应用 preload：那座桥是给渲染层用的，网页拿到就等于拿到主进程能力；
 * - cookie 变化后延迟合并再落盘：一次登录会连着触发几十次 changed 事件，逐次写盘没有意义。
 *
 * 导入导出用 Cookie-Editor 的 JSON 格式，用户可以和浏览器扩展互相搬运登录态。
 */
import { promises as fs } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { assertFetchableUrl, type HostnameResolver } from "../../../tools/web/addressPolicy.js";
import { promisify } from "node:util";
import { BrowserWindow, WebContentsView, clipboard, session, type WebContents, type Cookie, type CookiesSetDetails } from "electron";
import { desktopIpc, type DesktopCookieJarStatus, type DesktopBrowserSnapshot, type DesktopBrowserTab, type DesktopBrowserAction, type DesktopBrowserBounds } from "../../protocol.js";
import type { BrowserAutomationEndpoint } from "../../../tools/browser.js";
import { BrowserRelay } from "../../../browser/BrowserRelay.js";
import { browserRelayFile } from "../../../browser/relayClient.js";
import { relaySchemas } from "../../../browser/relayProtocol.js";
import { extractReadableHtml } from "../../../tools/web/html.js";
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
import { ToolOutcomeUnknownError } from "../../../tools/types.js";
import { localIpcEndpoint, removeLocalIpcEndpoint, secureLocalIpcEndpoint } from "../../../utils/localIpc.js";
import { BrowserEnvironmentStore, browserPartitionForEnvironment, type BrowserEnvironmentInput } from "../../browserEnvironments.js";

const execFileAsync = promisify(execFile);

/** 独立的持久 partition：登录态跨重启保留，且与应用自身 session 完全隔离。 */
const browserPartition = "persist:biny-browser";
const xiaohongshuPartition = "persist:biny-xiaohongshu";
const homeUrl = "https://www.google.com";
/** 一次登录会连续触发大量 cookie 变化，攒一下再落盘。 */
const syncDebounceMs = 800;

const browserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("new"), url: z.string().url().refine(isHttpUrl).optional(), environmentId: z.string().min(1).max(64).optional() }).strict(),
  z.object({ type: z.literal("navigate"), tabId: z.string().min(1).max(240), url: z.string().url().refine(isHttpUrl) }).strict(),
  z.object({ type: z.enum(["close", "select", "back", "forward", "reload", "stop", "float"]), tabId: z.string().min(1).max(240) }).strict()
]);

interface EmbeddedTab { view: WebContentsView; state: DesktopBrowserTab; navigation: number; inspection: number; popup?: BrowserWindow }
interface EmbeddedProject { revision: number; tabs: Map<string, EmbeddedTab>; activeId?: string }
type BrowserActionTarget = (contents: WebContents) => void;

export class DesktopBrowserService {
  private desktopCommand?: (args: Record<string, unknown>) => Promise<unknown>;

  attachDesktopCommands(handler: (args: Record<string, unknown>) => Promise<unknown>): void { this.desktopCommand = handler; }
  private previewActivity?: (source: { id: string; label: string; projectId?: string; sessionId?: string; capture: () => Promise<import("../../../computer/protocol.js").ComputerImage> }) => void;
  attachPreviewActivity(listener: typeof this.previewActivity): void { this.previewActivity = listener; }
  private computerUse?: (method: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  attachComputerUse(handler: (method: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>): void { this.computerUse = handler; }
  private relay?: BrowserRelay;
  private relayStarting?: Promise<void>;
  private relayChanging = false;

  async startRelay(): Promise<void> {
    if (this.relay) return;
    if (!this.relayStarting) this.relayStarting = (async () => {
      const relay = new BrowserRelay(browserRelayFile());
      await relay.start();
      this.relay = relay;
      relay.attachActivity(target => {
        this.previewActivity?.({ id: `relay:${target.browserId}:${target.tabId}`, label: target.browserName, sessionId: target.sessionId,
          capture: async () => {
            const response = await relay.request("screenshot", { browserId: target.browserId, tabId: target.tabId, fullPage: false }, undefined, undefined, true) as { mimeType: string; data: string };
            const { nativeImage } = await import("electron");
            const image = nativeImage.createFromBuffer(Buffer.from(response.data, "base64")).resize({ width: 1024 }).toJPEG(50);
            if (image.byteLength > 1048576) throw new Error("browser_preview_budget_exceeded");
            return { mimeType: "image/jpeg", dataBase64: image.toString("base64") };
          }
        });
      });
    })().finally(() => { this.relayStarting = undefined; });
    await this.relayStarting;
  }

  relayStatus(): RelayStatus { return this.relay?.status() ?? { running: false, connected: false, browsers: [] }; }

  async setupRelay(regenerate = false): Promise<{ extensionPath: string }> {
    return await this.changeRelay(async () => {
      await this.startRelay();
      const extensionPath = await prepareBrowserExtension();
      if (regenerate) await this.relay!.disconnect();
      // 密钥只经用户明确点击进入系统剪贴板，不发给 renderer 或模型。
      clipboard.writeText(this.relay!.pairingUrl());
      return { extensionPath };
    });
  }

  async disconnectRelay(): Promise<void> { await this.changeRelay(async () => { await this.relay?.disconnect(); }); }

  private async changeRelay<T>(action: () => Promise<T>): Promise<T> {
    if (this.relayChanging) throw new Error("浏览器配对操作正在进行，请等待完成后再试。");
    this.relayChanging = true;
    try { return await action(); } finally { this.relayChanging = false; }
  }
  private window: BrowserWindow | undefined;
  private desktopWindow: BrowserWindow | undefined;
  private readonly embeddedProjects = new Map<string, EmbeddedProject>();
  private readonly environmentWindows = new Map<string, BrowserWindow>();
  private readonly proxyReady = new Map<string, Promise<void>>();
  private readonly deletingBrowserEnvironments = new Set<string>();
  private automationContents: WebContents | undefined;
  private shownBrowser: { projectId: string; tabId: string } | undefined;
  private readonly guardedPages = new Map<number, { allowPrivateNetwork: boolean; reject(error: Error): void }>();
  private readonly guardedPartitions = new Set<string>();
  private automationServer: net.Server | undefined;
  private automationCredentials: BrowserAutomationEndpoint | undefined;
  /** 一个可见 BrowserWindow 对应一个上下文；来自不同 Runtime Host 的请求也必须在这里串行。 */
  private automationTail: Promise<void> = Promise.resolve();
  private readonly dialogWatchers = new Map<number, { close(): void; dialog?: Record<string, unknown> }>();
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTail = Promise.resolve();
  private cookieListenerAttached = false;
  /** 仅在本进程真的使用过这个 session 后才在退出时覆盖 jar，避免覆盖 CLI 新导入的内容。 */
  private browserSessionManaged = false;

  constructor(
    private readonly getJarPath: () => Promise<string>,
    private readonly assertCookieMutationAllowed: () => void = () => undefined,
    private readonly resolveWebHostname?: HostnameResolver,
    private readonly browserEnvironments = new BrowserEnvironmentStore()
  ) {}

  browserEnvironmentSnapshot() { return this.browserEnvironments.list(); }

  async initializeBrowserEnvironments(): Promise<void> {
    await Promise.all(this.browserEnvironments.list().filter((environment) => environment.id !== "default")
      .map((environment) => this.prepareBrowserEnvironment(environment.id)));
  }

  async createBrowserEnvironment(input: BrowserEnvironmentInput) {
    this.assertCookieMutationAllowed();
    const environment = await this.browserEnvironments.create(input);
    try { await this.applyBrowserEnvironmentProxy(environment.id); }
    catch (error) { await this.browserEnvironments.delete(environment.id); throw error; }
    return environment;
  }

  async updateBrowserEnvironment(id: string, input: BrowserEnvironmentInput) {
    this.assertCookieMutationAllowed();
    const previous = this.browserEnvironments.get(id);
    if (!previous || id === "default") throw new Error("浏览器环境不存在或不可修改。");
    const updated = await this.browserEnvironments.update(id, input);
    this.proxyReady.delete(id);
    try { await this.applyBrowserEnvironmentProxy(id); }
    catch (error) {
      await this.browserEnvironments.update(id, { name: previous.name, proxy: previous.proxy });
      this.proxyReady.delete(id);
      await this.applyBrowserEnvironmentProxy(id).catch(() => undefined);
      throw error;
    }
    return updated;
  }

  async deleteBrowserEnvironment(id: string): Promise<void> {
    this.assertCookieMutationAllowed();
    if (id === "default" || !this.browserEnvironments.get(id)) throw new Error("默认环境不可删除或浏览器环境不存在。");
    if (this.deletingBrowserEnvironments.has(id)) throw new Error("浏览器环境正在删除。");
    this.deletingBrowserEnvironments.add(id);
    try {
      const partition = browserPartitionForEnvironment(id);
      for (const [projectId, group] of this.embeddedProjects) {
        for (const [tabId, tab] of group.tabs) {
          if (tab.state.environmentId !== id) continue;
          tab.popup?.close();
          group.tabs.delete(tabId);
          if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
          this.desktopWindow?.contentView.removeChildView(tab.view);
          if (group.activeId === tabId) group.activeId = group.tabs.keys().next().value;
          if (this.shownBrowser?.tabId === tabId) this.shownBrowser = undefined;
          if (this.automationContents === tab.view.webContents) this.automationContents = undefined;
        }
        this.emitBrowserState(projectId);
      }
      const window = this.environmentWindows.get(id);
      if (window && !window.isDestroyed()) window.destroy();
      this.environmentWindows.delete(id);
      const environmentSession = session.fromPartition(partition);
      const getAllWindows = (BrowserWindow as unknown as { getAllWindows?: () => BrowserWindow[] }).getAllWindows;
      for (const candidate of getAllWindows?.() ?? []) {
        if (candidate.webContents.session === environmentSession && !candidate.isDestroyed()) candidate.destroy();
      }
      await environmentSession.clearStorageData();
      await environmentSession.clearAuthCache();
      await environmentSession.clearCache();
      await this.browserEnvironments.delete(id);
      this.proxyReady.delete(id);
    } finally {
      this.deletingBrowserEnvironments.delete(id);
    }
  }

  async clearBrowserEnvironment(id: string): Promise<void> {
    this.assertCookieMutationAllowed();
    if (id === "default" || !this.browserEnvironments.get(id)) throw new Error("默认环境不可清空或浏览器环境不存在。");
    const partition = browserPartitionForEnvironment(id);
    const environmentSession = session.fromPartition(partition);
    await environmentSession.clearStorageData();
    await environmentSession.clearAuthCache();
    await environmentSession.clearCache();
  }

  async importBrowserEnvironmentCookies(sourceId: string, targetId: string): Promise<{ imported: number }> {
    this.assertCookieMutationAllowed();
    if (sourceId === targetId) throw new Error("源环境和目标环境不能相同。");
    if (!this.browserEnvironments.get(sourceId) || !this.browserEnvironments.get(targetId)) throw new Error("浏览器环境不存在。");
    await this.prepareBrowserEnvironment(sourceId);
    await this.prepareBrowserEnvironment(targetId);
    const source = session.fromPartition(browserPartitionForEnvironment(sourceId));
    const target = session.fromPartition(browserPartitionForEnvironment(targetId));
    const cookies = await source.cookies.get({});
    for (const cookie of await target.cookies.get({})) {
      await target.cookies.remove(toCookiesSetDetails(toStoredCookie(cookie)).url, cookie.name);
    }
    let imported = 0;
    try {
      for (const cookie of cookies) { await target.cookies.set(toCookiesSetDetails(toStoredCookie(cookie))); imported++; }
    } catch (error) {
      throw new Error(`已复制 ${imported} 个 Cookie，后续写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return { imported };
  }

  private requireBrowserEnvironment(id: string) {
    const environment = this.browserEnvironments.get(id);
    if (!environment) throw new Error("浏览器环境不存在。");
    if (this.deletingBrowserEnvironments.has(environment.id)) throw new Error("浏览器环境正在删除。");
    return environment;
  }

  async prepareBrowserEnvironment(id: string): Promise<void> {
    this.requireBrowserEnvironment(id);
    if (id === "default") return;
    let pending = this.proxyReady.get(id);
    if (!pending) {
      pending = this.applyBrowserEnvironmentProxy(id);
      this.proxyReady.set(id, pending);
      void pending.catch(() => { if (this.proxyReady.get(id) === pending) this.proxyReady.delete(id); });
    }
    await pending;
    this.requireBrowserEnvironment(id);
  }

  private async applyBrowserEnvironmentProxy(id: string): Promise<void> {
    const environment = this.browserEnvironments.get(id);
    if (!environment || id === "default") throw new Error("浏览器环境不存在或不能更改默认代理。");
    const environmentSession = session.fromPartition(browserPartitionForEnvironment(id));
    await environmentSession.setProxy({
      mode: environment.proxy.mode,
      proxyRules: environment.proxy.proxyRules,
      proxyBypassRules: environment.proxy.proxyBypassRules
    });
    await environmentSession.closeAllConnections();
  }

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

  async applyBrowserAction(projectId: string, input: unknown): Promise<DesktopBrowserSnapshot> {
    const action = browserActionSchema.parse(input);
    if (action.type === "new") {
      const snapshot = this.browserSnapshot(projectId);
      const active = snapshot.tabs.find(tab => tab.id === snapshot.activeId);
      await this.prepareBrowserEnvironment(action.environmentId ?? active?.environmentId ?? "default");
    }
    return this.browserAction(projectId, action);
  }

  browserAction(projectId: string, action: DesktopBrowserAction, partition?: string): DesktopBrowserSnapshot {
    const host = this.desktopWindow;
    if (!host || host.isDestroyed()) throw new Error("浏览器主窗口不可用。");
    if ((action.type === "new" || action.type === "navigate") && action.url !== undefined && !isHttpUrl(action.url)) throw new Error("浏览器仅支持 HTTP 和 HTTPS 地址。");
    let group = this.embeddedProjects.get(projectId);
    if (!group) { group = { revision: 0, tabs: new Map() }; this.embeddedProjects.set(projectId, group); }
    if (action.type === "new") {
      if (group.tabs.size >= 20) throw new Error("最多打开 20 个浏览器标签，请先关闭部分标签。");
      const current = group.activeId ? group.tabs.get(group.activeId) : undefined;
      const environmentId = action.environmentId ?? current?.state.environmentId ?? "default";
      const environment = this.requireBrowserEnvironment(environmentId);
      const targetPartition = partition ?? browserPartitionForEnvironment(environmentId);
      const managedEnvironmentPartition = targetPartition === browserPartitionForEnvironment(environmentId);
      this.hideEmbeddedBrowser();
      if (targetPartition === browserPartition) this.attachCookieListener();
      const view = new WebContentsView({ webPreferences: { partition: targetPartition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      view.setVisible(false); host.contentView.addChildView(view);
      const id = randomUUID();
      const tab: EmbeddedTab = { view, navigation: 0, inspection: 0, state: {
        id, title: "新标签页", url: "", environmentId: managedEnvironmentPartition ? environment.id : undefined,
        environmentName: managedEnvironmentPartition ? environment.name : "小红书",
        environmentColor: managedEnvironmentPartition ? environment.color : "#f49bbc",
        loading: false, canGoBack: false, canGoForward: false
      } };
      group.tabs.set(id, tab); group.activeId = id;
      const contents = view.webContents;
      this.automationContents = contents;
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
          try { this.browserAction(projectId, { type: "new", url, environmentId }); }
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
        if (this.automationContents === contents) {
          const active = group.activeId ? group.tabs.get(group.activeId) : undefined;
          this.automationContents = active?.view.webContents;
        }
      } else if (action.type === "select") {
        this.hideEmbeddedBrowser(); group.activeId = action.tabId;
        this.automationContents = contents;
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
      } else if (action.type === "navigate") { this.automationContents = contents; this.navigateEmbedded(projectId, tab, action.url); }
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
    this.automationContents = tab.view.webContents;
    if (tab.state.environmentId === "default") this.browserSessionManaged = true;
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

  /** 本地控制面在完成系统权限设置后才接纳连接，令牌仍由每次请求验证。 */
  async startAutomationServer(endpoint: string): Promise<BrowserAutomationEndpoint> {
    if (this.automationCredentials) return this.automationCredentials;
    endpoint = localIpcEndpoint(endpoint);
    await removeLocalIpcEndpoint(endpoint);
    const credentials = { endpoint, token: randomBytes(32).toString("hex") };
    let ready = false;
    const server = net.createServer((socket) => {
      if (!ready) { socket.destroy(); return; }
      this.handleAutomationConnection(socket, credentials.token);
    });
    try {
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
      await secureLocalIpcEndpoint(endpoint);
      ready = true;
      this.automationServer = server;
      this.automationCredentials = credentials;
      return credentials;
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeLocalIpcEndpoint(endpoint);
      throw error;
    }
  }

  /**
   * 打开浏览器窗口并导航到目标地址；窗口已存在则复用（再开一个只会让登录态看起来分裂）。
   * `url` 省略时打开首页。
   */
  async open(url?: string, requiredEnvironment?: "default"): Promise<void> {
    await this.openPage(url, requiredEnvironment);
  }

  private async openPage(url?: string, requiredEnvironment?: "default"): Promise<WebContents> {
    const target = url ?? homeUrl;
    if (!isHttpUrl(target)) throw new Error("Browser navigation only supports HTTP and HTTPS URLs.");
    const shown = this.shownBrowser;
    const embedded = shown && this.embeddedProjects.get(shown.projectId)?.tabs.get(shown.tabId);
    if (embedded && !embedded.view.webContents.isDestroyed() && (!requiredEnvironment || embedded.state.environmentId === requiredEnvironment)) {
      this.automationContents = embedded.view.webContents;
      await embedded.view.webContents.loadURL(target);
      this.browserSessionManaged = true;
      return embedded.view.webContents;
    }
    this.attachCookieListener();
    if (this.window && !this.window.isDestroyed()) {
      const window = this.window;
      window.show();
      window.focus();
      this.automationContents = window.webContents;
      await window.loadURL(target);
      this.browserSessionManaged = true;
      return window.webContents;
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
    this.automationContents = window.webContents;
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
      if (this.browserSessionManaged) void this.syncToJar().catch(() => undefined);
    });
    window.once("ready-to-show", () => window.show());
    await window.loadURL(target);
    this.browserSessionManaged = true;
    return window.webContents;
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
    for (const watcher of this.dialogWatchers.values()) watcher.close();
    await this.relayStarting?.catch(() => undefined);
    await this.relay?.close();
    this.relay = undefined;
    await this.stopAutomationServer();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    if (this.browserSessionManaged) await this.syncToJar().catch(() => undefined);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
    for (const window of this.environmentWindows.values()) if (!window.isDestroyed()) window.destroy();
    this.environmentWindows.clear(); this.automationContents = undefined;
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
      if (Buffer.byteLength(buffer, "utf8") > 12 * 1024 * 1024) {
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
      const previewTarget: { contents?: WebContents } = {};
      try {
        result = method === "desktop_command" && this.desktopCommand ? await this.desktopCommand(args)
          : method === "dialog" ? await this.controlDialog(args, controller.signal)
          : method.startsWith("computer_") && this.computerUse ? await this.computerUse(method, args, controller.signal) : await this.enqueueAutomation(() => {
          controller.signal.throwIfAborted();
          return method === "web_read" ? this.readWebPage(args, controller.signal) : this.executeAutomation(method, args, controller.signal, contents => { previewTarget.contents = contents; });
        });
        if (["navigate", "click", "fill", "press"].includes(method) && this.previewActivity && previewTarget.contents) {
          try {
            const contents = previewTarget.contents;
            if (contents.isDestroyed()) throw new Error("browser_preview_closed");
            const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
            let projectId = typeof args.projectId === "string" ? args.projectId : undefined;
            // A session without an explicit project is resolved by the renderer.
            // CLI requests without either identity may return to the source tab's project.
            if (projectId === undefined && sessionId === undefined) {
              for (const [id, group] of this.embeddedProjects) {
                if ([...group.tabs.values()].some(tab => tab.view.webContents === contents)) { projectId = id; break; }
              }
            }
            this.previewActivity({ id: `browser:${contents.id}`, label: contents.getTitle() || "浏览器", projectId, sessionId,
              capture: async () => { if (contents.isDestroyed()) throw new Error("browser_preview_closed"); const image = (await contents.capturePage()).resize({ width: 1024 }).toJPEG(50); if (image.byteLength > 1048576) throw new Error("browser_preview_budget_exceeded"); return { mimeType: "image/jpeg", dataBase64: image.toString("base64") }; }
            });
          } catch (error) { console.error("Browser preview notification failed after completed action", error instanceof Error ? error.name : "Error"); }
        }
      } finally { socket.off("close", abort); }
      socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error), outcomeUnknown: error instanceof ToolOutcomeUnknownError })}\n`);
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
      const requestedEnvironment = typeof args.environment === "string" ? this.browserEnvironments.get(args.environment) : undefined;
      if (typeof args.environment === "string" && !requestedEnvironment) throw new Error("指定的浏览器环境不存在。");
      const environmentId = requestedEnvironment?.id ?? "default";
      const xiaohongshu = args.engine === "xiaohongshu" && !requestedEnvironment;
      const partition = xiaohongshu ? xiaohongshuPartition : browserPartitionForEnvironment(environmentId);
      if (!xiaohongshu) {
        await this.prepareBrowserEnvironment(environmentId);
        this.requireBrowserEnvironment(environmentId);
      }
      controller.signal.throwIfAborted();
      this.guardWebPartition(partition);
      const visible = args.visible === true && typeof args.projectId === "string" && this.shownBrowser?.projectId === args.projectId;
      if (visible) {
        projectId = args.projectId as string;
        const state = this.browserAction(projectId, { type: "new", environmentId }, partition);
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
        type WebReadPollResult = { ready: false } | { ready: true; html: string; body: string; finalUrl: string; title: string; contentType: string; truncatedAtByteLimit: boolean; googleChallenge?: boolean };
        let result: WebReadPollResult;
        // 搜索站点在导航完成后异步渲染；以 DOM 条件完成，超时有硬上限。
        do {
          controller.signal.throwIfAborted();
          result = await page.executeJavaScript(`(() => {
            const engine = ${JSON.stringify(args.engine ?? null)};
            const emptyOrChallenge = /没有找到|暂无搜索结果|did not match any documents|unusual traffic|登录后查看/i.test(document.body?.innerText || "");
            const ready = emptyOrChallenge || (engine === "google" ? !!document.querySelector('a h3, #captcha-form, form[action*="consent"]') : engine === "xiaohongshu" ? !!document.querySelector('section.note-item, .login-container, .login-modal') : true);
            if (!ready) return { ready: false };
            const googleChallenge = engine === "google" && ready ? !!document.querySelector('#captcha-form, form[action*="consent"]') : undefined;
            const encoder = new TextEncoder();
            const content = document.documentElement.cloneNode(true);
            content.querySelectorAll('script, style, noscript, template, svg, img, link, meta').forEach(node => node.remove());
            const htmlBytes = encoder.encode(content.outerHTML);
            const textBytes = encoder.encode(document.body?.innerText || '');
            const decoder = new TextDecoder();
            return { html: decoder.decode(htmlBytes.subarray(0, ${maxBytes})), body: decoder.decode(textBytes.subarray(0, ${maxBytes})), finalUrl: location.href, title: document.title, contentType: document.contentType, ready: true, truncatedAtByteLimit: ((document.contentType === 'text/html' || document.contentType === 'application/xhtml+xml') ? htmlBytes : textBytes).length > ${maxBytes}, ...(googleChallenge === undefined ? {} : { googleChallenge }) };
          })()`) as WebReadPollResult;
          if (!result.ready) await delay(200, undefined, { signal: controller.signal });
        } while (!result.ready);
        await assertFetchableUrl(new URL(result.finalUrl), { allowPrivateNetwork, resolveHostname: this.resolveWebHostname });
        if (status >= 400) throw new Error(`网页返回 HTTP ${status}。`);
        const body = result.contentType === "text/html" || result.contentType === "application/xhtml+xml" ? result.html : result.body;
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

  private async executeAutomation(method: string, args: Record<string, unknown>, signal?: AbortSignal, onAction?: BrowserActionTarget): Promise<unknown> {
    if (method === "list_environments") return this.browserEnvironments.list().map(({ id, name, color }) => ({ id, name, color }));
    if (method === "status") {
      const contents = this.automationContents;
      return { running: true, page: contents && !contents.isDestroyed() ? { url: contents.getURL(), title: contents.getTitle() } : null };
    }
    if (method === "clipboard") {
      if (args.action === "read") return { text: clipboard.readText() };
      if (args.action !== "write") throw new Error("Unknown clipboard action.");
      clipboard.writeText(z.string().parse(args.text));
      return { written: true };
    }
    if (method === "navigate") {
      const url = readString(args.url, "url");
      if (!isHttpUrl(url)) throw new Error("Browser navigation only supports HTTP and HTTPS URLs.");
      const requestedEnvironment = typeof args.environment === "string" ? args.environment : undefined;
      const selectedProject = [...this.embeddedProjects].find(([, group]) => [...group.tabs.values()].some(tab => tab.view.webContents === this.automationContents));
      const projectId = typeof args.projectId === "string" ? args.projectId : selectedProject?.[0];
      const active = projectId ? this.embeddedProjects.get(projectId)?.tabs.get(this.embeddedProjects.get(projectId)?.activeId ?? "") : undefined;
      const environment = requestedEnvironment
        ? this.browserEnvironments.get(requestedEnvironment)
        : active?.state.environmentId ? this.browserEnvironments.get(active.state.environmentId) : this.browserEnvironments.get("default");
      if (!environment) throw new Error("指定的浏览器环境不存在。");
      await this.prepareBrowserEnvironment(environment.id);
      let contents: WebContents;
      if (projectId && this.desktopWindow && !this.desktopWindow.isDestroyed()) {
        let tab = active?.state.environmentId === environment.id ? active : undefined;
        if (!tab) {
          const snapshot = this.browserAction(projectId, { type: "new", environmentId: environment.id });
          tab = this.embeddedProjects.get(projectId)?.tabs.get(snapshot.activeId ?? "");
        }
        if (!tab || tab.view.webContents.isDestroyed()) throw new Error("浏览器标签不可用。");
        contents = tab.view.webContents;
        this.automationContents = contents;
        await tab.view.webContents.loadURL(url);
        this.browserSessionManaged ||= environment.id === "default";
      } else if (environment.id === "default") {
        contents = await this.openPage(url, requestedEnvironment ? "default" : undefined);
      } else {
        contents = await this.openInEnvironmentWindow(url, environment.id);
      }
      // Selection may change through UI IPC while loadURL is pending. Report
      // the page we actually navigated without restoring an older selection.
      onAction?.(contents);
      return await this.pageState(contents);
    }
    const contents = await this.ensureContents();
    if (method === "evaluate") return await this.evaluate(readString(args.code, "code"), signal);
    if (method === "cdp") return await this.sendDebuggerCommand(readString(args.method, "method"), z.record(z.string(), z.unknown()).parse(args.params), signal);
    if (method === "viewport") {
      if (args.action === "reset") return await this.sendDebuggerCommand("Emulation.clearDeviceMetricsOverride", {}, signal);
      const size = z.object({ width: z.number().int().positive(), height: z.number().int().positive(), mobile: z.boolean() }).parse(args);
      return await this.sendDebuggerCommand("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1 }, signal);
    }
    if (method === "upload") {
      const files = relaySchemas.upload.shape.files.parse(args.files);
      const selector = readString(args.selector, "selector");
      return await this.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!(input instanceof HTMLInputElement) || input.type !== 'file') throw new Error('Selector must match a file input.');
        const transfer = new DataTransfer();
        for (const file of ${JSON.stringify(files)}) {
          const bytes = Uint8Array.from(atob(file.data), character => character.charCodeAt(0));
          transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { count: input.files.length, names: Array.from(input.files, file => file.name) };
      })()`, signal);
    }
    if (method === "download") return await this.downloadFile(relaySchemas.download.shape.url.parse(args.url), signal);
    if (method === "export") {
      const format = z.enum(["pdf", "html", "mhtml", "md"]).parse(args.format);
      const contents = await this.ensureContents();
      let data: Buffer;
      if (format === "pdf") data = await contents.printToPDF({});
      else if (format === "mhtml") data = Buffer.from((await this.sendDebuggerCommand("Page.captureSnapshot", { format: "mhtml" }, signal) as { data: string }).data);
      else {
        const html = String(await this.evaluate("document.documentElement.outerHTML", signal));
        data = Buffer.from(format === "md" ? (await extractReadableHtml(html, contents.getURL())).text : html);
      }
      const mimeTypes = { pdf: "application/pdf", html: "text/html", mhtml: "multipart/related", md: "text/markdown" };
      return { data: data.toString("base64"), mimeType: mimeTypes[format] };
    }
    if (method === "back" || method === "forward" || method === "reload") {
      const contents = await this.ensureContents();
      const history = contents.navigationHistory;
      if (method === "back" && !history.canGoBack() || method === "forward" && !history.canGoForward()) return await this.pageState();
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          contents.off("did-stop-loading", stopped);
          contents.off("did-fail-load", failed);
          signal?.removeEventListener("abort", aborted);
        };
        const stopped = (): void => { cleanup(); resolve(); };
        const failed = (_event: unknown, code: number, description: string, _url: string, mainFrame: boolean): void => {
          if (!mainFrame || code === -3) return;
          cleanup(); reject(new Error(description));
        };
        const aborted = (): void => { cleanup(); reject(signal?.reason); };
        contents.on("did-stop-loading", stopped);
        contents.on("did-fail-load", failed);
        signal?.addEventListener("abort", aborted, { once: true });
        try {
          if (method === "reload") contents.reload();
          else if (method === "back") history.goBack();
          else history.goForward();
        } catch (error) { cleanup(); reject(error); }
      });
      return await this.pageState();
    }
    if (method === "history") return (await this.ensureContents()).navigationHistory.getAllEntries();
    if (method === "screenshot") {
      const image = await (await this.ensureContents()).capturePage();
      return { mimeType: "image/png", data: image.toPNG().toString("base64") };
    }
    if (method === "scroll") {
      const delta = z.object({ x: z.number().finite(), y: z.number().finite() }).parse(args);
      return await this.evaluate(`(() => { window.scrollBy(${delta.x}, ${delta.y}); return { x: scrollX, y: scrollY }; })()`, signal);
    }
    if (method === "read_dom") return await this.readDom(readNumber(args.maxCharacters, 24_000, 100_000));
    if (method === "click") return await this.click(readString(args.selector, "selector"), onAction);
    if (method === "fill") return await this.fill(readString(args.selector, "selector"), readString(args.value, "value"), onAction);
    if (method === "press") return await this.press(args.selector === undefined ? undefined : readString(args.selector, "selector"), readString(args.key, "key"), signal, contents, onAction);
    throw new Error(`Unsupported browser automation method: ${method}`);
  }

  private async ensureContents(owner?: WebContents): Promise<WebContents> {
    if (owner) {
      if (owner.isDestroyed()) throw new Error("Browser action page is closed.");
      return owner;
    }
    if (this.automationContents && !this.automationContents.isDestroyed()) return this.automationContents;
    const shown = this.shownBrowser;
    const embedded = shown && this.embeddedProjects.get(shown.projectId)?.tabs.get(shown.tabId);
    if (embedded && !embedded.view.webContents.isDestroyed()) return embedded.view.webContents;
    if (this.window && !this.window.isDestroyed()) return this.window.webContents;
    const environmentWindow = [...this.environmentWindows.values()].find((window) => !window.isDestroyed());
    if (environmentWindow) return environmentWindow.webContents;
    throw new Error("Biny 内置浏览器未打开页面。读取日常浏览器请使用 ChromeRelayListTabs；不会自动打开首页。");
  }

  private async downloadFile(url: string, signal?: AbortSignal): Promise<unknown> {
    const contents = await this.ensureContents();
    const response = await contents.session.fetch(url, { credentials: "include", signal });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      if (!response.ok) throw new Error(`Download returned HTTP ${String(response.status)}.`);
      if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 8 * 1024 * 1024) throw new Error("浏览器文件超过 8 MiB 限制。");
        chunks.push(value);
      }
      return { data: Buffer.concat(chunks, total).toString("base64"), mimeType: response.headers.get("content-type") ?? "application/octet-stream" };
    } finally {
      if (reader) await reader.cancel().finally(() => reader.releaseLock());
    }
  }

  private async controlDialog(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const action = z.enum(["watch", "get", "accept", "dismiss", "stop"]).parse(args.action);
    const contents = await this.ensureContents();
    let watcher = this.dialogWatchers.get(contents.id);
    if (action === "watch" && !watcher) {
      const onMessage = (_event: unknown, method: string, params: unknown): void => {
        const current = this.dialogWatchers.get(contents.id);
        if (!current) return;
        if (method === "Page.javascriptDialogOpening") current.dialog = asRecord(params);
        else if (method === "Page.javascriptDialogClosed") current.dialog = undefined;
      };
      const close = (): void => {
        contents.debugger.off("message", onMessage);
        contents.off("destroyed", close);
        this.dialogWatchers.delete(contents.id);
      };
      watcher = { close };
      this.dialogWatchers.set(contents.id, watcher);
      contents.debugger.on("message", onMessage);
      contents.once("destroyed", close);
      try { await this.sendDebuggerCommand("Page.enable", {}, signal); }
      catch (error) { close(); throw error; }
    }
    if (action === "stop") { watcher?.close(); watcher = undefined; }
    if (action === "accept" || action === "dismiss") {
      await this.sendDebuggerCommand("Page.handleJavaScriptDialog", { accept: action === "accept", promptText: z.string().optional().parse(args.text) }, signal);
      if (watcher) watcher.dialog = undefined;
    }
    return { watching: watcher !== undefined, dialog: watcher?.dialog ?? null };
  }

  private async openInEnvironmentWindow(url: string, environmentId: string): Promise<WebContents> {
    this.requireBrowserEnvironment(environmentId);
    const partition = browserPartitionForEnvironment(environmentId);
    let window = this.environmentWindows.get(environmentId);
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({ width: 1180, height: 820, minWidth: 480, minHeight: 400, title: "Biny 浏览器", show: false,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      this.environmentWindows.set(environmentId, window);
      window.webContents.setWindowOpenHandler(({ url: requested }) => isHttpUrl(requested)
        ? { action: "allow", overrideBrowserWindowOptions: { width: 620, height: 760, webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } } }
        : { action: "deny" });
      window.once("ready-to-show", () => window?.show());
      window.once("closed", () => { if (this.environmentWindows.get(environmentId) === window) this.environmentWindows.delete(environmentId); });
    } else {
      window.show(); window.focus();
    }
    this.automationContents = window.webContents;
    await window.loadURL(url);
    return window.webContents;
  }

  private async pageState(contents?: WebContents): Promise<{ url: string; title: string }> {
    const result = await this.evaluate("({ url: location.href, title: document.title })", undefined, contents);
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

  private async click(selector: string, onAction?: BrowserActionTarget): Promise<unknown> {
    return await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('No visible HTML element matched the selector.');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return { tag: element.tagName.toLowerCase(), text: element.innerText?.trim().slice(0, 200) || '' };
    })()`, undefined, undefined, onAction);
  }

  private async fill(selector: string, value: string, onAction?: BrowserActionTarget): Promise<unknown> {
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
    })()`, undefined, undefined, onAction);
  }

  private async press(selector: string | undefined, key: string, signal?: AbortSignal, contents?: WebContents, onAction?: BrowserActionTarget): Promise<unknown> {
    // UI tab selection is independent of automationTail. Keep this action on its
    // original page without restoring selection over a newer user choice.
    const owner = contents ?? await this.ensureContents();
    if (selector) await this.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error('No visible HTML element matched the selector.'); element.focus(); })()`, signal, owner);
    await this.sendDebuggerCommand("Input.dispatchKeyEvent", { type: "keyDown", key, text: key.length === 1 ? key : undefined }, signal, owner);
    await this.sendDebuggerCommand("Input.dispatchKeyEvent", { type: "keyUp", key }, undefined, owner, onAction);
    return await this.pageState(owner);
  }

  private async evaluate(expression: string, signal?: AbortSignal, contents?: WebContents, onAction?: BrowserActionTarget): Promise<unknown> {
    const result = asRecord(await this.sendDebuggerCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, signal, contents, onAction));
    const exception = asRecord(result.exceptionDetails);
    if (Object.keys(exception).length) throw new Error(typeof exception.text === "string" ? exception.text : "Browser page evaluation failed.");
    const remote = asRecord(result.result);
    return remote.value;
  }

  private async sendDebuggerCommand(method: string, params: Record<string, unknown>, signal?: AbortSignal, owner?: WebContents, onAction?: BrowserActionTarget): Promise<unknown> {
    const contents = await this.ensureContents(owner);
    signal?.throwIfAborted();
    if (contents.isDestroyed()) throw new Error("Browser action page is closed.");
    const debuggerSession = contents.debugger;
    if (!debuggerSession.isAttached()) debuggerSession.attach("1.3");
    signal?.throwIfAborted();
    const result = await debuggerSession.sendCommand(method, params);
    onAction?.(contents);
    return result;
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
      void this.syncToJar().catch(() => undefined);
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
    await run;
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

function isXiaohongshuDomain(domain: string | undefined): boolean {
  const host = domain?.replace(/^\./, "").toLowerCase() ?? "";
  return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
}
