/**
 * Real App navigation-epoch regression candidate against main
 * 0639cfa307cfbb8e4bb3738cfdb107934b214a62. Authored without local execution.
 *
 * The platform fixture follows PR266 aaac382's CI-observed App setup. Product
 * callbacks, Sidebar, Workspace, Timeline, Composer and PromptInput stay real.
 * window.biny is the business seam; these tests do not start Host or storage.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type {
  DesktopApi,
  DesktopBootstrap,
  DesktopSessionDocument,
  DesktopSessionSummary,
  DesktopWorkspaceSnapshot
} from "../src/desktop/protocol.js";

const PROJECT = "quote-project";
const SESSION = "quote-session-a";
const SESSION_B = "quote-session-b";
const MESSAGE = "quote-answer-a";
const MESSAGE_B = "quote-answer-b";
const QUOTE_A = "First selected passage A.";
const QUOTE_B = "Newer selected passage B.";
const CAPTURE_LABEL = "Captured passage A";
const FRESH_LABEL = "Fresh quote after returning to A";
const TITLE_A = "Navigation quote A";
const TITLE_B = "Navigation quote B";
const ADD_BUTTON = '[aria-label="将选中文字添加到对话"]';
const TIME = "2026-10-17T12:00:00.000Z";
type Reference = Awaited<ReturnType<DesktopApi["referenceForMessage"]>>;
type Gate = "referenceForMessage" | "referenceCaptureSelectionQuote";

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

function snapshots(): { bootstrap: DesktopBootstrap; documents: Map<string, DesktopSessionDocument> } {
  const project = { id: PROJECT, name: "Quote fixture", path: "/synthetic/quote-project",
    dirty: false, missing: false, pinned: false, addedAt: TIME, lastOpenedAt: TIME };
  const session = (id: string, title: string): DesktopSessionSummary => ({
    id, projectId: PROJECT, fileName: `${id}.jsonl`, title,
    firstUserMessage: `Read ${title}.`, lastAssistantMessage: `${QUOTE_A}\n\n${QUOTE_B}`,
    eventCount: 2, createdAt: TIME, updatedAt: TIME, pinned: false, status: "completed"
  });
  const sessions = [session(SESSION, TITLE_A), session(SESSION_B, TITLE_B)];
  const workspace: DesktopWorkspaceSnapshot = {
    project, sessions, selectedSessionId: SESSION, permissionMode: "ask",
    capabilityDefaults: { tools: "none", skills: "none" }, requiresModelConfiguration: false,
    pickerModels: [], models: [], connections: []
  };
  const documents = new Map(sessions.map((item): [string, DesktopSessionDocument] => [item.id, {
    session: item,
    events: [
      { type: "user_message", time: TIME, messageId: `${item.id}-user`, content: `Read ${item.title}.` },
      { type: "assistant_message", time: TIME, messageId: item.id === SESSION ? MESSAGE : MESSAGE_B,
        replyToMessageId: `${item.id}-user`, slotId: `${item.id}-answer-slot`,
        content: `${QUOTE_A}\n\n${QUOTE_B}` }
    ],
    liveEvents: []
  }]));
  return {
    bootstrap: {
      version: "test", platform: "linux", projects: [project], sidebarSessions: sessions,
      activeProjectId: PROJECT, selectedSessionId: SESSION, activeView: "chat", workspace,
      sidebarWidth: 248, filePanelWidth: 360, themePreference: "light",
      fontPreference: { family: "system", size: 13 }
    },
    documents
  };
}

async function fixture(t: TestContext, gate: Gate) {
  try {
    return await setupFixture(t, gate);
  } catch (error) {
    if (error instanceof AggregateError) {
      try { t.diagnostic(`Quote fixture setup nested errors:\n${aggregateErrorDetails(error)}`); }
      catch { /* Diagnostics must never replace the original failure. */ }
    }
    throw error;
  }
}

async function setupFixture(t: TestContext, gate: Gate) {
  const resources: {
    dom?: JSDOM;
    root?: Root;
    React?: typeof import("react");
    assets?: ReturnType<typeof registerHooks>;
  } = {};
  let timersEnabled = false;
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const pending = deferred<Reference>();
  let pendingSettled = false;
  const source: Reference = {
    kind: "message", uri: `biny://thread/${SESSION}/message/${MESSAGE}`, label: "Source reply",
    content: `${QUOTE_A}\n\n${QUOTE_B}`, projectId: PROJECT, threadId: SESSION, messageId: MESSAGE
  };
  const captured: Reference = {
    kind: "snippet", uri: "biny://snippet/quote-fixture-A", label: CAPTURE_LABEL,
    content: QUOTE_A, projectId: PROJECT, threadId: SESSION, messageId: MESSAGE
  };

  const fresh: Reference = { ...captured, uri: "biny://snippet/quote-fixture-fresh", label: FRESH_LABEL };

  // Register before imports, globals, loader hooks or createRoot: a partial setup
  // failure must receive exactly the same cleanup as a failed assertion.
  t.after(async () => {
    const { dom, root, React, assets } = resources;
    const errors: unknown[] = [];
    try {
      const release = async (): Promise<void> => {
        if (!pendingSettled) { pendingSettled = true; pending.resolve(gate === "referenceForMessage" ? source : captured); }
        await pending.promise.then(() => undefined, () => undefined);
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
    if (errors.length) throw new AggregateError(errors, "Failed to restore quote integration fixture");
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
  // Keep native Selection/Range text, containers and offsets. Only supply the
  // positive rectangle which JSDOM cannot calculate without a layout engine.
  replace(window.Range.prototype, "getBoundingClientRect", () => new window.DOMRect(120, 180, 220, 24));

  const calls = { source: [] as Array<Parameters<DesktopApi["referenceForMessage"]>>,
    capture: [] as Array<Parameters<DesktopApi["referenceCaptureSelectionQuote"]>>,
    selection: [] as Array<Parameters<DesktopApi["commitSelection"]>>,
    opened: [] as Array<Parameters<DesktopApi["openSession"]>>, bootstrap: 0 };
  const subscriptions = new Set<symbol>();
  const subscribe = (): (() => void) => {
    const token = Symbol("subscription");
    subscriptions.add(token);
    return () => { subscriptions.delete(token); };
  };
  const data = snapshots();
  let bootstrap = data.bootstrap;
  let importsChanged: (() => void) | undefined;
  const api = {
    bootstrap: async () => { calls.bootstrap += 1; return bootstrap; },
    openSession: async (projectId: string, sessionId: string) => {
      calls.opened.push([projectId, sessionId]);
      assert.equal(projectId, PROJECT);
      const next = data.documents.get(sessionId);
      assert.equal(next !== undefined, true, "Only fixture sessions may be opened");
      return next!;
    },
    commitSelection: async (...args: Parameters<DesktopApi["commitSelection"]>) => { calls.selection.push(args); },
    recipeSuggestions: async () => [],
    skillCatalog: async () => ({ skills: [], inventory: [], unmanagedSkills: [], plugins: [], warnings: [], diagnostics: [] }),
    skillSettings: async () => ({ projectId: PROJECT, projectKey: PROJECT, globalDefaults: {}, projectOverrides: {}, activations: [] }),
    toolCatalog: async () => [],
    listProjectBranches: async () => [],
    planProjection: async (projectId: string, sessionId: string) => {
      assert.equal(projectId, PROJECT);
      return { sessionId, plans: [] };
    },
    onAppearanceChanged: subscribe,
    onApplicationImportsChanged: (listener: () => void) => {
      importsChanged = listener;
      const unsubscribe = subscribe();
      return () => { if (importsChanged === listener) importsChanged = undefined; unsubscribe(); };
    },
    onAgentEvent: subscribe,
    onSessionHandoff: subscribe,
    onMenuAction: subscribe,
    onSettingsCloseRequest: subscribe,
    onBrowserOpenRequest: subscribe,
    onReferenceOpen: subscribe,
    referenceForMessage: async (...args: Parameters<DesktopApi["referenceForMessage"]>) => {
      calls.source.push(args);
      return gate === "referenceForMessage" && calls.source.length === 1 ? await pending.promise : source;
    },
    referenceCaptureSelectionQuote: async (...args: Parameters<DesktopApi["referenceCaptureSelectionQuote"]>) => {
      calls.capture.push(args);
      if (gate === "referenceCaptureSelectionQuote" && calls.capture.length === 1) return await pending.promise;
      return calls.capture.length === 1 ? captured : fresh;
    }
  } satisfies Partial<DesktopApi>;
  replace(window, "biny", new Proxy(api, { get(target, key, receiver) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`Unexpected window.biny access: ${String(key)}`);
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
  // Freeze selection debounce and toast expiry. Test input is observed through
  // actual mouseup; a later timer must not resurrect the toolbar and mask Red.
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
  const timeline = (): HTMLDivElement => one<HTMLDivElement>(".message-timeline");
  const assertCurrent = (sessionId: string): void => {
    const messageId = sessionId === SESSION ? MESSAGE : MESSAGE_B;
    const title = sessionId === SESSION ? TITLE_A : TITLE_B;
    assert.equal(Boolean(document.querySelector(`article[data-message-id="${messageId}"] .markdown-body`)), true);
    assert.equal(document.querySelector('.biny-sidebar-session-item[aria-current="page"]')?.getAttribute("title"), title);
    assert.equal(Boolean(document.querySelector(".biny-workspace-chat .biny-composer .biny-prompt-editor")), true);
    assert.equal(input().disabled, false);
    assert.equal(input().closest("[inert]") === null, true, "The committed conversation must no longer be loading");
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
  const select = async (text = QUOTE_A): Promise<void> => {
    // The current A's article and Timeline are deliberately queried every time.
    const markdown = one<HTMLElement>(`article[data-message-id="${MESSAGE}"] .markdown-body`);
    const walker = document.createTreeWalker(markdown, window.NodeFilter.SHOW_TEXT);
    let textNode: Node | undefined;
    while (walker.nextNode()) { if (walker.currentNode.textContent === text) { textNode = walker.currentNode; break; } }
    assert.equal(textNode !== undefined, true, `Rendered reply must contain ${text}`);
    const range = document.createRange();
    range.setStart(textNode!, 0);
    range.setEnd(textNode!, text.length);
    await act(() => {
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
      timeline().dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      t.mock.timers.tick(0);
    });
    assert.equal(window.getSelection()?.toString(), text);
  };
  const button = (): HTMLButtonElement => one<HTMLButtonElement>(ADD_BUTTON);
  const click = async (): Promise<void> => {
    await act(() => {
      const target = button();
      const mouseDown = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
      target.dispatchEvent(mouseDown);
      assert.equal(mouseDown.defaultPrevented, true);
      target.click();
    });
  };
  const clickSession = async (sessionId: string): Promise<void> => {
    const title = sessionId === SESSION ? TITLE_A : TITLE_B;
    const targets = [...document.querySelectorAll<HTMLButtonElement>(".biny-sidebar-session-item")]
      .filter(target => target.getAttribute("title") === title);
    assert.equal(targets.length, 1, `Expected one actual sidebar button for ${title}`);
    assert.equal(targets[0]!.disabled, false);
    assert.equal(targets[0]!.closest("[inert]") === null, true);
    await act(async () => { targets[0]!.click(); });
  };
  const navigate = async (sessionId: string): Promise<void> => {
    const openedBefore = calls.opened.length;
    const committedBefore = calls.selection.length;
    await clickSession(sessionId);
    // aria-current alone is only pending intent. Require the real openSession
    // and commitSelection seams plus the new rendered message and usable input.
    assert.equal(calls.opened.length, openedBefore + 1);
    assert.deepEqual(calls.opened.at(-1), [PROJECT, sessionId]);
    assert.equal(calls.selection.length, committedBefore + 1);
    assert.deepEqual(calls.selection.at(-1), [PROJECT, sessionId, "chat"]);
    assertCurrent(sessionId);
    await drainFrames();
    await focusSentinel();
  };
  const rerenderMetadata = async (): Promise<void> => {
    assert.equal(typeof importsChanged, "function");
    const original = bootstrap.workspace!;
    const updatedName = "Updated quote fixture metadata";
    const project = { ...original.project, name: updatedName };
    bootstrap = { ...bootstrap, projects: [project], workspace: { ...original, project } };
    const before = calls.bootstrap;
    await act(async () => { importsChanged!(); });
    assert.equal(calls.bootstrap, before + 1);
    assert.equal(document.body.textContent?.includes(updatedName), true, "Observe the real metadata update, not a synthetic root render");
    assertCurrent(SESSION);
  };
  const settle = async (error?: Error): Promise<void> => {
    assert.equal(pendingSettled, false);
    await act(async () => {
      pendingSettled = true;
      if (error) pending.reject(error);
      else pending.resolve(gate === "referenceForMessage" ? source : captured);
    });
  };
  return { document, input, observeInput, typeInput, sentinel, calls, select, button, click,
    clickSession, navigate, rerenderMetadata, focusSentinel, settle, frame,
    tokenCount: () => document.querySelectorAll(".biny-prompt-reference-token").length,
    warning: () => document.querySelector(".desktop-toast-message")?.textContent ?? "" };
}

for (const gate of ["referenceForMessage", "referenceCaptureSelectionQuote"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`${gate} ${outcome} from old A cannot commit after real sidebar A-B-A navigation`, { timeout: 20_000 }, async t => {
      const h = await fixture(t, gate);
      await h.select();
      await h.click();
      assert.equal(h.button().disabled, true);
      assert.deepEqual(h.calls.source, [[PROJECT, SESSION, MESSAGE]]);
      assert.equal(h.calls.capture.length, gate === "referenceForMessage" ? 0 : 1);
      const originalInput = h.input();

      await h.navigate(SESSION_B);
      const bInput = h.input();
      assert.equal(bInput === originalInput, false);
      await h.navigate(SESSION);
      assert.equal(h.input() === originalInput, false);
      assert.equal(h.input() === bInput, false);
      await h.typeInput("New A draft");
      await h.focusSentinel();
      const observed = h.observeInput();
      const error = outcome === "failure" ? new Error(`Stale ${gate} failure from old A`) : undefined;
      await h.settle(error);
      await h.frame();

      assert.equal(h.calls.capture.length, gate === "referenceForMessage" ? 0 : 1,
        "A stale source lookup must not start capture; an already-started capture is not rolled back");
      assert.equal(h.warning(), "", "The real App catch must not surface the stale error in reopened A");
      assert.equal(h.input().value, "New A draft");
      assert.equal(h.tokenCount(), 0);
      assert.equal(observed.counts.focus, 0);
      assert.equal(observed.counts.selectionRange, 0);
      assert.equal(h.document.activeElement === h.sentinel, true);
      assert.deepEqual(h.calls.opened, [[PROJECT, SESSION], [PROJECT, SESSION_B], [PROJECT, SESSION]]);
      assert.deepEqual(h.calls.selection, [[PROJECT, SESSION, "chat"], [PROJECT, SESSION_B, "chat"], [PROJECT, SESSION, "chat"]]);

      if (gate === "referenceCaptureSelectionQuote" && outcome === "success") {
        await h.select();
        await h.click();
        assert.equal(h.warning(), "");
        assert.equal(h.calls.source.length, 2);
        assert.equal(h.calls.capture.length, 2);
        assert.equal(h.input().value, `New A draft @${FRESH_LABEL} `);
        assert.equal(h.tokenCount(), 1, "A new explicit quote request in reopened A must still work");
        assert.equal((await h.frame()) > 0, true);
        assert.equal(observed.counts.focus, 1);
        assert.equal(observed.counts.selectionRange, 1);
        assert.equal(h.document.activeElement === observed.target, true);
        assert.equal(h.input().selectionStart, h.input().value.length);
        assert.equal(h.input().selectionEnd, h.input().value.length);
      }
    });
  }
}

test("same-scope input and metadata rerender keep the requested quote and append to the latest draft", { timeout: 20_000 }, async t => {
  const h = await fixture(t, "referenceCaptureSelectionQuote");
  await h.select();
  await h.click();
  const currentInput = h.input();
  await h.typeInput("Typed while quote was pending");
  await h.rerenderMetadata();
  assert.equal(h.input() === currentInput, true);
  assert.equal(h.input().value, "Typed while quote was pending");
  assert.deepEqual(h.calls.opened, [[PROJECT, SESSION]]);
  assert.deepEqual(h.calls.selection, [[PROJECT, SESSION, "chat"]]);
  await h.focusSentinel();
  const observed = h.observeInput();
  await h.settle();
  assert.equal(h.warning(), "");
  assert.equal(h.input().value, `Typed while quote was pending @${CAPTURE_LABEL} `);
  assert.equal(h.tokenCount(), 1);
  assert.deepEqual(h.calls.source, [[PROJECT, SESSION, MESSAGE]]);
  assert.deepEqual(h.calls.capture, [[PROJECT, `biny://thread/${SESSION}/message/${MESSAGE}`, QUOTE_A]]);
  assert.equal(observed.counts.focus, 0);
  assert.equal(observed.counts.selectionRange, 0);
  assert.equal((await h.frame()) > 0, true);
  assert.equal(observed.counts.focus, 1);
  assert.equal(observed.counts.selectionRange, 1);
  assert.equal(h.document.activeElement === observed.target, true);
  assert.equal(h.input().selectionStart, h.input().value.length);
  assert.equal(h.input().selectionEnd, h.input().value.length);
  await h.frame();
  assert.equal(h.tokenCount(), 1);
  assert.equal(observed.counts.focus, 1);
});

for (const gate of ["referenceForMessage", "referenceCaptureSelectionQuote"] as const) {
  test(`${gate} still reports a current-scope failure through the real App`, { timeout: 20_000 }, async t => {
    const h = await fixture(t, gate);
    await h.select();
    await h.click();
    const observed = h.observeInput();
    const message = `Current ${gate} failure`;
    await h.settle(new Error(message));
    await h.frame();
    assert.equal(h.warning(), message);
    assert.equal(h.input().value, "");
    assert.equal(h.tokenCount(), 0);
    assert.equal(h.calls.capture.length, gate === "referenceForMessage" ? 0 : 1);
    assert.equal(observed.counts.focus, 0);
    assert.equal(observed.counts.selectionRange, 0);
    assert.equal(h.document.activeElement === h.sentinel, true);
  });
}

test("clicking the current sidebar row invalidates an older quote without reloading the session", { timeout: 20_000 }, async t => {
  const h = await fixture(t, "referenceForMessage");
  await h.select();
  await h.click();
  const currentInput = h.input();
  await h.clickSession(SESSION);
  assert.equal(h.input() === currentInput, true);
  assert.deepEqual(h.calls.opened, [[PROJECT, SESSION]], "Current-row navigation deliberately skips the read");
  assert.deepEqual(h.calls.selection, [[PROJECT, SESSION, "chat"]]);
  await h.focusSentinel();
  const observed = h.observeInput();
  await h.settle();
  await h.frame();
  assert.equal(h.calls.capture.length, 0, "The existing navigation epoch still advances for this explicit intent");
  assert.equal(h.warning(), "");
  assert.equal(h.input().value, "");
  assert.equal(h.tokenCount(), 0);
  assert.equal(observed.counts.focus, 0);
  assert.equal(observed.counts.selectionRange, 0);
  assert.equal(h.document.activeElement === h.sentinel, true);
});
