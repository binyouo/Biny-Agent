import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../src/llm/ModelManager.js";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

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
async function fixture(t: TestContext, options: { recovery?: boolean } = {}) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); imports?: ReturnType<typeof registerHooks> } = {};
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const network: string[] = [];
  const unknown: string[] = [];
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
    preparePrompt: async (projectId: string) => { assert.ok(["a", "b"].includes(projectId)); },
    sendPrompt: async (projectId: string, sessionId: string | undefined, input: string) => { actions.push({ kind: "send", projectId, sessionId, input }); return { sessionId: sessionId ?? `session-${projectId}`, runId: "run-inert", messageId: "message-inert" }; },
    runSlashCommand: async (projectId: string, sessionId: string | undefined, input: string) => { actions.push({ kind: "slash", projectId, sessionId, input }); return { command: input, title: "inert", content: "inert result" }; },
    resumeInterruptedTurn: async (projectId: string, sessionId: string) => { actions.push({ kind: "resume", projectId, sessionId }); return { sessionId, runId: "run-inert", messageId: "message-inert" }; },
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: [project("a"), project("b")],
      sidebarSessions: [session("a"), session("a", "second-a"), session("b")], workspace: workspace("a"), activeView: "chat",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    selectProject: async (id: string) => workspace(id),
    startDraft: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string) => { assert.ok(workspace(id).sessions.some(item => item.id === sessionId)); return documentFor(id, sessionId, options.recovery); },
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
  return { document, window, React, switches, refreshes, actions, commitments, api, click, emit,
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
    async think(thinking: ThinkingSelection) {
      const trigger = document.querySelector<HTMLButtonElement>('.biny-model-pill[data-composer-menu="model"]')!;
      if (trigger.getAttribute("aria-expanded") !== "true") await React.act(async () => trigger.click());
      await click('.model-picker-entry[data-section="thinking"]');
      const option = [...document.querySelectorAll<HTMLButtonElement>('.model-effort-options button')].find(button => button.textContent === thinking);
      assert.ok(option); await React.act(async () => option.click());
    },
    async rejectSwitch(index: number) { await React.act(async () => switches[index]!.gate.reject(new Error("Selection was not saved"))); },
    async resolveSwitch(index: number) { const request = switches[index]!; await React.act(async () => request.gate.resolve(info(request.alias, request.thinking))); },
    input: () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务输入"]')?.value,
    selectedTitle: () => document.querySelector(".biny-sidebar-session-entry.is-selected")?.textContent,
    body: () => document.querySelector(".biny-chat-body")?.textContent ?? "",
    loading: () => document.querySelector('.biny-chat-composer')?.getAttribute("aria-busy"),
    projectName: () => document.querySelector('button[title="选择项目"]')?.textContent,
    text: () => document.body.textContent ?? ""
  };
}

type ActionKind = "send" | "slash" | "resume";
type NavigationKind = "same-project" | "other-project" | "blank-task" | "return-source";
const actionText = (kind: ActionKind): string => kind === "slash" ? "/tasks" : kind === "send" ? "Only for session A" : "";
async function prepare(t: TestContext, kind: ActionKind) {
  const h = await fixture(t, { recovery: kind === "resume" });
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  if (actionText(kind)) await h.type(actionText(kind));
  await h.choose("beta");
  await h.click(`button[aria-label="${kind === "resume" ? "继续上次任务" : "发送消息"}"]`);
  assert.equal(h.switches.length, 1); assert.deepEqual([...h.actions], []);
  return h;
}
async function navigate(h: Awaited<ReturnType<typeof fixture>>, target: NavigationKind) {
  if (target === "blank-task") await h.emit("onMenuAction", "new-task");
  else if (target === "same-project") await h.emit("onSessionHandoff", { projectId: "a", sessionId: "second-a" });
  else {
    await h.emit("onSessionHandoff", { projectId: "b", sessionId: "session-b" });
    if (target === "return-source") await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  }
}
for (const kind of ["send", "slash", "resume"] as const) {
  for (const target of ["same-project", "other-project", "blank-task", "return-source"] as const) {
    test(`waiting ${kind} is retired after ${target} navigation`, async t => {
      const h = await prepare(t, kind);
      await navigate(h, target);
      await h.resolveSwitch(0);
      assert.deepEqual([...h.actions], [], "The unmounted Composer cannot dispatch into the newly selected owner");
      if (target !== "return-source") await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
      assert.equal(h.input(), actionText(kind), "Pre-dispatch retirement must preserve the source draft");
      assert.equal(h.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务输入"]')!.disabled, false);
    });
  }
  test(`same-owner waiting ${kind} executes after the save`, async t => {
    const h = await prepare(t, kind);
    await h.resolveSwitch(0);
    assert.deepEqual(h.actions, [{ kind, projectId: "a", sessionId: "session-a", ...(kind === "resume" ? {} : { input: actionText(kind) }) }]);
  });
}
test("a rejected current selection preserves a waiting draft without dispatch", async t => {
  const h = await prepare(t, "send");
  await h.rejectSwitch(0);
  assert.deepEqual([...h.actions], []);
  assert.equal(h.input(), actionText("send"));
  assert.match(h.text(), /Selection was not saved/u);
});

test("new model and thinking retain their order through real menu controls", async t => {
  const h = await fixture(t);
  await h.choose("beta"); await h.think("max");
  assert.equal(h.switches.length, 1);
  assert.match(h.document.querySelector('.biny-model-pill[data-composer-menu="model"]')!.textContent ?? "", /beta.*Max/u);
  await h.resolveSwitch(0); assert.equal(h.switches.length, 2);
  assert.equal(h.switches[1]!.alias, "beta"); assert.equal(h.switches[1]!.thinking, "max");
  await h.resolveSwitch(1);
  assert.match(h.document.querySelector('.biny-model-pill[data-composer-menu="model"]')!.textContent ?? "", /beta.*Max/u);
});

test("repeated submission while a selection is pending admits one action", async t => {
  const h = await prepare(t, "send");
  const form = h.document.querySelector('form.biny-composer')!;
  await h.React.act(async () => form.dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true })));
  await h.resolveSwitch(0);
  assert.equal(h.actions.length, 1);
});

test("an already dispatched send is not cancelled by later navigation", async t => {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.type("Already accepted by the source"); await h.click('button[aria-label="发送消息"]');
  assert.deepEqual(h.actions, [{ kind: "send", projectId: "a", sessionId: "session-a", input: "Already accepted by the source" }]);
  await navigate(h, "other-project");
  assert.equal(h.actions.length, 1);
  assert.match(h.body(), /Discuss b/u);
});

test("sidebar navigation retires a model-waiting send", async t => {
  const h = await prepare(t, "send");
  const row = [...h.document.querySelectorAll<HTMLButtonElement>('.biny-sidebar-session-entry button')].find(item => item.textContent?.includes("Conversation second-a"));
  assert.ok(row, "The other session is reachable through the rendered Sidebar");
  await h.React.act(async () => row.click());
  assert.match(h.selectedTitle() ?? "", /Conversation second-a/u);
  await h.resolveSwitch(0);
  assert.deepEqual([...h.actions], []);
});

test("sidebar navigation and a receipt in one turn do not cross submission owners", async t => {
  const h = await prepare(t, "send");
  const row = [...h.document.querySelectorAll<HTMLButtonElement>('.biny-sidebar-session-entry button')].find(item => item.textContent?.includes("Conversation second-a"));
  assert.ok(row);
  await h.React.act(async () => {
    row.click();
    const request = h.switches[0]!;
    request.gate.resolve(info(request.alias, request.thinking));
  });
  assert.ok(h.actions.every(action => action.projectId === "a" && action.sessionId === "session-a"), "An admitted source action may finish before navigation commits, but never target the destination");
  if (!h.actions.length) {
    await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
    assert.equal(h.input(), actionText("send"));
    assert.equal(h.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务输入"]')!.disabled, false);
  }
});
