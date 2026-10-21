import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ModelChoice, ModelRuntimeInfo } from "../src/llm/ModelManager.js";
import type { DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopSessionTreePage, DesktopSessionTreePageOptions, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const time = "2026-10-21T00:00:00.000Z";
function project(id: string): DesktopProject {
  return { id, name: `Project ${id}`, path: `/synthetic/${id}`, dirty: false, missing: false,
    pinned: false, addedAt: time, lastOpenedAt: time };
}
function session(projectId: string, index: number, patch: Partial<DesktopSessionSummary> = {}): DesktopSessionSummary {
  const id = `root-${String(index).padStart(3, "0")}`;
  return { id, projectId, fileName: `${id}.jsonl`, title: `${projectId} history ${id}`,
    firstUserMessage: `Message ${projectId} ${id}`, lastAssistantMessage: "", createdAt: time,
    updatedAt: new Date(Date.parse(time) - index * 1000).toISOString(), eventCount: 1,
    pinned: index === 74, archived: index === 70 || index === 74, status: "completed", ...patch };
}
function catalog(id: string): DesktopSessionSummary[] {
  return Array.from({ length: id === "a" ? 75 : 38 }, (_, index) => session(id, index));
}
const models: ModelChoice[] = [{ alias: "inert", displayName: "inert", provider: "inert", providerType: "openai-compatible", model: "inert", modelKey: "inert/inert", available: true, source: "configured", supportsTools: true, efforts: ["high"], defaultThinking: "high", thinkingLevelMap: { off: "none", high: "high" } }];
const model: ModelRuntimeInfo = { modelAlias: "inert", provider: "inert", modelLabel: "inert", thinking: "high", reasoningLabel: "high" };
function page(id: string, rows: DesktopSessionSummary[], nextCursor?: string, revision = "catalog-v1"): DesktopSessionTreePage {
  return { projectId: id, revision, sessions: rows, nextCursor };
}
function workspace(id: string, rows = catalog(id), revision = "catalog-v1"): DesktopWorkspaceSnapshot {
  return { project: project(id), sessions: rows, sessionPage: page(id, rows.slice(0, 32), rows.length > 32 ? `${id}:${revision}:32` : undefined, revision), permissionMode: "ask",
    capabilityDefaults: { tools: "auto", skills: "auto" }, requiresModelConfiguration: false,
    models, pickerModels: models, selectedModel: model, connections: [] };
}
function boot(ids = ["a", "b"], activeId = ids[0]): DesktopBootstrap {
  return { version: "test", platform: "linux", projects: ids.map(project), sidebarSessions: ids.flatMap(id => {
    const rows = catalog(id); return [...rows.slice(0, 32), ...rows.slice(32).filter(row => row.pinned)];
  }), workspace: activeId ? workspace(activeId) : undefined, activeView: "chat",
    sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } };
}
function documentFor(id: string, sessionId: string): DesktopSessionDocument {
  const row = catalog(id).find(item => item.id === sessionId);
  assert.ok(row, `Synthetic catalog contains exact ${id}/${sessionId}`);
  return { session: row, events: [{ type: "user_message", content: row.firstUserMessage }], liveEvents: [] };
}
let frameHost: { request(callback: FrameRequestCallback): number; cancel(id: number): void } | undefined;
let nextFrame = 0;
function requestFrame(callback: FrameRequestCallback): number { assert.ok(frameHost); return frameHost.request(callback); }
function cancelFrame(id: number): void { frameHost?.cancel(id); }

// Complete production App, Sidebar, SearchOverlay and every own view/hook stay real.
// Only IPC, native DOM/layout/assets, and published Xterm ESM entry resolution are adapted.
// All catalogs/documents are synthetic. Unexpected IPC, fetch and sockets fail cleanup.
async function fixture(t: TestContext) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); imports?: ReturnType<typeof registerHooks> } = {};
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const network: string[] = []; const unknown: string[] = [];
  const pages: Array<{ projectId: string; options: DesktopSessionTreePageOptions; gate: ReturnType<typeof deferred<DesktopSessionTreePage>> }> = [];
  const refreshes: Array<{ projectId: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const removals: Array<{ projectId: string; gate: ReturnType<typeof deferred<DesktopBootstrap>> }> = [];
  const opened: Array<{ projectId: string; sessionId: string }> = [];
  const commitments: Array<{ projectId: string; sessionId?: string; activeView: string }> = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false; let mounted = false;
  const unmount = async (): Promise<void> => {
    if (mounted && resources.React) { await resources.React.act(() => resources.root!.unmount()); mounted = false; }
  };
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      // Unmount before settlement so teardown cannot create another pagination request.
      await unmount();
      if (resources.React) await resources.React.act(async () => {
        pages.forEach(item => item.gate.resolve(page(item.projectId, [])));
        refreshes.forEach(item => item.gate.resolve(workspace(item.projectId)));
        removals.forEach(item => item.gate.resolve(boot(["b"])));
        await Promise.allSettled([...pages.map(item => item.gate.promise), ...refreshes.map(item => item.gate.promise), ...removals.map(item => item.gate.promise)]);
      });
    } catch (error) { errors.push(error); }
    try { resources.dom?.window.close(); } catch (error) { errors.push(error); }
    try { if (timersEnabled) t.mock.timers.reset(); } catch (error) { errors.push(error); }
    resources.imports?.deregister(); frames.clear(); frameHost = undefined;
    for (const undo of restore.reverse()) { try { undo(); } catch (error) { errors.push(error); } }
    assert.deepEqual(network, [], "The real renderer must not contact external services");
    assert.deepEqual(unknown, [], "All IPC effects must use explicit inert boundaries");
    if (errors.length) throw new AggregateError(errors, "App fixture cleanup failed");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  resources.imports = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@xterm/xterm") return next("@xterm/xterm/lib/xterm.mjs", context);
      if (specifier === "@xterm/addon-fit") return next("@xterm/addon-fit/lib/addon-fit.mjs", context);
      return next(specifier, context);
    }, load(url, context, next) {
      if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
      return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
    }
  });
  const { JSDOM: DOM } = await import("jsdom");
  const dom = new DOM('<!doctype html><div id="root"></div>', { url: "https://desktop.test", pretendToBeVisual: true });
  resources.dom = dom; const window = dom.window; const document = window.document;
  frameHost = { request(callback) { const id = ++nextFrame; frames.set(id, callback); return id; }, cancel(id) { frames.delete(id); } };
  class LayoutObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({ window, document, self: window, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, SVGElement: window.SVGElement,
    HTMLDialogElement: window.HTMLDialogElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: LayoutObserver,
    CSS: { escape: (value: string) => value, supports: () => false },
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame, IS_REACT_ACT_ENVIRONMENT: true
  })) replace(globalThis, key, value);
  replace(window, "requestAnimationFrame", requestFrame); replace(window, "cancelAnimationFrame", cancelFrame);
  replace(window, "ResizeObserver", LayoutObserver);
  replace(window, "matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
  replace(window.HTMLElement.prototype, "scrollIntoView", () => {}); replace(window.HTMLElement.prototype, "scrollTo", () => {});
  replace(window.HTMLCanvasElement.prototype, "getContext", () => null);
  replace(document, "fonts", { addEventListener() {}, removeEventListener() {} }); replace(window, "scrollTo", () => {});
  replace(window.HTMLDialogElement.prototype, "showModal", function (this: HTMLDialogElement): void { this.open = true; });
  replace(window.HTMLDialogElement.prototype, "close", function (this: HTMLDialogElement): void { this.open = false; });
  t.mock.method(globalThis, "fetch", async () => { network.push("fetch"); throw new Error("Unexpected fetch"); });
  t.mock.method(Socket.prototype, "connect", () => { network.push("socket"); throw new Error("Unexpected socket"); });
  const api: Record<string, unknown> = {
    bootstrap: async () => boot(), selectProject: async (id: string) => workspace(id), startDraft: async (id: string) => workspace(id),
    listSessionTreePage(projectId: string, options: DesktopSessionTreePageOptions) {
      const gate = deferred<DesktopSessionTreePage>(); pages.push({ projectId, options: { ...options }, gate }); return gate.promise;
    },
    refreshProject(projectId: string) { const gate = deferred<DesktopWorkspaceSnapshot>(); refreshes.push({ projectId, gate }); return gate.promise; },
    removeProject(projectId: string) { const gate = deferred<DesktopBootstrap>(); removals.push({ projectId, gate }); return gate.promise; },
    openSession: async (projectId: string, sessionId: string) => { opened.push({ projectId, sessionId }); return documentFor(projectId, sessionId); },
    commitSelection: async (projectId: string, sessionId: string | undefined, activeView: string) => { commitments.push({ projectId, sessionId, activeView }); },
    workspaceFileIndex: async (projectId: string) => ({ projectId, files: [], incomplete: false, scannedAt: time }),
    skillCatalog: async () => ({ skills: [], warnings: [] }), skillSettings: async () => ({ activations: [] }), toolCatalog: async () => [],
    listProjectBranches: async () => [], recipeSuggestions: async () => [], planProjection: async () => ({ plans: [], activePlan: undefined }),
    activitySuggestions: async () => [], setSidebarWidth: async () => {}, setFilePanelWidth: async () => {}
  };
  for (const name of ["onAppearanceChanged", "onApplicationImportsChanged", "onAgentEvent", "onSessionHandoff", "onMenuAction", "onSettingsCloseRequest", "onBrowserOpenRequest", "onReferenceOpen"]) {
    api[name] = (listener: (...args: never[]) => void) => { listeners.set(name, listener); return () => listeners.delete(name); };
  }
  replace(window, "biny", new Proxy(api, { get(target, name: string) {
    if (name in target) return target[name];
    return (..._args: unknown[]) => { unknown.push(name); throw new Error(`Unexpected IPC ${name}`); };
  } }));
  const React = await import("react"); resources.React = React; replace(globalThis, "React", React);
  t.mock.timers.enable({ apis: ["setTimeout"] }); timersEnabled = true;
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/desktop/renderer/src/App.js");
  const root = createRoot(document.getElementById("root")!); resources.root = root; mounted = true;
  await React.act(async () => root.render(React.createElement(App, { settingsEnabled: false })));
  const click = async (target: Element | null | undefined): Promise<void> => {
    assert.ok(Boolean(target), "The requested production control is rendered");
    await React.act(async () => (target as HTMLElement).click());
  };
  const group = (id = "a"): Element => {
    const target = document.querySelector(`.biny-project-row[title="/synthetic/${id}"]`)?.closest(".biny-project-group");
    assert.ok(Boolean(target), `Sidebar contains project ${id}`); return target!;
  };
  const button = (text: string, parent: ParentNode = document): HTMLButtonElement | undefined => [...parent.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text);
  const expand = async (id = "a"): Promise<void> => {
    const row = group(id).querySelector('.biny-project-row')!;
    if (row.getAttribute("aria-expanded") !== "true") await click(row);
    const localMore = button("显示更多", group(id)); if (localMore) await click(localMore);
  };
  const load = async (id = "a"): Promise<void> => {
    await expand(id);
    const more = button("加载更早会话", group(id));
    assert.ok(Boolean(more), `Expanded ${id} history must offer explicit root continuation beyond the first 32 records`);
    await click(more);
  };
  const settle = async (index: number, result: DesktopSessionTreePage): Promise<void> => {
    assert.ok(pages[index], `Root page request ${index} was admitted`);
    await React.act(async () => pages[index]!.gate.resolve(result));
  };
  const emit = async (name: string, value: DesktopMenuAction | DesktopSessionHandoff): Promise<void> => {
    assert.ok(listeners.has(name)); await React.act(async () => listeners.get(name)!(value as never));
  };
  const menu = async (id: string, text: string): Promise<void> => {
    await click(document.querySelector(`button[aria-label="Project ${id} 项目操作"]`));
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === text));
  };
  const refresh = async (snapshot: DesktopWorkspaceSnapshot): Promise<void> => {
    await menu(snapshot.project.id, "刷新项目状态");
    assert.equal(refreshes.at(-1)?.projectId, snapshot.project.id);
    await React.act(async () => refreshes.at(-1)!.gate.resolve(snapshot));
  };
  const search = async (query: string): Promise<void> => {
    await emit("onMenuAction", "search");
    const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索项目、任务或当前项目文件…"]');
    assert.ok(Boolean(input), "Actual SearchOverlay input is mounted");
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input!.dispatchEvent(new window.Event("input", { bubbles: true }));
      t.mock.timers.tick(500);
    });
    await React.act(async () => { t.mock.timers.tick(500); });
  };
  return { document, window, React, pages, refreshes, removals, opened, commitments, listeners,
    click, group, button, expand, load, settle, emit, menu, refresh, search, unmount,
    rowTitles: (id = "a") => [...group(id).querySelectorAll('.biny-sidebar-session-item')].map(row => row.getAttribute("title")),
    selectedTitles: () => [...document.querySelectorAll('.biny-sidebar-session-item[aria-current="page"]')].map(row => row.getAttribute("title")),
    projectName: () => document.querySelector('button[title="选择项目"]')?.textContent,
    searchTitles: () => [...document.querySelectorAll('.command-palette-row strong')].map(row => row.textContent),
    text: () => document.body.textContent ?? ""
  };
}

function assertRootRequest(h: Awaited<ReturnType<typeof fixture>>, index: number, projectId = "a", cursor: string | null = `${projectId}:catalog-v1:32`): void {
  const request = h.pages[index]; assert.ok(request, `Expected admitted root request ${index}`);
  assert.equal(request.projectId, projectId); assert.equal(request.options.parentSessionId, undefined);
  assert.equal(request.options.limit, 32); assert.equal(request.options.includeArchived, true);
  assert.equal(request.options.cursor, cursor ?? undefined);
}
async function loadSecondPage(h: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await h.load(); assertRootRequest(h, 0);
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
}

test("full App control: local expansion and pinned archived shortcut retain exact session identity", async t => {
  const h = await fixture(t); assert.equal(h.projectName(), "Project a");
  assert.equal(h.pages.length, 0); await h.expand();
  assert.equal(h.rowTitles().length, 33); assert.equal(new Set(h.rowTitles()).size, 33);
  assert.ok(h.rowTitles().includes("a history root-074")); assert.ok(!h.rowTitles().includes("a history root-032"));
  assert.equal(h.pages.length, 0, "Local expansion is not an implicit external history request");
  await h.click(h.group().querySelector('.biny-sidebar-session-item[title="a history root-031"]'));
  assert.deepEqual(h.opened, [{ projectId: "a", sessionId: "root-031" }]);
  assert.ok(h.selectedTitles().includes("a history root-031"));
  await h.search("a history root-031");
  assert.ok(h.searchTitles().includes("a history root-031"), "Actual search finds a known loaded record");
});

test("explicit root continuation reaches all 75 records once, including unpinned archived history", async t => {
  const h = await fixture(t); await loadSecondPage(h);
  assert.equal(h.rowTitles().length, 65); assert.ok(h.rowTitles().includes("a history root-063"));
  await h.load(); assertRootRequest(h, 1, "a", "a:catalog-v1:64");
  await h.settle(1, page("a", catalog("a").slice(64)));
  assert.deepEqual(h.rowTitles(), [session("a", 74).title, ...catalog("a").filter(row => !row.pinned).map(row => row.title)]);
  assert.equal(new Set(h.rowTitles()).size, 75); assert.ok(h.rowTitles().includes("a history root-070"));
  assert.equal(Boolean(h.button("加载更早会话", h.group())), false, "Exhausted history offers no phantom continuation");
});

test("newly loaded rows enter real Cmd+K results and open the exact project/session", async t => {
  const h = await fixture(t); await loadSecondPage(h);
  await h.search("a history root-045");
  assert.deepEqual(h.searchTitles(), ["a history root-045"]);
  await h.click([...h.document.querySelectorAll('.command-palette-row')].find(row => row.querySelector('strong')?.textContent === "a history root-045"));
  assert.deepEqual(h.opened, [{ projectId: "a", sessionId: "root-045" }]);
  assert.ok(h.selectedTitles().includes("a history root-045")); assert.equal(h.projectName(), "Project a");
});

test("root continuation never changes an existing selected session or commits navigation", async t => {
  const h = await fixture(t); await h.emit("onSessionHandoff", { projectId: "a", sessionId: "root-003" });
  const before = [...h.commitments]; await loadSecondPage(h);
  assert.ok(h.selectedTitles().includes("a history root-003")); assert.deepEqual(h.commitments, before);
  assert.deepEqual(h.opened, [{ projectId: "a", sessionId: "root-003" }]);
});

test("duplicate same-turn root clicks coalesce and keep pending feedback", async t => {
  const h = await fixture(t); await h.expand(); const more = h.button("加载更早会话", h.group());
  assert.ok(Boolean(more), "The expanded first page needs a continuation control");
  await h.React.act(async () => { more!.click(); more!.click(); });
  assert.equal(h.pages.length, 1); assertRootRequest(h, 0);
  const busy = h.button("加载中…", h.group()); assert.ok(Boolean(busy)); assert.equal(busy!.disabled, true);
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.equal(h.rowTitles().length, 65); assert.equal(h.pages.length, 1);
});

test("a current root failure is visible and the same cursor can be retried", async t => {
  const h = await fixture(t); await h.load();
  await h.React.act(async () => h.pages[0]!.gate.reject(new Error("Synthetic page unavailable")));
  assert.ok(h.group().textContent?.includes("加载失败，请重试。")); assert.equal(h.rowTitles().length, 33);
  await h.load(); assert.equal(h.pages.length, 2); assertRootRequest(h, 1);
  await h.settle(1, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.equal(h.group().textContent?.includes("加载失败，请重试。"), false); assert.equal(h.rowTitles().length, 65);
});

test("invalidated root cursor restarts at current first page and discards stale loaded rows", async t => {
  const h = await fixture(t); await loadSecondPage(h); await h.load(); assertRootRequest(h, 1, "a", "a:catalog-v1:64");
  await h.settle(1, { ...page("a", [], undefined, "catalog-v2"), revisionChanged: true });
  assertRootRequest(h, 2, "a", null); assert.equal(h.pages[2]!.options.includePinnedSessions, true);
  const replacement = catalog("a").slice(0, 32).map(row => row.id === "root-003" ? { ...row, title: "Updated current root" } : row);
  await h.settle(2, { ...page("a", replacement, "a:catalog-v2:32", "catalog-v2"), pinnedSessions: [session("a", 74, { title: "Updated archived pin" })] });
  assert.equal(h.rowTitles().length, 33); assert.ok(h.rowTitles().includes("Updated current root")); assert.ok(h.rowTitles().includes("Updated archived pin"));
  assert.ok(!h.rowTitles().includes("a history root-045"));
  await h.load(); assertRootRequest(h, 3, "a", "a:catalog-v2:32");
});

test("a failed revision restart remains retryable without claiming history is exhausted", async t => {
  const h = await fixture(t); await h.load();
  await h.settle(0, { ...page("a", [], undefined, "catalog-v2"), revisionChanged: true });
  assertRootRequest(h, 1, "a", null);
  await h.React.act(async () => h.pages[1]!.gate.reject(new Error("Restart unavailable")));
  assert.ok(h.group().textContent?.includes("加载失败，请重试。")); assert.equal(h.rowTitles().length, 33);
  await h.load(); assert.equal(h.pages.length, 3); assert.equal(h.pages[2]!.options.parentSessionId, undefined);
});

test("fresh same-project snapshot retires pending root results without resurrecting deleted rows", async t => {
  const h = await fixture(t); await h.load();
  const fresh = catalog("a").filter(row => row.id !== "root-045").map(row => row.id === "root-003" ? { ...row, title: "Fresh title" } : row);
  await h.refresh(workspace("a", fresh, "catalog-v2"));
  await h.settle(0, page("a", catalog("a").slice(32, 64), "obsolete-cursor"));
  assert.ok(h.rowTitles().includes("Fresh title")); assert.ok(!h.rowTitles().includes("a history root-045"));
  assert.ok(!h.rowTitles().includes("a history root-044"), "Retired page must not add even surviving rows");
  assert.equal(h.group().textContent?.includes("加载失败，请重试。"), false, "Retirement is not a current load failure");
  await h.load(); assertRootRequest(h, 1, "a", "a:catalog-v2:32");
});

test("fresh snapshots preserve loaded valid history, update metadata, and remove deleted records", async t => {
  const h = await fixture(t); await loadSecondPage(h);
  const fresh = catalog("a").filter(row => row.id !== "root-045").map(row => row.id === "root-044" ? { ...row, title: "Renamed loaded history" } : row);
  await h.refresh(workspace("a", fresh, "catalog-v2"));
  assert.ok(h.rowTitles().includes("Renamed loaded history")); assert.ok(h.rowTitles().includes("a history root-063"));
  assert.ok(!h.rowTitles().includes("a history root-045")); assert.ok(!h.rowTitles().includes("a history root-064"));
  assert.equal(new Set(h.rowTitles()).size, 64);
  await h.search("Renamed loaded history"); assert.deepEqual(h.searchTitles(), ["Renamed loaded history"]);
});

test("a stale failure cannot clear newer loading state or replace its retry feedback", async t => {
  const h = await fixture(t); await h.load(); await h.refresh(workspace("a", catalog("a"), "catalog-v2"));
  await h.load(); assert.equal(h.pages.length, 2);
  await h.React.act(async () => h.pages[0]!.gate.reject(new Error("Obsolete failure")));
  const busy = h.button("加载中…", h.group()); assert.ok(Boolean(busy)); assert.equal(busy!.disabled, true);
  assert.equal(h.group().textContent?.includes("加载失败，请重试。"), false);
  await h.settle(1, page("a", catalog("a").slice(32, 64), "a:catalog-v2:64", "catalog-v2"));
  assert.equal(h.rowTitles().length, 65);
});

test("unrelated project selection preserves pending root ownership and exact selected identity", async t => {
  const h = await fixture(t); await h.load();
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "root-003" });
  assert.equal(h.projectName(), "Project b"); const before = [...h.commitments];
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.equal(h.projectName(), "Project b"); assert.deepEqual(h.commitments, before);
  assert.ok(h.rowTitles("a").includes("a history root-045")); assert.ok(!h.rowTitles("b").includes("a history root-045"));
  assert.deepEqual(h.opened, [{ projectId: "b", sessionId: "root-003" }]);
  assert.ok(h.selectedTitles().includes("b history root-003"));
});

test("an unrelated project refresh does not retire root pagination for another project", async t => {
  const h = await fixture(t); await h.load(); await h.refresh(workspace("b", catalog("b"), "catalog-b2"));
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.ok(h.rowTitles().includes("a history root-045")); assert.equal(h.projectName(), "Project a");
  await h.load(); assertRootRequest(h, 1, "a", "a:catalog-v1:64");
});

test("inactive project with unknown bootstrap cursor discovers and skips its duplicate first page", async t => {
  const h = await fixture(t); await h.load("b"); assertRootRequest(h, 0, "b", null);
  await h.settle(0, page("b", catalog("b").slice(0, 32), "b:catalog-v1:32"));
  assertRootRequest(h, 1, "b", "b:catalog-v1:32");
  await h.settle(1, page("b", catalog("b").slice(32)));
  assert.deepEqual(h.rowTitles("b"), catalog("b").map(row => row.title));
  assert.equal(h.projectName(), "Project a"); assert.deepEqual(h.opened, []); assert.deepEqual(h.commitments, []);
  assert.equal(Boolean(h.button("加载更早会话", h.group("b"))), false);
});

test("refreshed cursor skips already-loaded pages before admitting older unseen history", async t => {
  const h = await fixture(t); await loadSecondPage(h); await h.refresh(workspace("a", catalog("a"), "catalog-v2"));
  await h.load(); assertRootRequest(h, 1, "a", "a:catalog-v2:32");
  await h.settle(1, page("a", catalog("a").slice(32, 64), "a:catalog-v2:64", "catalog-v2"));
  assertRootRequest(h, 2, "a", "a:catalog-v2:64");
  await h.settle(2, page("a", catalog("a").slice(64), undefined, "catalog-v2"));
  assert.equal(new Set(h.rowTitles()).size, 75); assert.equal(h.rowTitles().length, 75);
});

test("project removal prevents late root pages from reappearing in Sidebar or Cmd+K", async t => {
  const h = await fixture(t); await h.load(); await h.menu("a", "移除项目");
  assert.equal(h.removals[0]?.projectId, "a"); await h.React.act(async () => h.removals[0]!.gate.resolve(boot(["b"])));
  await h.settle(0, page("a", catalog("a").slice(32, 64), "obsolete-cursor"));
  assert.equal(Boolean(h.document.querySelector('.biny-project-row[title="/synthetic/a"]')), false);
  assert.ok(!h.text().includes("a history root-045")); assert.equal(h.projectName(), "Project b");
  await h.search("a history root-045"); assert.deepEqual(h.searchTitles(), []);
});

test("unmount retires a pending invalidation without issuing its first-page restart", async t => {
  const h = await fixture(t); await h.load(); await h.unmount();
  await h.settle(0, { ...page("a", [], undefined, "catalog-v2"), revisionChanged: true });
  assert.equal(h.pages.length, 1); assert.deepEqual(h.opened, []); assert.deepEqual(h.commitments, []);
  assert.equal(h.listeners.size, 0); assert.equal(h.document.getElementById("root")?.childElementCount, 0);
});

test("refresh retains previously visible first-page root displaced by a new session", async t => {
  const h = await fixture(t); await loadSecondPage(h);
  assert.ok(h.rowTitles().includes("a history root-031"));
  const newRoot = session("a", 100, { id: "root-new", title: "New first root", updatedAt: "2026-10-22T00:00:00.000Z" });
  await h.refresh(workspace("a", [newRoot, ...catalog("a")], "catalog-v2"));
  assert.ok(h.rowTitles().includes("a history root-031"), "A known live loaded root must not vanish when shifted out of page 1");
});

test("same-revision refresh during page loading retains continuation cursor", async t => {
  const h = await fixture(t); await loadSecondPage(h); await h.load();
 assertRootRequest(h, 1, "a", "a:catalog-v1:64");
  await h.refresh(workspace("a"));
  await h.load();
 assertRootRequest(h, 2, "a", "a:catalog-v1:64");
});

test("selected injected older root stays selected after root continuation", async t => {
  const h = await fixture(t); await h.emit("onSessionHandoff", {projectId: "a", sessionId: "root-070"});
  await h.expand(); assert.ok(h.selectedTitles().includes("a history root-070"));
  await h.load(); await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.ok(h.selectedTitles().includes("a history root-070"));
});

test("selected injected older root stays selected after snapshot refresh", async t => {
  const h = await fixture(t); await h.emit("onSessionHandoff", {projectId: "a", sessionId: "root-070"});
  await h.expand(); assert.ok(h.selectedTitles().includes("a history root-070"));
  await h.refresh(workspace("a"));
  assert.ok(h.selectedTitles().includes("a history root-070"));
});

test("delivered catalog page enriches injected open-session rows with child navigation", async t => {
  const h = await fixture(t); await h.emit("onSessionHandoff", {projectId:"a", sessionId:"root-045"}); await h.expand();
  const row = () => h.group().querySelector('[title="a history root-045"]')?.closest('.biny-sidebar-session-tree-row');
  assert.equal(Boolean(row()?.querySelector('button[aria-label="展开子会话"]')), false);
  await h.load();
  const enriched = catalog("a").slice(32,64).map(item => item.id === "root-045" ? {...item, hasChildren: true} : item);
  await h.settle(0, page("a", enriched, "a:catalog-v1:64"));
  assert.ok(row()?.querySelector('button[aria-label="展开子会话"]'), "Previously injected session must gain hasChildren from its actual catalog page");
});

test("root restart discards old child pages and allows new expansion", async t => {
  const h = await fixture(t);
  const rootRows = catalog("a").map(item => item.id === "root-003" ? {...item, hasChildren: true} : item);
  await h.refresh(workspace("a", rootRows)); await h.expand();
  const rootRow = () => h.group().querySelector('[title="a history root-003"]')!.closest('.biny-sidebar-session-tree-row')!;
  await h.click(rootRow().querySelector('button[aria-label="展开子会话"]'));
  assert.equal(h.pages[0]!.options.parentSessionId, "root-003");
  const child = session("a",101,{id:"child-001",title:"Old child",parentSessionId:"root-003"});
  await h.settle(0, {...page("a",[child],"children:next"), parentSessionId:"root-003"});
  const more = rootRow().nextElementSibling!.querySelector('button.biny-sidebar-session-expand');
  await h.click(more); assert.equal(h.pages[1]!.options.cursor,"children:next");
  await h.load(); assertRootRequest(h,2);
  await h.settle(2,{...page("a",[],undefined,"catalog-v2"),revisionChanged:true});
 assertRootRequest(h,3,"a",null);
  await h.settle(3,page("a",rootRows.slice(0,32),"a:catalog-v2:32","catalog-v2"));
  assert.ok(!h.rowTitles().includes("Old child"));
  await h.settle(1,{...page("a",[session("a",102,{id:"late-child",title:"Late child",parentSessionId:"root-003"})]),parentSessionId:"root-003"});
  assert.ok(!h.rowTitles().includes("Late child"));
  await h.click(rootRow().querySelector('button[aria-label="展开子会话"]'));
  assert.equal(h.pages[4]!.options.parentSessionId,"root-003");
  assert.equal(h.pages[4]!.options.cursor,undefined);
});

test("unpin refresh removes a shortcut-only row from loaded history", async t => {
  const h = await fixture(t); await h.expand();
  const pinned = () => h.document.querySelector('section[aria-label="置顶"]');
  assert.ok(pinned()?.querySelector('[title="a history root-074"]'));
  const fresh = catalog("a").map(row => row.id === "root-074" ? {...row,pinned:false,archived:false} : row);
  await h.refresh(workspace("a",fresh,"catalog-v2"));
  assert.equal(Boolean(pinned()?.querySelector('[title="a history root-074"]')),false);
  const row = h.group().querySelector('[title="a history root-074"]');
  assert.equal(Boolean(row),false);
});

test("Cmd+K excludes an unloaded older non-pinned root", async t => {
  const h = await fixture(t); await h.search("a history root-070");
  assert.deepEqual(h.searchTitles(),[]); assert.equal(h.pages.length,0);
});

test("all-loaded same-revision refresh does not resurrect root continuation", async t => {
  const h = await fixture(t); await loadSecondPage(h); await h.load();
  await h.settle(1,page("a",catalog("a").slice(64)));
  await h.refresh(workspace("a"));
  assert.equal(Boolean(h.button("加载更早会话",h.group())),false);
  assert.equal(h.rowTitles().length,75);
});

test("repeated root cursor is a retryable visible failure without duplicate rows", async t => {
  const h = await fixture(t); await h.load();
  await h.settle(0,page("a",catalog("a").slice(32,64),"a:catalog-v1:32"));
  assert.ok(h.group().textContent?.includes("加载失败，请重试。"));
  assert.equal(h.rowTitles().length,33); await h.load(); assertRootRequest(h,1);
});

test("root reset does not retire another project's equal-ID child expansion", async t => {
  const h = await fixture(t);
  const rowsB = catalog("b").map(row => row.id === "root-003" ? {...row,hasChildren:true} : row);
  await h.refresh(workspace("b",rowsB)); await h.expand("b");
  const rowB = () => h.group("b").querySelector('[title="b history root-003"]')!.closest('.biny-sidebar-session-tree-row')!;
  await h.click(rowB().querySelector('button[aria-label="展开子会话"]'));
  assert.equal(h.pages[0]!.projectId,"b"); assert.equal(h.pages[0]!.options.parentSessionId,"root-003");
  await h.load("a"); await h.settle(1,{...page("a",[],undefined,"catalog-v2"),revisionChanged:true});
  await h.settle(2,page("a",catalog("a").slice(0,32),"a:catalog-v2:32","catalog-v2"));
  assert.equal(rowB().querySelector('button.biny-sidebar-session-toggle')!.getAttribute('aria-expanded'),"true","Unrelated b child expansion must not close when a is reset");
  const child = session("b",101,{id:"b-child-001",title:"B child",parentSessionId:"root-003"});
  await h.settle(0,{...page("b",[child]),parentSessionId:"root-003"});
  assert.ok(h.rowTitles("b").includes("B child"));
});

test("actually paged pin remains loaded after unpin and uses refreshed archive metadata", async t => {
  const h = await fixture(t); await loadSecondPage(h); await h.load();
  await h.settle(1,page("a",catalog("a").slice(64)));
  const fresh = catalog("a").map(row => row.id === "root-074" || row.id === "root-070" ? {...row,pinned:false,archived:false} : row);
  await h.refresh(workspace("a",fresh,"catalog-v2"));
  assert.equal(h.rowTitles().length,75);
  for (const title of ["a history root-074","a history root-070"]) {
  const row = h.group().querySelector(`[title="${title}"]`); assert.ok(row);
  assert.equal(row!.closest('.biny-sidebar-session-entry')!.classList.contains('is-archived'),false);
  }
  assert.equal(Boolean(h.document.querySelector('section[aria-label="置顶"] [title="a history root-074"]')),false);
});
