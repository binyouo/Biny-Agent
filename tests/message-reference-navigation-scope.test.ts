/** Real App message-menu references retain their navigation scope across async source lookup. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type {
  DesktopApi, DesktopBootstrap, DesktopSessionDocument, DesktopSessionSummary, DesktopWorkspaceSnapshot
} from "../src/desktop/protocol.js";

const PROJECT = "reference-project";
const PROJECT_C = "reference-other-project";
const SESSION = "reference-session-a";
const SESSION_B = "reference-session-b";
const SESSION_C = "reference-session-c";
const MESSAGE = "reference-answer-a";
const SOURCE_LABEL = "Referenced source";
const TIME = "2026-10-18T12:00:00.000Z";
const SESSIONS = [
  { id: SESSION, projectId: PROJECT, title: "Reference source A", messageId: MESSAGE },
  { id: SESSION_B, projectId: PROJECT, title: "Reference destination B", messageId: "reference-answer-b" },
  { id: SESSION_C, projectId: PROJECT_C, title: "Reference destination C", messageId: "reference-answer-c" }
];
type Reference = Awaited<ReturnType<DesktopApi["referenceForMessage"]>>;
type Sender = "user" | "assistant";
function sessionInfo(id: string) {
  const info = SESSIONS.find(item => item.id === id);
  assert.ok(info, "Only declared fixture sessions are available");
  return info;
}
// Dependencies may retain RAF's function identity when first imported. Keep
// these forwarding functions stable across the file's sequential DOM fixtures.
let nextFrameId = 0;
let frameHost: { request(callback: FrameRequestCallback): number; cancel(id: number): void } | undefined;
function requestFrame(callback: FrameRequestCallback): number {
  assert.equal(frameHost !== undefined, true, "RAF must belong to an active fixture");
  return frameHost!.request(callback);
}
function cancelFrame(id: number): void { frameHost?.cancel(id); }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function aggregateErrorDetails(error: AggregateError): string {
  const details: string[] = [];
  const seen = new Set<Error>();
  let limited = false;
  const visit = (value: unknown, depth: number): void => {
    if (details.length >= 12) { limited = true; return; }
    if (!(value instanceof Error)) { details.push(`non-Error thrown value (${typeof value})`); return; }
    if (seen.has(value)) { details.push("repeated Error reference"); return; }
    seen.add(value);
    const header = `${value.name.slice(0, 80)}: ${value.message.slice(0, 500)}`;
    const stack = (value.stack ?? "").slice(0, 1_000).split("\n").slice(1, 5).join("\n");
    details.push(`${"  ".repeat(depth)}${header}${stack ? `\n${stack}` : ""}`);
    if (!(value instanceof AggregateError)) return;
    if (depth >= 3) { limited = true; return; }
    for (const nested of value.errors) {
      if (details.length >= 12) { limited = true; break; }
      visit(nested, depth + 1);
    }
  };
  visit(error, 0);
  const output = details.join("\n");
  return (output.slice(0, 11_970) + (limited || output.length > 11_970 ? "\n[diagnostic limit reached]" : "")).slice(0, 12_000);
}

function snapshots() {
  const projects = [PROJECT, PROJECT_C].map(id => ({ id, name: id, path: "/synthetic/" + id,
    dirty: false, missing: false, pinned: false, addedAt: TIME, lastOpenedAt: TIME }));
  const sessions: DesktopSessionSummary[] = SESSIONS.map(item => ({
    id: item.id, projectId: item.projectId, fileName: item.id + ".jsonl", title: item.title,
    firstUserMessage: "Read " + item.title + ".", lastAssistantMessage: "Answer for " + item.title + ".",
    eventCount: 2, createdAt: TIME, updatedAt: TIME, pinned: false, status: "completed"
  }));
  const workspaces = new Map(projects.map((project): [string, DesktopWorkspaceSnapshot] => [project.id, {
    project, sessions: sessions.filter(item => item.projectId === project.id),
    selectedSessionId: project.id === PROJECT ? SESSION : SESSION_C, permissionMode: "ask",
    capabilityDefaults: { tools: "none", skills: "none" }, requiresModelConfiguration: false,
    pickerModels: [], models: [], connections: []
  } satisfies DesktopWorkspaceSnapshot]));
  const documents = new Map(sessions.map((item): [string, DesktopSessionDocument] => [item.id, {
    session: item,
    events: [
      { type: "user_message", time: TIME, messageId: item.id + "-user", content: item.firstUserMessage! },
      { type: "assistant_message", time: TIME, messageId: sessionInfo(item.id).messageId,
        replyToMessageId: item.id + "-user", slotId: item.id + "-answer-slot", content: item.lastAssistantMessage! }
    ], liveEvents: []
  }]));
  const bootstrap: DesktopBootstrap = {
    version: "test", platform: "linux", projects, sidebarSessions: sessions,
    activeProjectId: PROJECT, selectedSessionId: SESSION, activeView: "chat", workspace: workspaces.get(PROJECT)!,
    sidebarWidth: 248, filePanelWidth: 360, themePreference: "light", fontPreference: { family: "system", size: 13 }
  };
  return { bootstrap, documents, workspaces };
}

async function fixture(t: TestContext) {
  try { return await setupFixture(t); }
  catch (error) {
    if (error instanceof AggregateError) t.diagnostic(aggregateErrorDetails(error));
    throw error;
  }
}

async function setupFixture(t: TestContext) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); assets?: ReturnType<typeof registerHooks> } = {};
  let timersEnabled = false;
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const pending = deferred<Reference>();
  const navigation = deferred<DesktopSessionDocument>();
  const inFlight = new Set<Promise<unknown>>();
  let pendingSettled = false;
  let holdNavigation = false;
  let source: Reference | undefined;
  const tracked = <T,>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    inFlight.add(promise);
    void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
  };
  const data = snapshots();
  const subscriptions = new Set<symbol>();
  // Register before imports, globals, loader hooks or createRoot: a partial setup
  // failure must receive exactly the same cleanup as a failed assertion.
  t.after(async () => {
    const { dom, root, React, assets } = resources;
    const errors: unknown[] = [];
    try {
      const release = async (): Promise<void> => {
        if (!pendingSettled && source) { pendingSettled = true; pending.resolve(source); }
        navigation.resolve(data.documents.get(SESSION_B)!);
        while (inFlight.size) await Promise.allSettled([...inFlight]);
      };
      // Drain the real async handlers through act before unmounting/restoring
      // globals, even when an earlier assertion left the external gate pending.
      if (React) await React.act(release);
      else await release();
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        if (root && React) await React.act(() => root!.unmount());
        assert.equal(subscriptions.size, 0, "All App subscriptions must unsubscribe");
      } catch (error) {
        errors.push(error);
      } finally {
        try { assets?.deregister(); }
        catch (error) { errors.push(error); }
        finally {
          try { dom?.window.close(); }
          catch (error) { errors.push(error); }
          finally {
            try { if (timersEnabled) t.mock.timers.reset(); }
            catch (error) { errors.push(error); }
            finally {
              try { frames.clear(); }
              catch (error) { errors.push(error); }
              for (const undo of restore.reverse()) {
                try { undo(); } catch (error) { errors.push(error); }
              }
            }
          }
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Failed to restore message reference fixture");
  });

  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  const { JSDOM: DOM } = await import("jsdom");
  const dom = new DOM('<!doctype html><button id="focus-sentinel">Outside input</button><div id="root"></div>',
    { url: "https://biny.test", pretendToBeVisual: true });
  resources.dom = dom;
  const window = dom.window;
  const document = window.document;
  let frameTime = 0;
  assert.equal(frameHost === undefined, true, "DOM fixtures must run sequentially");
  const previousFrameHost = frameHost;
  restore.push(() => { frameHost = previousFrameHost; });
  frameHost = {
    request(callback) { const id = ++nextFrameId; frames.set(id, callback); return id; },
    cancel(id) { frames.delete(id); }
  };
  class LayoutObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  for (const [key, value] of Object.entries({
    window, document, self: window, navigator: window.navigator, CSS: window.CSS,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    Document: window.Document, Range: window.Range, Selection: window.Selection, NodeFilter: window.NodeFilter,
    DOMParser: window.DOMParser, HTMLDialogElement: window.HTMLDialogElement,
    SVGElement: window.SVGElement, HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLCanvasElement: window.HTMLCanvasElement,
    Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent, CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: LayoutObserver,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    IS_REACT_ACT_ENVIRONMENT: true
  })) replace(globalThis, key, value);
  replace(window, "requestAnimationFrame", requestFrame);
  replace(window, "cancelAnimationFrame", cancelFrame);
  replace(window, "ResizeObserver", LayoutObserver);
  replace(window, "matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true
  }));
  replace(document, "fonts", { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() });
  replace(window.HTMLCanvasElement.prototype, "getContext", () => null);
  replace(window.HTMLElement.prototype, "scrollIntoView", () => {});
  // Actual message menus need their anchor rectangle; no product component is replaced.
  replace(window.HTMLElement.prototype, "getBoundingClientRect", () => new window.DOMRect(120, 180, 220, 24));

  const calls = { source: [] as Array<Parameters<DesktopApi["referenceForMessage"]>>,
    selection: [] as Array<Parameters<DesktopApi["commitSelection"]>>,
    opened: [] as Array<Parameters<DesktopApi["openSession"]>>,
    projects: [] as string[], network: [] as string[], bootstrap: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    calls.network.push("fetch"); throw new Error("Unexpected fetch in message-reference fixture");
  });
  t.mock.method(Socket.prototype, "connect", () => {
    calls.network.push("socket"); throw new Error("Unexpected socket in message-reference fixture");
  });
  const subscribe = (): (() => void) => {
    const token = Symbol("subscription"); subscriptions.add(token);
    return () => { subscriptions.delete(token); };
  };
  let bootstrap = data.bootstrap;
  let importsChanged: (() => void) | undefined;
  let handoff: Parameters<DesktopApi["onSessionHandoff"]>[0] | undefined;
  const api = {
    bootstrap: async () => { calls.bootstrap += 1; return bootstrap; },
    selectProject: async (projectId: string) => {
      calls.projects.push(projectId);
      const workspace = data.workspaces.get(projectId); assert.ok(workspace);
      return workspace;
    },
    openSession: (...args: Parameters<DesktopApi["openSession"]>) => tracked(async () => {
      const [projectId, sessionId] = args;
      calls.opened.push(args);
      const next = data.documents.get(sessionId); assert.ok(next);
      assert.equal(next.session.projectId, projectId);
      if (holdNavigation && sessionId === SESSION_B) return await navigation.promise;
      return next;
    }),
    commitSelection: async (...args: Parameters<DesktopApi["commitSelection"]>) => { calls.selection.push(args); },
    recipeSuggestions: async () => [],
    skillCatalog: async () => ({ skills: [], inventory: [], unmanagedSkills: [], plugins: [], warnings: [], diagnostics: [] }),
    skillSettings: async (projectId: string) => ({ projectId, projectKey: projectId, globalDefaults: {}, projectOverrides: {}, activations: [] }),
    toolCatalog: async () => [], listProjectBranches: async () => [],
    planProjection: async (_projectId: string, sessionId: string) => ({ sessionId, plans: [] }),
    onAppearanceChanged: subscribe,
    onApplicationImportsChanged: (listener: () => void) => {
      importsChanged = listener; const unsubscribe = subscribe();
      return () => { if (importsChanged === listener) importsChanged = undefined; unsubscribe(); };
    },
    onSessionHandoff: (listener: Parameters<DesktopApi["onSessionHandoff"]>[0]) => {
      handoff = listener; const unsubscribe = subscribe();
      return () => { if (handoff === listener) handoff = undefined; unsubscribe(); };
    },
    onAgentEvent: subscribe, onMenuAction: subscribe, onSettingsCloseRequest: subscribe,
    onBrowserOpenRequest: subscribe, onReferenceOpen: subscribe,
    referenceForMessage: (...args: Parameters<DesktopApi["referenceForMessage"]>) => tracked(async () => {
      calls.source.push(args);
      const [projectId, threadId, messageId] = args;
      assert.equal(projectId, sessionInfo(threadId).projectId);
      assert.ok([sessionInfo(threadId).messageId, threadId + "-user"].includes(messageId));
      const result: Reference = { kind: "message", uri: "biny://thread/" + threadId + "/message/" + messageId,
        label: SOURCE_LABEL, content: "Canonical source body.", projectId, threadId, messageId };
      if (calls.source.length === 1) { source = result; return await pending.promise; }
      return result;
    })
  } satisfies Partial<DesktopApi>;
  replace(window, "biny", new Proxy(api, { get(target, key, receiver) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error("Unexpected window.biny access: " + String(key));
    return Reflect.get(target, key, receiver);
  } }));
  const assets = registerHooks({ resolve(specifier, context, next) {
    // Node selects these packages' UMD main instead of the renderer bundler's
    // module entry. Resolve only to their real published ESM builds; no terminal
    // implementation or product component is replaced by the fixture.
    if (specifier === "@xterm/xterm") return next("@xterm/xterm/lib/xterm.mjs", context);
    if (specifier === "@xterm/addon-fit") return next("@xterm/addon-fit/lib/addon-fit.mjs", context);
    return next(specifier, context);
  }, load(url, context, next) {
    if (/\.(?:svg|png|jpg|webp)(?:\?.*)?$/u.test(url)) return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
    if (/\.css(?:\?.*)?$/u.test(url)) return { format: "module", shortCircuit: true, source: "export {};" };
    return next(url, context);
  } });
  resources.assets = assets;
  const React = await import("react");
  resources.React = React;
  replace(globalThis, "React", React);
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/desktop/renderer/src/App.js");
  const { act, createElement } = React;
  // Freeze toast expiry. RAF remains a controlled queue exercised explicitly below.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  timersEnabled = true;
  const root = createRoot(document.getElementById("root")!);
  resources.root = root;
  await act(async () => { root!.render(createElement(App, { settingsEnabled: false })); });

  const one = <T extends Element>(selector: string): T => {
    const matches = document.querySelectorAll<T>(selector);
    assert.equal(matches.length, 1, `Expected one ${selector}`);
    return matches[0]!;
  };
  const input = (): HTMLTextAreaElement => one<HTMLTextAreaElement>('textarea[aria-label="任务输入"]');
  const assertCurrent = (sessionId: string): void => {
    const info = sessionInfo(sessionId);
    assert.ok(document.querySelector('article[data-message-id="' + info.messageId + '"] .markdown-body'));
    assert.equal(document.querySelector('.biny-sidebar-session-item[aria-current="page"]')?.getAttribute("title"), info.title);
    assert.ok(document.querySelector(".biny-workspace-chat .biny-composer .biny-prompt-editor"));
    assert.equal(input().disabled, false);
    assert.equal(input().closest("[inert]"), null, "The committed conversation must be usable");
  };
  assertCurrent(SESSION);
  assert.equal(document.querySelector(".desktop-toast-message")?.textContent ?? "", "", "Bootstrap must not already be failing");
  assert.deepEqual(calls.selection, [[PROJECT, SESSION, "chat"]]);
  assert.deepEqual(calls.opened, [[PROJECT, SESSION]]);
  assert.equal(input().value, "");

  const frame = async (): Promise<number> => {
    const scheduled = [...frames.keys()];
    frameTime += 16;
    let ran = 0;
    await act(() => {
      for (const id of scheduled) {
        const callback = frames.get(id);
        if (!callback) continue;
        frames.delete(id);
        ran += 1;
        callback(frameTime);
      }
    });
    return ran;
  };
  const drainFrames = async (): Promise<void> => {
    for (let count = 0; frames.size; count += 1) {
      assert.equal(count < 100, true, "Layout RAF queue must become idle before observing quote focus");
      await frame();
    }
  };
  await drainFrames();
  const sentinel = one<HTMLButtonElement>("#focus-sentinel");
  const focusSentinel = async (): Promise<void> => {
    await act(() => sentinel.focus());
    assert.equal(document.activeElement === sentinel, true);
  };
  await focusSentinel();
  const observeInput = () => {
    // Query after navigation: do not spy on the old A or B's detached textarea.
    const target = input();
    const focus = target.focus;
    const setSelectionRange = target.setSelectionRange;
    const counts = { focus: 0, selectionRange: 0 };
    replace(target, "focus", function (options?: FocusOptions): void {
      counts.focus += 1;
      focus.call(target, options);
    });
    replace(target, "setSelectionRange", function (start: number, end: number, direction?: "forward" | "backward" | "none"): void {
      counts.selectionRange += 1;
      setSelectionRange.call(target, start, end, direction);
    });
    return { target, counts };
  };
  const typeInput = async (value: string): Promise<void> => {
    const target = input();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    assert.equal(typeof setter, "function");
    await act(() => {
      setter!.call(target, value);
      target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      target.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.equal(input().value, value, "The real controlled textarea must reflect the edit before settlement");
  };
  const reference = async (sender: Sender = "assistant", sessionId = SESSION): Promise<void> => {
    const info = sessionInfo(sessionId);
    const messageId = sender === "assistant" ? info.messageId : sessionId + "-user";
    const label = sender === "assistant" ? "更多回复操作" : "更多消息操作";
    const before = calls.source.length;
    await act(() => one<HTMLButtonElement>('article[data-message-id="' + messageId + '"] [aria-label="' + label + '"]').click());
    const targets = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .filter(target => target.textContent?.trim() === "引用消息");
    assert.equal(targets.length, 1, "Use the real message menu's reference action");
    await act(async () => { targets[0]!.click(); });
    assert.equal(document.querySelector('[role="menu"]'), null, "Menu closes while lookup is pending");
    assert.equal(calls.source.length, before + 1);
    assert.deepEqual(calls.source.at(-1), [info.projectId, sessionId, messageId]);
  };
  const clickSession = async (sessionId: string): Promise<void> => {
    const info = sessionInfo(sessionId);
    const projectRow = one<HTMLElement>('.biny-project-row[title="/synthetic/' + info.projectId + '"]');
    if (projectRow.getAttribute("aria-expanded") !== "true") {
      await act(() => projectRow.click());
      assert.equal(projectRow.getAttribute("aria-expanded"), "true", "Expand the real project row before choosing its session");
    }
    const targets = [...document.querySelectorAll<HTMLButtonElement>(".biny-sidebar-session-item")]
      .filter(target => target.getAttribute("title") === info.title);
    assert.equal(targets.length, 1, "Expected one actual sidebar button for " + info.title);
    assert.equal(targets[0]!.disabled, false);
    assert.equal(targets[0]!.closest("[inert]"), null);
    await act(async () => { targets[0]!.click(); });
  };
  const navigate = async (sessionId: string): Promise<void> => {
    const opened = calls.opened.length; const committed = calls.selection.length;
    await clickSession(sessionId);
    assert.equal(calls.opened.length, opened + 1);
    assert.deepEqual(calls.opened.at(-1), [sessionInfo(sessionId).projectId, sessionId]);
    assert.equal(calls.selection.length, committed + 1);
    assert.deepEqual(calls.selection.at(-1), [sessionInfo(sessionId).projectId, sessionId, "chat"]);
    assertCurrent(sessionId); await drainFrames(); await focusSentinel();
  };
  const reloadSameSession = async (): Promise<void> => {
    assert.equal(typeof handoff, "function");
    const opened = calls.opened.length; const committed = calls.selection.length;
    await act(async () => { handoff!({ projectId: PROJECT, sessionId: SESSION }); });
    assert.equal(calls.opened.length, opened + 1);
    assert.deepEqual(calls.opened.at(-1), [PROJECT, SESSION]);
    assert.equal(calls.selection.length, committed + 1);
    assert.deepEqual(calls.selection.at(-1), [PROJECT, SESSION, "chat"]);
    assertCurrent(SESSION); await drainFrames(); await focusSentinel();
  };
  const beginNavigation = async (): Promise<void> => {
    holdNavigation = true;
    await clickSession(SESSION_B);
    assert.deepEqual(calls.opened.at(-1), [PROJECT, SESSION_B]);
    assert.deepEqual(calls.selection, [[PROJECT, SESSION, "chat"]], "Destination read is still pending");
    assert.equal(document.querySelector('article[data-message-id="' + MESSAGE + '"]'), null);
    assert.equal(one<HTMLElement>('.biny-status-state[role="status"]').textContent, "正在恢复会话…");
    assert.ok(input().closest("[inert]"), "The origin Composer remains mounted but inert during the destination read");
  };
  const finishNavigation = async (): Promise<void> => {
    await act(async () => { navigation.resolve(data.documents.get(SESSION_B)!); });
    assertCurrent(SESSION_B);
    assert.deepEqual(calls.selection.at(-1), [PROJECT, SESSION_B, "chat"]);
  };
  const rerenderMetadata = async (): Promise<void> => {
    assert.equal(typeof importsChanged, "function");
    const original = bootstrap.workspace!;
    const name = "Updated reference fixture metadata";
    const project = { ...original.project, name };
    bootstrap = { ...bootstrap, projects: [project, ...bootstrap.projects.filter(item => item.id !== PROJECT)],
      workspace: { ...original, project } };
    const before = calls.bootstrap;
    await act(async () => { importsChanged!(); });
    assert.equal(calls.bootstrap, before + 1);
    assert.ok(document.body.textContent?.includes(name)); assertCurrent(SESSION);
  };
  const settle = async (error?: Error): Promise<void> => {
    assert.equal(pendingSettled, false); assert.ok(source, "Reference lookup must have entered the gate");
    await act(async () => {
      pendingSettled = true;
      if (error) pending.reject(error); else pending.resolve(source!);
    });
  };
  return { document, input, observeInput, typeInput, sentinel, calls, reference, clickSession, navigate,
    reloadSameSession, beginNavigation, finishNavigation, rerenderMetadata, focusSentinel, settle, frame,
    tokenCount: () => document.querySelectorAll(".biny-prompt-reference-token").length,
    warning: () => document.querySelector(".desktop-toast-message")?.textContent ?? "" };
}

for (const mode of ["session-b", "project-c", "aba", "same-row", "same-reload", "pending-b"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test("message reference " + outcome + " cannot commit after " + mode + " navigation", { timeout: 20_000 }, async t => {
      const h = await fixture(t);
      await h.reference();
      assert.equal(h.input().value, ""); assert.equal(h.tokenCount(), 0);
      const originalInput = h.input();
      if (mode === "session-b" || mode === "aba") await h.navigate(SESSION_B);
      if (mode === "project-c") { await h.navigate(SESSION_C); assert.deepEqual(h.calls.projects, [PROJECT_C]); }
      if (mode === "aba") await h.navigate(SESSION);
      if (mode === "same-row") {
        await h.clickSession(SESSION);
        assert.equal(h.input(), originalInput);
        assert.deepEqual(h.calls.opened, [[PROJECT, SESSION]], "Current row skips the read but advances the epoch");
        assert.deepEqual(h.calls.selection, [[PROJECT, SESSION, "chat"]]);
      }
      if (mode === "same-reload") { await h.reloadSameSession(); assert.equal(h.input(), originalInput); }
      if (mode !== "same-row" && mode !== "same-reload" && mode !== "pending-b") assert.notEqual(h.input(), originalInput);
      await h.typeInput("Latest independent draft");
      if (mode === "pending-b") await h.beginNavigation();
      await h.focusSentinel();
      const observed = h.observeInput();
      await h.settle(outcome === "failure" ? new Error("Stale message reference failure") : undefined);
      await h.frame();
      assert.equal(h.warning(), "", "Old lookup errors must not affect the new navigation epoch");
      assert.equal(h.input().value, "Latest independent draft", "Old source cannot write into the current draft");
      assert.equal(h.tokenCount(), 0);
      assert.deepEqual(observed.counts, { focus: 0, selectionRange: 0 });
      assert.equal(h.document.activeElement, h.sentinel);
      if (mode === "pending-b") {
        await h.finishNavigation();
        assert.equal(h.input().value, "");
        await h.navigate(SESSION);
        assert.equal(h.input().value, "Latest independent draft", "No hidden mutation was written to the origin draft either");
      }
      if (mode === "aba" && outcome === "success") {
        await h.reference();
        assert.equal(h.input().value, "Latest independent draft @" + SOURCE_LABEL + " ");
        assert.equal(h.tokenCount(), 1, "A fresh explicit request in reopened A still succeeds");
      }
      assert.deepEqual(h.calls.network, []);
    });
  }
}

for (const sender of ["user", "assistant"] as const) {
  test(sender + " message menu preserves same-scope edits and metadata refresh during lookup", { timeout: 20_000 }, async t => {
    const h = await fixture(t);
    await h.reference(sender);
    const originalInput = h.input();
    await h.typeInput("Typed during lookup"); await h.rerenderMetadata();
    assert.equal(h.input(), originalInput);
    assert.deepEqual(h.calls.opened, [[PROJECT, SESSION]]);
    assert.deepEqual(h.calls.selection, [[PROJECT, SESSION, "chat"]]);
    await h.focusSentinel(); const observed = h.observeInput();
    await h.settle();
    assert.equal(h.warning(), "");
    assert.equal(h.input().value, "Typed during lookup @" + SOURCE_LABEL + " ");
    assert.equal(h.tokenCount(), 1);
    assert.equal(observed.counts.focus, 0);
    await h.frame();
    assert.equal(observed.counts.focus, 1, "Keep the existing normal appendText focus behavior");
    assert.equal(h.document.activeElement, observed.target);
    await h.frame(); assert.equal(h.tokenCount(), 1); assert.equal(observed.counts.focus, 1);
    assert.deepEqual(h.calls.network, []);
  });
  test(sender + " message menu reports a current-scope lookup failure", { timeout: 20_000 }, async t => {
    const h = await fixture(t);
    await h.reference(sender); await h.focusSentinel(); const observed = h.observeInput();
    await h.settle(new Error("Current message reference failure")); await h.frame();
    assert.equal(h.warning(), "Current message reference failure");
    assert.equal(h.input().value, ""); assert.equal(h.tokenCount(), 0);
    assert.deepEqual(observed.counts, { focus: 0, selectionRange: 0 });
    assert.equal(h.document.activeElement, h.sentinel);
    assert.deepEqual(h.calls.network, []);
  });
}
