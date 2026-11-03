import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopRunReceipt, DesktopSlashResult, DesktopSettingsSnapshot, DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

import { defaultConfig } from "../src/config/schema.js";

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
function session(projectId: string, id = `session-${projectId}`): DesktopSessionSummary {
  return { id, projectId, fileName: `${projectId}.jsonl`, title: `Conversation ${projectId}`,
    firstUserMessage: `Discuss ${projectId}`, lastAssistantMessage: "", createdAt: time, updatedAt: time,
    eventCount: 1, pinned: false, status: "completed" };
}
const models = [{ alias: "inert", displayName: "inert", provider: "inert", providerType: "openai-compatible" as const,
  model: "inert", modelKey: "inert/inert", available: true, source: "configured" as const, supportsTools: true,
  efforts: ["high" as const], defaultThinking: "high" as const, thinkingLevelMap: { high: "high" } }];
function workspace(id: string): DesktopWorkspaceSnapshot {
  return { project: project(id), sessions: [session(id)], permissionMode: "ask",
    capabilityDefaults: { tools: "auto", skills: "auto" }, requiresModelConfiguration: false,
    models, pickerModels: models, selectedModel: { modelAlias: "inert", provider: "inert", modelLabel: "inert", thinking: "high", reasoningLabel: "high" }, connections: [] };
}
function documentFor(id: string, sessionId = `session-${id}`): DesktopSessionDocument {
  return { session: session(id, sessionId), events: [{ type: "user_message", content: `Discuss ${id}` }], liveEvents: [] };
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
  const reads: Array<{ projectId: string; sessionId: string; gate: ReturnType<typeof deferred<DesktopSessionDocument>> }> = [];
  const sends: Array<ReturnType<typeof deferred<DesktopRunReceipt>>> = [];
  const slashes: Array<ReturnType<typeof deferred<DesktopSlashResult>>> = [];
  const actions: Array<{ kind: string; projectId: string; sessionId?: string; input: string }> = [];
  const selections: Array<{ id: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const commitments: Array<{ projectId: string; sessionId?: string; activeView: string }> = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        reads.forEach(item => item.gate.resolve(documentFor(item.projectId, item.sessionId)));
        selections.forEach(item => item.gate.resolve(workspace(item.id)));
        sends.forEach(item => item.resolve({ sessionId: "session-a", runId: "inert-run", messageId: "inert-message" }));
        slashes.forEach(item => item.resolve({ command: "/tasks", title: "Inert result", content: "Source action result" }));
        await Promise.allSettled([...reads.map(item => item.gate.promise), ...selections.map(item => item.gate.promise), ...sends.map(item => item.promise), ...slashes.map(item => item.promise)]);
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
    quickChatSettings: async () => ({ autoHideOnBlur: false, clickThrough: false, injectScreenContext: false }),
    settingsSnapshot: async (id: string) => settingsSnapshot(id),
    updateSettingsDraftState: async () => {}, previewAppearance: async () => {},
    applicationImports: async () => ({ sources: [], history: [], sync: { enabled: false, hasSelection: false } }),
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: [project("a"), project("b")],
      sidebarSessions: [session("a"), session("b")], workspace: workspace("a"), activeView: "chat",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    preparePrompt: async (projectId: string) => { assert.ok(["a", "b"].includes(projectId)); },
    sendPrompt(projectId: string, sessionId: string | undefined, input: string) { actions.push({ kind: "send", projectId, sessionId, input }); const gate = deferred<DesktopRunReceipt>(); sends.push(gate); return gate.promise; },
    runSlashCommand(projectId: string, sessionId: string | undefined, input: string) { actions.push({ kind: "slash", projectId, sessionId, input }); const gate = deferred<DesktopSlashResult>(); slashes.push(gate); return gate.promise; },
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
  await React.act(async () => root.render(React.createElement(App)));
  const click = async (selector: string): Promise<void> => {
    const target = document.querySelector<HTMLButtonElement>(selector); assert.ok(target, selector);
    await React.act(async () => target.click());
  };
  const emit = async (name: string, value: DesktopMenuAction | DesktopSessionHandoff): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React, selections, sends, slashes, actions, commitments, api, click, emit,
    async submit(kind: "send" | "slash", input = kind === "send" ? "Source action input" : "/tasks") {
      const textarea = document.querySelector<HTMLTextAreaElement>(".biny-chat-composer textarea"); assert.ok(textarea);
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, input);
        textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await click('button[aria-label="发送消息"]');
    },
    async settleAction(kind: "send" | "slash", id = "a") { await React.act(async () => {
      if (kind === "send") sends[0]!.resolve({ sessionId: `session-${id}`, runId: "inert-run", messageId: "inert-message" });
      else slashes[0]!.resolve({ command: "/tasks", title: "Inert result", content: "Source action result" });
    }); },
    holdSelection() {
      api.selectProject = (id: string) => { const gate = deferred<DesktopWorkspaceSnapshot>(); selections.push({ id, gate }); return gate.promise; };
    },
    async importEntry(id: string) {
      await click(`button[aria-label="Project ${id} 项目操作"]`);
      await React.act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(performance.now())); });
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"]:not([inert]) [role="menuitem"]')].find(item => item.textContent?.includes("导入会话"));
      assert.ok(button, "The production project menu exposes import");
      await React.act(async () => button.click());
    },
    async resolveSelection(index: number) { await React.act(async () => selections[index]!.gate.resolve(workspace(selections[index]!.id))); },
    async rejectSelection(index: number) { await React.act(async () => selections[index]!.gate.reject(new Error("Import project unavailable"))); },
    settingsTitle: () => document.querySelector(".settings-titlebar h2")?.textContent,

    holdRead() {
      const gate = deferred<DesktopSessionDocument>();
      let current: { projectId: string; sessionId: string; gate: typeof gate } | undefined;
      api.openSession = async (projectId: string, sessionId: string) => {
        assert.equal(current, undefined, "One controlled read per hold");
        current = { projectId, sessionId, gate }; reads.push(current); return await gate.promise;
      };
      return {
        async resolve(_id: string) { assert.ok(current); await React.act(async () => gate.resolve(documentFor(current!.projectId, current!.sessionId))); },
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

function settingsSnapshot(projectId: string): DesktopSettingsSnapshot {
  const config = structuredClone(defaultConfig);
  return {
    projectId, hasRunningTasks: false, preferenceRevision: 1, configRevision: "config:1",
    themePreference: "light", fontPreference: { family: "system", size: 14 },
    activity: { ...config.activity, outputDirectory: "/synthetic/activity" }, identity: config.context.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat, toolExecutionMode: config.agent.toolExecutionMode,
    subagent: { enabled: false, runtime: "builtin" }, externalSubagentBlockers: [],
    permission: config.permission, webSearch: config.web.search,
    models: { configured: models, connections: [], embeddingModels: [], defaultModel: "inert", thinking: "high", modelProfiles: {} },
    skills: { projectId, projectKey: projectId, globalDefaults: {}, projectOverrides: {}, activations: [] }
  };
}

test("current cross-project import entry opens the intended project and settings", async t => {
  const h = await fixture(t);
  h.holdSelection(); await h.importEntry("b");
  assert.equal(h.selections.length, 1);
  assert.equal(h.settingsTitle(), undefined);
  await h.resolveSelection(0);
  assert.equal(h.projectName(), "Project b");
  assert.equal(h.settingsTitle(), "导入");
  assert.deepEqual(h.commitments, [{ projectId: "b", sessionId: undefined, activeView: "chat" }]);
});

test("late import entry cannot replace a newer session handoff", async t => {
  const h = await fixture(t);
  h.holdSelection(); await h.importEntry("b");
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  assert.match(h.body(), /Discuss a/u);
  const commits = [...h.commitments];
  await h.resolveSelection(0);
  assert.equal(h.projectName(), "Project a", "Late import-project selection must not take navigation ownership");
  assert.match(h.body(), /Discuss a/u);
  assert.equal(h.settingsTitle(), undefined, "Stale import must not open settings over the newer chat");
  assert.deepEqual(h.commitments, commits);
});

test("late import entry cannot replace the native menu's newer blank task", async t => {
  const h = await fixture(t);
  h.holdSelection(); await h.importEntry("b");
  await h.emit("onMenuAction", "new-task");
  const commits = [...h.commitments];
  await h.resolveSelection(0);
  assert.equal(h.projectName(), "Project a");
  assert.equal(h.settingsTitle(), undefined);
  assert.deepEqual(h.commitments, commits);
});

test("current import entry failure keeps the current conversation and permits retry", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  h.holdSelection(); await h.importEntry("b");
  await h.rejectSelection(0);
  assert.equal(h.projectName(), "Project a");
  assert.match(h.body(), /Discuss a/u);
  assert.match(h.text(), /Import project unavailable/u);
  assert.equal(h.settingsTitle(), undefined);
  await h.importEntry("b"); await h.resolveSelection(1);
  assert.equal(h.projectName(), "Project b");
  assert.equal(h.settingsTitle(), "导入");
});

test("late import failure does not warn over a newer conversation", async t => {
  const h = await fixture(t);
  h.holdSelection(); await h.importEntry("b");
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.rejectSelection(0);
  assert.doesNotMatch(h.text(), /Import project unavailable/u);
  assert.match(h.body(), /Discuss a/u);
});

test("same-project import entry preserves its selected conversation", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  h.holdSelection(); await h.importEntry("a");
  assert.equal(h.selections.length, 0);
  assert.equal(h.settingsTitle(), "导入");
  assert.match(h.body(), /Discuss a/u);
});

for (const outcome of ["pending", "failed"] as const) test(`late import cannot retire a newer ${outcome} handoff`, async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  h.holdSelection(); await h.importEntry("b");
  const read = h.holdRead();
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a-new" });
  if (outcome === "failed") await read.reject(new Error("Newer session unavailable"));
  const commits = [...h.commitments];
  await h.resolveSelection(0);
  assert.equal(h.projectName(), "Project a");
  assert.equal(h.settingsTitle(), undefined);
  assert.deepEqual(h.commitments, commits);
  if (outcome === "pending") {
    assert.equal(h.loading(), "true");
    await read.resolve("a");
    assert.equal(h.loading(), "false");
    assert.match(h.body(), /Discuss a/u);
  } else assert.match(h.text(), /Newer session unavailable/u);
});

test("the latest import entry wins reversed project completions", async t => {
  const h = await fixture(t);
  h.holdSelection(); await h.importEntry("b"); await h.importEntry("b");
  assert.equal(h.selections.length, 2);
  await h.resolveSelection(1);
  assert.equal(h.projectName(), "Project b");
  const commits = [...h.commitments];
  await h.resolveSelection(0);
  assert.deepEqual(h.commitments, commits, "Superseded import must not re-adopt even the same project");
  assert.equal(h.settingsTitle(), "导入");
});

test("same-project import retires an older cross-project import", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  h.holdSelection(); await h.importEntry("b"); await h.importEntry("a");
  assert.equal(h.settingsTitle(), "导入");
  const commits = [...h.commitments];
  await h.resolveSelection(0);
  assert.equal(h.projectName(), "Project a");
  assert.match(h.body(), /Discuss a/u);
  assert.deepEqual(h.commitments, commits);
});

for (const target of ["a", "b"]) test(`import entry ${target} retires an earlier pending handoff`, async t => {
  const h = await fixture(t);
  const read = h.holdRead();
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  assert.equal(h.loading(), "true");
  h.holdSelection(); await h.importEntry(target);
  assert.equal(h.loading(), "false", "New import intent must retire obsolete loading presentation");
  await read.resolve("a");
  assert.equal(h.selectedTitle(), undefined, "Earlier session read cannot adopt after the import intent");
  if (target === "b") await h.resolveSelection(0);
  assert.equal(h.projectName(), `Project ${target}`);
  assert.equal(h.settingsTitle(), "导入");
});

for (const kind of ["send", "slash"] as const) {
  for (const existing of [false, true]) test(`import adoption retires ${kind} dispatched during its wait from ${existing ? "session" : "draft"}`, async t => {
    const h = await fixture(t);
    if (existing) await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    h.holdSelection(); await h.importEntry("b");
    await h.submit(kind);
    assert.deepEqual(h.actions, [{ kind, projectId: "a", sessionId: existing ? "session-a" : undefined, input: kind === "send" ? "Source action input" : "/tasks" }]);
    await h.resolveSelection(0);
    assert.equal(h.projectName(), "Project b");
    const commits = [...h.commitments];
    await h.settleAction(kind);
    assert.equal(h.projectName(), "Project b");
    assert.equal(h.selectedTitle(), undefined);
    assert.doesNotMatch(h.body(), /Source action input|Discuss a/u);
    assert.equal(h.document.querySelector(".slash-result-modal"), null);
    assert.deepEqual(h.commitments, commits);
    assert.equal(h.settingsTitle(), "导入");
  });
  test(`failed import retains the ${kind} dispatched during its wait`, async t => {
    const h = await fixture(t);
    h.holdSelection(); await h.importEntry("b"); await h.submit(kind);
    await h.rejectSelection(0); await h.settleAction(kind);
    assert.equal(h.projectName(), "Project a");
    if (kind === "send") assert.match(h.selectedTitle() ?? "", /Conversation a/u);
    else assert.match(h.document.querySelector(".slash-result-modal")?.textContent ?? "", /Source action result/u);
    assert.equal(h.settingsTitle(), undefined);
    assert.match(h.text(), /Import project unavailable/u);
  });
  test(`import still adopts after the waiting ${kind} settles first`, async t => {
    const h = await fixture(t);
    h.holdSelection(); await h.importEntry("b"); await h.submit(kind); await h.settleAction(kind);
    await h.resolveSelection(0);
    assert.equal(h.projectName(), "Project b");
    assert.equal(h.selectedTitle(), undefined);
    assert.equal(h.settingsTitle(), "导入");
  });
}

test("stale import completion does not retire the newer owner's receipt", async t => {
  const h = await fixture(t);
  h.holdSelection(); await h.importEntry("b");
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.submit("send");
  await h.resolveSelection(0); await h.settleAction("send");
  assert.equal(h.projectName(), "Project a");
  assert.match(h.selectedTitle() ?? "", /Conversation a/u);
  assert.match(h.body(), /Discuss a/u);
  assert.equal(h.settingsTitle(), undefined);
});
