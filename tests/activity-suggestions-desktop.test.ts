import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

test("new-chat suggestions load once, submit, and hide on empty results or errors", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let calls = 0;
  let fail = false;
  let resolve!: (suggestions: string[]) => void;
  Object.defineProperty(window, "biny", { value: { activitySuggestions: async () => {
    calls++; if (fail) throw new Error("suggestion API unavailable");
    return await new Promise<string[]>(done => { resolve = done; });
  } } });
  const { Workspace } = await import("../src/desktop/renderer/src/components/Workspace.js");
  const root = createRoot(document.getElementById("root")!);
  const submitted: string[] = [];
  const props = { turns: [], loading: false, thinking: false, running: false,
    runtimePanelOpen: false, onSendActivitySuggestion: async (text: string) => { submitted.push(text); }
  } as unknown as React.ComponentProps<typeof Workspace>;
  try {
    await React.act(async () => root.render(React.createElement(Workspace, props)));
    assert.equal(calls, 1, "the new-chat page must consume the activity suggestions API");
    assert.equal(document.querySelectorAll(".biny-activity-suggestion-skeleton").length, 4);
    await React.act(async () => resolve(["继续检查本地索引", "整理最近的工作记录"]));
    const button = document.querySelector<HTMLButtonElement>(".suggestion-chip");
    assert.equal(button?.textContent, "继续检查本地索引");
    assert.equal(button?.title, "继续检查本地索引");
    await React.act(async () => button!.click());
    assert.deepEqual(submitted, ["继续检查本地索引"]);
    await React.act(async () => root.render(React.createElement(Workspace, { ...props, running: true })));
    assert.equal(document.querySelector(".biny-activity-suggestions"), null);
    await React.act(async () => root.render(React.createElement(Workspace, props)));
    assert.equal(calls, 1, "returning within five minutes reuses the request result");
    assert.equal(document.querySelectorAll(".suggestion-chip").length, 2);
    await React.act(async () => root.render(React.createElement(Workspace, { ...props, loading: true })));
    assert.equal(document.querySelector(".biny-activity-suggestions"), null);
    let now = Date.now() + 5 * 60_000;
    t.mock.method(Date, "now", () => now);
    await React.act(async () => root.render(React.createElement(Workspace, props)));
    assert.equal(calls, 2);
    assert.equal(document.querySelectorAll(".suggestion-chip").length, 2, "refresh retains the last successful suggestions until new data arrives");
    await React.act(async () => resolve([]));
    assert.equal(document.querySelector(".biny-activity-suggestions"), null);
    await React.act(async () => root.render(React.createElement(Workspace, { ...props, loading: true })));
    now += 5 * 60_000;
    fail = true;
    await React.act(async () => root.render(React.createElement(Workspace, props)));
    assert.equal(calls, 3);
    assert.equal(document.querySelector(".biny-activity-suggestions"), null);
    await React.act(async () => window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(calls, 3, "focus and read errors must not trigger automatic retries");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("suggestion submission uses composer capabilities and guards without attaching the current draft files", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const imports = registerHooks({ load(url, context, next) {
    if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
  const root = createRoot(document.getElementById("root")!);
  try {
    const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
    const { ComposerDraftState } = await import("../src/desktop/renderer/src/components/composer/composerDraft.js");
    const draft = new ComposerDraftState();
    draft.update({ draft: { value: "未发送的草稿", tokens: [] }, attachments: [{ id: "attachment", name: "draft.txt", path: "/tmp/draft.txt", mimeType: "text/plain", size: 1 }] });
    const ref = React.createRef<import("../src/desktop/renderer/src/components/Composer.js").ComposerHandle>();
    const sends: unknown[][] = [];
    const errors: string[] = [];
    let failSend = false;
    const noop = async (): Promise<void> => {};
    const props: React.ComponentProps<typeof Composer> = {
      ref, project: { id: "p", name: "p", path: "/tmp/p", dirty: false, missing: false, pinned: false, addedAt: "", lastOpenedAt: "" },
      drafts: new Map([["p:draft", draft]]), draftKey: "p:draft", models: [],
      memoryState: "enabled", memoryToggleBusy: false, memoryToggleDisabled: false,
      running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: false,
      focusToken: 0, capabilityDefaults: { tools: "none", skills: "none" }, skills: [], toolCatalog: [],
      onSend: async (...args) => { sends.push(args); if (failSend) throw new Error("send failed"); }, onMutateQueuedMessage: noop, onResume: noop,
      onSubmitEdit: noop, onCancelEdit: () => {}, onSlashCommand: noop, onStop: noop,
      onToggleMemory: noop, onSwitchModel: noop, onSaveAttachment: async () => { throw new Error("unused"); },
      onWarning: () => {}, onSubmitError: message => { errors.push(message); }
    };
    await React.act(async () => root.render(React.createElement(Composer, props)));
    assert.equal(typeof ref.current?.submitSuggestion, "function");
    await React.act(async () => { await Promise.all([ref.current!.submitSuggestion("继续检查本地索引"), ref.current!.submitSuggestion("重复点击")]); });
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.[0], "继续检查本地索引");
    assert.deepEqual(sends[0]?.[1], []);
    assert.deepEqual(sends[0]?.[4], { tools: [], skills: [] });
    failSend = true;
    const original = { draft: { value: "保留的草稿", tokens: [] }, attachments: [{ id: "attachment", name: "draft.txt", path: "/tmp/draft.txt", mimeType: "text/plain", size: 1 }] };
    await React.act(async () => draft.update(original));
    await React.act(async () => ref.current!.submitSuggestion("发送失败的建议"));
    assert.deepEqual(draft.getSnapshot().draft, original.draft);
    assert.deepEqual(draft.getSnapshot().attachments, original.attachments);
    assert.deepEqual(errors, ["send failed"]);
    await React.act(async () => root.render(React.createElement(Composer, { ...props, sessionWriterConflict: true })));
    await React.act(async () => ref.current!.submitSuggestion("不应发送"));
    assert.equal(sends.length, 2);
  } finally {
    await React.act(() => root.unmount());
    imports.deregister(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
