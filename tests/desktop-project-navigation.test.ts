import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopAgentEventEnvelope, DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const time = "2026-10-20T00:00:00.000Z";
function project(id: string): DesktopProject {
  return { id, name: `Project ${id}`, path: `/synthetic/${id}`, dirty: false, missing: false,
    pinned: false, addedAt: time, lastOpenedAt: time };
}
function session(projectId: string): DesktopSessionSummary {
  return { id: `session-${projectId}`, projectId, fileName: `${projectId}.jsonl`, title: `Conversation ${projectId}`,
    firstUserMessage: `Discuss ${projectId}`, lastAssistantMessage: "", createdAt: time, updatedAt: time,
    eventCount: 1, pinned: false, status: "completed" };
}
function workspace(id: string): DesktopWorkspaceSnapshot {
  return { project: project(id), sessions: [session(id)], permissionMode: "ask",
    capabilityDefaults: { tools: "auto", skills: "auto" }, requiresModelConfiguration: false,
    models: [], pickerModels: [], connections: [] };
}
function documentFor(id: string): DesktopSessionDocument {
  return { session: session(id), events: [{ type: "user_message", content: `Discuss ${id}` }], liveEvents: [] };
}
let frameHost: { request(callback: FrameRequestCallback): number; cancel(id: number): void } | undefined;
let nextFrame = 0;
function requestFrame(callback: FrameRequestCallback): number {
  assert.ok(frameHost, "Animation frames require a live fixture");
  return frameHost.request(callback);
}
function cancelFrame(id: number): void { frameHost?.cancel(id); }

// Mount the complete production App and its own views/hooks. Only IPC, native
// DOM facilities, assets and the dependency ESM entry resolution are adapted.
// The callbacks below are the real App subscriptions, not extracted handlers.
async function fixture(t: TestContext) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); imports?: ReturnType<typeof registerHooks> } = {};
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const network: string[] = [];
  const unknown: string[] = [];
  const creations: Array<{ url?: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot | undefined>> }> = [];
  const opens: Array<ReturnType<typeof deferred<DesktopWorkspaceSnapshot | undefined>>> = [];
  const reads: Array<ReturnType<typeof deferred<DesktopSessionDocument>>> = [];
  const commitments: Array<{ projectId: string; sessionId?: string; activeView: string }> = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        creations.forEach(item => item.gate.resolve(undefined)); opens.forEach(item => item.resolve(undefined));
        reads.forEach(item => item.resolve(documentFor("b")));
        await Promise.allSettled([...creations.map(item => item.gate.promise), ...opens.map(item => item.promise), ...reads.map(item => item.promise)]);
      });
    } catch (error) { errors.push(error); }
    try { if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount()); }
    catch (error) { errors.push(error); }
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
    // Use the same published ESM distributions selected by the renderer bundler.
    resolve(specifier, context, next) {
      if (specifier === "@xterm/xterm") return next("@xterm/xterm/lib/xterm.mjs", context);
      if (specifier === "@xterm/addon-fit") return next("@xterm/addon-fit/lib/addon-fit.mjs", context);
      return next(specifier, context);
    }, load(url, context, next) {
    if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM: DOM } = await import("jsdom");
  const dom = new DOM('<!doctype html><div id="root"></div>', { url: "https://desktop.test", pretendToBeVisual: true });
  resources.dom = dom;
  const window = dom.window; const document = window.document;
  frameHost = { request(callback) { const id = ++nextFrame; frames.set(id, callback); return id; }, cancel(id) { frames.delete(id); } };
  class LayoutObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({
    window, document, self: window, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
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
  replace(window.HTMLElement.prototype, "scrollIntoView", () => {});
  replace(window.HTMLElement.prototype, "scrollTo", () => {});
  replace(window.HTMLCanvasElement.prototype, "getContext", () => null);
  replace(document, "fonts", { addEventListener() {}, removeEventListener() {} });
  replace(window, "scrollTo", () => {});
  replace(window.HTMLDialogElement.prototype, "showModal", function (this: HTMLDialogElement): void { this.open = true; });
  replace(window.HTMLDialogElement.prototype, "close", function (this: HTMLDialogElement): void { this.open = false; });
  t.mock.method(globalThis, "fetch", async () => { network.push("fetch"); throw new Error("Unexpected fetch"); });
  t.mock.method(Socket.prototype, "connect", () => { network.push("socket"); throw new Error("Unexpected socket"); });
  const api: Record<string, unknown> = {
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: [project("a"), project("b")],
      sidebarSessions: [session("a"), session("b")], workspace: workspace("a"), activeView: "chat",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    createEmptyProject(url?: string) { const gate = deferred<DesktopWorkspaceSnapshot | undefined>(); creations.push({ url, gate }); return gate.promise; },
    openProject() { const gate = deferred<DesktopWorkspaceSnapshot | undefined>(); opens.push(gate); return gate.promise; },
    selectProject: async (id: string) => workspace(id),
    startDraft: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string) => { assert.equal(sessionId, session(id).id); return documentFor(id); },
    commitSelection: async (projectId: string, sessionId: string | undefined, activeView: string) => { commitments.push({ projectId, sessionId, activeView }); },
    skillCatalog: async () => ({ skills: [], warnings: [] }), skillSettings: async () => ({ activations: [] }), toolCatalog: async () => [],
    listProjectBranches: async () => [], recipeSuggestions: async () => [], planProjection: async () => ({ plans: [], activePlan: undefined }),
    activitySuggestions: async () => [],
    setSidebarWidth: async () => {}, setFilePanelWidth: async () => {}
  };
  for (const name of ["onAppearanceChanged", "onApplicationImportsChanged", "onAgentEvent", "onSessionHandoff", "onMenuAction",
    "onSettingsCloseRequest", "onBrowserOpenRequest", "onReferenceOpen"]) {
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
  const root = createRoot(document.getElementById("root")!); resources.root = root;
  await React.act(async () => root.render(React.createElement(App, { settingsEnabled: false })));
  const click = async (selector: string): Promise<void> => {
    const target = document.querySelector<HTMLButtonElement>(selector); assert.ok(target, selector);
    await React.act(async () => target.click());
  };
  const emit = async (name: string, value: DesktopAgentEventEnvelope | DesktopMenuAction | DesktopSessionHandoff): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React, creations, opens, commitments, api, click, emit,
    async create(url?: string) {
      await click('button[title="选择项目"]');
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.includes("新建项目"));
      assert.ok(item);
      await React.act(async () => item.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
      const form = document.querySelector('dialog[open][aria-label="新建项目"] form'); assert.ok(form);
      if (url) await React.act(async () => {
        const input = form.querySelector("input")!;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, url);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await React.act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
      assert.equal(document.querySelector<HTMLInputElement>('dialog[open] input')?.disabled, true);
    },
    async resolveCreate(index: number, value: DesktopWorkspaceSnapshot | undefined) {
      await React.act(async () => { creations[index]!.gate.resolve(value); await creations[index]!.gate.promise; });
    },
    async resolveOpen(index: number, value: DesktopWorkspaceSnapshot | undefined) {
      await React.act(async () => { opens[index]!.resolve(value); await opens[index]!.promise; });
    },
    async rejectOpen(index: number, error: Error) { await React.act(async () => opens[index]!.reject(error)); },
    async rejectCreate(index: number, error: Error) { await React.act(async () => creations[index]!.gate.reject(error)); },
    holdRead() {
      const gate = deferred<DesktopSessionDocument>(); reads.push(gate);
      api.openSession = async () => await gate.promise;
      return {
        async resolve(id: string) { await React.act(async () => gate.resolve(documentFor(id))); },
        async reject(error: Error) { await React.act(async () => gate.reject(error)); }
      };
    },
    selectedTitle: () => document.querySelector(".biny-sidebar-session-entry.is-selected")?.textContent,
    body: () => document.querySelector(".biny-chat-body")?.textContent ?? "",
    loading: () => document.querySelector('.biny-chat-composer')?.getAttribute("aria-busy"),
    projectName: () => document.querySelector('button[title="选择项目"]')?.textContent,
    text: () => document.body.textContent ?? ""
  };
}

test("new project completion preserves a newer session handoff", async t => {
  const h = await fixture(t);
  assert.equal(h.projectName(), "Project a");
  await h.create("https://created.example");
  assert.equal(h.creations.length, 1);
  assert.equal(h.creations[0]!.url, "https://created.example");
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  assert.equal(h.projectName(), "Project b");
  assert.match(h.body(), /Discuss b/u);
  await h.resolveCreate(0, workspace("created"));
  assert.equal(h.projectName(), "Project b", "A completed create must not replace a later handoff");
  assert.match(h.body(), /Discuss b/u);
  assert.deepEqual(h.commitments, [{ projectId: "b", sessionId: "session-b", activeView: "chat" }]);
});


test("new project completion preserves the native menu's newer blank task", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.create();
  await h.emit("onMenuAction", "new-task");
  const commits = [...h.commitments];
  await h.resolveCreate(0, workspace("created"));
  assert.equal(h.projectName(), "Project a");
  assert.equal(h.selectedTitle(), undefined);
  assert.deepEqual(h.commitments, commits, "No obsolete creation selection may be persisted");
  assert.equal(h.document.querySelector('dialog[open][aria-label="新建项目"]'), null);
  assert.match(h.text(), /Project created/u, "The successfully created directory remains discoverable");
});

for (const operation of ["create", "open"] as const) {
  test(`${operation} completion cannot replace a newer handoff that is still loading`, async t => {
    const h = await fixture(t);
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    if (operation === "create") await h.create(); else await h.emit("onMenuAction", "open-project");
    const read = h.holdRead();
    await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
    assert.equal(h.loading(), "true");
    assert.match(h.selectedTitle() ?? "", /Conversation b/u);
    const commits = [...h.commitments];
    if (operation === "create") await h.resolveCreate(0, workspace("created")); else await h.resolveOpen(0, workspace("opened"));
    assert.equal(h.loading(), "true", "The newer pending read retains its loading state");
    assert.match(h.selectedTitle() ?? "", /Conversation b/u);
    assert.deepEqual(h.commitments, commits);
    await read.resolve("b");
    assert.equal(h.projectName(), "Project b");
    assert.match(h.body(), /Discuss b/u);
    assert.equal(h.loading(), "false");
    assert.equal(h.commitments.at(-1)?.sessionId, "session-b");
    assert.match(h.text(), operation === "create" ? /Project created/u : /Project opened/u);
  });

  test(`${operation} completion cannot revive after the newer navigation fails`, async t => {
    const h = await fixture(t);
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    if (operation === "create") await h.create(); else await h.emit("onMenuAction", "open-project");
    const read = h.holdRead();
    await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
    await read.reject(new Error("Newer history unavailable"));
    if (operation === "create") await h.resolveCreate(0, workspace("created")); else await h.resolveOpen(0, workspace("opened"));
    assert.equal(h.projectName(), "Project a");
    assert.match(h.body(), /Discuss a/u);
    assert.match(h.text(), /Newer history unavailable/u);
    assert.deepEqual(h.commitments, [{ projectId: "a", sessionId: "session-a", activeView: "chat" }]);
  });

  test(`${operation} currently owned success adopts its workspace exactly once`, async t => {
    const h = await fixture(t);
    if (operation === "create") await h.create(); else await h.emit("onMenuAction", "open-project");
    if (operation === "create") await h.resolveCreate(0, workspace("new")); else await h.resolveOpen(0, workspace("new"));
    assert.equal(h.projectName(), "Project new");
    assert.equal(h.selectedTitle(), undefined);
    assert.deepEqual(h.commitments, [{ projectId: "new", sessionId: undefined, activeView: "chat" }]);
    assert.equal(h.document.querySelector('dialog[open][aria-label="新建项目"]'), null);
  });

  test(`${operation} cancellation preserves the loaded conversation without a selection write`, async t => {
    const h = await fixture(t);
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    if (operation === "create") await h.create(); else await h.emit("onMenuAction", "open-project");
    if (operation === "create") await h.resolveCreate(0, undefined); else await h.resolveOpen(0, undefined);
    assert.equal(h.projectName(), "Project a");
    assert.match(h.body(), /Discuss a/u);
    assert.deepEqual(h.commitments, [{ projectId: "a", sessionId: "session-a", activeView: "chat" }]);
    assert.equal(h.document.querySelector('dialog[open][aria-label="新建项目"]'), null);
  });
}

test("opening projects out of order honors the latest menu invocation, not latest response", async t => {
  const h = await fixture(t);
  await h.emit("onMenuAction", "open-project");
  await h.emit("onMenuAction", "open-project");
  await h.resolveOpen(1, workspace("newer"));
  await h.resolveOpen(0, workspace("older"));
  assert.equal(h.projectName(), "Project newer");
  assert.deepEqual(h.commitments, [{ projectId: "newer", sessionId: undefined, activeView: "chat" }]);
  assert.match(h.text(), /Project older/u, "A successful older import remains in the project catalog");
});

test("a newer cancelled open request retires the older creation intent", async t => {
  const h = await fixture(t);
  await h.create();
  await h.emit("onMenuAction", "open-project");
  await h.resolveOpen(0, undefined);
  await h.resolveCreate(0, workspace("created"));
  assert.equal(h.projectName(), "Project a");
  assert.deepEqual([...h.commitments], []);
  assert.match(h.text(), /Project created/u);
});

test("a newer create intent retires an older open while preserving failed creation retry", async t => {
  const h = await fixture(t);
  await h.emit("onMenuAction", "open-project");
  await h.create("https://created.example");
  await h.rejectCreate(0, new Error("Directory already exists"));
  await h.resolveOpen(0, workspace("older"));
  assert.equal(h.projectName(), "Project a");
  assert.deepEqual([...h.commitments], []);
  const dialog = h.document.querySelector('dialog[open][aria-label="新建项目"]')!;
  assert.match(dialog.textContent ?? "", /Directory already exists/u);
  assert.equal(dialog.querySelector<HTMLInputElement>("input")?.disabled, false);
  await h.React.act(async () => dialog.querySelector("form")!.dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true })));
  await h.resolveCreate(1, workspace("retried"));
  assert.equal(h.projectName(), "Project retried");
  assert.equal(h.commitments.at(-1)?.projectId, "retried");
});

test("a stale open snapshot cannot replace a newer session in that same project", async t => {
  const h = await fixture(t);
  await h.emit("onMenuAction", "open-project");
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  const obsolete = workspace("b"); obsolete.project.name = "Obsolete B"; obsolete.sessions = [];
  await h.resolveOpen(0, obsolete);
  assert.equal(h.projectName(), "Project b");
  assert.match(h.body(), /Discuss b/u);
  assert.match(h.selectedTitle() ?? "", /Conversation b/u);
  assert.deepEqual(h.commitments, [{ projectId: "b", sessionId: "session-b", activeView: "chat" }]);
});

test("stale open errors do not replace newer navigation feedback", async t => {
  const h = await fixture(t);
  await h.emit("onMenuAction", "open-project");
  const read = h.holdRead();
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  await read.reject(new Error("Newer history unavailable"));
  await h.rejectOpen(0, new Error("Obsolete folder error"));
  assert.match(h.text(), /Newer history unavailable/u);
  assert.doesNotMatch(h.text(), /Obsolete folder error/u);
});

test("current open errors remain visible and permit another menu attempt", async t => {
  const h = await fixture(t);
  await h.emit("onMenuAction", "open-project");
  await h.rejectOpen(0, new Error("Current folder unavailable"));
  assert.match(h.text(), /Current folder unavailable/u);
  await h.emit("onMenuAction", "open-project");
  await h.resolveOpen(1, workspace("retry"));
  assert.equal(h.projectName(), "Project retry");
  assert.deepEqual(h.commitments, [{ projectId: "retry", sessionId: undefined, activeView: "chat" }]);
});

test("canceling a newer native open clears the superseded read without reviving it", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  const read = h.holdRead();
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  assert.equal(h.loading(), "true");
  await h.emit("onMenuAction", "open-project");
  await h.resolveOpen(0, undefined);
  assert.equal(h.loading(), "false", "Cancelled replacement must not strand the old loading indicator");
  assert.match(h.selectedTitle() ?? "", /Conversation a/u);
  await read.resolve("b");
  assert.equal(h.projectName(), "Project a");
  assert.match(h.body(), /Discuss a/u);
  assert.deepEqual(h.commitments, [{ projectId: "a", sessionId: "session-a", activeView: "chat" }]);
});

for (const operation of ["create", "open"] as const) {
  test(`stale ${operation} cancellation does not clear a newer loading handoff`, async t => {
    const h = await fixture(t);
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    if (operation === "create") await h.create(); else await h.emit("onMenuAction", "open-project");
    const read = h.holdRead();
    await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
    if (operation === "create") await h.resolveCreate(0, undefined); else await h.resolveOpen(0, undefined);
    assert.equal(h.loading(), "true");
    assert.match(h.selectedTitle() ?? "", /Conversation b/u);
    await read.resolve("b");
    assert.equal(h.projectName(), "Project b");
    assert.match(h.body(), /Discuss b/u);
    assert.deepEqual(h.commitments, [
      { projectId: "a", sessionId: "session-a", activeView: "chat" },
      { projectId: "b", sessionId: "session-b", activeView: "chat" }
    ]);
  });
}

test("stale creation failure stays local to its dialog and preserves the newer handoff", async t => {
  const h = await fixture(t);
  await h.create("https://created.example");
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  await h.rejectCreate(0, new Error("Directory already exists"));
  assert.equal(h.projectName(), "Project b");
  assert.match(h.body(), /Discuss b/u);
  const dialog = h.document.querySelector('dialog[open][aria-label="新建项目"]')!;
  assert.match(dialog.textContent ?? "", /Directory already exists/u);
  assert.equal(dialog.querySelector<HTMLInputElement>("input")?.value, "https://created.example");
  assert.equal(dialog.querySelector<HTMLInputElement>("input")?.disabled, false);
  assert.deepEqual(h.commitments, [{ projectId: "b", sessionId: "session-b", activeView: "chat" }]);
});

for (const [action, state] of [["忽略此提示", "dismissed"], ["提取", "extracted"]] as const) {
  test(`recipe ${state} survives a late history response and resets on session change`, async t => {
    const h = await fixture(t);
    const history = deferred<Array<{ id: "repeatable-doc-task"; title: string; description: string; slots: []; extractPrompt: string }>>();
    const recipe = { id: "repeatable-doc-task" as const, title: "Recipe", description: "", slots: [] as [], extractPrompt: "Extract" };
    const saved: unknown[][] = [];
    h.api.recipeSuggestions = async (projectId: string) => projectId === "a" ? history.promise : [recipe];
    h.api.setRecipeState = async (...args: unknown[]) => { saved.push(args); };
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    await h.emit("onAgentEvent", { projectId: "a", event: { type: "recipe.ready", sessionId: "session-a", runId: "run", timestamp: time, recipe } });
    await h.React.act(async () => t.mock.timers.tick(16));
    assert.ok(h.document.querySelector(".biny-recipe-ready-banner"));
    const button = [...h.document.querySelectorAll<HTMLButtonElement>(".biny-recipe-ready-banner button")].find(item => item.getAttribute("aria-label") === action || item.textContent === action);
    assert.ok(button);
    await h.React.act(async () => button.click());
    assert.deepEqual(saved, [["a", "session-a", recipe.id, state]]);
    await h.React.act(async () => history.resolve([recipe]));
    assert.equal(Boolean(h.document.querySelector(".biny-recipe-ready-banner")), false);
    await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
    assert.ok(h.document.querySelector(".biny-recipe-ready-banner"), "The same recipe remains available in another session");
  });
}
