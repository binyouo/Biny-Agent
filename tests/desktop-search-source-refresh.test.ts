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
  const scans: string[] = [];
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
    workspaceFileIndex: async (projectId: string) => { scans.push(projectId); return { projectId, files: [], incomplete: false, scannedAt: time }; },
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
  return { document, window, React, pages, refreshes, removals, opened, commitments, listeners, scans,
    click, group, button, expand, load, settle, emit, menu, refresh, search, unmount,
    rowTitles: (id = "a") => [...group(id).querySelectorAll('.biny-sidebar-session-item')].map(row => row.getAttribute("title")),
    selectedTitles: () => [...document.querySelectorAll('.biny-sidebar-session-item[aria-current="page"]')].map(row => row.getAttribute("title")),
    projectName: () => document.querySelector('button[title="选择项目"]')?.textContent,
    searchTitles: () => [...document.querySelectorAll('.command-palette-row strong')].map(row => row.textContent),
    text: () => document.body.textContent ?? ""
  };
}

function paletteInput(h: Awaited<ReturnType<typeof fixture>>): HTMLInputElement {
  const input = h.document.querySelector<HTMLInputElement>('input[placeholder="搜索项目、任务或当前项目文件…"]');
  assert.ok(input); return input;
}

test("live root search: pending page refreshes the unchanged query and opens its exact row", async t => {
  const h = await fixture(t); await h.load(); await h.search("a history root-045");
  assert.deepEqual(h.searchTitles(), []);
  const input = paletteInput(h); input.focus(); input.setSelectionRange(2, 5);
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.ok(h.rowTitles().includes("a history root-045"));
  assert.deepEqual(h.searchTitles(), ["a history root-045"]);
  assert.equal(paletteInput(h), input); assert.equal(h.document.activeElement, input);
  assert.equal(input.value, "a history root-045"); assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5]);
  assert.deepEqual(h.scans, ["a"]); assert.deepEqual(h.opened, []);
  await h.click(h.document.querySelector('.command-palette-row'));
  assert.deepEqual(h.opened, [{ projectId: "a", sessionId: "root-045" }]);
});

test("live root search: newest typed query wins across consecutive page deliveries", async t => {
  const h = await fixture(t); await h.load(); await h.search("a history root-045");
  await h.search("a history root-070");
  const input = paletteInput(h);
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.deepEqual(h.searchTitles(), []);
  await h.load(); await h.settle(1, page("a", catalog("a").slice(64)));
  assert.deepEqual(h.searchTitles(), ["a history root-070"]);
  assert.equal(paletteInput(h), input); assert.equal(input.value, "a history root-070");
  assert.deepEqual(h.scans, ["a"]); assert.deepEqual(h.opened, []);
});

test("live root search: loaded-row rename and deletion update current results", async t => {
  const h = await fixture(t); await h.load();
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  await h.search("a history root-045");
  const renamed = catalog("a").map(row => row.id === "root-045" ? { ...row, title: "a history root-045 renamed" } : row);
  await h.refresh(workspace("a", renamed, "catalog-v2"));
  assert.deepEqual(h.searchTitles(), ["a history root-045 renamed"]);
  await h.refresh(workspace("a", renamed.filter(row => row.id !== "root-045"), "catalog-v3"));
  assert.deepEqual(h.searchTitles(), []); assert.equal(paletteInput(h).value, "a history root-045");
  assert.deepEqual(h.scans, ["a"]); assert.deepEqual(h.opened, []);
});

test("live root search: empty bootstrap gains delivered rows without loading unrequested history", async t => {
  const h = await fixture(t); await h.load(); await h.search("");
  assert.ok(!h.searchTitles().includes("a history root-045"));
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.ok(h.searchTitles().includes("a history root-045"));
  assert.ok(!h.searchTitles().includes("a history root-070"));
  assert.equal(paletteInput(h).value, ""); assert.equal(h.pages.length, 1); assert.deepEqual(h.scans, ["a"]);
});

test("live root search: closed palette stays closed and reopen uses delivered history", async t => {
  const h = await fixture(t); await h.load(); await h.search("a history root-045");
  await h.React.act(async () => paletteInput(h).dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.equal(h.document.querySelector('dialog[open]'), null); assert.deepEqual(h.scans, ["a"]);
  await h.search("a history root-045"); assert.deepEqual(h.searchTitles(), ["a history root-045"]);
  assert.deepEqual(h.scans, ["a", "a"]); assert.deepEqual(h.opened, []);
});

test("live root search: stale refresh-invalidated page cannot repopulate current results", async t => {
  const h = await fixture(t); await h.load(); await h.search("a history root-045");
  await h.refresh(workspace("a", catalog("a"), "catalog-v2"));
  await h.settle(0, page("a", catalog("a").slice(32, 64), "a:catalog-v1:64"));
  assert.deepEqual(h.searchTitles(), []); assert.ok(!h.rowTitles().includes("a history root-045"));
  assert.equal(paletteInput(h).value, "a history root-045"); assert.deepEqual(h.scans, ["a"]);
});
