/** Real React components and exact IPC callbacks; only synthetic context, display and IPC dependencies. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { z } from "zod";
import type { DesktopQuickChatSettings } from "../src/desktop/protocol.js";

const require = createRequire(import.meta.url);
const root = process.cwd();
const quickPath = "src/desktop/renderer/src/quickchat/QuickChatApp.tsx";
const panelPath = "src/desktop/renderer/src/components/settings/SettingsQuickChat.tsx";
const ipcSource = readFileSync(path.join(root, "src/desktop/electron/main/ipc.ts"), "utf8");
const ipcAst = ts.createSourceFile("ipc.ts", ipcSource, ts.ScriptTarget.Latest, true);
const settingsSchema = z.object({ autoHideOnBlur: z.boolean(), injectScreenContext: z.boolean(), clickThrough: z.boolean() }).strict();
const settingsEvent = "settings-changed";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function callback(name: string, scope: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  const found: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(ipcAst) === `desktopIpc.${name}` && node.arguments[1]) found.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(ipcAst);
  assert.equal(found.length, 1, `exact production ${name} callback`);
  const javascript = ts.transpileModule(`(${found[0]!.getText(ipcAst)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(javascript, scope) as (...args: unknown[]) => Promise<unknown>;
}
function harness() {
  let settings: DesktopQuickChatSettings = { autoHideOnBlur: true, injectScreenContext: true, clickThrough: false };
  const listeners = new Map<number, Set<(value: DesktopQuickChatSettings) => void>>();
  const calls: unknown[][] = [];
  const patches: unknown[] = [];
  let save: () => Promise<void> = async () => {};
  let load: (() => Promise<DesktopQuickChatSettings>) | undefined;
  let switchModel: () => Promise<unknown> = async () => ({ modelAlias: "other", thinking: "off" });
  const emit = (id: number, next: DesktopQuickChatSettings): void => { for (const fn of listeners.get(id) ?? []) fn({ ...next }); };
  const context = {
    state: { quickChatSettings: () => ({ ...settings }), setQuickChatSettings: async (next: DesktopQuickChatSettings) => { settings = { ...next }; await save(); } },
    agents: { sendPrompt: async (...args: unknown[]) => { calls.push(args); return { sessionId: "session", runId: "run" }; } },
    getQuickChatWindow: () => ({ ownsWebContents: (id: number) => id === 2, applySettings: () => {}, send: (_channel: string, next: DesktopQuickChatSettings) => emit(2, next) }),
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel: string, next: DesktopQuickChatSettings) => emit(1, next) } })
  };
  const scope = { context, desktopIpc: { quickChatSettingsChanged: settingsEvent }, quickChatSettingsSchema: settingsSchema, idSchema: z.string(), promptSchema: z.string().min(1), promptContextSchema: z.string().max(30_000).optional(), attachmentSchema: z.unknown(), chatPersonalizationSchema: z.unknown(), idempotencyKeySchema: z.string().optional(), agentCapabilitySelectionSchema: z.unknown(), z };
  const set = callback("setQuickChatSettings", scope);
  const send = callback("sendPrompt", scope);
  const makeApi = (id: number) => ({
    quickChatSettings: async () => load ? await load() : ({ ...settings }),
    setQuickChatSettings: async (patch: Partial<DesktopQuickChatSettings>) => { patches.push(structuredClone(patch)); return await set({ sender: { id } }, patch); },
    onQuickChatSettingsChanged: (fn: (next: DesktopQuickChatSettings) => void) => { const list = listeners.get(id) ?? new Set(); list.add(fn); listeners.set(id, list); return () => list.delete(fn); },
    bootstrap: async () => ({ activeProjectId: "project", projects: [{ id: "project" }], workspace: { runtime: { info: { modelAlias: "model", thinking: "off" } }, pickerModels: ["model", "other"].map(alias => ({ alias, displayName: alias, efforts: [], defaultThinking: "off" })) } }),
    quickChatScreenContext: async () => ({ frontApp: { appName: "Synthetic", windowTitle: "Synthetic title" }, promptContext: "SYNTHETIC_CONTEXT" }),
    getQuickChatClickThrough: async () => false,
    onQuickChatContext: () => () => {}, onQuickChatFocusInput: () => () => {}, onQuickChatClickThroughChanged: () => () => {}, onAgentEvent: () => () => {},
    switchModel: async () => await switchModel(),
    sendPrompt: async (...args: unknown[]) => await send({ sender: { id } }, ...args)
  });
  return { makeApi, context, set, send, calls, patches, emit, get settings() { return settings; }, setSave: (fn: () => Promise<void>) => { save = fn; }, setLoad: (fn: () => Promise<DesktopQuickChatSettings>) => { load = fn; }, setSwitch: (fn: () => Promise<unknown>) => { switchModel = fn; } };
}

test("QuickChat opt-out is authoritative at IPC and settings patches preserve unrelated fields", async () => {
  const h = harness();
  await h.set({}, { ...h.settings, injectScreenContext: false });
  assert.equal(h.settings.injectScreenContext, false);
  await h.send({ sender: { id: 2 } }, "project", undefined, "literal user text", [], undefined, undefined, undefined, "SYNTHETIC_CONTEXT");
  assert.equal(h.calls[0]![2], "literal user text");
  assert.equal(h.calls[0]![7], undefined);
  await h.send({ sender: { id: 1 } }, "project", undefined, "other source", [], undefined, undefined, undefined, "OTHER_CONTEXT");
  assert.equal(h.calls[1]![7], "OTHER_CONTEXT", "non-QuickChat context must not be stripped");
  await assert.rejects(h.send({ sender: { id: 2 } }, "project", undefined, "input", [], undefined, undefined, undefined, {}));
  await h.set({}, { ...h.settings, injectScreenContext: true });
  await h.send({ sender: { id: 2 } }, "project", undefined, "input", [], undefined, undefined, undefined, "SYNTHETIC_CONTEXT");
  assert.equal(h.calls[2]![7], "SYNTHETIC_CONTEXT");
  await h.set({}, { injectScreenContext: false });
  await h.set({}, { autoHideOnBlur: false });
  assert.equal(h.settings.injectScreenContext, false);
});

test("late save completion broadcasts and returns current policy, not its captured older value", async () => {
  const h = harness();
  const first = deferred<void>();
  h.setSave(async () => await first.promise);
  const pending = h.set({}, { ...h.settings, injectScreenContext: true });
  h.setSave(async () => {});
  await h.set({}, { ...h.settings, injectScreenContext: false });
  let broadcast: DesktopQuickChatSettings | undefined;
  h.makeApi(2).onQuickChatSettingsChanged(next => { broadcast = next; });
  first.resolve();
  const result = await pending as DesktopQuickChatSettings;
  assert.equal(result.injectScreenContext, false);
  assert.equal(broadcast?.injectScreenContext, false);
});

test("mounted QuickChat and settings preserve opt-out across window updates and asynchronous work", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://synthetic.invalid" });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react") as typeof import("react");
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const jsx = require("react/jsx-runtime") as unknown;
  const appearance = { snapshot: {}, bootstrap: () => {} };
  function component(file: string, api: unknown): import("react").ComponentType {
    const code = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const exports: Record<string, import("react").ComponentType> = {};
    const inertRequire = (name: string): unknown => {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".css")) return {};
      if (name.includes("agentEvents")) return { isTerminalRunEvent: () => false };
      if (name.includes("modelThinking")) return { modelThinkingSelections: () => [] };
      if (name.includes("useDesktopAppearance")) return { useDesktopAppearance: () => appearance };
      if (name.includes("AppearanceProvider")) return { AppearanceProvider: ({ children }: { children: import("react").ReactNode }) => children };
      if (name.includes("SettingsSwitch")) return { SettingsSwitch: (p: { label: string; checked: boolean; disabled: boolean; onChange(value: boolean): void }) => React.createElement("input", { type: "checkbox", "aria-label": p.label, checked: p.checked, disabled: p.disabled, onChange: (e: import("react").ChangeEvent<HTMLInputElement>) => p.onChange(e.target.checked) }) };
      if (name.includes("ModelPickerMenu")) return { ModelPickerMenu: (p: { onSelectModel(alias: string): void }) => React.createElement("button", { "aria-label": "synthetic select other model", onClick: () => p.onSelectModel("other") }) };
      const nameOnly = name.split("/").at(-1)!.replace(".js", "");
      return { [nameOnly]: () => null };
    };
    vm.runInNewContext(code, { require: inertRequire, exports, window: { biny: api }, console, URL }, { filename: file });
    return exports[file === quickPath ? "QuickChatApp" : "SettingsQuickChat"]!;
  }
  async function mount(h: ReturnType<typeof harness>, file: string, id: number) {
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const renderer = createRoot(container);
    const Component = component(file, h.makeApi(id));
    await React.act(async () => { renderer.render(React.createElement(Component)); });
    return { container, close: async () => { await React.act(async () => { renderer.unmount(); }); container.remove(); } };
  }
  const click = async (container: HTMLElement, label: string) => {
    const node = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    assert.ok(node, label);
    await React.act(async () => { node.click(); });
  };
  async function input(container: HTMLElement) {
    const node = container.querySelector("textarea")!;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(node, "SYNTHETIC_USER_TEXT");
      node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  try {
    await t.test("successful main-panel opt-out updates existing QuickChat and suppresses context", async () => {
      const h = harness(); const quick = await mount(h, quickPath, 2); const panel = await mount(h, panelPath, 1);
      try {
        await click(panel.container, "注入前台应用上下文");
        assert.equal(h.settings.injectScreenContext, false);
        assert.match(quick.container.textContent!, /仅发送输入内容/u);
        await input(quick.container); await click(quick.container, "发送");
        assert.equal(h.calls.length, 1); assert.equal(h.calls[0]![7], undefined);
      } finally { await quick.close(); await panel.close(); }
    });
    await t.test("opt-out while model switch awaits affects the actual submitted context", async () => {
      const h = harness(); const wait = deferred<unknown>(); h.setSwitch(async () => await wait.promise);
      const quick = await mount(h, quickPath, 2);
      try {
        await click(quick.container, "synthetic select other model"); await input(quick.container); await click(quick.container, "发送");
        assert.equal(h.calls.length, 0);
        await React.act(async () => { await h.set({}, { ...h.settings, injectScreenContext: false }); });
        await React.act(async () => { wait.resolve({ modelAlias: "other", thinking: "off" }); });
        assert.equal(h.calls.length, 1); assert.equal(h.calls[0]![7], undefined);
        assert.doesNotMatch(quick.container.textContent!, /已附带前台上下文/u);
      } finally { await quick.close(); }
    });
    await t.test("initial stale settings response cannot overwrite a newer opt-out event", async () => {
      const h = harness(); const wait = deferred<DesktopQuickChatSettings>(); h.setLoad(async () => await wait.promise);
      const quick = await mount(h, quickPath, 2); const panel = await mount(h, panelPath, 1);
      try {
        await React.act(async () => { await h.set({}, { ...h.settings, injectScreenContext: false }); });
        await React.act(async () => { wait.resolve({ autoHideOnBlur: true, injectScreenContext: true, clickThrough: false }); });
        assert.match(quick.container.textContent!, /仅发送输入内容/u);
        assert.equal(panel.container.querySelector<HTMLInputElement>('[aria-label="注入前台应用上下文"]')!.checked, false);
        await input(quick.container); await click(quick.container, "发送");
        assert.equal(h.calls[0]![7], undefined);
      } finally { await quick.close(); await panel.close(); }
    });
    await t.test("failed opt-in followed by external opt-out cannot leak into an unrelated patch", async () => {
      const h = harness(); await h.set({}, { ...h.settings, injectScreenContext: false }); const panel = await mount(h, panelPath, 1);
      try {
        h.setSave(async () => { throw new Error("synthetic save failure"); });
        await click(panel.container, "注入前台应用上下文");
        h.setSave(async () => {});
        await React.act(async () => { await h.set({}, { ...h.settings, injectScreenContext: false }); });
        await click(panel.container, "失焦时自动隐藏");
        assert.deepEqual(h.patches.at(-1), { autoHideOnBlur: false });
        assert.equal(h.settings.injectScreenContext, false);
      } finally { await panel.close(); }
    });
    await t.test("failed QuickChat opt-out keeps local suppression rather than rolling back to enabled", async () => {
      const h = harness(); const quick = await mount(h, quickPath, 2);
      try {
        h.setSave(async () => { throw new Error("synthetic save failure"); });
        await click(quick.container, "不附带前台上下文");
        assert.match(quick.container.textContent!, /仅发送输入内容/u);
        await input(quick.container); await click(quick.container, "发送");
        assert.equal(h.calls[0]![7], undefined);
      } finally { await quick.close(); }
    });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    dom.window.close();
  }
});

test("preload settings subscription forwards updates and detaches on cleanup", () => {
  const source = readFileSync(path.join(root, "src/desktop/electron/preload/index.ts"), "utf8");
  const ast = ts.createSourceFile("preload.ts", source, ts.ScriptTarget.Latest, true);
  let method: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === "onQuickChatSettingsChanged") method = node;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(method);
  let handler: ((event: unknown, value: DesktopQuickChatSettings) => void) | undefined;
  const ipcRenderer = { on: (channel: string, fn: typeof handler) => { assert.equal(channel, settingsEvent); handler = fn; }, removeListener: (channel: string, fn: typeof handler) => { assert.equal(channel, settingsEvent); assert.equal(fn, handler); handler = undefined; } };
  const code = ts.transpileModule(`({${method.getText(ast)}})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const bridge = vm.runInNewContext(code, { ipcRenderer, desktopIpc: { quickChatSettingsChanged: settingsEvent } }) as { onQuickChatSettingsChanged(fn: (value: DesktopQuickChatSettings) => void): () => void };
  let received: DesktopQuickChatSettings | undefined;
  const detach = bridge.onQuickChatSettingsChanged(value => { received = value; });
  const next = { autoHideOnBlur: true, injectScreenContext: false, clickThrough: false };
  handler!({}, next); assert.equal(received, next); detach(); assert.equal(handler, undefined);
});

test("native QuickChat sender identity is valid only for its live web contents", () => {
  const source = readFileSync(path.join(root, "src/desktop/electron/main/quickChatWindow.ts"), "utf8");
  const ast = ts.createSourceFile("quickChatWindow.ts", source, ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "ownsWebContents") initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(initializer);
  const code = ts.transpileModule(`(${initializer.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  for (const destroyed of [false, true]) for (const windowDestroyed of [false, true]) {
    const owns = vm.runInNewContext(code, { destroyed, window: { isDestroyed: () => windowDestroyed, webContents: { id: 2 } } }) as (id: number) => boolean;
    assert.equal(owns(2), !destroyed && !windowDestroyed); assert.equal(owns(1), false);
  }
});
