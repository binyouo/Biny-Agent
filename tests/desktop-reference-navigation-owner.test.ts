import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopWorkspaceFilePreview, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

import type { LocalReferenceResult } from "../src/session/localReferences.js";

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
  const fileReads: Array<{ projectId: string; path: string; gate: ReturnType<typeof deferred<DesktopWorkspaceFilePreview>> }> = [];
  const references: Array<{ projectId: string; uri: string; gate: ReturnType<typeof deferred<LocalReferenceResult>> }> = [];
  const commitments: Array<{ projectId: string; sessionId?: string; activeView: string }> = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        references.forEach(item => item.gate.reject(new Error("audit cleanup")));
        fileReads.forEach(item => item.gate.resolve(file(item.path)));
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
  const window = dom.window; const document = window.document; replace(window, "innerWidth", 1800);
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
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 1800; } });
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
      sidebarWidth: 240, filePanelWidth: 800, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    createEmptyProject(url?: string) { const gate = deferred<DesktopWorkspaceSnapshot | undefined>(); creations.push({ url, gate }); return gate.promise; },
    openProject() { const gate = deferred<DesktopWorkspaceSnapshot | undefined>(); opens.push(gate); return gate.promise; },
    selectProject: async (id: string) => workspace(id),
    startDraft: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string) => { assert.equal(sessionId, session(id).id); return documentFor(id); },
    commitSelection: async (projectId: string, sessionId: string | undefined, activeView: string) => { commitments.push({ projectId, sessionId, activeView }); },
    skillCatalog: async () => ({ skills: [], warnings: [] }), skillSettings: async () => ({ activations: [] }), toolCatalog: async () => [],
    listProjectBranches: async () => [], recipeSuggestions: async () => [], planProjection: async () => ({ plans: [], activePlan: undefined }),
    referenceResolve: (projectId: string, uri: string) => { const gate = deferred<LocalReferenceResult>(); references.push({ projectId, uri, gate }); return gate.promise; },
    readWorkspaceFile: (projectId: string, path: string) => { const gate = deferred<DesktopWorkspaceFilePreview>(); fileReads.push({ projectId, path, gate }); return gate.promise; },
    listWorkspaceDirectory: async (_projectId: string, path: string) => ({ path, entries: ["alpha.txt", "beta.txt"].map(name => ({ name, path: name, kind: "file" })) }),
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
    assert.equal(target.disabled, false, selector);
    assert.equal(target.closest('[hidden], [inert], [aria-hidden="true"]'), null, `${selector} must be reachable`);
    assert.equal(document.querySelectorAll("dialog[open]").length, 0, "No synthetic background clicks through a modal");
    await React.act(async () => target.click());
  };
  const emit = async (name: string, value: DesktopMenuAction | DesktopSessionHandoff): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React, creations, opens, commitments, api, click, emit, fileReads, references,
    async unmount() { await React.act(() => root.unmount()); resources.root = undefined; },
    async openFiles() { await click('.biny-inspector-rail-btn[aria-label="文件"]'); },
    async threadReference(kind: "thread" | "message" | "snippet" = "thread", projectId = "a") {
      const uri = kind === "snippet" ? `biny://snippet/synthetic-${projectId}` : `biny://thread/session-${projectId}${kind === "message" ? "/message/synthetic" : ""}`;
      await React.act(async () => listeners.get("onReferenceOpen")!({ projectId, uri } as never));
    },
    async reference(path: string, projectId = "a") {
      await React.act(async () => listeners.get("onReferenceOpen")!({ projectId, uri: `biny://file/${path}` } as never));
    },
    async resolveReference(index: number, resolvedPath?: string) { const request = references[index]!; const path = resolvedPath ?? request.uri.replace("biny://file/", ""); await React.act(async () => request.gate.resolve({ kind: "file", projectId: request.projectId, uri: request.uri, label: path, content: path })); },
    async rejectReference(index: number) { await React.act(async () => references[index]!.gate.reject(new Error("obsolete reference failure"))); },
    async resolveFile(index: number) { await React.act(async () => fileReads[index]!.gate.resolve(file(fileReads[index]!.path))); },
    async rejectFile(index: number) { await React.act(async () => fileReads[index]!.gate.reject(new Error("obsolete file failure"))); },
    path: () => document.querySelector(".file-browser-path-label")?.textContent,
    preview: () => document.querySelector(".file-browser-content")?.textContent ?? "",
    async tree(path: string) {
      const target = [...document.querySelectorAll<HTMLButtonElement>("[role=treeitem]")].find(row => row.lastElementChild?.textContent === path); assert.ok(target, path);
      assert.equal(target.closest('[hidden], [inert], [aria-hidden="true"]'), null, "File row must be visible");
      await React.act(async () => target.click());
    },
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

function file(path: string): DesktopWorkspaceFilePreview { return { path, content: `Body ${path}`, bytes: 100, binary: false, truncated: false }; }



function resolvedReference(request: { projectId: string; uri: string }, kind: "thread" | "message" | "snippet"): LocalReferenceResult {
  return { kind, projectId: request.projectId, uri: request.uri, threadId: `session-${request.projectId}`, messageId: kind === "thread" ? undefined : "synthetic", label: "Original reference", content: "synthetic" };
}

for (const kind of ["thread", "message", "snippet"] as const) {
  for (const navigation of ["project", "new-task"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      test(`${kind} late ${outcome} cannot replace ${navigation} intent`, async t => {
        const h = await fixture(t);
        await h.threadReference(kind);
        assert.equal(h.references.length, 1);
        if (navigation === "project") await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
        else await h.emit("onMenuAction", "new-task");
        const selected = h.selectedTitle();
        const commitments = h.commitments.length;
        if (outcome === "success") await h.React.act(async () => h.references[0]!.gate.resolve(resolvedReference(h.references[0]!, kind)));
        else await h.rejectReference(0);
        assert.equal(h.projectName(), navigation === "project" ? "Project b" : "Project a");
        assert.equal(h.selectedTitle(), selected);
        assert.equal(h.commitments.length, commitments);
        assert.doesNotMatch(h.text(), /obsolete reference failure/);
      });
    }
  }
  test(`current ${kind} opens normally`, async t => {
    const h = await fixture(t);
    await h.threadReference(kind);
    const count = h.commitments.length;
    await h.React.act(async () => h.references[0]!.gate.resolve(resolvedReference(h.references[0]!, kind)));
    assert.equal(h.projectName(), "Project a");
    assert.ok(h.commitments.length > count);
    assert.match(h.body(), /Discuss a/);
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`newer same-project reference retires old ${outcome} before either navigation`, async t => {
    const h = await fixture(t);
    await h.threadReference();
    await h.threadReference("message");
    const count = h.commitments.length;
    if (outcome === "success") await h.React.act(async () => h.references[0]!.gate.resolve(resolvedReference(h.references[0]!, "thread")));
    else await h.rejectReference(0);
    assert.equal(h.commitments.length, count);
    assert.doesNotMatch(h.text(), /obsolete reference failure/);
    await h.React.act(async () => h.references[1]!.gate.resolve(resolvedReference(h.references[1]!, "message")));
    assert.ok(h.commitments.length > count);
  });
  test(`unmount retires non-file reference ${outcome}`, async t => {
    const h = await fixture(t);
    await h.threadReference();
    await h.unmount();
    const count = h.commitments.length;
    if (outcome === "success") await h.React.act(async () => h.references[0]!.gate.resolve(resolvedReference(h.references[0]!, "thread")));
    else await h.rejectReference(0);
    assert.equal(h.commitments.length, count);
  });
}

test("superseded explicit cross-project selection never dispatches old reference lookup", async t => {
  const h = await fixture(t);
  const selection = deferred<DesktopWorkspaceSnapshot>();
  h.api.selectProject = () => selection.promise;
  await h.threadReference("thread", "b");
  await h.emit("onMenuAction", "new-task");
  await h.React.act(async () => selection.resolve(workspace("b")));
  assert.equal(h.references.length, 0);
  assert.equal(h.projectName(), "Project a");
});

test("current explicit cross-project reference resolves and navigates in its target", async t => {
  const h = await fixture(t);
  await h.threadReference("thread", "b");
  assert.equal(h.references[0]?.projectId, "b");
  await h.React.act(async () => h.references[0]!.gate.resolve(resolvedReference(h.references[0]!, "thread")));
  assert.equal(h.projectName(), "Project b");
  assert.match(h.body(), /Discuss b/);
});

test("explicit current-project reference retires an older cross-project selection", async t => {
  const h = await fixture(t);
  const selection = deferred<DesktopWorkspaceSnapshot>();
  h.api.selectProject = (id: string) => id === "b" ? selection.promise : Promise.resolve(workspace(id));
  await h.threadReference("thread", "b");
  await h.threadReference("thread", "a");
  assert.equal(h.references.length, 1);
  assert.equal(h.references[0]!.projectId, "a");
  await h.React.act(async () => selection.resolve(workspace("b")));
  assert.equal(h.projectName(), "Project a");
  assert.equal(h.references.length, 1);
  await h.React.act(async () => h.references[0]!.gate.resolve(resolvedReference(h.references[0]!, "thread")));
  assert.equal(h.projectName(), "Project a");
});

for (const outcome of ["success", "failure"] as const) {
  test(`reverse completion keeps the newer reference after old ${outcome}`, async t => {
    const h = await fixture(t);
    await h.threadReference();
    await h.threadReference("snippet");
    await h.React.act(async () => h.references[1]!.gate.resolve(resolvedReference(h.references[1]!, "snippet")));
    const count = h.commitments.length;
    if (outcome === "success") await h.React.act(async () => h.references[0]!.gate.resolve(resolvedReference(h.references[0]!, "thread")));
    else await h.rejectReference(0);
    assert.equal(h.commitments.length, count);
    assert.doesNotMatch(h.text(), /obsolete reference failure/);
  });
}

test("current reference failure still reports its warning without navigating", async t => {
  const h = await fixture(t);
  await h.threadReference();
  const count = h.commitments.length;
  await h.rejectReference(0);
  assert.match(h.text(), /obsolete reference failure/);
  assert.equal(h.commitments.length, count);
});

test("failed explicit project selection does not resolve or open the requested reference", async t => {
  const h = await fixture(t);
  h.api.selectProject = async () => { throw new Error("synthetic selection failure"); };
  await h.threadReference("thread", "b");
  assert.equal(h.references.length, 0);
  assert.equal(h.projectName(), "Project a");
  assert.match(h.text(), /synthetic selection failure/);
});

for (const navigate of [false, true]) test(`Markdown deep-link hub ${navigate ? "retires after navigation" : "opens current thread"}`, async t => {
  const h = await fixture(t);
  const { openDeepLink } = await import("../src/desktop/renderer/src/deepLinks.js");
  await h.React.act(async () => openDeepLink("biny://thread/session-a"));
  assert.equal(h.references.length, 1);
  if (navigate) await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  const count = h.commitments.length;
  await h.React.act(async () => h.references[0]!.gate.resolve(resolvedReference(h.references[0]!, "thread")));
  assert.equal(h.projectName(), navigate ? "Project b" : "Project a");
  if (navigate) assert.equal(h.commitments.length, count);
  else assert.ok(h.commitments.length > count);
});
