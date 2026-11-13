import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../src/llm/ModelManager.js";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopRunReceipt, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopSlashResult, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

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
  return { id, projectId, fileName: `${projectId}.jsonl`, title: `Conversation ${id}`,
    firstUserMessage: `Discuss ${projectId}`, lastAssistantMessage: "", createdAt: time, updatedAt: time,
    eventCount: 1, pinned: false, status: "completed" };
}
const models: ModelChoice[] = ["alpha", "beta", "gamma"].map(alias => ({ alias, displayName: alias, provider: "inert", providerType: "openai-compatible", model: alias, modelKey: `inert/${alias}`, available: true, source: "configured", supportsTools: true, efforts: ["high", "max"], defaultThinking: "high", thinkingLevelMap: { off: "none", high: "high", max: "max" } }));
function info(alias: string, thinking: ThinkingSelection = "high"): ModelRuntimeInfo { return { modelAlias: alias, provider: "inert", modelLabel: alias, thinking, reasoningLabel: thinking }; }
function workspace(id: string): DesktopWorkspaceSnapshot {
  return { project: project(id), sessions: [session(id), session(id, `second-${id}`)], permissionMode: "ask",
    capabilityDefaults: { tools: "auto", skills: "auto" }, requiresModelConfiguration: false,
    models, pickerModels: models, selectedModel: info("alpha"), connections: [] };
}
function documentFor(id: string, sessionId = `session-${id}`, recovery = false): DesktopSessionDocument {
  return { recovery: recovery ? { canContinue: true, message: "Inert paused task" } : undefined, session: session(id, sessionId), events: [{ type: "user_message", content: `Discuss ${id}` }], liveEvents: [] };
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
  const opens: Array<ReturnType<typeof deferred<DesktopWorkspaceSnapshot | undefined>>> = [];
  const creations: Array<ReturnType<typeof deferred<DesktopWorkspaceSnapshot | undefined>>> = [];
  const slashes: Array<ReturnType<typeof deferred<DesktopSlashResult>>> = [];
  const sends: Array<ReturnType<typeof deferred<DesktopRunReceipt>>> = [];
  const switches: Array<{ projectId: string; alias: string; thinking: ThinkingSelection; gate: ReturnType<typeof deferred<ModelRuntimeInfo>> }> = [];
  const refreshes: Array<{ projectId: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const actions: Array<{ kind: "send" | "slash" | "resume"; projectId: string; sessionId: string | undefined; input?: string }> = [];
  const commitments: Array<{ projectId: string; sessionId?: string; activeView: string }> = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        // Resolving one save can start the next queued save and its refresh.
        // Drain all admitted gates before restoring the process-global fixture.
        for (let index = 0; index < switches.length; index += 1) {
          const item = switches[index]!;
          item.gate.resolve(info(item.alias, item.thinking));
          await item.gate.promise.catch(() => undefined);
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        creations.forEach(item => item.resolve(undefined));
        slashes.forEach(item => item.resolve({ command: "/tasks", title: "Source A", content: "Only source A result" }));
        opens.forEach(item => item.resolve(undefined));
        sends.forEach(item => item.resolve({ sessionId: "session-a", runId: "run-inert", messageId: "message-inert" }));
        await Promise.allSettled([...creations.map(item => item.promise), ...slashes.map(item => item.promise), ...opens.map(item => item.promise), ...sends.map(item => item.promise)]);
        refreshes.forEach(item => item.gate.resolve(workspace(item.projectId)));
        await Promise.allSettled(refreshes.map(item => item.gate.promise));
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
    switchModel(projectId: string, alias: string, thinking: ThinkingSelection) { const gate = deferred<ModelRuntimeInfo>(); switches.push({ projectId, alias, thinking, gate }); return gate.promise; },
    refreshProject(projectId: string) { const gate = deferred<DesktopWorkspaceSnapshot>(); refreshes.push({ projectId, gate }); return gate.promise; },
    createEmptyProject() { const gate = deferred<DesktopWorkspaceSnapshot | undefined>(); creations.push(gate); return gate.promise; },
    openProject() { const gate = deferred<DesktopWorkspaceSnapshot | undefined>(); opens.push(gate); return gate.promise; },
    preparePrompt: async (projectId: string) => { assert.ok(projectId); },
    sendPrompt: async (projectId: string, sessionId: string | undefined, input: string) => { actions.push({ kind: "send", projectId, sessionId, input }); const gate = deferred<DesktopRunReceipt>(); sends.push(gate); return await gate.promise; },
    runSlashCommand: async (projectId: string, sessionId: string | undefined, input: string) => { actions.push({ kind: "slash", projectId, sessionId, input }); const gate = deferred<DesktopSlashResult>(); slashes.push(gate); return await gate.promise; },
    resumeInterruptedTurn: async (projectId: string, sessionId: string) => { actions.push({ kind: "resume", projectId, sessionId }); return { sessionId, runId: "run-inert", messageId: "message-inert" }; },
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: [project("a"), project("b")],
      sidebarSessions: [session("a"), session("a", "second-a"), session("b")], workspace: workspace("a"), activeView: "chat",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    selectProject: async (id: string) => workspace(id),
    startDraft: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string) => { assert.ok(workspace(id).sessions.some(item => item.id === sessionId)); return documentFor(id, sessionId, true); },
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
  const emit = async (name: string, value: DesktopMenuAction | DesktopSessionHandoff): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React, opens, creations, sends, slashes, switches, refreshes, actions, commitments, api, click, emit,
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
    async choose(alias: string) {
      const trigger = document.querySelector<HTMLButtonElement>('.biny-model-pill[data-composer-menu="model"]')!;
      if (trigger.getAttribute("aria-expanded") !== "true") await React.act(async () => trigger.click());
      await click('.model-picker-entry[data-section="model"]');
      const option = [...document.querySelectorAll<HTMLButtonElement>('.model-picker-submenu-option')].find(button => button.textContent === alias);
      assert.ok(option, `model ${alias} is rendered`); await React.act(async () => option.click());
    },
    async type(text: string) {
      const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务输入"]')!;
      assert.ok(input); assert.equal(input.disabled, false);
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    async resolveSwitch(index: number) { const request = switches[index]!; await React.act(async () => request.gate.resolve(info(request.alias, request.thinking))); },
    input: () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务输入"]')?.value,
    selectedTitle: () => document.querySelector(".biny-sidebar-session-entry.is-selected")?.textContent,
    body: () => document.querySelector(".biny-chat-body")?.textContent ?? "",
    loading: () => document.querySelector('.biny-chat-composer')?.getAttribute("aria-busy"),
    projectName: () => document.querySelector('button[title="选择项目"]')?.textContent,
    text: () => document.body.textContent ?? ""
  };
}



type Outcome = "receipt" | "absent" | "error";
const outcomes: Outcome[] = ["receipt", "absent", "error"];
const settle = (gate: ReturnType<typeof deferred<DesktopRunReceipt | undefined>>, outcome: Outcome): void => {
  if (outcome === "error") gate.reject(new Error("Source resume failed"));
  else gate.resolve(outcome === "absent" ? undefined : { sessionId: "session-a", runId: "prior-run", messageId: "prior-message" });
};
for (const outcome of outcomes) for (const targetProject of ["a", "b"]) {
  test(`late resume ${outcome} must not retire newer ${targetProject} navigation`, async t => {
    const h = await fixture(t);
    const resume = deferred<DesktopRunReceipt | undefined>();
    const target = deferred<DesktopSessionDocument>();
    const targetSession = targetProject === "a" ? "second-a" : "session-b";
    const reads: string[] = [];
    let refreshes = 0;
    h.api.resumeInterruptedTurn = () => resume.promise;
    h.api.refreshProject = async (id: string) => { refreshes++; return workspace(id); };
    h.api.openSession = async (projectId: string, sessionId: string) => {
      reads.push(sessionId);
      return sessionId === targetSession ? target.promise : documentFor(projectId, sessionId, true);
    };
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    await h.click('button[aria-label="继续上次任务"]');
    await h.emit("onSessionHandoff", { projectId: targetProject, sessionId: targetSession });
    assert.deepEqual(reads, ["session-a", targetSession]);
    await h.React.act(async () => settle(resume, outcome));
    await h.React.act(async () => target.resolve(documentFor(targetProject, targetSession)));
    assert.equal(h.projectName(), `Project ${targetProject}`);
    assert.equal(h.selectedTitle()?.includes(`Conversation ${targetSession}`), true);
    assert.deepEqual(reads, ["session-a", targetSession], "stale resume must not re-open source");
    assert.equal(refreshes, 0);
    assert.doesNotMatch(h.text(), /Source resume failed/);
  });
}
for (const outcome of outcomes) test(`late resume ${outcome} preserves recovery reread after A-B-A`, async t => {
  const h = await fixture(t);
  const resume = deferred<DesktopRunReceipt | undefined>();
  let refreshes = 0;
  h.api.resumeInterruptedTurn = () => resume.promise;
  h.api.refreshProject = async (id: string) => { refreshes++; return workspace(id); };
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.click('button[aria-label="继续上次任务"]');
  await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  assert.ok(h.document.querySelector('button[aria-label="正在继续上次任务"]'));
  const commits = [...h.commitments];
  await h.React.act(async () => settle(resume, outcome));
  assert.ok(h.document.querySelector('button[aria-label="继续上次任务"]'), "newly read recovery must not be cleared by the old receipt");
  assert.deepEqual(h.commitments, commits, "old resume must not recommit selection");
  assert.equal(refreshes, 0);
  assert.doesNotMatch(h.text(), /Source resume failed/);
});
for (const outcome of outcomes) test(`current resume ${outcome} still settles normally`, async t => {
  const h = await fixture(t);
  const resume = deferred<DesktopRunReceipt | undefined>();
  let refreshes = 0;
  h.api.resumeInterruptedTurn = () => resume.promise;
  h.api.refreshProject = async (id: string) => { refreshes++; return workspace(id); };
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.click('button[aria-label="继续上次任务"]');
  await h.React.act(async () => settle(resume, outcome));
  assert.equal(h.selectedTitle()?.includes("Conversation session-a"), true);
  if (outcome === "receipt") assert.equal(h.document.querySelector('button[aria-label="继续上次任务"]'), null);
  else assert.ok(h.document.querySelector('button[aria-label="继续上次任务"]'));
  assert.equal(refreshes, outcome === "error" ? 1 : 0);
  if (outcome === "error") assert.match(h.text(), /Source resume failed/);
});
