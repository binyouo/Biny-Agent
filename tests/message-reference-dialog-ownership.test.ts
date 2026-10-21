/** Real App reference dialogs retain request, navigation and project ownership. */
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
const TIME = "2026-10-18T12:00:00.000Z";
const SESSIONS = [
  { id: SESSION, projectId: PROJECT, title: "Reference source A", messageId: MESSAGE },
  { id: SESSION_B, projectId: PROJECT, title: "Reference destination B", messageId: "reference-answer-b" },
  { id: SESSION_C, projectId: PROJECT_C, title: "Reference destination C", messageId: "reference-answer-c" }
];
type Reference = Awaited<ReturnType<DesktopApi["referenceForMessage"]>>;
type Sender = "user" | "assistant";
type Backlinks = Awaited<ReturnType<DesktopApi["referenceBacklinks"]>>;
type PendingRead<T> = { gate: ReturnType<typeof deferred<T>>; value: T; settled: boolean };
function referenceValue(sessionId: string, sender: Sender): Reference {
  const info = sessionInfo(sessionId);
  const messageId = sender === "assistant" ? info.messageId : sessionId + "-user";
  const slotId = sender === "assistant" ? sessionId + "-answer-slot" : messageId;
  return { kind: "message", uri: "biny://thread/" + sessionId + "/message/" + slotId,
    label: "Referrer " + sender + " in " + sessionId, content: "Canonical " + sender + " source.",
    projectId: info.projectId, threadId: sessionId, messageId };
}
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
  const sourceReads: PendingRead<Reference>[] = [];
  const backlinkReads: PendingRead<Backlinks>[] = [];
  const resolutionReads: PendingRead<Reference>[] = [];
  const navigation = deferred<DesktopSessionDocument>();
  const inFlight = new Set<Promise<unknown>>();
  let holdNavigation = false;
  let holdBacklinks = false;
  let holdResolutions = false;
  const deferRead = <T,>(reads: PendingRead<T>[], value: T): Promise<T> => {
    const read = { gate: deferred<T>(), value, settled: false };
    reads.push(read);
    return read.gate.promise;
  };
  const releaseReads = <T,>(reads: PendingRead<T>[]): void => {
    for (const read of reads) if (!read.settled) { read.settled = true; read.gate.resolve(read.value); }
  };
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
        holdBacklinks = false; holdResolutions = false;
        releaseReads(sourceReads); releaseReads(backlinkReads); releaseReads(resolutionReads);
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
    if (errors.length) throw new AggregateError(errors, "Failed to restore reference dialog fixture");
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
  replace(window, "scrollTo", () => {});
  // JSDOM does not implement native dialog display. Keep the actual Dialog,
  // its close controls, cancellation handlers and App callbacks mounted.
  replace(window.HTMLDialogElement.prototype, "showModal", function (this: HTMLDialogElement): void { this.open = true; });
  replace(window.HTMLDialogElement.prototype, "close", function (this: HTMLDialogElement): void { this.open = false; });
  // Actual message menus need their anchor rectangle; no product component is replaced.
  replace(window.HTMLElement.prototype, "getBoundingClientRect", () => new window.DOMRect(120, 180, 220, 24));

  const calls = { source: [] as Array<Parameters<DesktopApi["referenceForMessage"]>>,
    backlinks: [] as Array<Parameters<DesktopApi["referenceBacklinks"]>>,
    resolved: [] as Array<Parameters<DesktopApi["referenceResolve"]>>,
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
      return await deferRead(sourceReads, referenceValue(threadId, messageId === threadId + "-user" ? "user" : "assistant"));
    }),
    referenceBacklinks: (...args: Parameters<DesktopApi["referenceBacklinks"]>) => tracked(async () => {
      calls.backlinks.push(args);
      const [projectId, uri] = args;
      const target = sourceReads.find(read => read.value.uri === uri)?.value;
      assert.ok(target, "Backlinks require a source URI returned by this fixture");
      if (projectId !== target.projectId) throw new Error("Conversation is not available.");
      const sourceSession = projectId === PROJECT ? SESSION_B : SESSION_C;
      const source = referenceValue(sourceSession, target.messageId === target.threadId + "-user" ? "user" : "assistant");
      const links: Backlinks = [{ sourceUri: source.uri, targetUri: uri, kind: "explicit" }];
      return holdBacklinks ? await deferRead(backlinkReads, links) : links;
    }),
    referenceResolve: (...args: Parameters<DesktopApi["referenceResolve"]>) => tracked(async () => {
      calls.resolved.push(args);
      const [projectId, uri] = args;
      const result = SESSIONS.flatMap(info => [referenceValue(info.id, "user"), referenceValue(info.id, "assistant")])
        .find(reference => reference.uri === uri);
      assert.ok(result, "Only declared canonical reference URIs are resolved");
      if (projectId !== result.projectId) throw new Error("Conversation is not available.");
      return holdResolutions ? await deferRead(resolutionReads, result) : result;
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
  // Compare DOM presence and identity as booleans: assertion failures must not
  // recursively inspect React-owned DOM graphs while constructing diagnostics.
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
  const reference = async (sender: Sender = "assistant", sessionId = SESSION): Promise<number> => {
    assert.equal(document.querySelector("dialog[open]") === null, true, "Never click through an open modal");
    const info = sessionInfo(sessionId);
    const messageId = sender === "assistant" ? info.messageId : sessionId + "-user";
    const label = sender === "assistant" ? "更多回复操作" : "更多消息操作";
    const before = calls.source.length;
    await act(() => one<HTMLButtonElement>('article[data-message-id="' + messageId + '"] [aria-label="' + label + '"]').click());
    const targets = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .filter(target => target.textContent?.trim() === "查看引用来源");
    assert.equal(targets.length, 1, "Use the real message menu's reference action");
    await act(async () => { targets[0]!.click(); });
    assert.equal(document.querySelector('[role="menu"]') === null, true, "Menu closes while lookup is pending");
    assert.equal(calls.source.length, before + 1);
    assert.deepEqual(calls.source.at(-1), [info.projectId, sessionId, messageId]);
    return before;
  };
  const clickSession = async (sessionId: string): Promise<void> => {
    assert.equal(document.querySelector("dialog[open]") === null, true, "Sidebar clicks must not bypass a modal");
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
  const handoffSession = async (sessionId = SESSION): Promise<void> => {
    assert.equal(typeof handoff, "function");
    const info = sessionInfo(sessionId);
    const opened = calls.opened.length; const committed = calls.selection.length;
    // Exercise App's actual desktop event subscription, which can arrive while
    // a native modal is open. This is not a synthetic click through its backdrop.
    await act(async () => { handoff!({ projectId: info.projectId, sessionId }); });
    assert.equal(calls.opened.length, opened + 1);
    assert.deepEqual(calls.opened.at(-1), [info.projectId, sessionId]);
    assert.equal(calls.selection.length, committed + 1);
    assert.deepEqual(calls.selection.at(-1), [info.projectId, sessionId, "chat"]);
    assertCurrent(sessionId); await drainFrames();
  };
  const beginNavigation = async (): Promise<void> => {
    holdNavigation = true;
    await clickSession(SESSION_B);
    assert.deepEqual(calls.opened.at(-1), [PROJECT, SESSION_B]);
    assert.deepEqual(calls.selection, [[PROJECT, SESSION, "chat"]], "Destination read is still pending");
    assert.equal(document.querySelector('article[data-message-id="' + MESSAGE + '"]') === null, true);
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
  const settleRead = async <T,>(reads: PendingRead<T>[], index: number, error?: Error): Promise<void> => {
    const read = reads[index]; assert.ok(read, "The requested API read must have entered its gate");
    assert.equal(read.settled, false);
    await act(async () => {
      read.settled = true;
      if (error) read.gate.reject(error); else read.gate.resolve(read.value);
    });
  };
  const dialog = (): HTMLDialogElement | null => document.querySelector("dialog[open]");
  const assertSource = (sender: Sender = "assistant", sessionId = SESSION_B): HTMLButtonElement => {
    const modal = dialog(); assert.ok(modal, "The real source dialog must be open");
    assert.ok(modal.textContent?.includes("引用来源"));
    const buttons = modal.querySelectorAll<HTMLButtonElement>(".message-references-list button");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]!.querySelector("strong")?.textContent, referenceValue(sessionId, sender).label);
    assert.equal(modal.querySelector('[role="alert"]') === null, true);
    return buttons[0]!;
  };
  const closeDialog = async (mode: "button" | "escape" = "button"): Promise<void> => {
    const modal = dialog(); assert.ok(modal);
    await act(async () => {
      if (mode === "escape") modal.dispatchEvent(new window.Event("cancel", { cancelable: true }));
      else {
        const close = modal.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
        assert.ok(close, "Use the published DialogHeader close button");
        close.click();
      }
    });
    assert.equal(dialog() === null, true, "The real App must clear the closed dialog");
  };
  const openSource = async (sender: Sender = "assistant", sessionId = SESSION_B): Promise<void> => {
    const button = assertSource(sender, sessionId);
    await act(async () => { button.click(); });
    assert.equal(dialog() === null, true);
    assertCurrent(sessionId);
  };
  return { document, input, typeInput, sentinel, calls, reference, clickSession, navigate, assertCurrent,
    handoffSession, beginNavigation, finishNavigation, rerenderMetadata, focusSentinel, frame,
    dialog, assertSource, closeDialog, openSource,
    holdBacklinks: () => { holdBacklinks = true; },
    holdResolutions: () => { holdResolutions = true; },
    settleSource: (index: number, error?: Error) => settleRead(sourceReads, index, error),
    settleBacklinks: (index: number, error?: Error) => settleRead(backlinkReads, index, error),
    settleResolution: (index: number, error?: Error) => settleRead(resolutionReads, index, error),
    warning: () => document.querySelector(".desktop-toast-message")?.textContent ?? "" };
}

for (const mode of ["session-b", "project-c", "aba", "same-row", "same-reload", "pending-b"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test("source dialog " + outcome + " cannot open after " + mode + " navigation", { timeout: 20_000 }, async t => {
      const h = await fixture(t);
      const pending = await h.reference();
      assert.equal(h.dialog() === null, true);
      const originalInput = h.input();
      if (mode === "session-b" || mode === "aba") await h.navigate(SESSION_B);
      if (mode === "project-c") { await h.navigate(SESSION_C); assert.deepEqual(h.calls.projects, [PROJECT_C]); }
      if (mode === "aba") await h.navigate(SESSION);
      if (mode === "same-row") {
        await h.clickSession(SESSION);
        assert.equal(h.input() === originalInput, true);
        assert.deepEqual(h.calls.opened, [[PROJECT, SESSION]], "Current row skips reading but advances navigation intent");
        assert.deepEqual(h.calls.selection, [[PROJECT, SESSION, "chat"]]);
      }
      if (mode === "same-reload") { await h.handoffSession(); assert.equal(h.input() === originalInput, true); }
      if (mode !== "same-row" && mode !== "same-reload" && mode !== "pending-b") assert.equal(h.input() !== originalInput, true);
      await h.typeInput("Latest independent draft");
      if (mode === "pending-b") await h.beginNavigation();
      await h.settleSource(pending, outcome === "failure" ? new Error("Stale source lookup failed") : undefined);
      assert.equal(h.warning(), "", "Old source errors cannot affect the current navigation epoch");
      assert.equal(h.dialog() === null, true, "Old source lookup must not open a dialog in another navigation epoch");
      assert.deepEqual(h.calls.backlinks, [], "Do not read backlinks for a discarded lookup");
      assert.deepEqual(h.calls.resolved, []);
      assert.equal(h.input().value, "Latest independent draft");
      if (mode === "pending-b") {
        await h.finishNavigation();
        await h.navigate(SESSION);
        assert.equal(h.input().value, "Latest independent draft");
      }
      if (mode === "aba") {
        const fresh = await h.reference();
        await h.settleSource(fresh);
        h.assertSource();
        await h.closeDialog();
      }
      assert.deepEqual(h.calls.network, []);
    });
  }
}

for (const state of ["newest-pending", "newest-open", "newest-closed"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test("superseded source " + outcome + " stays inactive while " + state, { timeout: 20_000 }, async t => {
      const h = await fixture(t);
      const old = await h.reference("assistant");
      const latest = await h.reference("user");
      assert.equal(h.dialog() === null, true, "Both real menu actions happen before a modal exists");
      if (state !== "newest-pending") {
        await h.settleSource(latest); h.assertSource("user");
        if (state === "newest-closed") await h.closeDialog();
      }
      const reads = [...h.calls.backlinks];
      await h.settleSource(old, outcome === "failure" ? new Error("Superseded source failed") : undefined);
      assert.equal(h.warning(), "");
      assert.deepEqual(h.calls.backlinks, reads, "The superseded lookup cannot replace the current dialog");
      if (state === "newest-open") h.assertSource("user");
      else assert.equal(h.dialog() === null, true, "A stale result must neither preempt nor reopen a dialog");
      if (state === "newest-pending") {
        await h.settleSource(latest); h.assertSource("user"); await h.closeDialog("escape");
      }
      if (state === "newest-open") await h.closeDialog();
      const fresh = await h.reference("assistant");
      await h.settleSource(fresh); h.assertSource("assistant");
      assert.deepEqual(h.calls.network, []);
    });
  }
}

for (const outcome of ["success", "failure"] as const) {
  test("same-message repeated source " + outcome + " keeps the newer request", { timeout: 20_000 }, async t => {
    const h = await fixture(t);
    const old = await h.reference();
    const latest = await h.reference();
    assert.deepEqual(h.calls.source[0], h.calls.source[1], "Project, session and message IDs are identical");
    await h.settleSource(old, outcome === "failure" ? new Error("Old same-message lookup failed") : undefined);
    assert.equal(h.warning(), ""); assert.equal(h.dialog() === null, true); assert.deepEqual(h.calls.backlinks, []);
    await h.settleSource(latest); h.assertSource();
    assert.equal(h.calls.backlinks.length, 1);
    assert.deepEqual(h.calls.network, []);
  });
}

for (const sender of ["user", "assistant"] as const) {
  test(sender + " source dialog preserves same-scope edits and metadata refresh", { timeout: 20_000 }, async t => {
    const h = await fixture(t);
    const pending = await h.reference(sender);
    const originalInput = h.input();
    await h.typeInput("Typed during lookup"); await h.rerenderMetadata();
    assert.equal(h.input() === originalInput, true);
    assert.deepEqual(h.calls.opened, [[PROJECT, SESSION]]);
    assert.deepEqual(h.calls.selection, [[PROJECT, SESSION, "chat"]]);
    await h.settleSource(pending);
    h.assertSource(sender);
    assert.deepEqual(h.calls.backlinks, [[PROJECT, referenceValue(SESSION, sender).uri]]);
    assert.deepEqual(h.calls.resolved, [[PROJECT, referenceValue(SESSION_B, sender).uri]]);
    assert.equal(h.warning(), ""); assert.equal(h.input().value, "Typed during lookup");
    await h.closeDialog(sender === "user" ? "escape" : "button");
    const fresh = await h.reference(sender); await h.settleSource(fresh); h.assertSource(sender);
    assert.deepEqual(h.calls.network, []);
  });
  test(sender + " source dialog reports a current-scope lookup failure", { timeout: 20_000 }, async t => {
    const h = await fixture(t);
    const pending = await h.reference(sender);
    await h.settleSource(pending, new Error("Current source lookup failed"));
    assert.equal(h.warning(), "Current source lookup failed");
    assert.equal(h.dialog() === null, true); assert.deepEqual(h.calls.backlinks, []);
    assert.equal(h.input().value, "");
    assert.deepEqual(h.calls.network, []);
  });
}

for (const stage of ["backlinks", "resolve"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test("closed source dialog ignores internal " + stage + " " + outcome, { timeout: 20_000 }, async t => {
      const h = await fixture(t);
      if (stage === "backlinks") h.holdBacklinks(); else h.holdResolutions();
      const pending = await h.reference(); await h.settleSource(pending);
      assert.ok(h.dialog()?.textContent?.includes("正在读取"));
      assert.equal(h.calls.backlinks.length, 1);
      if (stage === "resolve") assert.equal(h.calls.resolved.length, 1);
      await h.closeDialog(stage === "backlinks" ? "escape" : "button");
      const error = outcome === "failure" ? new Error("Closed dialog read failed") : undefined;
      if (stage === "backlinks") await h.settleBacklinks(0, error);
      else await h.settleResolution(0, error);
      assert.equal(h.dialog() === null, true); assert.equal(h.warning(), "");
      assert.deepEqual(h.calls.network, []);
    });
  }
}

test("open source dialog retains its project through a real session-handoff event and source navigation", { timeout: 20_000 }, async t => {
  const h = await fixture(t);
  const pending = await h.reference(); await h.settleSource(pending);
  h.assertSource(); const modal = h.dialog();
  await h.handoffSession(SESSION_C);
  assert.equal(h.dialog() === modal, true, "Keep the existing open-dialog retention behavior");
  h.assertSource();
  assert.deepEqual(h.calls.backlinks, [[PROJECT, referenceValue(SESSION, "assistant").uri]]);
  assert.deepEqual(h.calls.resolved, [[PROJECT, referenceValue(SESSION_B, "assistant").uri]]);
  assert.equal(h.warning(), "");
  await h.openSource();
  assert.deepEqual(h.calls.projects, [PROJECT_C, PROJECT]);
  assert.deepEqual(h.calls.resolved.at(-1), [PROJECT, referenceValue(SESSION_B, "assistant").uri]);
  assert.deepEqual(h.calls.selection.at(-1), [PROJECT, SESSION_B, "chat"]);
  assert.deepEqual(h.calls.network, []);
});

test("open source dialog keeps its pending backlinks in the originating project after handoff", { timeout: 20_000 }, async t => {
  const h = await fixture(t); h.holdBacklinks();
  const pending = await h.reference(); await h.settleSource(pending);
  assert.ok(h.dialog()?.textContent?.includes("正在读取"));
  await h.handoffSession(SESSION_C);
  assert.deepEqual(h.calls.backlinks, [[PROJECT, referenceValue(SESSION, "assistant").uri]]);
  await h.settleBacklinks(0); h.assertSource();
  assert.deepEqual(h.calls.resolved, [[PROJECT, referenceValue(SESSION_B, "assistant").uri]]);
  assert.equal(h.warning(), "");
  assert.deepEqual(h.calls.network, []);
});

test("current source dialog retains backend backlink errors", { timeout: 20_000 }, async t => {
  const h = await fixture(t); h.holdBacklinks();
  const pending = await h.reference(); await h.settleSource(pending);
  await h.settleBacklinks(0, new Error("Conversation is not available."));
  assert.equal(h.dialog()?.querySelector('[role="alert"]')?.textContent, "Conversation is not available.");
  assert.equal(h.warning(), ""); assert.deepEqual(h.calls.resolved, []);
  assert.deepEqual(h.calls.network, []);
});
