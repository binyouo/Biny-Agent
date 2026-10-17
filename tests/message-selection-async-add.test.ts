/**
 * Renderer integration candidate, authored against main
 * 0639cfa307cfbb8e4bb3738cfdb107934b214a62. Not executed during preparation.
 *
 * Mount the real App -> Workspace -> MessageTimeline and Composer -> PromptInput.
 * Only window.biny is the external business boundary. Asset loading and missing
 * JSDOM layout APIs are platform shims, never replacements for product modules.
 * The two failure cases exercise App's real catch, including its fulfilled-void
 * result, rather than reproducing that catch in a fake parent component.
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
const SESSION = "quote-session";
const MESSAGE = "quote-answer";
const QUOTE_A = "First selected passage A.";
const QUOTE_B = "Newer selected passage B.";
const CAPTURE_LABEL = "Captured passage A";
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

function snapshots(): { bootstrap: DesktopBootstrap; document: DesktopSessionDocument } {
  const project = { id: PROJECT, name: "Quote fixture", path: "/synthetic/quote-project",
    dirty: false, missing: false, pinned: false, addedAt: TIME, lastOpenedAt: TIME };
  const session: DesktopSessionSummary = {
    id: SESSION, projectId: PROJECT, fileName: "quote-session.jsonl", title: "Quote ownership",
    firstUserMessage: "Read these passages.", lastAssistantMessage: `${QUOTE_A}\n\n${QUOTE_B}`,
    eventCount: 2, createdAt: TIME, updatedAt: TIME, pinned: false, status: "completed"
  };
  const workspace: DesktopWorkspaceSnapshot = {
    project, sessions: [session], selectedSessionId: SESSION, permissionMode: "ask",
    capabilityDefaults: { tools: "none", skills: "none" }, requiresModelConfiguration: false,
    pickerModels: [], models: [], connections: []
  };
  return {
    bootstrap: {
      version: "test", platform: "linux", projects: [project], sidebarSessions: [session],
      activeProjectId: PROJECT, selectedSessionId: SESSION, activeView: "chat", workspace,
      sidebarWidth: 248, filePanelWidth: 360, themePreference: "light",
      fontPreference: { family: "system", size: 13 }
    },
    document: {
      session,
      events: [
        { type: "user_message", time: TIME, messageId: "quote-user", content: "Read these passages." },
        { type: "assistant_message", time: TIME, messageId: MESSAGE, replyToMessageId: "quote-user",
          slotId: "quote-answer-slot", content: `${QUOTE_A}\n\n${QUOTE_B}` }
      ],
      liveEvents: []
    }
  };
}

async function fixture(t: TestContext, gate: Gate) {
  let dom: JSDOM | undefined;
  let root: Root | undefined;
  let React: typeof import("react") | undefined;
  let assets: ReturnType<typeof registerHooks> | undefined;
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

  // Register before imports, globals, loader hooks or createRoot: a partial setup
  // failure must receive exactly the same cleanup as a failed assertion.
  t.after(async () => {
    try {
      const release = async (): Promise<void> => {
        if (!pendingSettled) { pendingSettled = true; pending.resolve(gate === "referenceForMessage" ? source : captured); }
        await pending.promise.then(() => undefined, () => undefined);
      };
      // Drain the real async handlers through act before unmounting/restoring
      // globals, even when an earlier assertion left the external gate pending.
      if (React) await React.act(release);
      else await release();
    } finally {
      try {
        if (root && React) await React.act(() => root!.unmount());
      } finally {
        try { assets?.deregister(); }
        finally {
          try { dom?.window.close(); }
          finally {
            try { if (timersEnabled) t.mock.timers.reset(); }
            finally {
              frames.clear();
              const errors: unknown[] = [];
              for (const undo of restore.reverse()) {
                try { undo(); } catch (error) { errors.push(error); }
              }
              if (errors.length) throw new AggregateError(errors, "Failed to restore quote integration fixture");
            }
          }
        }
      }
    }
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
  dom = new DOM('<!doctype html><button id="focus-sentinel">Outside input</button><div id="root"></div>',
    { url: "https://biny.test", pretendToBeVisual: true });
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
    window, document, self: window, navigator: window.navigator,
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
    selection: [] as Array<Parameters<DesktopApi["commitSelection"]>> };
  const subscriptions = new Set<symbol>();
  const subscribe = (): (() => void) => {
    const token = Symbol("subscription");
    subscriptions.add(token);
    return () => { subscriptions.delete(token); };
  };
  const data = snapshots();
  const api = {
    bootstrap: async () => data.bootstrap,
    openSession: async (projectId: string, sessionId: string) => {
      assert.equal(projectId, PROJECT); assert.equal(sessionId, SESSION);
      return data.document;
    },
    commitSelection: async (...args: Parameters<DesktopApi["commitSelection"]>) => { calls.selection.push(args); },
    recipeSuggestions: async () => [],
    skillCatalog: async () => ({ skills: [], inventory: [], unmanagedSkills: [], plugins: [], warnings: [], diagnostics: [] }),
    skillSettings: async () => ({ projectId: PROJECT, projectKey: PROJECT, globalDefaults: {}, projectOverrides: {}, activations: [] }),
    toolCatalog: async () => [],
    listProjectBranches: async () => [],
    planProjection: async () => ({ sessionId: SESSION, plans: [] }),
    onAppearanceChanged: subscribe,
    onApplicationImportsChanged: subscribe,
    onAgentEvent: subscribe,
    onSessionHandoff: subscribe,
    onMenuAction: subscribe,
    onSettingsCloseRequest: subscribe,
    onBrowserOpenRequest: subscribe,
    onReferenceOpen: subscribe,
    referenceForMessage: async (...args: Parameters<DesktopApi["referenceForMessage"]>) => {
      calls.source.push(args);
      return gate === "referenceForMessage" ? await pending.promise : source;
    },
    referenceCaptureSelectionQuote: async (...args: Parameters<DesktopApi["referenceCaptureSelectionQuote"]>) => {
      calls.capture.push(args);
      return gate === "referenceCaptureSelectionQuote" ? await pending.promise : captured;
    }
  } satisfies Partial<DesktopApi>;
  replace(window, "biny", new Proxy(api, { get(target, key, receiver) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`Unexpected window.biny access: ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } }));

  assets = registerHooks({ load(url, context, next) {
    if (/\.(?:svg|png|jpg|webp)(?:\?.*)?$/u.test(url)) return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
    if (/\.css(?:\?.*)?$/u.test(url)) return { format: "module", shortCircuit: true, source: "export {};" };
    return next(url, context);
  } });
  React = await import("react");
  replace(globalThis, "React", React);
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/desktop/renderer/src/App.js");
  const { act, createElement } = React;
  // Freeze selection debounce and toast expiry. Test input is observed through
  // actual mouseup; a later timer must not resurrect the toolbar and mask Red.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  timersEnabled = true;
  root = createRoot(document.getElementById("root")!);
  await act(async () => { root!.render(createElement(App, { settingsEnabled: false })); });

  const one = <T extends Element>(selector: string): T => {
    const matches = document.querySelectorAll<T>(selector);
    assert.equal(matches.length, 1, `Expected one ${selector}`);
    return matches[0]!;
  };
  const input = one<HTMLTextAreaElement>('textarea[aria-label="任务输入"]');
  const timeline = one<HTMLDivElement>(".message-timeline");
  const markdown = one<HTMLElement>(`article[data-message-id="${MESSAGE}"] .markdown-body`);
  assert.equal(Boolean(document.querySelector(".biny-workspace-chat .biny-composer .biny-prompt-editor")), true);
  assert.equal(document.querySelector(".desktop-toast-message")?.textContent ?? "", "", "Bootstrap must not already be failing");
  assert.deepEqual(calls.selection, [[PROJECT, SESSION, "chat"]]);
  assert.equal(input.value, "");
  assert.equal(input.disabled, false);

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
  // Drain startup layout work before establishing focus observations. Each
  // invocation runs one snapshot; RAFs scheduled during it await the next frame.
  // The bound fails setup instead of silently discarding a perpetual RAF loop.
  for (let count = 0; frames.size; count += 1) {
    assert.equal(count < 100, true, "Startup RAF queue must become idle before testing append focus");
    await frame();
  }
  const sentinel = one<HTMLButtonElement>("#focus-sentinel");
  await act(() => sentinel.focus());
  assert.equal(document.activeElement === sentinel, true);
  const focus = input.focus;
  const setSelectionRange = input.setSelectionRange;
  const inputCalls = { focus: 0, selectionRange: 0 };
  replace(input, "focus", function (options?: FocusOptions): void {
    inputCalls.focus += 1;
    focus.call(input, options);
  });
  replace(input, "setSelectionRange", function (start: number, end: number, direction?: "forward" | "backward" | "none"): void {
    inputCalls.selectionRange += 1;
    setSelectionRange.call(input, start, end, direction);
  });

  const select = async (text: string) => {
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
      timeline.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      t.mock.timers.tick(0);
    });
    return { text, node: textNode!, start: 0, end: text.length };
  };
  const assertSelection = (expected: Awaited<ReturnType<typeof select>>): void => {
    const selection = window.getSelection();
    assert.equal(selection?.toString(), expected.text);
    assert.equal(selection?.rangeCount, 1);
    assert.equal(selection?.isCollapsed, false);
    const range = selection!.getRangeAt(0);
    assert.equal(range.startContainer === expected.node, true);
    assert.equal(range.endContainer === expected.node, true);
    assert.equal(range.startOffset, expected.start);
    assert.equal(range.endOffset, expected.end);
    assert.equal(selection!.anchorNode === expected.node, true);
    assert.equal(selection!.focusNode === expected.node, true);
    assert.equal(selection!.anchorOffset, expected.start);
    assert.equal(selection!.focusOffset, expected.end);
  };
  const button = (): HTMLButtonElement => one<HTMLButtonElement>(ADD_BUTTON);
  const click = async (): Promise<void> => {
    await act(() => {
      const target = button();
      const mouseDown = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
      target.dispatchEvent(mouseDown);
      assert.equal(mouseDown.defaultPrevented, true, "The real button preserves native selection on mousedown");
      target.click();
    });
  };
  const settle = async (error?: Error): Promise<void> => {
    assert.equal(pendingSettled, false);
    await act(async () => {
      pendingSettled = true;
      if (error) pending.reject(error);
      else pending.resolve(gate === "referenceForMessage" ? source : captured);
    });
  };
  return { document, input, inputCalls, sentinel, calls, select, assertSelection, button, click, settle, frame,
    tokenCount: () => document.querySelectorAll(".biny-prompt-reference-token").length,
    warning: () => document.querySelector(".desktop-toast-message")?.textContent ?? "" };
}

for (const gate of ["referenceForMessage", "referenceCaptureSelectionQuote"] as const) {
  test(`${gate} failure reaches real App warning without closing or focusing over newer selection B`, { timeout: 20_000 }, async t => {
    const h = await fixture(t, gate);
    await h.select(QUOTE_A);
    await h.click();
    assert.equal(h.button().disabled, true);
    assert.equal(h.button().getAttribute("aria-busy"), "true");
    assert.deepEqual(h.calls.source, [[PROJECT, SESSION, MESSAGE]]);
    assert.equal(h.calls.capture.length, gate === "referenceForMessage" ? 0 : 1);

    const selectedB = await h.select(QUOTE_B);
    h.assertSelection(selectedB);
    assert.equal(h.button().disabled, true, "New B keeps the original global single-flight gate");
    const message = `${gate} deliberately rejected A`;
    await h.settle(new Error(message));
    await h.frame();
    assert.equal(h.warning(), message, "The visible warning must come from App's actual catch");
    assert.equal(h.button().disabled, false, "A settlement releases B's add button");
    assert.equal(h.button().getAttribute("aria-busy"), "false");
    h.assertSelection(selectedB);
    assert.equal(h.input.value, "");
    assert.equal(h.tokenCount(), 0, "Failed A must not create a reference token");
    assert.equal(h.inputCalls.focus, 0, "Failure must not schedule a Composer focus");
    assert.equal(h.inputCalls.selectionRange, 0);
    assert.equal(h.document.activeElement === h.sentinel, true);
    assert.deepEqual(h.calls.source, [[PROJECT, SESSION, MESSAGE]]);
    assert.deepEqual(h.calls.capture, gate === "referenceForMessage" ? []
      : [[PROJECT, `biny://thread/${SESSION}/message/${MESSAGE}`, QUOTE_A]]);
  });
}

test("ordinary successful quote adds exactly once and its real RAF focuses and positions PromptInput", { timeout: 20_000 }, async t => {
  const h = await fixture(t, "referenceCaptureSelectionQuote");
  await h.select(QUOTE_A);
  await h.click();
  assert.equal(h.button().disabled, true);
  await h.settle();
  assert.equal(Boolean(h.document.querySelector(ADD_BUTTON)), false, "Same owner still hides at settlement");
  assert.equal(h.warning(), "");
  assert.deepEqual(h.calls.source, [[PROJECT, SESSION, MESSAGE]]);
  assert.deepEqual(h.calls.capture, [[PROJECT, `biny://thread/${SESSION}/message/${MESSAGE}`, QUOTE_A]]);
  assert.equal(h.input.value, `@${CAPTURE_LABEL} `);
  assert.equal(h.tokenCount(), 1);
  assert.equal(h.inputCalls.focus, 0, "Append focus is still deferred until RAF");
  assert.equal(h.inputCalls.selectionRange, 0);
  assert.equal(h.document.activeElement === h.sentinel, true);

  assert.equal((await h.frame()) > 0, true, "Execute queued RAF callbacks rather than replacing RAF with a noop");
  assert.equal(h.inputCalls.focus, 1);
  assert.equal(h.inputCalls.selectionRange, 1);
  assert.equal(h.document.activeElement === h.input, true, "The call-through spy must actually focus the native textarea");
  assert.equal(h.input.selectionStart, h.input.value.length);
  assert.equal(h.input.selectionEnd, h.input.value.length);
  await h.frame();
  assert.equal(h.inputCalls.focus, 1);
  assert.equal(h.inputCalls.selectionRange, 1);
  assert.equal(h.input.value, `@${CAPTURE_LABEL} `);
  assert.equal(h.tokenCount(), 1, "Later layout RAFs do not append a duplicate token");
});

test("same-owner capture failure still closes A and shows the real App warning without inserting or focusing", { timeout: 20_000 }, async t => {
  const h = await fixture(t, "referenceCaptureSelectionQuote");
  await h.select(QUOTE_A);
  await h.click();
  assert.equal(h.button().disabled, true);
  assert.deepEqual(h.calls.capture, [[PROJECT, `biny://thread/${SESSION}/message/${MESSAGE}`, QUOTE_A]]);
  const message = "Capture deliberately rejected the unchanged selection A";
  await h.settle(new Error(message));
  await h.frame();
  assert.equal(h.warning(), message, "The visible warning must come from App's actual catch");
  assert.equal(Boolean(h.document.querySelector(ADD_BUTTON)), false, "Failed A still hides when A remains the owner");
  assert.equal(h.input.value, "");
  assert.equal(h.tokenCount(), 0);
  assert.equal(h.inputCalls.focus, 0);
  assert.equal(h.inputCalls.selectionRange, 0);
  assert.equal(h.document.activeElement === h.sentinel, true);
});
