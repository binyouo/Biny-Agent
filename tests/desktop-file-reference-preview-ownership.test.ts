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

for (const outcome of ["success", "failure"] as const) {
  test(`direct file A then B preserves B after late A ${outcome}`, async t => {
    const h = await fixture(t); await h.openFiles(); await h.tree("alpha.txt"); await h.tree("beta.txt");
    assert.deepEqual(h.fileReads.map(({projectId,path}) => ({projectId,path})), [{projectId:"a",path:"alpha.txt"},{projectId:"a",path:"beta.txt"}]);
    if (outcome === "success") await h.resolveFile(0); else await h.rejectFile(0);
    assert.equal(h.path(), "beta.txt"); assert.match(h.preview(), /正在读取文件/);
    await h.resolveFile(1); assert.equal(h.path(), "beta.txt"); assert.match(h.preview(), /Body beta.txt/);
    assert.doesNotMatch(h.preview(), /alpha|obsolete/);
  });
  test(`closed current file stays closed after pending ${outcome}`, async t => {
    const h = await fixture(t); await h.openFiles(); await h.tree("alpha.txt"); await h.click('[aria-label="关闭当前文件"]');
    if (outcome === "success") await h.resolveFile(0); else await h.rejectFile(0);
    assert.equal(h.path(), undefined); assert.match(h.preview(), /选择要预览的文件/);
  });
  test(`workspace switch retires pending direct file ${outcome}`, async t => {
    const h = await fixture(t); await h.openFiles(); await h.tree("alpha.txt");
    await h.emit("onSessionHandoff", {projectId:"b", sessionId:"session-b"}); await h.openFiles(); await h.tree("beta.txt");
    if (outcome === "success") await h.resolveFile(0); else await h.rejectFile(0);
    assert.equal(h.path(), "beta.txt"); assert.match(h.preview(), /正在读取文件/);
    await h.resolveFile(1); assert.match(h.preview(), /Body beta.txt/); assert.equal(h.projectName(), "Project b");
  });
}

test("late reference lookup cannot replace a newer reference preview", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.reference("beta.txt");
  await h.resolveReference(1); await h.resolveFile(0); assert.equal(h.path(), "beta.txt");
  await h.resolveReference(0); if (h.fileReads.length > 1) await h.resolveFile(1);
  assert.equal(h.path(), "beta.txt"); assert.match(h.preview(), /Body beta.txt/);
});

test("late reference lookup cannot replace a newer tree preview", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.openFiles(); await h.tree("beta.txt");
  await h.resolveFile(0); assert.equal(h.path(), "beta.txt");
  await h.resolveReference(0); if (h.fileReads.length > 1) await h.resolveFile(1);
  assert.equal(h.path(), "beta.txt"); assert.match(h.preview(), /Body beta.txt/);
});

test("late reference lookup cannot read its old path under the newly selected project", async t => {
  const h = await fixture(t); await h.reference("alpha.txt");
  await h.emit("onSessionHandoff", {projectId:"b", sessionId:"session-b"});
  await h.resolveReference(0); if (h.fileReads.length) await h.resolveFile(0);
  assert.deepEqual(h.fileReads.map(({projectId,path}) => ({projectId,path})), [], "No stale A path may be sent to B's file reader");
  assert.equal(h.projectName(), "Project b");
});

test("late reference failure cannot warn in the newer project", async t => {
  const h = await fixture(t); await h.reference("alpha.txt");
  await h.emit("onSessionHandoff", {projectId:"b", sessionId:"session-b"}); await h.rejectReference(0);
  assert.doesNotMatch(h.text(), /obsolete reference failure/);
});

test("current reference opens its requested file in the same project", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.resolveReference(0);
  assert.deepEqual(h.fileReads.map(({projectId,path}) => ({projectId,path})), [{projectId:"a",path:"alpha.txt"}]);
  assert.equal(h.path(), "alpha.txt"); assert.match(h.preview(), /正在读取文件/);
  await h.resolveFile(0); assert.match(h.preview(), /Body alpha.txt/);
});

test("current reference rejection remains visible and retry succeeds", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.rejectReference(0);
  assert.match(h.text(), /obsolete reference failure/); assert.equal(h.fileReads.length, 0);
  await h.reference("alpha.txt"); await h.resolveReference(1); await h.resolveFile(0);
  assert.equal(h.path(), "alpha.txt"); assert.match(h.preview(), /Body alpha.txt/);
});

test("closing current file retires an earlier pending reference before it can reopen the preview", async t => {
  const h = await fixture(t); await h.openFiles(); await h.tree("beta.txt"); await h.resolveFile(0);
  await h.reference("alpha.txt"); await h.click('[aria-label="关闭当前文件"]');
  await h.resolveReference(0); if (h.fileReads.length > 1) await h.resolveFile(1);
  assert.equal(h.path(), undefined); assert.match(h.preview(), /选择要预览的文件/);
});

test("current explicit cross-project file reference opens under its requested project", async t => {
  const h = await fixture(t); await h.reference("alpha.txt", "b");
  assert.equal(h.projectName(), "Project b"); await h.resolveReference(0);
  assert.deepEqual(h.fileReads.map(({projectId,path}) => ({projectId,path})), [{projectId:"b",path:"alpha.txt"}]);
  await h.resolveFile(0); assert.equal(h.path(), "alpha.txt"); assert.match(h.preview(), /Body alpha.txt/);
});

for (const outcome of ["success", "failure"] as const) {
  test(`a newer pending reference retains ownership after older ${outcome}`, async t => {
    const h = await fixture(t); await h.reference("alpha.txt"); await h.reference("beta.txt");
    if (outcome === "success") await h.resolveReference(0); else await h.rejectReference(0);
    assert.equal(h.fileReads.length, 0); assert.doesNotMatch(h.text(), /obsolete reference failure/);
    await h.resolveReference(1); assert.deepEqual(h.fileReads.map(item => item.path), ["beta.txt"]);
    assert.match(h.preview(), /正在读取文件/); await h.resolveFile(0); assert.equal(h.path(), "beta.txt");
  });
  test(`project A to B to A does not revive the old file reference ${outcome}`, async t => {
    const h = await fixture(t); await h.reference("alpha.txt");
    await h.emit("onSessionHandoff", {projectId:"b",sessionId:"session-b"});
    await h.emit("onMenuAction", "new-task");
    await h.emit("onSessionHandoff", {projectId:"a",sessionId:"session-a"});
    if (outcome === "success") await h.resolveReference(0); else await h.rejectReference(0);
    assert.equal(h.fileReads.length, 0); assert.doesNotMatch(h.text(), /obsolete reference failure/);
    assert.equal(h.projectName(), "Project a"); assert.match(h.body(), /Discuss a/);
  });
  test(`same-session reload retires an older file reference ${outcome}`, async t => {
    const h = await fixture(t); await h.emit("onSessionHandoff", {projectId:"a",sessionId:"session-a"});
    await h.reference("alpha.txt"); await h.emit("onSessionHandoff", {projectId:"a",sessionId:"session-a"});
    if (outcome === "success") await h.resolveReference(0); else await h.rejectReference(0);
    assert.equal(h.fileReads.length, 0); assert.doesNotMatch(h.text(), /obsolete reference failure/);
  });
  test(`collapse does not reopen the inspector after old reference ${outcome}`, async t => {
    const h = await fixture(t); await h.openFiles(); await h.tree("beta.txt"); await h.resolveFile(0);
    await h.reference("alpha.txt"); await h.click('[aria-label="收起工作区工具"]');
    if (outcome === "success") await h.resolveReference(0); else await h.rejectReference(0);
    assert.equal(h.fileReads.length, 1); assert.doesNotMatch(h.text(), /obsolete reference failure/);
    assert.equal(h.document.querySelector(".desktop-inspector-wrap")?.getAttribute("aria-hidden"), "true");
  });
}

test("a pending newer navigation retires the reference before the destination document commits", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); const next = h.holdRead();
  await h.emit("onSessionHandoff", {projectId:"b",sessionId:"session-b"});
  await h.resolveReference(0); assert.equal(h.fileReads.length, 0);
  await next.resolve("b"); assert.equal(h.projectName(), "Project b");
});

test("reference-dispatched file reads remain retired after a newer pending navigation", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.resolveReference(0);
  const next = h.holdRead(); await h.emit("onSessionHandoff", {projectId:"b",sessionId:"session-b"});
  await h.resolveFile(0); assert.doesNotMatch(h.preview(), /Body alpha.txt/);
  await next.resolve("b"); assert.equal(h.projectName(), "Project b");
});

for (const cancellation of ["tree", "file-close", "collapse"] as const) {
  test(`cross-project reference reservation is retired by ${cancellation} during project selection`, async t => {
    const h = await fixture(t); await h.openFiles(); await h.tree("beta.txt"); await h.resolveFile(0);
    const select = deferred<DesktopWorkspaceSnapshot>(); h.api.selectProject = () => select.promise;
    await h.reference("alpha.txt", "b"); assert.equal(h.references.length, 0);
    if (cancellation === "tree") await h.tree("beta.txt");
    else await h.click(`[aria-label="${cancellation === "file-close" ? "关闭当前文件" : "收起工作区工具"}"]`);
    await h.React.act(async () => select.resolve(workspace("b")));
    assert.equal(h.references.length, 0, "Cancelled request must not start its file lookup after selection");
    assert.equal(h.projectName(), "Project b");
  });
}

test("failed explicit project selection does not resolve or read a file under the old project", async t => {
  const h = await fixture(t); h.api.selectProject = async () => { throw new Error("project unavailable"); };
  await h.reference("alpha.txt", "b"); assert.equal(h.projectName(), "Project a");
  assert.match(h.text(), /project unavailable/); assert.equal(h.references.length, 0); assert.equal(h.fileReads.length, 0);
});

test("a superseded explicit project selection does not resolve its old file", async t => {
  const h = await fixture(t); const select = deferred<DesktopWorkspaceSnapshot>(); h.api.selectProject = () => select.promise;
  await h.reference("alpha.txt", "b"); await h.emit("onMenuAction", "new-task");
  await h.React.act(async () => select.resolve(workspace("b")));
  assert.equal(h.references.length, 0); assert.equal(h.fileReads.length, 0); assert.equal(h.projectName(), "Project a");
});

test("immediate cross-project replies publish the preview after the target scope commits", async t => {
  const h = await fixture(t); const calls: string[] = [];
  h.api.referenceResolve = async (projectId: string, uri: string) => { calls.push(`${projectId}:${uri}`); return {kind:"file", projectId, uri, label:"alpha.txt", content:"alpha.txt"}; };
  h.api.readWorkspaceFile = async (projectId: string, path: string) => { calls.push(`${projectId}:${path}`); return file(path); };
  await h.reference("alpha.txt", "b"); assert.deepEqual(calls, ["b:biny://file/alpha.txt", "b:alpha.txt"]);
  assert.equal(h.projectName(), "Project b"); assert.equal(h.path(), "alpha.txt"); assert.match(h.preview(), /Body alpha.txt/);
});

test("resolved file label remains authoritative for encoded URI paths", async t => {
  const h = await fixture(t); await h.reference("dir/%E6%8A%A5%E5%91%8A.txt");
  await h.resolveReference(0, "dir/报告.txt"); assert.deepEqual(h.fileReads.map(item => item.path), ["dir/报告.txt"]);
  await h.resolveFile(0); assert.equal(h.path(), "dir/报告.txt");
});

test("unmounted App does not start a file read after its pending reference resolves", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.unmount();
  await h.resolveReference(0); assert.equal(h.fileReads.length, 0);
});

test("a retired reference read clears loading after newer navigation fails and direct selection can retry", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.resolveReference(0);
  const next = h.holdRead(); await h.emit("onSessionHandoff", {projectId:"b",sessionId:"session-b"});
  await next.reject(new Error("navigation failed")); await h.resolveFile(0);
  assert.doesNotMatch(h.preview(), /正在读取文件|Body alpha.txt/);
  await h.tree("alpha.txt"); assert.equal(h.fileReads.length, 2); await h.resolveFile(1);
  assert.equal(h.path(), "alpha.txt"); assert.match(h.preview(), /Body alpha.txt/);
});

test("directly selecting the same file can supersede a still-pending retired reference read", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.resolveReference(0);
  const next = h.holdRead(); await h.emit("onSessionHandoff", {projectId:"b",sessionId:"session-b"});
  await next.reject(new Error("navigation failed")); await h.tree("alpha.txt");
  assert.equal(h.fileReads.length, 2); await h.resolveFile(1); await h.rejectFile(0);
  assert.equal(h.path(), "alpha.txt"); assert.match(h.preview(), /Body alpha.txt/); assert.doesNotMatch(h.preview(), /obsolete/);
});

test("a duplicate direct selection owns the existing read independently of the earlier reference", async t => {
  const h = await fixture(t); await h.reference("alpha.txt"); await h.resolveReference(0); await h.tree("alpha.txt");
  assert.equal(h.fileReads.length, 1, "Ordinary same-file selection must still share the in-flight read");
  const next = h.holdRead(); await h.emit("onSessionHandoff", {projectId:"b",sessionId:"session-b"});
  await next.reject(new Error("navigation failed")); await h.resolveFile(0);
  assert.equal(h.path(), "alpha.txt"); assert.match(h.preview(), /Body alpha.txt/);
});

test("a newer explicit reference to current A retires the older pending selection of B", async t => {
  const h = await fixture(t); const select = deferred<DesktopWorkspaceSnapshot>();
  h.api.selectProject = (id: string) => id === "b" ? select.promise : Promise.resolve(workspace(id));
  await h.reference("alpha.txt", "b"); assert.equal(h.references.length, 0);
  await h.reference("beta.txt", "a"); assert.equal(h.references.length, 1);
  await h.resolveReference(0); await h.resolveFile(0);
  assert.equal(h.projectName(), "Project a"); assert.equal(h.path(), "beta.txt");
  await h.React.act(async () => select.resolve(workspace("b")));
  assert.equal(h.references.length, 1, "Old B reference must stay retired");
  assert.equal(h.projectName(), "Project a", "Older reference project selection must not steal the newer explicit A reference");
  assert.equal(h.path(), "beta.txt"); assert.match(h.preview(), /Body beta.txt/);
});
