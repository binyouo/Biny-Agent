import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopAgentEventEnvelope, DesktopRunReceipt, DesktopBootstrap, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

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
  const sendGate = deferred<DesktopRunReceipt>();
  const sends: unknown[][] = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        sendGate.resolve({ sessionId: "new-session", runId: "new-run", messageId: "cleanup" });
        await sendGate.promise;
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
    selectProject: async (id: string) => workspace(id), startDraft: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string) => { assert.equal(sessionId, session(id).id); return documentFor(id); },
    refreshProject: async () => workspace("a"), commitSelection: async () => {},
    preparePrompt: async () => undefined,
    sendPrompt: (...args: unknown[]) => { sends.push(args); return sendGate.promise; },
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
    assert.equal(target.disabled, false, selector);
    assert.equal(target.closest('[hidden], [inert], [aria-hidden="true"]'), null, `${selector} must be reachable`);
    assert.equal(document.querySelectorAll("dialog[open]").length, 0, "No synthetic background clicks through a modal");
    await React.act(async () => target.click());
  };
  return { document, api, sends,
    async navigate(target: DesktopSessionHandoff) { await React.act(async () => listeners.get("onSessionHandoff")!(target as never)); },
    async tick(ms: number) { await React.act(async () => { t.mock.timers.tick(ms); }); },
    async send() {
      const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
      assert.ok(input);
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "hi");
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await click('[aria-label="发送消息"]');
      assert.equal(sends.length, 1);
    },
    async event(event: DesktopAgentEventEnvelope) { await React.act(async () => { listeners.get("onAgentEvent")!(event as never); }); },
    async receipt() { await React.act(async () => sendGate.resolve({ sessionId: "new-session", runId: "new-run", messageId: sends[0]![6] as string })); },
    body: () => document.querySelector(".biny-chat-body")?.textContent ?? ""
  };
}

function envelope(type: "message.user" | "assistant.delta" | "run.completed" | "run.failed", messageId: string): DesktopAgentEventEnvelope {
  const base = { sessionId: "new-session", runId: "new-run", timestamp: time };
  const event = type === "message.user" ? { ...base, type, content: "hi", messageId }
    : type === "assistant.delta" ? { ...base, type, content: "Hello from the completed run" }
    : type === "run.failed" ? { ...base, type, error: "Provider unavailable" }
    : { ...base, type, durationMs: 1 };
  const snapshot: DesktopAgentEventEnvelope["snapshot"] = {
    revision: type === "run.completed" || type === "run.failed" ? 2 : 1,
    permissionMode: "ask",
    info: { workspaceRoot: "/synthetic/a", sessionId: "new-session", sessionFile: "/synthetic/session.jsonl",
      provider: "test", modelLabel: "test", reasoningLabel: "off", modelAlias: "test", thinking: "off" },
    state: type === "run.completed" || type === "run.failed" ? { kind: "idle" } : { kind: "runs", activeRun: {
      sessionId: "new-session", runId: "new-run", messageId, input: "hi", status: "thinking", startedAt: time
    } }
  };
  return { projectId: "a", sessionId: "new-session", event, snapshot };
}

test("a new session shows buffered output when receipt is the last notification", async t => {
  const h = await fixture(t);
  await h.send();
  const id = h.sends[0]![6] as string;
  await h.event(envelope("message.user", id));
  await h.event(envelope("assistant.delta", id));
  await h.event(envelope("run.completed", id));
  await h.tick(16);
  await h.tick(260);
  await h.receipt();
  assert.match(h.body(), /Hello from the completed run/);
  assert.doesNotMatch(h.body(), /Thinking\.\.\./);
});

test("receipt joins buffered head events before subsequent streamed output without duplication", async t => {
  const h = await fixture(t);
  await h.send();
  const id = h.sends[0]![6] as string;
  await h.event(envelope("message.user", id));
  await h.event(envelope("assistant.delta", id));
  await h.tick(16);
  await h.receipt();
  assert.match(h.body(), /Hello from the completed run/);
  assert.ok(h.document.querySelector('[aria-label="暂停生成"]'));
  await h.event(envelope("run.completed", id));
  await h.tick(16);
  assert.equal(h.document.querySelectorAll(".user-bubble").length, 1);
  assert.equal(h.body().match(/Hello from the completed run/g)?.length, 1);
  assert.equal(h.document.querySelector('[aria-label="暂停生成"]'), null);
  assert.doesNotMatch(h.body(), /Thinking\.\.\./);
});

test("a failed run before receipt displays the failure and releases Thinking", async t => {
  const h = await fixture(t);
  await h.send();
  const id = h.sends[0]![6] as string;
  await h.event(envelope("message.user", id));
  await h.event(envelope("run.failed", id));
  await h.tick(16);
  await h.tick(260);
  await h.receipt();
  assert.match(h.document.body.textContent!, /Provider unavailable/);
  assert.doesNotMatch(h.body(), /Thinking\.\.\./);
});

test("leaving during send does not replay the former session into the selected conversation", async t => {
  const h = await fixture(t);
  await h.send();
  const id = h.sends[0]![6] as string;
  await h.event(envelope("message.user", id));
  await h.event(envelope("assistant.delta", id));
  await h.event(envelope("run.completed", id));
  await h.tick(16);
  await h.navigate({ projectId: "b", sessionId: "session-b" });
  await h.receipt();
  assert.match(h.body(), /Discuss b/);
  assert.doesNotMatch(h.body(), /Hello from the completed run|Thinking\.\.\./);
});

test("opening authoritative history discards buffered events without duplicate messages", async t => {
  const h = await fixture(t);
  await h.send();
  const id = h.sends[0]![6] as string;
  await h.event(envelope("message.user", id));
  await h.event(envelope("assistant.delta", id));
  await h.event(envelope("run.completed", id));
  await h.tick(16);
  h.api.openSession = async (): Promise<DesktopSessionDocument> => ({
    session: { ...session("a"), id: "new-session" }, liveEvents: [],
    events: [
      { type: "user_message", messageId: id, content: "hi" },
      { type: "assistant_message", content: "Hello from the completed run" }
    ]
  });
  await h.navigate({ projectId: "a", sessionId: "new-session" });
  await h.receipt();
  assert.equal(h.document.querySelectorAll(".user-bubble").length, 1);
  assert.equal(h.body().match(/Hello from the completed run/g)?.length, 1);
  assert.doesNotMatch(h.body(), /Thinking\.\.\./);
});
