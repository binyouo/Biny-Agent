import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { reduceInteractiveRunState, type AgentHostEvent, type InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import type { PermissionResult } from "../src/permission/PermissionManager.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../src/llm/ModelManager.js";
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
function session(projectId: string, id = `session-${projectId}`): DesktopSessionSummary {
  return { id, projectId, fileName: `${projectId}.jsonl`, title: `Conversation ${id}`,
    firstUserMessage: `Discuss ${projectId}`, lastAssistantMessage: "", createdAt: time, updatedAt: time,
    eventCount: 1, pinned: false, status: "completed" };
}
const models: ModelChoice[] = ["alpha"].map(alias => ({ alias, displayName: alias, provider: "inert", providerType: "openai-compatible", model: alias, modelKey: `inert/${alias}`, available: true, source: "configured", supportsTools: true, efforts: ["high", "max"], defaultThinking: "high", thinkingLevelMap: { off: "none", high: "high", max: "max" } }));
function info(alias: string, thinking: ThinkingSelection = "high"): ModelRuntimeInfo { return { modelAlias: alias, provider: "inert", modelLabel: alias, thinking, reasoningLabel: thinking }; }
function workspace(id: string): DesktopWorkspaceSnapshot {
  return { project: project(id), sessions: [session(id), session(id, `second-${id}`)], permissionMode: "ask",
    capabilityDefaults: { tools: "auto", skills: "auto" }, requiresModelConfiguration: false,
    models, pickerModels: models, selectedModel: info("alpha"), connections: [] };
}
function documentFor(id: string, sessionId = `session-${id}`): DesktopSessionDocument {
  return { session: session(id, sessionId), events: [], liveEvents: permissionEvents(sessionId), runtimeSnapshot: snapshotFor(sessionId) };
}
function permissionEvents(sessionId: string, requestId = `request-${sessionId}`, toolCallId = `tool-${sessionId}`): AgentHostEvent[] {
  const base = { sessionId, runId: `run-${sessionId}`, timestamp: time };
  return [{ ...base, type: "message.user", messageId: `message-${sessionId}`, content: `Discuss ${sessionId}` },
    { ...base, type: "run.started", messageId: `message-${sessionId}`, input: `Discuss ${sessionId}`, model: { alias: "alpha", provider: "inert", label: "alpha", reasoning: "off" }, skills: [] },
    { ...base, type: "permission.requested", requestId, toolCallId, request: { toolCallId, tool: "mcp_inert_probe", title: "Inert request", details: requestId, actionType: "network", riskLevel: "medium", requireFullYes: false, canRemember: false } }];
}
function snapshotFor(sessionId: string): InteractiveRuntimeSnapshot {
  const requested = permissionEvents(sessionId).at(-1)!;
  assert.equal(requested.type, "permission.requested");
  return { revision: 1, permissionMode: "ask", info: { workspaceRoot: "/synthetic", sessionId, sessionFile: `/synthetic/${sessionId}.jsonl`, ...info("alpha") },
    state: { kind: "runs", activeRun: { sessionId, runId: `run-${sessionId}`, messageId: `message-${sessionId}`, input: "inert", status: "waiting_permission", startedAt: time },
      pendingPermission: { sessionId, runId: requested.runId, requestId: requested.requestId, toolCallId: requested.toolCallId, request: requested.request } } };
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
  const permissions: Array<{ projectId: string; requestId: string; result: PermissionResult; gate: ReturnType<typeof deferred<void>> }> = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        permissions.forEach(item => item.gate.resolve());
        await Promise.allSettled(permissions.map(item => item.gate.promise));
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
  const documents = new Map<string, DesktopSessionDocument>();
  const api: Record<string, unknown> = {
    resolvePermission(projectId: string, requestId: string, result: PermissionResult) { const gate = deferred<void>(); permissions.push({ projectId, requestId, result, gate }); return gate.promise; },
    refreshProject: async (projectId: string) => workspace(projectId),
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: [project("a"), project("b")],
      sidebarSessions: [session("a"), session("a", "second-a"), session("b")], workspace: workspace("a"), activeView: "chat",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    selectProject: async (id: string) => workspace(id),
    startDraft: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string) => { assert.ok(workspace(id).sessions.some(item => item.id === sessionId)); return documents.get(sessionId) ?? documentFor(id, sessionId); },
    commitSelection: async () => {},
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
  const emit = async (name: string, value: DesktopMenuAction | DesktopSessionHandoff | DesktopAgentEventEnvelope): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React, permissions, click, emit,
    async permissionEvent(event: AgentHostEvent) {
      const current = documents.get(event.sessionId) ?? documentFor("a", event.sessionId);
      const previous = current.runtimeSnapshot ?? snapshotFor(event.sessionId);
      const snapshot = { ...previous, revision: previous.revision + 1, state: reduceInteractiveRunState(previous.state, event) };
      documents.set(event.sessionId, { ...current, liveEvents: [...current.liveEvents, event], runtimeSnapshot: snapshot });
      await emit("onAgentEvent", { projectId: "a", sessionId: event.sessionId, snapshot, event });
      await React.act(async () => t.mock.timers.tick(16));
    },
    async settle(index: number, rejection = false) {
      await React.act(async () => { if (rejection) permissions[index]!.gate.reject(new Error("Permission request is no longer pending.")); else permissions[index]!.gate.resolve(); });
    },
    text: () => document.body.textContent ?? "",
    card: () => document.querySelector(".permission-card")?.textContent ?? ""
  };
}


async function prepare(t: TestContext, choice: "allow" | "deny" = "allow") {
  const h = await fixture(t);
  await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  await h.click(`.permission-actions button.${choice === "allow" ? "is-primary" : "is-danger"}`);
  assert.deepEqual(h.permissions.map(item => [item.projectId, item.requestId, item.result.approved]), [["a", "request-session-a", choice === "allow"]]);
  return h;
}
function resolution(approved: boolean): Extract<AgentHostEvent, { type: "permission.resolved" }> {
  return { type: "permission.resolved", sessionId: "session-a", runId: "run-session-a", timestamp: time, requestId: "request-session-a", toolCallId: "tool-session-a", tool: "mcp_inert_probe", approved, action: approved ? "allow_once" : "deny", message: approved ? "Resolved by another client" : "Cancelled by the user" };
}

for (const choice of ["allow", "deny"] as const) test(`authoritative result supersedes optimistic ${choice} before IPC rejection`, async t => {
  const h = await prepare(t, choice);
  await h.permissionEvent(resolution(choice === "deny"));
  assert.match(h.card(), choice === "deny" ? /已允许一次/u : /已拒绝/u);
  assert.match(h.card(), choice === "deny" ? /Resolved by another client/u : /Cancelled by the user/u);
  assert.equal(h.document.querySelectorAll(".permission-actions button").length, 0);
  await h.settle(0, true);
  assert.match(h.card(), choice === "deny" ? /已允许一次/u : /已拒绝/u);
  assert.equal(h.permissions.length, 1);
});
for (const choice of ["allow", "deny"] as const) for (const rejection of [false, true]) test(`replacement request survives old ${choice} ${rejection ? "rejection" : "acknowledgement"}`, async t => {
  const h = await prepare(t, choice);
  await h.permissionEvent(resolution(choice === "allow"));
  const replacement = permissionEvents("session-a", "request-b").at(-1)!;
  await h.permissionEvent(replacement);
  assert.match(h.card(), /request-b/u);
  await h.settle(0, rejection);
  assert.match(h.card(), /request-b/u);
  assert.doesNotMatch(h.card(), /已允许|已拒绝|no longer pending/u);
  await h.click(".permission-actions button.is-danger");
  assert.deepEqual(h.permissions.map(item => [item.projectId, item.requestId, item.result.approved]), [["a", "request-session-a", choice === "allow"], ["a", "request-b", false]]);
});
for (const target of ["same-project", "other-project", "blank-task"] as const) for (const rejection of [false, true]) test(`late receipt leaves ${target} untouched after ${rejection ? "rejection" : "acknowledgement"}`, async t => {
  const h = await prepare(t);
  if (target === "blank-task") await h.emit("onMenuAction", "new-task");
  else await h.emit("onSessionHandoff", target === "same-project" ? { projectId: "a", sessionId: "second-a" } : { projectId: "b", sessionId: "session-b" });
  const before = h.card();
  await h.settle(0, rejection);
  assert.equal(h.card(), before);
  assert.doesNotMatch(h.text(), /Permission request is no longer pending/u);
  assert.equal(h.permissions.length, 1);
  if (target !== "blank-task") {
    await h.click(".permission-actions button.is-danger");
    assert.deepEqual(h.permissions.map(item => [item.projectId, item.requestId]), [["a", "request-session-a"], target === "same-project" ? ["a", "request-second-a"] : ["b", "request-session-b"]]);
  }
});
for (const choice of ["allow", "deny"] as const) test(`current ${choice} acknowledgement retains its resolved card`, async t => {
  const h = await prepare(t, choice); await h.permissionEvent(resolution(choice === "allow")); await h.settle(0);
  assert.match(h.card(), choice === "allow" ? /已允许一次/u : /已拒绝/u); assert.equal(h.permissions.length, 1);
});
test("a current rejected submission allows an explicit manual retry", async t => {
  const h = await prepare(t); await h.settle(0, true);
  assert.match(h.card(), /Permission request is no longer pending/u);
  await h.click(".permission-actions button.is-danger");
  assert.deepEqual(h.permissions.map(item => [item.requestId, item.result.approved]), [["request-session-a", true], ["request-session-a", false]]);
});
for (const choice of ["allow", "deny"] as const) test(`repeated DOM clicks do not duplicate a pending ${choice} submission`, async t => {
  const h = await fixture(t); await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  const allow = h.document.querySelector<HTMLButtonElement>(".permission-actions button.is-primary")!;
  const deny = h.document.querySelector<HTMLButtonElement>(".permission-actions button.is-danger")!;
  await h.React.act(async () => (choice === "allow" ? allow : deny).click());
  await h.React.act(async () => { allow.click(); deny.click(); });
  assert.equal(h.permissions.length, 1); assert.equal(h.permissions[0]!.result.approved, choice === "allow");
});

test("replacement approval starts with fresh full-yes confirmation and no session grant", async t => {
  const h = await fixture(t); await h.emit("onSessionHandoff", { projectId: "a", sessionId: "session-a" });
  const first = permissionEvents("session-a", "strict-a").at(-1)!;
  assert.equal(first.type, "permission.requested"); first.request.requireFullYes = true;
  await h.permissionEvent(first);
  assert.equal(h.document.querySelector<HTMLButtonElement>(".permission-actions button.is-primary")!.disabled, true);
  assert.equal(h.document.querySelector(".permission-actions button.is-session"), null);
  const input = h.document.querySelector<HTMLInputElement>('.permission-confirmation input[placeholder="yes"]')!;
  await h.React.act(async () => {
    Object.getOwnPropertyDescriptor(h.window.HTMLInputElement.prototype, "value")!.set!.call(input, "yes");
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  });
  await h.click(".permission-actions button.is-primary");
  assert.equal(h.permissions[0]!.result.confirmation, "yes");
  await h.permissionEvent({ ...resolution(true), requestId: "strict-a" });
  await h.permissionEvent({ ...first, requestId: "strict-b" });
  await h.settle(0, true);
  assert.equal(h.document.querySelector<HTMLInputElement>('.permission-confirmation input[placeholder="yes"]')!.value, "");
  assert.equal(h.document.querySelector<HTMLButtonElement>(".permission-actions button.is-primary")!.disabled, true);
  assert.equal(h.document.querySelector(".permission-actions button.is-session"), null);
  assert.equal(h.permissions.length, 1);
});
