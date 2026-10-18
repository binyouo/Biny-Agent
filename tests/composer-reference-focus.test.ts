/**
 * Real Composer/PromptInput regression for append commit -> queued RAF only.
 * The public imperative handle and native DOM methods are never mocked. This
 * does not test the earlier App capture wait or promise to preserve pre-commit
 * caret positions. Authored without running repository code or tests locally.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ComposerHandle } from "../src/desktop/renderer/src/components/Composer.js";
import type { ReferenceDraft } from "../src/desktop/renderer/src/components/composer/referenceCompletion.js";

const INITIAL: ReferenceDraft = {
  value: "abcdef @notes ",
  tokens: [{ start: 7, end: 13, label: "notes", uri: "biny://file/notes.txt", kind: "file" }]
};
const REFERENCE = { kind: "snippet" as const, label: "Captured A", uri: "biny://snippet/focus-A" };
const APPENDED = `${INITIAL.value}@${REFERENCE.label} `;
const INTENT_EVENTS = new Set(["pointerdown", "keydown", "input", "compositionstart", "focusin"]);

// Imported dependencies can retain RAF identity across sequential DOM fixtures.
let nextFrameId = 0;
let frameHost: { request(callback: FrameRequestCallback): number; cancel(id: number): void } | undefined;
function requestFrame(callback: FrameRequestCallback): number {
  assert.equal(frameHost !== undefined, true, "RAF needs an active fixture");
  return frameHost!.request(callback);
}
function cancelFrame(id: number): void { frameHost?.cancel(id); }

interface Resources {
  dom?: JSDOM;
  root?: Root;
  React?: typeof import("react");
  assets?: ReturnType<typeof registerHooks>;
  frames: Map<number, FrameRequestCallback>;
}
interface Options { editing?: boolean }
type Fixture = Awaited<ReturnType<typeof setupFixture>>;

async function withFixture(t: TestContext, run: (fixture: Fixture) => Promise<void>, options: Options = {}): Promise<void> {
  const resources: Resources = { frames: new Map() };
  const restore: Array<() => void> = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    await attempt(async () => {
      if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount());
      resources.root = undefined;
    });
    await attempt(() => resources.assets?.deregister());
    await attempt(() => resources.dom?.window.close());
    await attempt(() => resources.frames.clear());
    for (const undo of restore.reverse()) await attempt(undo);
    if (errors.length) throw new AggregateError(errors, "Failed to restore Composer focus fixture");
  };
  // Register before imports, DOM/global changes, loader hooks, or createRoot.
  t.after(close);
  let failed = false;
  let failure: unknown;
  try { await run(await setupFixture(resources, restore, options)); }
  catch (error) {
    failed = true; failure = error;
    if (error instanceof AggregateError) {
      try {
        const details = error.errors.slice(0, 6).map((nested: unknown) => nested instanceof Error
          ? `${nested.name}: ${nested.message}\n${nested.stack ?? ""}`.slice(0, 1_000) : String(nested).slice(0, 300));
        t.diagnostic(`Composer fixture nested errors:\n${details.join("\n")}`);
      } catch { /* Diagnostics must never replace the same original error. */ }
    }
  }
  try { await close(); }
  catch (error) {
    if (!failed) throw error;
    // A cleanup problem must not replace the original setup/body assertion.
    try { t.diagnostic(`Cleanup also failed: ${String(error).slice(0, 1_000)}`); } catch { /* Preserve failure. */ }
  }
  if (failed) throw failure;
}

async function setupFixture(resources: Resources, restore: Array<() => void>, options: Options) {
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  const { JSDOM: DOM } = await import("jsdom");
  const dom = new DOM('<!doctype html><button id="before">Before</button><button id="after">After</button><div id="root"></div>',
    { url: "https://biny.test", pretendToBeVisual: true });
  resources.dom = dom;
  const window = dom.window;
  const document = window.document;
  assert.equal(frameHost === undefined, true, "DOM fixtures must be sequential");
  const previousFrameHost = frameHost;
  restore.push(() => { frameHost = previousFrameHost; });
  frameHost = {
    request(callback) { const id = ++nextFrameId; resources.frames.set(id, callback); return id; },
    cancel(id) { resources.frames.delete(id); }
  };
  class LayoutObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  for (const [key, value] of Object.entries({
    window, document, self: window, navigator: window.navigator, CSS: window.CSS,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    Document: window.Document, Range: window.Range, Selection: window.Selection,
    SVGElement: window.SVGElement, HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLCanvasElement: window.HTMLCanvasElement,
    HTMLDialogElement: window.HTMLDialogElement, DOMParser: window.DOMParser,
    Event: window.Event, InputEvent: window.InputEvent, MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent, KeyboardEvent: window.KeyboardEvent, FocusEvent: window.FocusEvent,
    CustomEvent: window.CustomEvent, MutationObserver: window.MutationObserver, DOMRect: window.DOMRect,
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
  const api = { referenceSearch: async () => [], readInlineImage: async () => undefined };
  replace(window, "biny", new Proxy(api, { get(target, key, receiver) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`Unexpected window.biny access: ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } }));
  resources.assets = registerHooks({ resolve(specifier, context, next) {
    // Keep real package implementations when Node otherwise selects UMD main.
    if (specifier === "@xterm/xterm") return next("@xterm/xterm/lib/xterm.mjs", context);
    if (specifier === "@xterm/addon-fit") return next("@xterm/addon-fit/lib/addon-fit.mjs", context);
    return next(specifier, context);
  }, load(url, context, next) {
    if (/\.(?:svg|png|jpg|webp)(?:\?.*)?$/u.test(url)) return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
    if (/\.css(?:\?.*)?$/u.test(url)) return { format: "module", shortCircuit: true, source: "export {};" };
    return next(url, context);
  } });
  const React = await import("react");
  resources.React = React;
  replace(globalThis, "React", React);
  const { createRoot } = await import("react-dom/client");
  const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
  const { ComposerDraftState } = await import("../src/desktop/renderer/src/components/composer/composerDraft.js");
  const draft = new ComposerDraftState();
  draft.update({ draft: structuredClone(INITIAL), history: [
    { before: { value: "abcdef ", tokens: [] }, after: structuredClone(INITIAL) }
  ] });
  const original = structuredClone(draft.getSnapshot());
  const ref = React.createRef<ComposerHandle>();
  const edits: string[] = [];
  const sends: string[] = [];
  const warnings: string[] = [];
  const noop = async (): Promise<void> => {};
  const props: React.ComponentProps<typeof Composer> = {
    ref, project: { id: "p", name: "p", path: "/synthetic/project", dirty: false, missing: false, pinned: false, addedAt: "", lastOpenedAt: "" },
    drafts: new Map([["p:session", draft]]), draftKey: "p:session", models: [],
    memoryState: "enabled", memoryToggleBusy: false, memoryToggleDisabled: false,
    running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: false,
    focusToken: 0, capabilityDefaults: { tools: "none", skills: "none" }, skills: [], toolCatalog: [],
    editingMessage: options.editing ? { nonce: 1, value: "editing @[notes](biny://file/notes.txt)" } : undefined,
    onSend: async value => { sends.push(value); }, onSubmitEdit: async value => { edits.push(value); },
    onCancelEdit() {}, onMutateQueuedMessage: noop, onResume: noop, onSlashCommand: noop, onStop: noop,
    onToggleMemory: noop, onSwitchModel: noop, onSaveAttachment: async () => { throw new Error("Unexpected attachment save"); },
    onWarning: message => { warnings.push(message); }, onSubmitError: message => { warnings.push(message); }
  };
  const root = createRoot(document.getElementById("root")!);
  resources.root = root;
  let currentProps = props;
  const render = async (changes: Partial<typeof props> = {}): Promise<void> => {
    currentProps = { ...currentProps, ...changes };
    await React.act(() => root.render(React.createElement(Composer, currentProps)));
  };
  await render();
  const one = <T extends Element>(selector: string): T => {
    const matches = document.querySelectorAll<T>(selector);
    assert.equal(matches.length, 1, `Expected one ${selector}`);
    return matches[0]!;
  };
  const input = one<HTMLTextAreaElement>('textarea[aria-label="任务输入"]');
  const before = one<HTMLButtonElement>("#before");
  const after = one<HTMLButtonElement>("#after");
  const form = one<HTMLFormElement>("form.biny-composer");
  assert.equal(input.disabled, false);
  assert.deepEqual(warnings, []);
  assert.equal(input.value, options.editing ? "editing @notes" : INITIAL.value);
  let frameTime = 0;
  const frame = async (): Promise<number> => {
    const ids = [...resources.frames.keys()];
    frameTime += 16;
    let count = 0;
    await React.act(() => {
      for (const id of ids) {
        const callback = resources.frames.get(id);
        if (!callback) continue;
        resources.frames.delete(id);
        count += 1;
        callback(frameTime);
      }
    });
    return count;
  };
  for (let count = 0; resources.frames.size; count += 1) {
    assert.equal(count < 100, true, "Startup RAF queue must settle");
    await frame();
  }
  await React.act(() => before.focus());
  assert.equal(document.activeElement === before, true);
  const nativeFocus = input.focus;
  const nativeRange = input.setSelectionRange;
  const calls = { focus: 0, range: 0 };
  replace(input, "focus", function (focusOptions?: FocusOptions): void {
    calls.focus += 1;
    nativeFocus.call(input, focusOptions);
  });
  replace(input, "setSelectionRange", function (start: number, end: number, direction?: "forward" | "backward" | "none"): void {
    calls.range += 1;
    nativeRange.call(input, start, end, direction);
  });

  // Observe actual native registration/removal without replacing callbacks.
  // Register after startup so unrelated component lifetime listeners are absent.
  const captures = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  const capture = (value?: boolean | EventListenerOptions): boolean => typeof value === "boolean" ? value : Boolean(value?.capture);
  replace(document, "addEventListener", function (type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | AddEventListenerOptions): void {
    if (listener && INTENT_EVENTS.has(type) && capture(listenerOptions)) {
      const set = captures.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      set.add(listener); captures.set(type, set);
    }
    add(type, listener, listenerOptions);
  });
  replace(document, "removeEventListener", function (type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | EventListenerOptions): void {
    if (listener && capture(listenerOptions)) captures.get(type)?.delete(listener);
    remove(type, listener, listenerOptions);
  });
  const blurListeners = new Set<EventListenerOrEventListenerObject>();
  const addWindow = window.addEventListener.bind(window);
  const removeWindow = window.removeEventListener.bind(window);
  replace(window, "addEventListener", function (type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | AddEventListenerOptions): void {
    if (type === "blur" && listener && !capture(listenerOptions)) blurListeners.add(listener);
    addWindow(type, listener, listenerOptions);
  });
  replace(window, "removeEventListener", function (type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | EventListenerOptions): void {
    if (type === "blur" && listener && !capture(listenerOptions)) blurListeners.delete(listener);
    removeWindow(type, listener, listenerOptions);
  });
  const intentListenerCount = (): number => blurListeners.size + [...captures.values()].reduce((total, listeners) => total + listeners.size, 0);
  const focusInput = async (): Promise<void> => {
    await React.act(() => input.focus());
    assert.equal(document.activeElement === input, true);
  };
  const append = async (reference = REFERENCE): Promise<void> => {
    await React.act(() => ref.current!.appendReference(reference));
    assert.equal(input.value.includes(`@${reference.label} `), true, "Controlled textarea commit must precede new intent");
    assert.equal(document.querySelectorAll(".biny-prompt-reference-token").length, 2);
  };
  const range = (): [number, number, string] => [input.selectionStart, input.selectionEnd, input.selectionDirection];
  const moveCaret = async (gesture: "keydown" | "pointerdown"): Promise<void> => {
    assert.equal(document.activeElement === input, true);
    await React.act(() => {
      if (gesture === "keydown") input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
      else input.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      // JSDOM does not execute the key/pointer default selection behavior.
      // Establish that native DOM result explicitly, then test its ownership.
      input.setSelectionRange(2, 4, "backward");
      input.dispatchEvent(new window.Event("select", { bubbles: true }));
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    assert.equal(document.activeElement === input, true);
    assert.deepEqual(range(), [2, 4, "backward"]);
  };
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  const typeValue = async (value: string): Promise<void> => {
    assert.equal(document.activeElement === input, true);
    await React.act(() => {
      valueSetter.call(input, value);
      input.setSelectionRange(2, 2, "none");
      input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "X" }));
    });
    assert.equal(input.value, value);
    if (!currentProps.editingMessage) assert.equal(draft.getSnapshot().draft.value, value, "Production onChange must accept the native input");
  };
  const submitEdit = async (): Promise<void> => {
    await React.act(() => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  };
  const unmount = async (): Promise<void> => {
    await React.act(() => root.unmount());
    resources.root = undefined;
  };
  return { React, window, document, input, before, after, calls, draft, original, edits, sends, warnings,
    ref, render, frame, focusInput, append, range, moveCaret, typeValue, submitEdit, unmount, intentListenerCount };
}

function assertOrdinaryAppend(h: Fixture, value = APPENDED): void {
  const snapshot = h.draft.getSnapshot();
  assert.equal(snapshot.draft.value, value);
  assert.equal(h.input.value, value);
  assert.deepEqual(snapshot.draft.tokens.map(token => token.uri), [INITIAL.tokens[0]!.uri, REFERENCE.uri]);
  for (const token of snapshot.draft.tokens) assert.equal(value.slice(token.start, token.end), `@${token.label}`);
  assert.equal(snapshot.draft.tokens.filter(token => token.uri === REFERENCE.uri).length, 1);
}

test("normal append to an unfocused Composer keeps content/history and focuses once at the new end", { timeout: 20_000 }, async t => {
  await withFixture(t, async h => {
    const before = { ...h.calls };
    await h.append();
    assertOrdinaryAppend(h);
    assert.deepEqual(h.draft.getSnapshot().history[0], h.original.history[0]);
    assert.equal(h.draft.getSnapshot().history.length, 2);
    assert.deepEqual(h.calls, before, "Append commits before deferred focus");
    assert.equal(h.document.activeElement === h.before, true);
    assert.equal((await h.frame()) > 0, true);
    assert.equal(h.document.activeElement === h.input, true);
    assert.deepEqual(h.range().slice(0, 2), [APPENDED.length, APPENDED.length]);
    assert.deepEqual(h.calls, { focus: before.focus + 1, range: before.range + 1 });
    assert.equal(h.intentListenerCount(), 0);
    await h.frame();
    assert.deepEqual(h.calls, { focus: before.focus + 1, range: before.range + 1 });
    assertOrdinaryAppend(h);
  });
});

test("already-focused draft with a token still gets normal append caret after value commit and metadata rerender", { timeout: 20_000 }, async t => {
  await withFixture(t, async h => {
    await h.focusInput();
    await h.React.act(() => h.input.setSelectionRange(2, 4, "backward"));
    const before = { ...h.calls };
    await h.append();
    assertOrdinaryAppend(h);
    assert.equal(h.document.activeElement === h.input, true);
    assert.deepEqual(h.calls, before);
    await h.React.act(() => {
      h.input.dispatchEvent(new h.window.Event("select", { bubbles: true }));
      h.document.dispatchEvent(new h.window.Event("selectionchange"));
    });
    await h.render({ resourceRevision: 2 });
    assert.equal(h.document.activeElement === h.input, true);
    await h.frame();
    assert.deepEqual(h.range().slice(0, 2), [APPENDED.length, APPENDED.length]);
    assert.deepEqual(h.calls, { focus: before.focus + 1, range: before.range + 1 });
    assert.equal(h.intentListenerCount(), 0);
    assertOrdinaryAppend(h);
  });
});

for (const gesture of ["keydown", "pointerdown"] as const) {
  test(`new ${gesture} caret in the already-focused input survives the older append RAF`, { timeout: 20_000 }, async t => {
    await withFixture(t, async h => {
      await h.focusInput();
      const focused = h.calls.focus;
      await h.append();
      assertOrdinaryAppend(h);
      assert.equal(h.document.activeElement === h.input, true);
      assert.equal(h.calls.focus, focused);
      await h.moveCaret(gesture);
      assert.equal(h.calls.focus, focused, "Caret-only case must not focus again after append");
      const before = { ...h.calls };
      await h.frame();
      assert.deepEqual(h.range(), [2, 4, "backward"]);
      assert.deepEqual(h.calls, before);
      assert.equal(h.document.activeElement === h.input, true);
      assert.equal(h.intentListenerCount(), 0);
      assertOrdinaryAppend(h);
    });
  });
}

test("focus acquired by another control after append is not stolen by the old RAF", { timeout: 20_000 }, async t => {
  await withFixture(t, async h => {
    await h.append();
    assertOrdinaryAppend(h);
    await h.React.act(() => h.after.focus());
    assert.equal(h.document.activeElement === h.after, true);
    const before = { ...h.calls };
    await h.frame();
    assert.equal(h.document.activeElement === h.after, true);
    assert.deepEqual(h.calls, before);
    assert.equal(h.intentListenerCount(), 0);
    assertOrdinaryAppend(h);
  });
});

for (const roundTrip of [false, true]) {
  test(`native input after append preserves newer caret${roundTrip ? " even after returning to the same text" : " and reference identity"}`, { timeout: 20_000 }, async t => {
    await withFixture(t, async h => {
      await h.focusInput();
      await h.append();
      await h.typeValue(`X${APPENDED}`);
      if (roundTrip) await h.typeValue(APPENDED);
      const value = roundTrip ? APPENDED : `X${APPENDED}`;
      assertOrdinaryAppend(h, value);
      const before = { ...h.calls };
      const range = h.range();
      await h.frame();
      assert.deepEqual(h.range(), range);
      assert.deepEqual(h.calls, before);
      assert.equal(h.intentListenerCount(), 0);
      assertOrdinaryAppend(h, value);
    });
  });
}

test("compositionstart after append cancels only its pending focus, without claiming native IME coverage", { timeout: 20_000 }, async t => {
  await withFixture(t, async h => {
    await h.focusInput();
    await h.append();
    await h.React.act(() => {
      h.input.dispatchEvent(new h.window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      h.input.setSelectionRange(2, 2, "none");
    });
    const before = { ...h.calls };
    await h.frame();
    assert.deepEqual(h.range().slice(0, 2), [2, 2]);
    assert.deepEqual(h.calls, before);
    assert.equal(h.intentListenerCount(), 0);
    assertOrdinaryAppend(h);
  });
});

test("a later append supersedes only the older RAF while both reference payloads remain", { timeout: 20_000 }, async t => {
  await withFixture(t, async h => {
    await h.append();
    const second = { kind: "snippet" as const, label: "Captured B", uri: "biny://snippet/focus-B" };
    await h.React.act(() => h.ref.current!.appendReference(second));
    const value = `${APPENDED}@${second.label} `;
    assert.equal(h.input.value, value);
    assert.equal(h.document.querySelectorAll(".biny-prompt-reference-token").length, 3);
    assert.deepEqual(h.draft.getSnapshot().draft.tokens.map(token => token.uri), [INITIAL.tokens[0]!.uri, REFERENCE.uri, second.uri]);
    const before = { ...h.calls };
    await h.frame();
    assert.deepEqual(h.calls, { focus: before.focus + 1, range: before.range + 1 });
    assert.deepEqual(h.range().slice(0, 2), [value.length, value.length]);
    assert.equal(h.intentListenerCount(), 0);
    assert.equal(h.draft.getSnapshot().history.length, 3);
  });
});

for (const newerCaret of [false, true]) {
  test(`stable editing draft retains appended URI while ${newerCaret ? "new caret cancels" : "normal append uses"} its focus`, { timeout: 20_000 }, async t => {
    await withFixture(t, async h => {
      await h.focusInput();
      await h.append();
      assert.equal(h.input.value, "editing @notes @Captured A ");
      assert.deepEqual(h.draft.getSnapshot(), h.original, "Editing must not change the ordinary draft");
      if (newerCaret) await h.moveCaret("keydown");
      const before = { ...h.calls };
      await h.frame();
      if (newerCaret) {
        assert.deepEqual(h.range(), [2, 4, "backward"]);
        assert.deepEqual(h.calls, before);
      } else {
        assert.deepEqual(h.range().slice(0, 2), [h.input.value.length, h.input.value.length]);
        assert.deepEqual(h.calls, { focus: before.focus + 1, range: before.range + 1 });
      }
      assert.equal(h.intentListenerCount(), 0);
      await h.submitEdit();
      assert.deepEqual(h.edits, ["editing @[notes](biny://file/notes.txt) @[Captured A](biny://snippet/focus-A)"]);
      assert.deepEqual(h.sends, []);
      assert.deepEqual(h.warnings, []);
      assert.deepEqual(h.draft.getSnapshot(), h.original);
    }, { editing: true });
  });
}

test("a new edit nonce owns the reused textarea before the old append RAF runs", { timeout: 20_000 }, async t => {
  await withFixture(t, async h => {
    await h.focusInput();
    await h.append();
    const replacement = "second edit has a deliberately longer untouched ending";
    await h.render({ editingMessage: { nonce: 2, value: replacement } });
    assert.equal(h.input.value, replacement);
    assert.equal(h.document.activeElement === h.input, true);
    const before = { ...h.calls };
    const range = h.range();
    await h.frame();
    assert.deepEqual(h.range(), range);
    assert.deepEqual(h.calls, before);
    assert.equal(h.intentListenerCount(), 0);
    assert.deepEqual(h.draft.getSnapshot(), h.original);
    await h.submitEdit();
    assert.deepEqual(h.edits, [replacement], "Do not restore an edit the user replaced");
  }, { editing: true });
});

test("unmount removes pending reference-focus listeners and never focuses a detached textarea", { timeout: 20_000 }, async t => {
  await withFixture(t, async h => {
    await h.append();
    assertOrdinaryAppend(h);
    const before = { ...h.calls };
    await h.unmount();
    assert.equal(h.input.isConnected, false);
    assert.equal(h.intentListenerCount(), 0, "Actual intent listener registrations must be removed");
    await h.frame();
    assert.deepEqual(h.calls, before);
    assert.equal(h.draft.getSnapshot().draft.tokens.filter(token => token.uri === REFERENCE.uri).length, 1);
  });
});
