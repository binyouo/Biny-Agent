import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { Socket } from "node:net";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import type { ProviderSettingsProps } from "../src/desktop/renderer/src/components/settings/ProviderSettings.js";
import type { DesktopModelLoginProvider, DesktopModelLoginStartResult, DesktopStagedModelLoginResult } from "../src/desktop/protocol.js";
import { JSDOM, VirtualConsole } from "jsdom";
import { SettingsDraftContext, type SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

const imports = registerHooks({ load(url, context, next) {
  if (/\.(svg|png|css)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  return next(url, context);
} });
// React DOM detects input-event support at import time. Supply a DOM before
// loading it so synthetic textarea autofocus uses the modern event path.
const bootstrap = new JSDOM("<!doctype html>");
const bootstrapGlobals = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.window.document });
const { createRoot } = await import("react-dom/client");
for (const [key, descriptor] of bootstrapGlobals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}
bootstrap.window.close();
const { ProviderSettings } = await import("../src/desktop/renderer/src/components/settings/ProviderSettings.js");
const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
Object.assign(globalThis, { React });

/** Real component ownership only: no SettingsDraftProvider, App, or native IPC. */
async function loginFixture(t: TestContext) {
  const restore: Array<() => void> = [];
  const forbidden: string[] = [];
  const canceled: Array<[DesktopModelLoginProvider, string]> = [];
  const completed: Array<[DesktopModelLoginProvider, string]> = [];
  const added: string[] = [];
  const released: string[] = [];
  const saves: Parameters<SettingsDraftContextValue["saveModels"]>[0][] = [];
  const starts: Array<ReturnType<typeof deferred<DesktopModelLoginStartResult>>> = [];
  const completion = deferred<DesktopStagedModelLoginResult>();
  const modelSave = deferred<undefined>();
  const request: DesktopModelLoginStartResult = { authRequestId: "inert-request", stateHint: "inert", method: "paste-code" };
  const result: DesktopStagedModelLoginResult = { handle: "inert-handle", kind: "oauth-login", provider: "claude-code",
    expiresAt: "2099-01-01T00:00:00.000Z", models: [{ id: "inert-model", displayName: "Inert model", supportsThinking: false }] };
  const resources: { dom?: JSDOM; root?: Root } = {};
  const unexpected = (name: string): never => { forbidden.push(name); throw new Error(`Unexpected operation: ${name}`); };
  const unavailable = (): never => unexpected("unrelated callback");
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  t.after(async () => {
    const errors: unknown[] = [];
    try { await act(async () => modelSave.resolve(undefined)); } catch (error) { errors.push(error); }
    try { if (resources.root) await act(() => resources.root!.unmount()); } catch (error) { errors.push(error); }
    try { await act(async () => { for (const start of starts) start.resolve(request); completion.resolve(result); await Promise.all(starts.map(start => start.promise)); }); }
    catch (error) { errors.push(error); }
    try { resources.dom?.window.close(); } catch (error) { errors.push(error); }
    for (const undo of restore.reverse()) { try { undo(); } catch (error) { errors.push(error); } }
    assert.deepEqual(forbidden, [], "All unrelated operations must remain inert, even when production catches an error");
    if (errors.length) throw new AggregateError(errors, "Login fixture cleanup failed");
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => { forbidden.push(`JSDOM: ${error.message}`); });
  const dom = resources.dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://renderer.example.invalid", pretendToBeVisual: true, virtualConsole });
  const window = dom.window;
  await new Promise<void>(resolve => window.addEventListener("load", () => resolve(), { once: true }));
  const document = window.document;
  class LayoutObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({ window, document, self: window, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement, Element: window.Element, Node: window.Node,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect, ResizeObserver: LayoutObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    CSS: { escape: (value: string) => value, supports: () => false }, IS_REACT_ACT_ENVIRONMENT: true
  })) replace(globalThis, key, value);
  replace(window.HTMLElement.prototype, "scrollTo", () => {});
  replace(window, "matchMedia", (media: string) => ({ matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
  replace(window, "ResizeObserver", LayoutObserver);
  replace(globalThis, "fetch", () => unexpected("fetch"));
  replace(Socket.prototype, "connect", () => unexpected("socket"));
  replace(window, "fetch", () => unexpected("window.fetch"));
  replace(window, "open", () => unexpected("window.open"));
  replace(window.XMLHttpRequest.prototype, "open", () => unexpected("XMLHttpRequest"));
  replace(window, "WebSocket", function () { return unexpected("WebSocket"); });
  replace(window, "biny", new Proxy({}, { get: (_target, key) => unexpected(`IPC ${String(key)}`) }));
  const context: SettingsDraftContextValue = {
    loading: false, revalidating: false, runtimeBlocked: false, manualSaving: false, dirtyCount: 0, preferencesOnly: false, invalid: false, saveState: "clean",
    retryLoad: unavailable, setThemePreference: unavailable, setFontPreference: unavailable,
    updateActivityImmediately: unavailable,
    setIdentity: unavailable, setRedaction: unavailable, setMemory: unavailable, setCompaction: unavailable, setChatParams: unavailable,
    setSubagent: unavailable, setPermission: unavailable, setWebSearch: unavailable, setChat: unavailable,
    setSkills: unavailable, upsertModel: unavailable, removeModel: unavailable, setModelProfile: unavailable,
    stageCredential: unavailable, discard: unavailable, saveAll: unavailable,
    addOauthCredentialHandle(handle) { added.push(handle); },
    async releaseCredential(handle) { released.push(handle); },
    async saveModels(input) { saves.push(input); return await modelSave.promise; }
  };
  const props: ProviderSettingsProps = {
    active: true, loading: false, models: [], connections: [], catalogs: {},
    onTest: unavailable, onFetchCatalog: unavailable, onReadModelApiKey: unavailable, onNotify: unavailable, onOpenExternal: unavailable,
    onStartLogin(provider) { assert.equal(provider, "claude-code"); const start = deferred<DesktopModelLoginStartResult>(); starts.push(start); return start.promise; },
    onCompleteLogin(provider, id) { completed.push([provider, id]); return completion.promise; },
    async onCancelLogin(provider, id) { canceled.push([provider, id]); }
  };
  const root = resources.root = createRoot(document.getElementById("root")!);
  const render = async (visible: boolean): Promise<void> => {
    await act(() => root.render(React.createElement(SettingsDraftContext.Provider, { value: context },
      visible ? React.createElement(ProviderSettings, props) : null)));
  };
  const click = async (button: HTMLButtonElement | undefined): Promise<void> => {
    assert.ok(button); assert.equal(button.disabled, false);
    await act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  };
  await render(true);
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text);
  await click([...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.querySelector("strong")?.textContent === "Claude Code"));
  await click(document.querySelector<HTMLButtonElement>(".login-subscription-card .settings-primary-button") ?? undefined);
  assert.equal(starts.length, 1);
  return { canceled, completed, added, released, saves, document, starts,
    click: (text: string) => click(button(text)),
    remove: () => render(false),
    async finishStart(index: number) {
      const start = starts[index]; assert.ok(start);
      await act(async () => { start.resolve({ ...request, authRequestId: `request-${index}`, stateHint: `state-${index}` }); await start.promise; });
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("paste-code restart cancels current request and opens a fresh attempt", async t => {
  const h = await loginFixture(t);
  await h.finishStart(0);
  assert.match(h.document.body.textContent ?? "", /state-0/u);
  await h.click("重新开始登录");
  assert.equal(h.starts.length, 2, "restart must start a new login, not hit the single-flight guard");
  assert.deepEqual(h.canceled, [["claude-code", "request-0"]]);
  assert.equal(h.document.querySelector("textarea"), null, "retired authorization input is cleared while opening");
  await h.finishStart(1);
  assert.match(h.document.body.textContent ?? "", /state-1/u);
  assert.doesNotMatch(h.document.body.textContent ?? "", /state-0/u);
  assert.deepEqual(h.completed, []);
  assert.deepEqual(h.saves, []);
});

test("unmount after restart cancels the late new request without completing it", async t => {
  const h = await loginFixture(t);
  await h.finishStart(0);
  await h.click("重新开始登录");
  assert.equal(h.starts.length, 2);
  await h.remove();
  await h.finishStart(1);
  assert.deepEqual(h.canceled, [["claude-code", "request-0"], ["claude-code", "request-1"]]);
  assert.deepEqual(h.completed, []);
  assert.deepEqual(h.saves, []);
});

test("repeated waiting-state restart retires only each corresponding request", async t => {
  const h = await loginFixture(t);
  for (let index = 0; index < 3; index += 1) {
    await h.finishStart(index);
    await h.click("重新开始登录");
    assert.equal(h.starts.length, index + 2);
    assert.equal(h.canceled.length, index + 1);
    assert.deepEqual(h.canceled[index], ["claude-code", `request-${index}`]);
  }
  await h.finishStart(3);
  assert.match(h.document.body.textContent ?? "", /state-3/u);
  assert.deepEqual(h.completed, []);
});

test.after(() => {
  imports.deregister();
  if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
  else Reflect.deleteProperty(globalThis, "React");
});
