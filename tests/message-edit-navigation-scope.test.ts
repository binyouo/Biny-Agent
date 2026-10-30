/** Real App historical-message edits keep their UI settlement in the submitting navigation and editor. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type {
  DesktopApi, DesktopBootstrap, DesktopSessionDocument, DesktopSessionSummary, DesktopWorkspaceSnapshot
} from "../src/desktop/protocol.js";

const PROJECT = "edit-project";
const PROJECT_C = "edit-other-project";
const SESSION = "edit-session-a";
const SESSION_B = "edit-session-b";
const SESSION_C = "edit-session-c";
const MESSAGE = "edit-answer-a";
const TIME = "2026-10-18T12:00:00.000Z";
const SESSIONS = [
  { id: SESSION, projectId: PROJECT, title: "Edit source A", messageId: MESSAGE },
  { id: SESSION_B, projectId: PROJECT, title: "Edit destination B", messageId: "edit-answer-b" },
  { id: SESSION_C, projectId: PROJECT_C, title: "Edit destination C", messageId: "edit-answer-c" }
];
type Receipt = Awaited<ReturnType<DesktopApi["editPrompt"]>>;
type EditRequest = { args: Parameters<DesktopApi["editPrompt"]>; gate: ReturnType<typeof deferred<Receipt>>; settled: boolean };
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

function snapshots(twoTurns: boolean) {
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
  if (twoTurns) {
    const first = documents.get(SESSION)!;
    // Public summaries are not canonical message-tree nodes. Keep both turns
    // on the real user → assistant → user → assistant ancestry path.
    documents.set(SESSION, { ...first, events: [first.events[0]!,
      { type: "agent_message", time: TIME, messageId: MESSAGE, parentMessageId: SESSION + "-user",
        replyToMessageId: SESSION + "-user", slotId: SESSION + "-answer-slot",
        message: { role: "assistant", content: [{ type: "text", text: first.session.lastAssistantMessage! }] } },
      first.events[1]!,
      { type: "user_message", time: TIME, messageId: SESSION + "-user-second", parentMessageId: MESSAGE, content: "Second source question" },
      { type: "agent_message", time: TIME, messageId: MESSAGE + "-second", parentMessageId: SESSION + "-user-second",
        replyToMessageId: SESSION + "-user-second", slotId: SESSION + "-answer-slot-second",
        message: { role: "assistant", content: [{ type: "text", text: "Second source reply" }] } },
      { type: "assistant_message", time: TIME, messageId: MESSAGE + "-second", replyToMessageId: SESSION + "-user-second",
        slotId: SESSION + "-answer-slot-second", content: "Second source reply" }
    ] });
  }
  const bootstrap: DesktopBootstrap = {
    version: "test", platform: "linux", projects, sidebarSessions: sessions,
    activeProjectId: PROJECT, selectedSessionId: SESSION, activeView: "chat", workspace: workspaces.get(PROJECT)!,
    sidebarWidth: 248, filePanelWidth: 360, themePreference: "light", fontPreference: { family: "system", size: 13 }
  };
  return { bootstrap, documents, workspaces };
}

async function fixture(t: TestContext, twoTurns = false) {
  try { return await setupFixture(t, twoTurns); }
  catch (error) {
    if (error instanceof AggregateError) t.diagnostic(aggregateErrorDetails(error));
    throw error;
  }
}

async function setupFixture(t: TestContext, twoTurns: boolean) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); assets?: ReturnType<typeof registerHooks> } = {};
  let timersEnabled = false;
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const edits: EditRequest[] = [];
  const heldReads: Array<{ sessionId: string; entered: boolean; gate: ReturnType<typeof deferred<DesktopSessionDocument>> }> = [];
  const heldRefreshes: Array<{ projectId: string; entered: boolean; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const inFlight = new Set<Promise<unknown>>();
  const tracked = <T,>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    inFlight.add(promise);
    void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
  };
  const data = snapshots(twoTurns);
  const subscriptions = new Set<symbol>();
  // Register before imports, globals, loader hooks or createRoot: a partial setup
  // failure must receive exactly the same cleanup as a failed assertion.
  t.after(async () => {
    const { dom, root, React, assets } = resources;
    const errors: unknown[] = [];
    try {
      const release = async (): Promise<void> => {
        for (const edit of edits) {
          if (!edit.settled) { edit.settled = true; edit.gate.resolve(receiptFor(edit)); }
        }
        for (const held of heldReads) held.gate.resolve(data.documents.get(held.sessionId)!);
        for (const held of heldRefreshes) held.gate.resolve(data.workspaces.get(held.projectId)!);
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
    if (errors.length) throw new AggregateError(errors, "Failed to restore message edit fixture");
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

  const calls = { refresh: [] as string[],
    selection: [] as Array<Parameters<DesktopApi["commitSelection"]>>,
    opened: [] as Array<Parameters<DesktopApi["openSession"]>>,
    projects: [] as string[], network: [] as string[], bootstrap: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    calls.network.push("fetch"); throw new Error("Unexpected fetch in message-edit fixture");
  });
  t.mock.method(Socket.prototype, "connect", () => {
    calls.network.push("socket"); throw new Error("Unexpected socket in message-edit fixture");
  });
  const subscribe = (): (() => void) => {
    const token = Symbol("subscription"); subscriptions.add(token);
    return () => { subscriptions.delete(token); };
  };
  const bootstrap = data.bootstrap;
  // Distinct real edit gestures must get distinct nonce timestamps even on a fast CI runner.
  let now = Date.now();
  t.mock.method(Date, "now", () => ++now);
  const receiptFor = (edit: EditRequest): Receipt => ({ sessionId: edit.args[1], runId: "edit-run-" + edits.indexOf(edit), messageId: "edited-message-" + edits.indexOf(edit) });
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
      const held = heldReads.find(read => read.sessionId === sessionId && !read.entered);
      if (held) { held.entered = true; return await held.gate.promise; }
      return next;
    }),
    commitSelection: async (...args: Parameters<DesktopApi["commitSelection"]>) => { calls.selection.push(args); },
    refreshProject: (projectId: string) => tracked(async () => {
      calls.refresh.push(projectId);
      const workspace = data.workspaces.get(projectId); assert.ok(workspace);
      const held = heldRefreshes.find(refresh => refresh.projectId === projectId && !refresh.entered);
      if (held) { held.entered = true; return await held.gate.promise; }
      return workspace;
    }),
    recipeSuggestions: async () => [],
    skillCatalog: async () => ({ skills: [], inventory: [], unmanagedSkills: [], plugins: [], warnings: [], diagnostics: [] }),
    skillSettings: async (projectId: string) => ({ projectId, projectKey: projectId, globalDefaults: {}, projectOverrides: {}, activations: [] }),
    toolCatalog: async () => [], listProjectBranches: async () => [],
    planProjection: async (_projectId: string, sessionId: string) => ({ sessionId, plans: [] }),
    onAppearanceChanged: subscribe,
    onApplicationImportsChanged: subscribe, onSessionHandoff: subscribe,
    onAgentEvent: subscribe, onMenuAction: subscribe, onSettingsCloseRequest: subscribe,
    onBrowserOpenRequest: subscribe, onReferenceOpen: subscribe,
    preparePrompt: async (projectId: string) => { assert.ok([PROJECT, PROJECT_C].includes(projectId)); },
    editPrompt: (...args: Parameters<DesktopApi["editPrompt"]>) => tracked(async () => {
      const [projectId, sessionId, index, input, attachments, key] = args;
      assert.equal(projectId, sessionInfo(sessionId).projectId);
      assert.ok(index === 0 || (twoTurns && sessionId === SESSION && index === 1), "The API target must be one of the declared editable messages");
      assert.ok(input.trim()); assert.deepEqual(attachments, []);
      assert.equal(typeof key, "string"); assert.ok(key);
      const edit = { args, gate: deferred<Receipt>(), settled: false };
      edits.push(edit);
      return await edit.gate.promise;
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
    assert.equal(input().closest("[inert]") === null, true, "The committed conversation must be usable");
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
      assert.equal(count < 100, true, "Layout RAF queue must become idle");
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
  const typeInput = async (value: string): Promise<void> => {
    const target = input();
    assert.equal(target.disabled, false, "Only type through an enabled editor");
    assert.equal(target.closest("[inert]") === null, true, "Only type in the current visible conversation");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    assert.equal(typeof setter, "function");
    await act(() => {
      setter!.call(target, value);
      target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      target.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.equal(input().value, value, "The real controlled textarea must reflect the edit before settlement");
  };
  const beginEdit = async (sessionId = SESSION, index = 0): Promise<void> => {
    const suffix = index === 1 ? "-user-second" : "-user";
    const target = one<HTMLButtonElement>('article[data-message-id="' + sessionId + suffix + '"] [aria-label="编辑消息"]');
    assert.equal(target.disabled, false); assert.equal(target.closest("[inert]") === null, true);
    await act(() => target.click());
    assert.ok(document.querySelector(".composer-edit-banner"));
    assert.equal(input().value, index === 1 ? "Second source question" : data.documents.get(sessionId)!.session.firstUserMessage);
  };
  const submit = async (): Promise<void> => {
    const button = one<HTMLButtonElement>('[aria-label="发送消息"]');
    assert.equal(button.disabled, false); assert.notEqual(button.getAttribute("aria-disabled"), "true");
    assert.equal(button.closest("[inert]") === null, true);
    const before = edits.length;
    await act(async () => { button.click(); });
    assert.equal(edits.length, before + 1, "The public edit API must receive exactly one submission");
    assert.equal(input().disabled, true, "The pending edit disables keyboard input");
    assert.equal(one<HTMLButtonElement>('[aria-label="发送消息"]').getAttribute("aria-disabled"), "true");
  };
  const cancelEdit = async (): Promise<void> => {
    const button = one<HTMLButtonElement>('[aria-label="取消编辑"]');
    assert.equal(button.disabled, false); assert.equal(button.closest("[inert]") === null, true);
    await act(() => button.click());
    assert.equal(document.querySelector(".composer-edit-banner") === null, true);
  };
  const settle = async (index = 0, error?: Error): Promise<void> => {
    const edit = edits[index]; assert.ok(edit); assert.equal(edit.settled, false);
    await act(async () => {
      edit.settled = true;
      if (error) edit.gate.reject(error); else edit.gate.resolve(receiptFor(edit));
    });
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
    assert.equal(targets[0]!.closest("[inert]") === null, true);
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
  const holdRead = (sessionId: string) => {
    const held = { sessionId, entered: false, gate: deferred<DesktopSessionDocument>() };
    heldReads.push(held);
    return { entered: () => held.entered, async release() { await act(async () => { held.gate.resolve(data.documents.get(sessionId)!); }); } };
  };
  const holdRefresh = (projectId: string) => {
    const held = { projectId, entered: false, gate: deferred<DesktopWorkspaceSnapshot>() };
    heldRefreshes.push(held);
    return { entered: () => held.entered, async release(error?: Error) { await act(async () => {
      if (error) held.gate.reject(error); else held.gate.resolve(data.workspaces.get(projectId)!);
    }); } };
  };
  const updateReadDocument = (sessionId: string, assistant: string): void => {
    const current = data.documents.get(sessionId); assert.ok(current);
    data.documents.set(sessionId, { ...current, events: current.events.map(event => event.type === "assistant_message" ? { ...event, content: assistant } : event) });
  };
  return { document, input, typeInput, sentinel, calls, edits, beginEdit, submit, cancelEdit,
    clickSession, navigate, assertCurrent, focusSentinel, settle, frame, drainFrames,
    holdRead, holdRefresh, updateReadDocument,
    warning: () => document.querySelector(".desktop-toast-message")?.textContent ?? "" };
}

for (const destination of [SESSION_B, SESSION_C]) {
  test("late edit receipt preserves the current conversation and its ordinary draft: " + destination, { timeout: 20_000 }, async t => {
    const h = await fixture(t);
    await h.typeInput("Source unsent draft");
    await h.beginEdit(); await h.typeInput("Submitted source edit"); await h.submit();
    await h.navigate(destination); await h.typeInput("Destination unsent draft");
    const currentInput = h.input();
    await h.settle(); await h.drainFrames();
    h.assertCurrent(destination);
    assert.equal(h.input() === currentInput, true, "An old receipt cannot replace the destination Composer");
    assert.equal(h.input().value, "Destination unsent draft");
    assert.deepEqual(h.edits[0]!.args.slice(0, 5), [PROJECT, SESSION, 0, "Submitted source edit", []]);
    assert.deepEqual(h.calls.selection.at(-1), [sessionInfo(destination).projectId, destination, "chat"]);
    await h.navigate(SESSION); assert.equal(h.input().value, "Source unsent draft");
    assert.deepEqual(h.calls.network, []);
  });

  for (const outcome of ["success", "failure"] as const) {
    test("old edit " + outcome + " preserves a newer editor in " + destination, { timeout: 20_000 }, async t => {
      const h = await fixture(t);
      await h.beginEdit(); await h.typeInput("Submitted source edit"); await h.submit();
      await h.navigate(destination); await h.typeInput("Destination ordinary draft");
      await h.beginEdit(destination); await h.typeInput("Destination edited message");
      const currentInput = h.input();
      await h.settle(0, outcome === "failure" ? new Error("Old source edit failed") : undefined);
      await h.drainFrames();
      h.assertCurrent(destination);
      assert.equal(h.input() === currentInput, true);
      assert.ok(h.document.querySelector(".composer-edit-banner"), "Old settlement cannot cancel the newer edit");
      assert.equal(h.input().value, "Destination edited message");
      assert.equal(h.document.body.textContent?.includes("Old source edit failed"), false);
      await h.typeInput("Destination continued edit"); await h.submit();
      assert.deepEqual(h.edits[1]!.args.slice(0, 5), [sessionInfo(destination).projectId, destination, 0, "Destination continued edit", []]);
      await h.settle(1);
      assert.equal(h.document.querySelector(".composer-edit-banner") === null, true);
      assert.equal(h.input().value, "Destination ordinary draft");
      assert.deepEqual(h.calls.network, []);
    });
  }
}

test("same-ID A to B to A navigation preserves a newly opened edit from A's older receipt", { timeout: 20_000 }, async t => {
  const h = await fixture(t);
  await h.beginEdit(); await h.typeInput("First source edit"); await h.submit();
  await h.navigate(SESSION_B); await h.navigate(SESSION);
  await h.beginEdit(); await h.typeInput("New source edit after returning");
  const currentInput = h.input();
  await h.settle(); await h.drainFrames();
  assert.ok(h.document.querySelector(".composer-edit-banner"));
  assert.equal(h.input() === currentInput, true);
  assert.equal(h.input().disabled, false);
  assert.equal(h.input().value, "New source edit after returning");
  assert.ok(h.document.querySelector('article[data-message-id="' + MESSAGE + '"] .markdown-body'),
    "The reloaded original conversation must not be replaced by the old optimistic prefix");
  assert.deepEqual(h.calls.network, []);
});

for (const outcome of ["success", "failure"] as const) {
  test("old edit " + outcome + " cannot settle a newer pending edit", { timeout: 20_000 }, async t => {
    const h = await fixture(t);
    await h.beginEdit(); await h.typeInput("Source request"); await h.submit();
    await h.navigate(SESSION_B);
    await h.beginEdit(SESSION_B); await h.typeInput("Destination request"); await h.submit();
    const currentInput = h.input();
    await h.settle(0, outcome === "failure" ? new Error("Old source failure") : undefined);
    await h.drainFrames();
    assert.equal(h.input() === currentInput, true);
    assert.equal(h.input().disabled, true, "Only the newer request may release its own pending state");
    assert.ok(h.document.querySelector(".composer-edit-banner"));
    const bubbles = [...h.document.querySelectorAll(".user-bubble")].map(element => element.textContent);
    assert.ok(bubbles.some(text => text?.includes("Destination request")), "The new pending optimistic edit remains visible");
    assert.equal(h.document.body.textContent?.includes("Old source failure"), false);
    await h.settle(1);
    assert.equal(h.input().disabled, false);
    assert.equal(h.document.querySelector(".composer-edit-banner") === null, true);
    assert.deepEqual(h.calls.network, []);
  });
}

test("current edit succeeds once, disables repeated submission, and restores the separate ordinary draft", { timeout: 20_000 }, async t => {
  const h = await fixture(t);
  await h.typeInput("Ordinary draft to preserve");
  await h.beginEdit(); await h.typeInput("Confirmed current edit"); await h.submit();
  const button = h.document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!;
  assert.equal(button.getAttribute("aria-disabled"), "true"); button.click();
  assert.equal(h.edits.length, 1, "The aria-disabled send action cannot duplicate the pending edit");
  await h.settle(); await h.drainFrames();
  assert.equal(h.document.querySelector(".composer-edit-banner") === null, true);
  assert.equal(h.input().value, "Ordinary draft to preserve");
  assert.equal(h.input().disabled, false);
  assert.equal(h.document.querySelector('.biny-sidebar-session-item[aria-current="page"]')?.getAttribute("title"), sessionInfo(SESSION).title);
  assert.equal(h.warning(), ""); assert.deepEqual(h.calls.network, []);
});

test("current edit failure retains edited text and a deliberate retry uses a fresh operation key", { timeout: 20_000 }, async t => {
  const h = await fixture(t);
  await h.typeInput("Separate ordinary draft");
  await h.beginEdit(); await h.typeInput("Failed current edit"); await h.submit();
  await h.settle(0, new Error("Current edit failed")); await h.drainFrames();
  h.assertCurrent(SESSION);
  assert.ok(h.document.querySelector(".composer-edit-banner"));
  assert.equal(h.input().value, "Failed current edit");
  assert.ok(h.document.body.textContent?.includes("Current edit failed"));
  assert.deepEqual(h.calls.refresh, [PROJECT]);
  await h.typeInput("Retried current edit"); await h.submit();
  assert.notEqual(h.edits[1]!.args[5], h.edits[0]!.args[5]);
  assert.deepEqual(h.edits[1]!.args.slice(0, 5), [PROJECT, SESSION, 0, "Retried current edit", []]);
  await h.settle(1);
  assert.equal(h.input().value, "Separate ordinary draft");
  assert.equal(h.document.querySelector(".composer-edit-banner") === null, true);
  assert.equal(h.document.body.textContent?.includes("Current edit failed"), false);
  assert.deepEqual(h.calls.network, []);
});

test("canceling an unsubmitted historical edit restores the separate ordinary draft without an API write", { timeout: 20_000 }, async t => {
  const h = await fixture(t);
  await h.typeInput("Ordinary draft");
  await h.beginEdit(); await h.typeInput("Canceled historical edit"); await h.cancelEdit();
  assert.equal(h.input().value, "Ordinary draft"); assert.equal(h.input().disabled, false);
  assert.equal(h.edits.length, 0); assert.deepEqual(h.calls.network, []);
});

test("old edit failure cannot publish while destination navigation is still pending", { timeout: 20_000 }, async t => {
  const h = await fixture(t);
  await h.beginEdit(); await h.typeInput("Source edit before navigation"); await h.submit();
  const sourceInput = h.input();
  const navigation = h.holdRead(SESSION_B);
  await h.clickSession(SESSION_B);
  assert.equal(navigation.entered(), true);
  assert.equal(h.input() === sourceInput, true, "The old Composer is still mounted during loading");
  assert.ok(h.input().closest("[inert]"));
  await h.settle(0, new Error("Failure belonging to superseded source")); await h.drainFrames();
  assert.equal(h.document.body.textContent?.includes("Failure belonging to superseded source"), false);
  assert.deepEqual(h.calls.refresh, [], "A superseded failure must not refresh or restore the old document");
  assert.deepEqual(h.calls.selection, [[PROJECT, SESSION, "chat"]]);
  await navigation.release();
  h.assertCurrent(SESSION_B); assert.equal(h.input().value, "");
  assert.deepEqual(h.calls.network, []);
});

test("same-ID navigation rejects an old failure before rolling back the reloaded document", { timeout: 20_000 }, async t => {
  const h = await fixture(t);
  await h.beginEdit(); await h.typeInput("Source edit before reload"); await h.submit();
  await h.navigate(SESSION_B);
  h.updateReadDocument(SESSION, "Fresh reply loaded after returning");
  await h.navigate(SESSION);
  await h.beginEdit(); await h.typeInput("New source edit after reload");
  const refresh = h.holdRefresh(PROJECT);
  await h.settle(0, new Error("Old pre-navigation failure"));
  assert.ok(h.document.body.textContent?.includes("Fresh reply loaded after returning"),
    "The stale catch must not replace the latest loaded document with its original snapshot");
  assert.equal(refresh.entered(), false);
  assert.deepEqual(h.calls.refresh, []);
  assert.ok(h.document.querySelector(".composer-edit-banner"));
  assert.equal(h.input().value, "New source edit after reload");
  assert.deepEqual(h.calls.network, []);
});

for (const outcome of ["success", "failure"] as const) {
  test("navigation during current edit recovery suppresses the eventual old error after refresh " + outcome, { timeout: 20_000 }, async t => {
    const h = await fixture(t);
    await h.beginEdit(); await h.typeInput("Source edit awaiting recovery"); await h.submit();
    const refresh = h.holdRefresh(PROJECT);
    await h.settle(0, new Error("Source edit recovery failure"));
    assert.equal(refresh.entered(), true, "The failure was current when recovery began");
    const navigation = h.holdRead(SESSION_B);
    await h.clickSession(SESSION_B);
    assert.equal(navigation.entered(), true); assert.ok(h.input().closest("[inert]"));
    await refresh.release(outcome === "failure" ? new Error("Recovery refresh failed") : undefined);
    await h.drainFrames();
    assert.equal(h.document.body.textContent?.includes("Source edit recovery failure"), false);
    assert.equal(h.document.body.textContent?.includes("Recovery refresh failed"), false);
    await navigation.release();
    h.assertCurrent(SESSION_B); assert.equal(h.input().value, "");
    assert.deepEqual(h.calls.network, []);
  });
}

for (const cancelFirst of [false, true]) {
  for (const outcome of ["success", "failure"] as const) {
    test("same-session newer message edit survives old " + outcome + (cancelFirst ? " after explicit cancel" : " after selecting another message"), { timeout: 20_000 }, async t => {
      const h = await fixture(t, true);
      for (const suffix of ["-user", "-user-second"]) {
        const buttons = h.document.querySelectorAll<HTMLButtonElement>('article[data-message-id="' + SESSION + suffix + '"] [aria-label="编辑消息"]');
        assert.equal(buttons.length, 1, "Both linked history turns must expose their real edit action before submission");
        assert.equal(buttons[0]!.disabled, false);
        assert.equal(buttons[0]!.closest("[inert]") === null, true);
      }
      await h.typeInput("Separate current-session draft");
      await h.beginEdit(SESSION, 1); await h.typeInput("Submitted second-message edit"); await h.submit();
      assert.equal(h.edits[0]!.args[2], 1);
      if (cancelFirst) await h.cancelEdit();
      await h.beginEdit(SESSION, 0);
      assert.equal(h.input().disabled, true, "Switching edit targets does not bypass the pending submit gate");
      assert.equal(h.input().value, "Read Edit source A.", "The real earlier-message action selects its own text");
      await h.settle(0, outcome === "failure" ? new Error("Earlier second-message edit failed") : undefined);
      await h.drainFrames();
      assert.ok(h.document.querySelector(".composer-edit-banner"), "The old settlement must not dismiss the newer message editor");
      assert.equal(h.input().disabled, false);
      assert.equal(h.input().value, "Read Edit source A.", "The old failed draft cannot replace text belonging to a different message index");
      assert.equal(h.document.body.textContent?.includes("Earlier second-message edit failed"), false);
      await h.typeInput("Explicit first-message edit"); await h.submit();
      assert.deepEqual(h.edits[1]!.args.slice(0, 5), [PROJECT, SESSION, 0, "Explicit first-message edit", []]);
      await h.settle(1);
      assert.equal(h.document.querySelector(".composer-edit-banner") === null, true);
      assert.equal(h.input().value, "Separate current-session draft");
      assert.deepEqual(h.calls.network, []);
    });
  }
}
