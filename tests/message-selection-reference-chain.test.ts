/**
 * Real App -> timeline selection -> local reference service/graph -> Composer send.
 * Only DesktopApi, layout and asset loading are external seams. No model or IPC
 * process runs. The graph preserves selected display text; its source URI names
 * a slot, so resolving it follows that slot's current version.
 *
 * Authored as inert text; execution is intentionally left to the authorized CI.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopApi, DesktopBootstrap, DesktopSessionDocument, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import type { SessionEvent } from "../src/session/events.js";
import type { LocalReferenceGraph } from "../src/session/localReferences.js";

const PROJECT = "reference-chain-project";
const SESSION = "reference-chain-session";
const INITIAL = "initial:canonical:user";
const ASSISTANT = "answer:canonical";
const USER = "delivered:canonical:user";
const SLOT = "slot:delivered:user";
const RUN = "live:run";
const RAW = "Only change the **title**.";
const QUOTE = "Only change the title.";
const TIME = "2026-10-17T12:00:00.000Z";
const ADD_BUTTON = '[aria-label="将选中文字添加到对话"]';
type Reference = Awaited<ReturnType<DesktopApi["referenceForMessage"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function waitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Reference-chain fixture aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error("Reference-chain fixture aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(value => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function sessionEvents(): SessionEvent[] {
  return [
    { type: "user_message", time: TIME, messageId: INITIAL, slotId: "slot:initial", content: "Inspect this heading." },
    { type: "agent_message", time: TIME, messageId: ASSISTANT, slotId: "slot:answer", parentMessageId: INITIAL,
      message: { role: "assistant", content: [{ type: "text", text: "The heading is ready." }] } },
    { type: "user_message", time: TIME, messageId: USER, slotId: SLOT, parentMessageId: ASSISTANT, content: RAW }
  ];
}

function snapshots(workspacePath: string): { bootstrap: DesktopBootstrap; document: DesktopSessionDocument } {
  const project = { id: PROJECT, name: "Reference chain", path: workspacePath,
    dirty: false, missing: false, pinned: false, addedAt: TIME, lastOpenedAt: TIME };
  const session: DesktopSessionSummary = {
    id: SESSION, projectId: PROJECT, fileName: SESSION + ".jsonl", title: "Reference chain",
    firstUserMessage: "Inspect this heading.", lastAssistantMessage: "The heading is ready.",
    eventCount: 3, createdAt: TIME, updatedAt: TIME, pinned: false, status: "completed"
  };
  const workspace: DesktopWorkspaceSnapshot = {
    project, sessions: [session], selectedSessionId: SESSION, permissionMode: "ask",
    capabilityDefaults: { tools: "none", skills: "none" }, requiresModelConfiguration: false,
    pickerModels: [], models: [], connections: []
  };
  const base = { sessionId: SESSION, runId: RUN, timestamp: TIME };
  return {
    bootstrap: {
      version: "test", platform: "linux", projects: [project], sidebarSessions: [session],
      activeProjectId: PROJECT, selectedSessionId: SESSION, activeView: "chat", workspace,
      sidebarWidth: 248, filePanelWidth: 360, themePreference: "light",
      fontPreference: { family: "system", size: 13 }
    },
    // A live projection can precede the renderer's next persisted-history refresh.
    // The source service already sees the actual canonical messages on disk.
    document: {
      session, events: [], liveEvents: [
        { ...base, type: "message.user", messageId: INITIAL, content: "Inspect this heading." },
        { ...base, type: "run.started", messageId: ASSISTANT, input: "Inspect this heading.", skills: [],
          model: { alias: "primary", provider: "test", label: "test", reasoning: "default" } },
        { ...base, type: "assistant.completed", content: "The heading is ready." },
        { ...base, type: "message.user", messageId: USER, content: RAW, delivery: "steer" },
        { ...base, type: "run.completed", durationMs: 1 }
      ]
    }
  };
}

async function harness(t: TestContext) {
  const resources: {
    directory?: string; graph?: LocalReferenceGraph; dom?: JSDOM; root?: Root;
    React?: typeof import("react"); assets?: ReturnType<typeof registerHooks>;
  } = {};
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const pendingCalls = new Set<Promise<unknown>>();
  const captureEntered = deferred<void>();
  const captureGate = deferred<void>();
  const captureFinished = deferred<void>();
  let timersEnabled = false;
  let nextFrameId = 0;
  let frameTime = 0;
  const calls = {
    source: [] as Array<Parameters<DesktopApi["referenceForMessage"]>>,
    capture: [] as Array<Parameters<DesktopApi["referenceCaptureSelectionQuote"]>>,
    send: [] as Array<Parameters<DesktopApi["sendPrompt"]>>,
    selection: [] as Array<Parameters<DesktopApi["commitSelection"]>>,
    network: [] as string[]
  };
  const sources: Reference[] = [];
  const captures: Reference[] = [];
  const tracked = <T,>(operation: () => Promise<T>): Promise<T> => {
    const promise = Promise.resolve().then(operation);
    pendingCalls.add(promise);
    void promise.then(() => pendingCalls.delete(promise), () => pendingCalls.delete(promise));
    return promise;
  };
  // Install cleanup before creating files, importing renderer dependencies or
  // replacing globals. Release the external gate and drain actual API calls.
  t.after(async () => {
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    await attempt(async () => {
      const drain = async (): Promise<void> => {
        captureEntered.resolve();
        captureGate.resolve();
        captureFinished.resolve();
        while (pendingCalls.size) await Promise.allSettled([...pendingCalls]);
      };
      if (resources.React) await resources.React.act(drain);
      else await drain();
    });
    await attempt(async () => {
      if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount());
    });
    await attempt(() => resources.assets?.deregister());
    await attempt(() => resources.dom?.window.close());
    await attempt(() => { if (timersEnabled) t.mock.timers.reset(); });
    await attempt(() => t.mock.restoreAll());
    frames.clear();
    for (const undo of restore.reverse()) await attempt(undo);
    await attempt(() => resources.graph?.close());
    await attempt(async () => { if (resources.directory) await rm(resources.directory, { recursive: true, force: true }); });
    if (errors.length) throw new AggregateError(errors, "Failed to restore reference-chain fixture");
  });

  t.mock.method(globalThis, "fetch", async () => {
    calls.network.push("fetch");
    throw new Error("Unexpected external fetch in reference-chain fixture");
  });
  t.mock.method(Socket.prototype, "connect", () => {
    calls.network.push("socket");
    throw new Error("Unexpected socket in reference-chain fixture");
  });
  const directory = resources.directory = await mkdtemp(path.join(os.tmpdir(), "biny-reference-chain-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  restore.push(() => {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
  });
  process.env.BINY_AGENT_DIR = directory;
  const { projectSessionsDir } = await import("../src/config/paths.js");
  const { LocalReferenceService, LocalReferenceGraph } = await import("../src/session/localReferences.js");
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const sessions = projectSessionsDir(workspacePath, { env: { BINY_AGENT_DIR: directory } });
  await mkdir(sessions, { recursive: true });
  const sessionFile = path.join(sessions, SESSION + ".jsonl");
  await writeFile(sessionFile, sessionEvents().map(event => JSON.stringify(event)).join("\n") + "\n");
  const service = new LocalReferenceService({
    root: directory, projects: [{ id: PROJECT, path: workspacePath, name: "Reference chain" }]
  });
  const graph = resources.graph = new LocalReferenceGraph(directory, service);

  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  const { JSDOM: DOM } = await import("jsdom");
  const dom = resources.dom = new DOM('<!doctype html><div id="root"></div>', {
    url: "https://biny.test", pretendToBeVisual: true
  });
  const window = dom.window;
  const document = window.document;
  const requestFrame = (callback: FrameRequestCallback): number => { const id = ++nextFrameId; frames.set(id, callback); return id; };
  const cancelFrame = (id: number): void => { frames.delete(id); };
  class LayoutObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
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
  replace(window.Range.prototype, "getBoundingClientRect", () => new window.DOMRect(120, 180, 220, 24));

  const subscriptions = new Set<symbol>();
  const subscribe = (): (() => void) => {
    const token = Symbol("subscription");
    subscriptions.add(token);
    return () => { subscriptions.delete(token); };
  };
  const data = snapshots(workspacePath);
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
    onAppearanceChanged: subscribe, onApplicationImportsChanged: subscribe, onAgentEvent: subscribe,
    onSessionHandoff: subscribe, onMenuAction: subscribe, onSettingsCloseRequest: subscribe,
    onBrowserOpenRequest: subscribe, onReferenceOpen: subscribe,
    referenceForMessage: (...args: Parameters<DesktopApi["referenceForMessage"]>) => tracked(async () => {
      calls.source.push(args);
      const [projectId, threadId, messageId] = args;
      const source = await service.referenceForMessage(threadId, messageId, projectId);
      sources.push(source);
      return source;
    }),
    referenceCaptureSelectionQuote: (...args: Parameters<DesktopApi["referenceCaptureSelectionQuote"]>) => tracked(async () => {
      calls.capture.push(args);
      captureEntered.resolve();
      await captureGate.promise;
      try {
        const [projectId, sourceUri, quote] = args;
        const result = await graph.captureSelectionQuote(sourceUri, quote, projectId);
        captures.push(result);
        return result;
      } finally { captureFinished.resolve(); }
    }),
    sendPrompt: async (...args: Parameters<DesktopApi["sendPrompt"]>) => {
      calls.send.push(args);
      return { sessionId: SESSION, runId: "sent:run", messageId: "sent:user" };
    }
  } satisfies Partial<DesktopApi>;
  replace(window, "biny", new Proxy(api, { get(target, key, receiver) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error("Unexpected window.biny access: " + String(key));
    return Reflect.get(target, key, receiver);
  } }));
  resources.assets = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@xterm/xterm") return next("@xterm/xterm/lib/xterm.mjs", context);
    if (specifier === "@xterm/addon-fit") return next("@xterm/addon-fit/lib/addon-fit.mjs", context);
    return next(specifier, context);
  }, load(url, context, next) {
    if (/\.(?:svg|png|jpg|webp)(?:\?.*)?$/u.test(url)) return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(url) + ";" };
    if (/\.css(?:\?.*)?$/u.test(url)) return { format: "module", shortCircuit: true, source: "export {};" };
    return next(url, context);
  } });
  const React = resources.React = await import("react");
  replace(globalThis, "React", React);
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/desktop/renderer/src/App.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  timersEnabled = true;
  const root = resources.root = createRoot(document.getElementById("root")!);
  await React.act(async () => { root.render(React.createElement(App, { settingsEnabled: false })); });
  const one = <T extends Element>(selector: string): T => {
    const matches = document.querySelectorAll<T>(selector);
    assert.equal(matches.length, 1, "Expected one " + selector);
    return matches[0]!;
  };
  const input = one<HTMLTextAreaElement>('textarea[aria-label="任务输入"]');
  const timeline = one<HTMLDivElement>(".message-timeline");
  const markdown = one<HTMLElement>('[data-quote-message-id="' + USER + '"] .markdown-body');
  assert.ok(document.querySelector(".biny-workspace-chat .biny-composer .biny-prompt-editor"));
  assert.equal(document.querySelector(".desktop-toast-message")?.textContent ?? "", "");
  assert.deepEqual(calls.selection, [[PROJECT, SESSION, "chat"]]);
  assert.equal(input.value, "");
  assert.equal(input.disabled, false);

  const frame = async (): Promise<void> => {
    const scheduled = [...frames.keys()];
    frameTime += 16;
    await React.act(() => {
      for (const id of scheduled) {
        const callback = frames.get(id);
        if (!callback) continue;
        frames.delete(id);
        callback(frameTime);
      }
    });
  };
  for (let count = 0; frames.size; count += 1) {
    assert.ok(count < 100, "Startup RAF queue must become idle");
    await frame();
  }
  const selectAndCapture = async (): Promise<void> => {
    const paragraph = markdown.querySelector("p");
    assert.ok(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    await React.act(() => {
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
      timeline.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      t.mock.timers.tick(0);
    });
    assert.equal(window.getSelection()!.toString(), QUOTE);
    await React.act(async () => {
      const button = one<HTMLButtonElement>(ADD_BUTTON);
      const down = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
      button.dispatchEvent(down);
      assert.equal(down.defaultPrevented, true);
      button.click();
      await waitWithSignal(captureEntered.promise, t.signal);
    });
  };
  const releaseCapture = async (): Promise<void> => {
    await React.act(async () => { captureGate.resolve(); await waitWithSignal(captureFinished.promise, t.signal); });
  };
  const submit = async (): Promise<void> => {
    const form = input.closest("form");
    assert.ok(form);
    await React.act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
  };
  return { input, document, calls, sources, captures, service, graph, sessionFile, selectAndCapture, releaseCapture, submit, frame,
    tokens: () => document.querySelectorAll(".biny-prompt-reference-token").length,
    warning: () => document.querySelector(".desktop-toast-message")?.textContent ?? "" };
}

test("delivered canonical user selection reaches real snippet storage and the actual Composer send token", { timeout: 20_000 }, async t => {
  const h = await harness(t);
  await h.selectAndCapture();
  const sourceUri = "biny://thread/" + SESSION + "/message/" + encodeURIComponent(SLOT);
  assert.notEqual(USER, SLOT, "canonical message identity must not be disguised as a slot");
  assert.deepEqual(h.calls.source, [[PROJECT, SESSION, USER]]);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0]!.messageId, USER);
  assert.equal(h.sources[0]!.uri, sourceUri);
  assert.equal(h.sources[0]!.content, RAW);
  assert.deepEqual(h.calls.capture, [[PROJECT, sourceUri, QUOTE]]);
  assert.equal(RAW.includes(QUOTE), false, "rendered Markdown quote is a snapshot, not a raw-source substring");
  assert.equal(h.captures.length, 0);
  assert.equal(h.input.value, "");
  assert.equal(h.tokens(), 0, "no token exists while actual capture remains pending");

  await h.releaseCapture();
  assert.equal(h.warning(), "");
  assert.equal(h.captures.length, 1);
  const captured = h.captures[0]!;
  assert.equal(captured.kind, "snippet");
  assert.ok(captured.uri.startsWith("biny://snippet/"));
  assert.equal(captured.threadId, SESSION);
  assert.equal(captured.messageId, USER);
  assert.equal(captured.content, QUOTE);
  assert.equal(h.input.value, "@" + QUOTE + " ");
  assert.equal(h.tokens(), 1);
  assert.equal(h.document.querySelector(ADD_BUTTON), null);
  await h.frame();
  await h.frame();
  assert.equal(h.tokens(), 1, "layout work must not duplicate the captured token");

  await h.submit();
  assert.equal(h.calls.send.length, 1, "use the mounted form and Composer's real materialization path");
  const [projectId, sessionId, sentInput, attachments, delivery] = h.calls.send[0]!;
  assert.equal(projectId, PROJECT);
  assert.equal(sessionId, SESSION);
  assert.equal(sentInput, "@[" + QUOTE + "](" + captured.uri + ")");
  assert.deepEqual(attachments, []);
  assert.equal(delivery, undefined);
  assert.equal(h.input.value, "");
  assert.equal(h.tokens(), 0);
  assert.equal(h.warning(), "");
  const resolved = await h.graph.resolve(captured.uri, PROJECT);
  assert.equal(resolved.content, QUOTE);
  assert.equal(resolved.messageId, USER);

  // Existing contract: the text snapshot survives, while navigation follows the
  // source slot. This deliberately does not assert permanent original-version identity.
  const replacement = "replacement:canonical:user";
  const replacementEvents: SessionEvent[] = [
    { type: "user_message", time: TIME, messageId: replacement, slotId: SLOT, parentMessageId: ASSISTANT,
      content: "Only change the subtitle." },
    { type: "message_version_selected", slotId: SLOT, messageId: replacement }
  ];
  await appendFile(h.sessionFile, replacementEvents.map(event => JSON.stringify(event)).join("\n") + "\n");
  const current = await h.service.referenceForMessage(SESSION, replacement, PROJECT);
  assert.equal(current.uri, sourceUri);
  const afterVersionChange = await h.graph.resolve(captured.uri, PROJECT);
  assert.equal(afterVersionChange.content, QUOTE);
  assert.equal(afterVersionChange.messageId, replacement);
  assert.deepEqual(h.calls.network, [], "the full local reference chain performs no external requests");
});
