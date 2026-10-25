/** Real Composer input events, draft identity, and submission; only search IPC is faked. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { LocalReferenceKind, LocalReferenceResult } from "../src/session/localReferences.js";

const ALPHA: LocalReferenceResult = { kind: "file", label: "alpha.ts", uri: "biny://file/alpha.ts", content: "alpha.ts", projectId: "p" };
const BETA: LocalReferenceResult = { kind: "file", label: "beta.ts", uri: "biny://file/beta.ts", content: "beta.ts", projectId: "p" };
const MEMORY: LocalReferenceResult = { kind: "memory", label: "alpha memory", uri: "biny://memory/alpha", content: "alpha memory", projectId: "p" };
interface Request {
  projectId: string;
  query: string;
  kind?: LocalReferenceKind;
  resolve(results: LocalReferenceResult[]): void;
  reject(error: Error): void;
}

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
type Fixture = Awaited<ReturnType<typeof setupFixture>>;

async function withFixture(t: TestContext, run: (fixture: Fixture) => Promise<void>): Promise<void> {
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
    if (errors.length) throw new AggregateError(errors, "Failed to restore reference-results fixture");
  };
  // Register before imports, DOM/global changes, loader hooks, or createRoot.
  t.after(close);
  let failed = false;
  let failure: unknown;
  try { await run(await setupFixture(resources, restore)); }
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

async function setupFixture(resources: Resources, restore: Array<() => void>) {
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
  const requests: Request[] = [];
  const api = { referenceSearch: (projectId: string, query: string, kind?: LocalReferenceKind) =>
    new Promise<LocalReferenceResult[]>((resolve, reject) => requests.push({ projectId, query, kind, resolve, reject })) };
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
  const sends: string[] = [];
  const inspected: string[] = [];
  const warnings: string[] = [];
  const noop = async (): Promise<void> => {};
  const props: React.ComponentProps<typeof Composer> = {
    project: { id: "p", name: "p", path: "/synthetic/project", dirty: false, missing: false, pinned: false, addedAt: "", lastOpenedAt: "" },
    drafts: new Map([["p:session", draft]]), draftKey: "p:session", models: [], onChangeFastMode() {},
    memoryState: "enabled", memoryToggleBusy: false, memoryToggleDisabled: false,
    running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: false,
    focusToken: 0, capabilityDefaults: { tools: "none", skills: "none" }, skills: [], toolCatalog: [],
    onSend: async value => { sends.push(value); }, onSubmitEdit: noop,
    onInspectReference: result => { inspected.push(result.uri); },
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
  const form = one<HTMLFormElement>("form.biny-composer");
  assert.equal(input.disabled, false);
  assert.deepEqual(warnings, []);
  assert.equal(input.value, "");
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
  const options = (): string[] => [...document.querySelectorAll('[role="listbox"][aria-label="本地引用"] [role="option"] code')]
    .map(element => element.textContent ?? "");
  const edit = async (value: string): Promise<void> => {
    await React.act(() => input.focus());
    // Each edit commits before the next distinct keyboard or pointer event.
    await React.act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    assert.equal(draft.getSnapshot().draft.value, value, "Real Composer must own the edit before the next user event");
  };
  const key = async (value: string): Promise<void> => {
    await React.act(async () => { input.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value })); });
  };
  const request = async (query: string, kind: LocalReferenceKind = "file", projectId = "p"): Promise<Request> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = [...requests].reverse().find(item => item.query === query && item.kind === kind && item.projectId === projectId);
      if (found) return found;
      await React.act(async () => { await delay(10); });
    }
    throw new Error(`Reference request not dispatched: ${projectId}/${kind}/${query}`);
  };
  const resolve = async (pending: Request, results: LocalReferenceResult[]): Promise<void> => {
    await React.act(async () => { pending.resolve(results); });
  };
  const publishAlpha = async (): Promise<Request> => {
    await edit("@文件:alpha");
    const pending = await request("alpha");
    await resolve(pending, [ALPHA]);
    assert.deepEqual(options(), [ALPHA.label]);
    return pending;
  };
  const submit = async (): Promise<void> => {
    await React.act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.deepEqual(warnings, []);
  };
  const click = async (button: HTMLElement): Promise<void> => {
    await React.act(() => { button.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    await React.act(() => { button.click(); });
  };
  return { React, dom, document, input, draft, requests, sends, inspected, options, edit, key, request, resolve, publishAlpha,
    submit, click, render, props, unmount: async () => {
      await React.act(() => root.unmount()); resources.root = undefined;
    } };
}

for (const key of ["Enter", "Tab"]) {
  for (const phase of ["debounce", "pending"] as const) {
    test(`a changed query cannot choose the previous result with ${key} during ${phase}`, async t => {
      await withFixture(t, async f => {
        await f.publishAlpha();
        await f.edit("@文件:beta");
        if (phase === "pending") await f.request("beta");
        else assert.equal(f.requests.some(request => request.query === "beta"), false);
        await f.key(key);
        await f.submit();
        t.diagnostic(JSON.stringify({ sends: f.sends, inspected: f.inspected }));
        assert.deepEqual(f.inspected, [], "An old query must not select or inspect alpha for the beta completion");
        assert.deepEqual(f.sends, ["@文件:beta"], "The submitted prompt must not materialize an obsolete URI");
      });
    });
  }
}

test("a kind change with the same query/range retires previous options", async t => {
  await withFixture(t, async f => {
    await f.publishAlpha();
    await f.edit("@记忆:alpha");
    assert.deepEqual(f.options(), []);
    assert.equal(f.input.getAttribute("aria-activedescendant"), null);
    await f.resolve(await f.request("alpha", "memory"), [MEMORY]);
    await f.key("Tab");
    await f.submit();
    assert.deepEqual(f.sends, ["@[alpha memory](biny://memory/alpha)"]);
  });
});

test("a changed query removes the old pointer target; current pointer selection still submits", async t => {
  await withFixture(t, async f => {
    await f.publishAlpha();
    const previous = f.document.querySelector<HTMLElement>('[role="option"]')!;
    await f.edit("@文件:beta");
    assert.deepEqual(f.options(), []);
    assert.equal(previous.isConnected, false);
    await f.click(previous);
    assert.deepEqual(f.inspected, []);
    assert.equal(f.draft.getSnapshot().draft.value, "@文件:beta");
    await f.resolve(await f.request("beta"), [BETA]);
    await f.click(f.document.querySelector<HTMLElement>('[role="option"]')!);
    await f.submit();
    assert.deepEqual(f.inspected, [BETA.uri]);
    assert.deepEqual(f.sends, ["@[beta.ts](biny://file/beta.ts)"]);
  });
});

for (const key of ["Enter", "Tab"]) {
  test(`current-query keyboard selection remains functional with ${key}`, async t => {
    await withFixture(t, async f => {
      await f.publishAlpha();
      await f.key(key);
      assert.deepEqual(f.draft.getSnapshot().draft.tokens.map(token => token.uri), [ALPHA.uri]);
      await f.submit();
      assert.deepEqual(f.sends, ["@[alpha.ts](biny://file/alpha.ts)"]);
    });
  });
}

test("late old-query fulfillment cannot replace current results", async t => {
  await withFixture(t, async f => {
    await f.edit("@文件:alpha");
    const old = await f.request("alpha");
    await f.edit("@文件:beta");
    await f.resolve(await f.request("beta"), [BETA]);
    await f.resolve(old, [ALPHA]);
    assert.deepEqual(f.options(), [BETA.label]);
    await f.key("Tab");
    await f.submit();
    assert.deepEqual(f.sends, ["@[beta.ts](biny://file/beta.ts)"]);
  });
});

for (const outcome of ["empty", "error"] as const) {
  test(`current-query ${outcome} does not restore or commit old results`, async t => {
    await withFixture(t, async f => {
      await f.publishAlpha();
      await f.edit("@文件:beta");
      const pending = await f.request("beta");
      if (outcome === "empty") await f.resolve(pending, []);
      else await f.React.act(async () => { pending.reject(new Error("Search unavailable")); });
      assert.deepEqual(f.options(), []);
      assert.equal(f.document.querySelector('[role="alert"]')?.textContent ?? null,
        outcome === "error" ? "Search unavailable" : null);
      await f.key("Tab");
      await f.submit();
      assert.deepEqual(f.inspected, []);
      assert.deepEqual(f.sends, ["@文件:beta"]);
    });
  });
}

for (const close of ["dismiss", "blur", "unmount"] as const) {
  test(`late search fulfillment after ${close} cannot reopen the menu`, async t => {
    await withFixture(t, async f => {
      await f.edit("@文件:alpha");
      const pending = await f.request("alpha");
      if (close === "dismiss") await f.key("Escape");
      else if (close === "blur") await f.React.act(() => f.document.querySelector<HTMLElement>("#before")!.focus());
      else await f.unmount();
      await f.resolve(pending, [ALPHA]);
      assert.equal(f.document.querySelector('[role="listbox"][aria-label="本地引用"]') === null, true);
      assert.deepEqual(f.inspected, []);
      assert.deepEqual(f.sends, []);
    });
  });
}

test("same completion in another project cannot retain the old project's result", async t => {
  await withFixture(t, async f => {
    await f.publishAlpha();
    await f.render({ project: { ...f.props.project!, id: "other" } });
    assert.deepEqual(f.options(), []);
    const other = { ...ALPHA, projectId: "other", uri: "biny://file/other/alpha.ts" };
    await f.resolve(await f.request("alpha", "file", "other"), [other]);
    await f.key("Tab");
    await f.submit();
    assert.deepEqual(f.inspected, [other.uri]);
    assert.deepEqual(f.sends, ["@[alpha.ts](biny://file/other/alpha.ts)"]);
  });
});

test("previous query errors disappear when a new query is pending", async t => {
  await withFixture(t, async f => {
    await f.edit("@文件:alpha");
    const pending = await f.request("alpha");
    await f.React.act(async () => { pending.reject(new Error("Alpha search unavailable")); });
    assert.equal(f.document.querySelector('[role="alert"]')?.textContent, "Alpha search unavailable");
    await f.edit("@文件:beta");
    assert.equal(f.document.querySelector('[role="alert"]')?.textContent ?? null, null);
    await f.resolve(await f.request("beta"), [BETA]);
    await f.key("Tab");
    await f.submit();
    assert.deepEqual(f.sends, ["@[beta.ts](biny://file/beta.ts)"]);
  });
});

test("unknown reference kinds retire options and recover for a valid query", async t => {
  await withFixture(t, async f => {
    await f.publishAlpha();
    await f.edit("@未知:alpha");
    assert.deepEqual(f.options(), []);
    assert.equal(f.document.querySelector('[role="alert"]')?.textContent, "未知引用种类：未知");
    await f.edit("@文件:beta");
    assert.equal(f.document.querySelector('[role="alert"]')?.textContent ?? null, null);
    await f.resolve(await f.request("beta"), [BETA]);
    await f.key("Tab");
    await f.submit();
    assert.deepEqual(f.sends, ["@[beta.ts](biny://file/beta.ts)"]);
  });
});

test("late obsolete rejection cannot hide a successful current query", async t => {
  await withFixture(t, async f => {
    await f.edit("@文件:alpha");
    const old = await f.request("alpha");
    await f.edit("@文件:beta");
    await f.resolve(await f.request("beta"), [BETA]);
    await f.React.act(async () => { old.reject(new Error("Old query failure")); });
    assert.deepEqual(f.options(), [BETA.label]);
    assert.equal(f.document.querySelector('[role="alert"]')?.textContent ?? null, null);
  });
});
