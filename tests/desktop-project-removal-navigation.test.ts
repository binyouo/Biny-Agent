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
async function fixture(t: TestContext, ids = ["a", "b", "c"]) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); imports?: ReturnType<typeof registerHooks> } = {};
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const network: string[] = [];
  const unknown: string[] = [];
  const reads: Array<{ projectId: string; sessionId: string; gate: ReturnType<typeof deferred<DesktopSessionDocument>> }> = [];
  const sends: Array<ReturnType<typeof deferred<DesktopRunReceipt>>> = [];
  const slashes: Array<ReturnType<typeof deferred<DesktopSlashResult>>> = [];
  const actions: Array<{ kind: string; projectId: string; sessionId?: string; input: string }> = [];
  const removals: Array<{ id: string; gate: ReturnType<typeof deferred<DesktopBootstrap>> }> = [];
  const selections: Array<{ id: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const commitments: Array<{ projectId: string; sessionId?: string; activeView: string }> = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        removals.forEach(item => item.gate.resolve(bootstrapFor(ids.filter(id => id !== item.id))));
        reads.forEach(item => item.gate.resolve(documentFor(item.projectId, item.sessionId)));
        selections.forEach(item => item.gate.resolve(workspace(item.id)));
        sends.forEach(item => item.resolve({ sessionId: "session-a", runId: "inert-run", messageId: "inert-message" }));
        slashes.forEach(item => item.resolve({ command: "/tasks", title: "Inert result", content: "Source action result" }));
        await Promise.allSettled([...removals.map(item => item.gate.promise), ...reads.map(item => item.gate.promise), ...selections.map(item => item.gate.promise), ...sends.map(item => item.promise), ...slashes.map(item => item.promise)]);
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
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: ids.map(project),
      sidebarSessions: ids.map(id => session(id)), workspace: workspace("a"), activeView: "chat",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    removeProject: (id: string) => { const gate = deferred<DesktopBootstrap>(); removals.push({ id, gate }); return gate.promise; },
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
  const emit = async (name: string, value: DesktopMenuAction | DesktopSessionHandoff | { uri: string; projectId?: string }): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React, removals, selections, sends, slashes, actions, commitments, api, click, emit,
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
    async chooseProject(id: string) {
      await click('button[title="选择项目"]');
      await React.act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(performance.now())); });
      const button = [...document.querySelectorAll<HTMLButtonElement>('.biny-workspace-context-menu [role="menuitemradio"]')].find(item => item.textContent?.includes(`Project ${id}`));
      assert.ok(button, `Project ${id} option`);
      await React.act(async () => button.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })));
    },
    async menuEntry(id: string, label: string) {
      await click(`button[aria-label="Project ${id} 项目操作"]`);
      await React.act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(performance.now())); });
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"]:not([inert]) [role="menuitem"]')].find(item => item.textContent?.includes(label));
      assert.ok(button, `The production project menu exposes ${label}`);
      await React.act(async () => button.click());
    },
    async removeEntry(id: string) { await this.menuEntry(id, "移除项目"); },
    async resolveRemoval(index: number, result = bootstrapFor(ids.filter(id => id !== removals[index]!.id))) { await React.act(async () => removals[index]!.gate.resolve(result)); },
    async rejectRemoval(index: number) { await React.act(async () => removals[index]!.gate.reject(new Error("Removal unavailable"))); },
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
    async fillDraft(value: string) {
      const textarea = document.querySelector<HTMLTextAreaElement>(".biny-chat-composer textarea"); assert.ok(textarea);
      await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value); textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    },
    draft: () => document.querySelector<HTMLTextAreaElement>(".biny-chat-composer textarea")?.value,
    projectIds: () => [...document.querySelectorAll("button[aria-label$=' 项目操作']")].map(button => button.getAttribute("aria-label")),
    heading: () => document.querySelector(".biny-chat-title")?.textContent,
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

function bootstrapFor(ids: string[], activeId = ids[0]): DesktopBootstrap {
  return { version: "test", platform: "linux", projects: ids.map(project), sidebarSessions: ids.map(id => session(id)),
    workspace: activeId ? workspace(activeId) : undefined, activeView: "chat", sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } };
}

test("removing an inactive project preserves the current conversation and draft", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.fillDraft("Keep this local edit");
  await h.removeEntry("b");
  assert.deepEqual(h.removals.map(item => item.id), ["b"]);
  const commits = [...h.commitments];
  await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a"));
  assert.equal(h.projectName(), "Project a");
  assert.match(h.selectedTitle() ?? "", /Conversation a/u);
  assert.match(h.body(), /Discuss a/u);
  assert.equal(h.draft(), "Keep this local edit");
  assert.deepEqual(h.commitments, commits);
  assert.deepEqual(h.projectIds(), ["Project a 项目操作", "Project c 项目操作"]);
});

test("current active removal adopts a blank surviving project", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.removeEntry("a"); await h.resolveRemoval(0);
  assert.equal(h.projectName(), "Project b");
  assert.equal(h.selectedTitle(), undefined);
  assert.doesNotMatch(h.body(), /Discuss a/u);
  assert.equal(h.loading(), "false");
  await h.submit("send");
  assert.equal(h.actions[0]?.projectId, "b", "The fallback's synchronous identity owns the next send");
  await h.settleAction("send", "b");
});

test("removing the final project leaves no removed workspace or conversation", async t => {
  const h = await fixture(t, ["a"]);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.removeEntry("a"); await h.resolveRemoval(0);
  assert.equal(h.projectName(), undefined);
  assert.equal(h.selectedTitle(), undefined);
  assert.doesNotMatch(h.body(), /Discuss a/u);
  assert.deepEqual(h.projectIds(), []);
});

for (const removed of ["a", "c"]) test(`late ${removed} removal preserves a newer settled conversation`, async t => {
  const h = await fixture(t);
  await h.removeEntry(removed);
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  await h.fillDraft("Newer B draft");
  const commits = [...h.commitments];
  await h.resolveRemoval(0, bootstrapFor(["a", "b", "c"].filter(id => id !== removed), removed === "a" ? "c" : "a"));
  assert.equal(h.projectName(), "Project b");
  assert.match(h.selectedTitle() ?? "", /Conversation b/u);
  assert.match(h.body(), /Discuss b/u);
  assert.equal(h.draft(), "Newer B draft");
  assert.deepEqual(h.commitments, commits);
});

for (const outcome of ["success", "failure"] as const) test(`active removal preserves a newer pending B read through ${outcome}`, async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.removeEntry("a");
  const read = h.holdRead(); await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  await h.resolveRemoval(0, bootstrapFor(["b", "c"], "c"));
  assert.equal(h.projectName(), undefined, "A was removed, but stale fallback C must not replace pending B");
  assert.equal(h.loading(), "true", "Removal must not finish the newer read's loading state");
  if (outcome === "success") {
    await read.resolve("b");
    assert.equal(h.projectName(), "Project b"); assert.match(h.body(), /Discuss b/u);
    assert.match(h.selectedTitle() ?? "", /Conversation b/u);
  } else {
    await read.reject(new Error("New B unavailable"));
    assert.equal(h.projectName(), undefined); assert.doesNotMatch(h.body(), /Discuss a/u);
    assert.match(h.text(), /New B unavailable/u);
  }
  assert.equal(h.loading(), "false");
});

test("removal after an already pending unrelated read does not cancel that read", async t => {
  const h = await fixture(t);
  const read = h.holdRead(); await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  await h.removeEntry("a"); await h.resolveRemoval(0, bootstrapFor(["b", "c"], "c"));
  assert.equal(h.loading(), "true"); assert.equal(h.projectName(), undefined);
  await read.resolve("b"); assert.equal(h.projectName(), "Project b"); assert.match(h.body(), /Discuss b/u);
});

test("removal of a pending target preserves the displayed unrelated conversation", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  const read = h.holdRead(); await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  await h.removeEntry("b"); await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a"));
  assert.equal(h.projectName(), "Project a"); assert.match(h.body(), /Discuss a/u);
  assert.equal(h.loading(), "false");
  const commits = [...h.commitments];
  await read.resolve("b");
  assert.equal(h.projectName(), "Project a"); assert.match(h.selectedTitle() ?? "", /Conversation a/u);
  assert.deepEqual(h.commitments, commits, "Removed target's sampled read cannot re-adopt or commit selection");
  assert.deepEqual(h.projectIds(), ["Project a 项目操作", "Project c 项目操作"]);
});

test("reversed inactive removals cannot reinsert an already removed project", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.removeEntry("b"); await h.removeEntry("c");
  await h.resolveRemoval(1, bootstrapFor(["a"], "a"));
  await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a"));
  assert.deepEqual(h.projectIds(), ["Project a 项目操作"]);
  assert.match(h.body(), /Discuss a/u); assert.match(h.selectedTitle() ?? "", /Conversation a/u);
});

test("active removal never adopts a fallback removed by a later completion", async t => {
  const h = await fixture(t);
  await h.removeEntry("a"); await h.removeEntry("b");
  await h.resolveRemoval(1, bootstrapFor(["a", "c"], "a"));
  await h.resolveRemoval(0, bootstrapFor(["b", "c"], "b"));
  assert.equal(h.projectName(), undefined);
  assert.deepEqual(h.projectIds(), ["Project c 项目操作"]);
});

test("current removal failure preserves the conversation and allows retry", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.removeEntry("a"); await h.rejectRemoval(0);
  assert.equal(h.projectName(), "Project a"); assert.match(h.body(), /Discuss a/u);
  assert.match(h.text(), /Removal unavailable/u);
  await h.removeEntry("a"); await h.resolveRemoval(1);
  assert.equal(h.projectName(), "Project b");
});

test("late removal failure cannot warn over a newer conversation", async t => {
  const h = await fixture(t); await h.removeEntry("a");
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  await h.rejectRemoval(0);
  assert.doesNotMatch(h.text(), /Removal unavailable/u);
  assert.match(h.body(), /Discuss b/u);
});

for (const kind of ["send", "slash"] as const) {
  for (const existing of [false, true]) test(`active removal retires in-window ${kind} from ${existing ? "session" : "draft"}`, async t => {
    const h = await fixture(t);
    if (existing) await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    await h.removeEntry("a"); await h.submit(kind);
    assert.equal(h.actions[0]?.projectId, "a");
    await h.resolveRemoval(0); await h.settleAction(kind);
    assert.equal(h.projectName(), "Project b"); assert.equal(h.selectedTitle(), undefined);
    assert.doesNotMatch(h.body(), /Source action input|Discuss a/u);
    assert.doesNotMatch(h.heading() ?? "", /Conversation a/u);
    assert.equal(Boolean(h.document.querySelector(".slash-result-modal")), false);
  });
  test(`inactive removal preserves the current ${kind} receipt`, async t => {
    const h = await fixture(t);
    await h.removeEntry("b"); await h.submit(kind);
    await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a")); await h.settleAction(kind);
    assert.equal(h.projectName(), "Project a");
    if (kind === "send") assert.match(h.selectedTitle() ?? "", /Conversation a/u);
    else assert.match(h.document.querySelector(".slash-result-modal")?.textContent ?? "", /Source action result/u);
  });
  test(`failed active removal preserves its in-window ${kind} receipt`, async t => {
    const h = await fixture(t); await h.removeEntry("a"); await h.submit(kind);
    await h.rejectRemoval(0); await h.settleAction(kind);
    assert.equal(h.projectName(), "Project a");
    if (kind === "send") assert.match(h.selectedTitle() ?? "", /Conversation a/u);
    else assert.match(h.document.querySelector(".slash-result-modal")?.textContent ?? "", /Source action result/u);
  });
  test(`stale active removal preserves the newer B ${kind} receipt`, async t => {
    const h = await fixture(t); await h.removeEntry("a");
    await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
    await h.submit(kind); await h.resolveRemoval(0, bootstrapFor(["b", "c"], "c")); await h.settleAction(kind, "b");
    assert.equal(h.projectName(), "Project b"); assert.match(h.selectedTitle() ?? "", /Conversation b/u);
    if (kind === "slash") assert.match(h.document.querySelector(".slash-result-modal")?.textContent ?? "", /Source action result/u);
  });
}

for (const kind of ["send", "slash"] as const) {
  test(`removed A ${kind} cannot reuse the newer pending B navigation epoch`, async t => {
    const h = await fixture(t);
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    h.holdSelection(); await h.chooseProject("b");
    assert.equal(h.selections.length, 1); assert.equal(h.loading(), "false");
    await h.removeEntry("a"); await h.submit(kind);
    assert.equal(h.actions[0]?.projectId, "a");
    await h.resolveRemoval(0, bootstrapFor(["b", "c"], "c")); await h.settleAction(kind);
    assert.equal(h.projectName(), undefined); assert.doesNotMatch(h.heading() ?? "", /Conversation a/u);
    assert.equal(Boolean(h.document.querySelector(".slash-result-modal")), false);
    await h.resolveSelection(0);
    assert.equal(h.projectName(), "Project b"); assert.equal(h.selectedTitle(), undefined);
    assert.deepEqual(h.projectIds(), ["Project b 项目操作", "Project c 项目操作"]);
  });
  test(`cancelling removed pending B preserves A's ${kind} under that navigation epoch`, async t => {
    const h = await fixture(t);
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    h.holdSelection(); await h.chooseProject("b");
    await h.removeEntry("b"); await h.submit(kind);
    await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a")); await h.settleAction(kind);
    assert.equal(h.projectName(), "Project a"); assert.match(h.selectedTitle() ?? "", /Conversation a/u);
    if (kind === "slash") assert.match(h.document.querySelector(".slash-result-modal")?.textContent ?? "", /Source action result/u);
    await h.resolveSelection(0);
    assert.equal(h.projectName(), "Project a"); assert.match(h.body(), /Discuss a/u);
    assert.deepEqual(h.projectIds(), ["Project a 项目操作", "Project c 项目操作"]);
  });
  test(`removing a draft-only target retires only that ${kind} receipt`, async t => {
    const h = await fixture(t); await h.chooseProject("b");
    assert.equal(h.projectName(), "Project b");
    await h.removeEntry("b"); await h.submit(kind);
    assert.equal(h.actions[0]?.projectId, "b");
    await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a")); await h.settleAction(kind, "b");
    assert.equal(h.projectName(), "Project a"); assert.equal(h.selectedTitle(), undefined);
    assert.equal(Boolean(h.document.querySelector(".slash-result-modal")), false);
    assert.doesNotMatch(h.heading() ?? "", /Conversation b/u);
    assert.deepEqual(h.projectIds(), ["Project a 项目操作", "Project c 项目操作"]);
  });
}

test("inactive removal preserves a newer unrelated draft target and text", async t => {
  const h = await fixture(t); await h.removeEntry("b");
  await h.chooseProject("c"); await h.fillDraft("Keep draft C");
  await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a"));
  assert.equal(h.projectName(), "Project c"); assert.equal(h.draft(), "Keep draft C");
  await h.submit("send"); assert.equal(h.actions[0]?.projectId, "c"); await h.settleAction("send", "c");
});

for (const kind of ["send", "slash"] as const) test(`active removal preserves a newer unrelated draft ${kind}`, async t => {
  const h = await fixture(t); await h.removeEntry("a"); await h.chooseProject("c");
  const input = kind === "send" ? "Keep draft C" : "/tasks";
  await h.fillDraft(input);
  await h.resolveRemoval(0, bootstrapFor(["b", "c"], "b"));
  assert.equal(h.projectName(), "Project c");
  assert.equal(h.draft(), input, "Removing A cannot discard C's unsent input");
  assert.equal(h.document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.disabled, false);
  await h.submit(kind, input);
  assert.deepEqual(h.actions, [{ kind, projectId: "c", sessionId: undefined, input }]);
  await h.settleAction(kind, "c");
  assert.equal(h.projectName(), "Project c");
  if (kind === "send") assert.match(h.selectedTitle() ?? "", /Conversation c/u);
  else assert.match(h.document.querySelector(".slash-result-modal")?.textContent ?? "", /Source action result/u);
});

test("a sampled import-entry selection cannot reinsert its removed target", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  h.holdSelection(); await h.menuEntry("b", "导入会话");
  await h.removeEntry("b"); await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a"));
  const commits = [...h.commitments]; await h.resolveSelection(0);
  assert.equal(h.projectName(), "Project a"); assert.match(h.body(), /Discuss a/u);
  assert.equal(h.settingsTitle(), undefined); assert.deepEqual(h.commitments, commits);
  assert.deepEqual(h.projectIds(), ["Project a 项目操作", "Project c 项目操作"]);
});

test("a failed removed-target import entry cannot warn over the retained conversation", async t => {
  const h = await fixture(t); h.holdSelection(); await h.menuEntry("b", "导入会话");
  await h.removeEntry("b"); await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a"));
  await h.rejectSelection(0);
  assert.doesNotMatch(h.text(), /Import project unavailable/u);
});

test("a sampled new-task workspace cannot reinsert its removed target", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  h.holdSelection(); h.api.startDraft = h.api.selectProject;
  await h.click('button[aria-label="新建任务 Project b"]');
  assert.equal(h.selections.length, 1);
  await h.removeEntry("b"); await h.resolveRemoval(0, bootstrapFor(["a", "c"], "a"));
  const commits = [...h.commitments]; await h.resolveSelection(0);
  assert.equal(h.projectName(), "Project a"); assert.match(h.body(), /Discuss a/u);
  assert.deepEqual(h.commitments, commits); assert.equal(h.loading(), "false");
  assert.deepEqual(h.projectIds(), ["Project a 项目操作", "Project c 项目操作"]);
});

test("a direct read without a sidebar pending marker cannot resurrect the removed workspace", async t => {
  const h = await fixture(t);
  await h.removeEntry("a"); const read = h.holdRead();
  await h.emit("onReferenceOpen", { uri: "biny://session?s=session-a" });
  assert.equal(h.loading(), "true");
  await h.resolveRemoval(0);
  assert.equal(h.projectName(), undefined); assert.equal(h.loading(), "true");
  const commits = [...h.commitments]; await read.resolve("a");
  assert.equal(h.projectName(), undefined); assert.doesNotMatch(h.heading() ?? "", /Conversation a/u);
  assert.equal(h.loading(), "false"); assert.deepEqual(h.commitments, commits);
});

test("removal between import adoption and settings completion suppresses overlay", async t => {
  const h = await fixture(t);
  h.api.activitySettings = async () => ({ activity: settingsSnapshot("a").activity, configRevision: "config:1" });
  h.holdSelection(); await h.menuEntry("b", "导入会话");
  await h.removeEntry("b");
  await h.React.act(async () => {
    h.selections[0]!.gate.resolve(workspace("b"));
    h.removals[0]!.gate.resolve(bootstrapFor(["a", "c"], "a"));
  });
  assert.equal(h.projectName(), undefined);
  assert.equal(h.settingsTitle(), undefined);
  assert.deepEqual(h.projectIds(), ["Project a 项目操作", "Project c 项目操作"]);
});
