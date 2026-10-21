import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../src/llm/ModelManager.js";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopSettingsSnapshot, DesktopSettingsSaveInput, DesktopSettingsSaveResult, DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

import { defaultConfig } from "../src/config/schema.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const time = "2026-10-20T00:00:00.000Z";
function project(id: string): DesktopProject {
  return { id, name: `Project ${id}`, path: `/synthetic/${id}`, dirty: false, missing: false,
    pinned: false, addedAt: time, lastOpenedAt: time };
}
function session(projectId: string, id = `session-${projectId}`): DesktopSessionSummary {
  return { id, projectId, fileName: `${projectId}.jsonl`, title: `Conversation ${id}`,
    firstUserMessage: `Discuss ${projectId}`, lastAssistantMessage: "", createdAt: time, updatedAt: time,
    eventCount: 1, pinned: false, status: "completed" };
}
const models: ModelChoice[] = ["alpha", "beta", "gamma"].map(alias => ({ alias, displayName: alias, provider: "inert", providerType: "openai-compatible", model: alias, modelKey: `inert/${alias}`, available: true, source: "configured", supportsTools: true, efforts: ["high", "max"], defaultThinking: "high", thinkingLevelMap: { off: "none", high: "high", max: "max" } }));
function info(alias: string, thinking: ThinkingSelection = "high"): ModelRuntimeInfo { return { modelAlias: alias, provider: "inert", modelLabel: alias, thinking, reasoningLabel: thinking }; }
function workspace(id: string): DesktopWorkspaceSnapshot {
  return { project: project(id), sessions: [session(id), session(id, `second-${id}`)], permissionMode: "ask",
    capabilityDefaults: { tools: "auto", skills: "auto" }, requiresModelConfiguration: false,
    models, pickerModels: models, selectedModel: info("alpha"), connections: [] };
}
function documentFor(id: string, sessionId = `session-${id}`, recovery = false): DesktopSessionDocument {
  return { recovery: recovery ? { canContinue: true, message: "Inert paused task" } : undefined, session: session(id, sessionId), events: [{ type: "user_message", content: `Discuss ${id}` }], liveEvents: [] };
}
let frameHost: { request(callback: FrameRequestCallback): number; cancel(id: number): void } | undefined;
let nextFrame = 0;
function requestFrame(callback: FrameRequestCallback): number {
  assert.ok(frameHost, "Animation frames require a live fixture");
  return frameHost.request(callback);
}
function cancelFrame(id: number): void { frameHost?.cancel(id); }

// Mount the complete production App and its own views/hooks. Only IPC, native
// DOM facilities, assets and the dependency ESM entry resolution are adapted.
// The callbacks below are the real App subscriptions, not extracted handlers.
async function fixture(t: TestContext, options: { recovery?: boolean } = {}) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); imports?: ReturnType<typeof registerHooks> } = {};
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const network: string[] = [];
  const unknown: string[] = [];
  const saves: Array<{ projectId: string; input: DesktopSettingsSaveInput; gate: ReturnType<typeof deferred<DesktopSettingsSaveResult>> }> = [];
  let current = settingsSnapshot();
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        for (const item of saves) item.gate.resolve({ status: "rolled_back", draftRetained: true, journalId: "cleanup", snapshot: current, message: "Fixture cleanup" });
        await Promise.allSettled(saves.map(item => item.gate.promise));
      });
    } catch (error) { errors.push(error); }
    try { if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount()); }
    catch (error) { errors.push(error); }
    try { resources.dom?.window.close(); } catch (error) { errors.push(error); }
    try { if (timersEnabled) t.mock.timers.reset(); } catch (error) { errors.push(error); }
    resources.imports?.deregister(); frames.clear(); frameHost = undefined;
    for (const undo of restore.reverse()) { try { undo(); } catch (error) { errors.push(error); } }
    assert.deepEqual(network, [], "The real renderer must not contact external services");
    assert.deepEqual(unknown, [], "All IPC effects must use explicit inert boundaries");
    if (errors.length) throw new AggregateError(errors, "App fixture cleanup failed");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  resources.imports = registerHooks({
    // Use the same published ESM distributions selected by the renderer bundler.
    resolve(specifier, context, next) {
      if (specifier === "@xterm/xterm") return next("@xterm/xterm/lib/xterm.mjs", context);
      if (specifier === "@xterm/addon-fit") return next("@xterm/addon-fit/lib/addon-fit.mjs", context);
      return next(specifier, context);
    }, load(url, context, next) {
    if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM: DOM } = await import("jsdom");
  const dom = new DOM('<!doctype html><div id="root"></div>', { url: "https://desktop.test", pretendToBeVisual: true });
  resources.dom = dom;
  const window = dom.window; const document = window.document;
  frameHost = { request(callback) { const id = ++nextFrame; frames.set(id, callback); return id; }, cancel(id) { frames.delete(id); } };
  class LayoutObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({
    window, document, self: window, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLDialogElement: window.HTMLDialogElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: LayoutObserver,
    CSS: { escape: (value: string) => value, supports: () => false },
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame, IS_REACT_ACT_ENVIRONMENT: true
  })) replace(globalThis, key, value);
  replace(window, "requestAnimationFrame", requestFrame); replace(window, "cancelAnimationFrame", cancelFrame);
  replace(window, "ResizeObserver", LayoutObserver);
  replace(window, "matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
  replace(window.HTMLElement.prototype, "scrollIntoView", () => {});
  replace(window.HTMLElement.prototype, "scrollTo", () => {});
  replace(window.HTMLCanvasElement.prototype, "getContext", () => null);
  replace(document, "fonts", { addEventListener() {}, removeEventListener() {} });
  replace(window, "scrollTo", () => {});
  replace(window.HTMLDialogElement.prototype, "showModal", function (this: HTMLDialogElement): void { this.open = true; });
  replace(window.HTMLDialogElement.prototype, "close", function (this: HTMLDialogElement): void { this.open = false; });
  t.mock.method(globalThis, "fetch", async () => { network.push("fetch"); throw new Error("Unexpected fetch"); });
  t.mock.method(Socket.prototype, "connect", () => { network.push("socket"); throw new Error("Unexpected socket"); });
  const api: Record<string, unknown> = {
    quickChatSettings: async () => ({ autoHideOnBlur: false, clickThrough: false, injectScreenContext: false }),
    settingsSnapshot: async () => current,
    updateSettingsDraftState: async () => {}, previewAppearance: async () => {},
    saveSettings(projectId: string, input: DesktopSettingsSaveInput) {
      const gate = deferred<DesktopSettingsSaveResult>();
      saves.push({ projectId, input: structuredClone(input), gate });
      return gate.promise;
    },
    refreshProject: async (id: string) => ({ ...workspace(id), models: current.models.configured, connections: current.models.connections }),
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: [project("a"), project("b")],
      sidebarSessions: [session("a"), session("a", "second-a"), session("b")], workspace: workspace("a"), activeView: "chat",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    selectProject: async (id: string) => workspace(id),
    startDraft: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string) => { assert.ok(workspace(id).sessions.some(item => item.id === sessionId)); return documentFor(id, sessionId, options.recovery); },
    commitSelection: async () => {},
    skillCatalog: async () => ({ skills: [], warnings: [] }), skillSettings: async () => ({ activations: [] }), toolCatalog: async () => [],
    listProjectBranches: async () => [], recipeSuggestions: async () => [], planProjection: async () => ({ plans: [], activePlan: undefined }),
    activitySuggestions: async () => [],
    setSidebarWidth: async () => {}, setFilePanelWidth: async () => {}
  };
  for (const name of ["onAppearanceChanged", "onApplicationImportsChanged", "onAgentEvent", "onSessionHandoff", "onMenuAction",
    "onSettingsCloseRequest", "onBrowserOpenRequest", "onReferenceOpen"]) {
    api[name] = (listener: (...args: never[]) => void) => { listeners.set(name, listener); return () => listeners.delete(name); };
  }
  replace(window, "biny", new Proxy(api, { get(target, name: string) {
    if (name in target) return target[name];
    return (..._args: unknown[]) => { unknown.push(name); throw new Error(`Unexpected IPC ${name}`); };
  } }));
  const React = await import("react"); resources.React = React; replace(globalThis, "React", React);
  t.mock.timers.enable({ apis: ["setTimeout"] }); timersEnabled = true;
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/desktop/renderer/src/App.js");
  const root = createRoot(document.getElementById("root")!); resources.root = root;
  await React.act(async () => root.render(React.createElement(App)));
  const click = async (selector: string): Promise<void> => {
    const target = document.querySelector<HTMLButtonElement>(selector); assert.ok(target, selector);
    if (target.matches(":disabled") || target.closest("[inert]")) return;
    await React.act(async () => {
      target.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
      target.click();
    });
  };
  const emit = async (name: string, value: DesktopMenuAction | DesktopSessionHandoff): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React, saves, api, click, emit,
    async openModels() {
      await emit("onMenuAction", "settings");
      await click('button[data-settings-tab="模型"]');
    },
    async type(selector: string, text: string) {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      assert.ok(input, selector);
      if (input.matches(":disabled") || input.closest("[inert]")) return false;
      await React.act(async () => {
        const prototype = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      return true;
    },
    async resolve(index: number) {
      const item = saves[index]!;
      current = { ...current, configRevision: `config:${index + 2}`,
        models: { ...current.models,
          modelProfiles: item.input.models?.upserts[0]?.modelProfile
            ? { inert: { alpha: item.input.models.upserts[0].modelProfile } }
            : current.models.modelProfiles,
          connections: [...current.models.connections, ...(item.input.models?.customProviders ?? []).map(provider => ({
            providerAlias: provider.alias, displayName: provider.displayName, baseUrl: provider.baseUrl,
            providerType: "openai-compatible" as const, protocol: provider.protocol, apiBackend: provider.apiBackend,
            requiresApiKey: false, hasCredential: false
          }))]
        }
      };
      await React.act(async () => item.gate.resolve({ status: "committed", journalId: "inert", appliedFields: [], snapshot: current }));
    },
    async reject(index: number) { await React.act(async () => saves[index]!.gate.reject(new Error("Inert save failure"))); },
    text: () => document.body.textContent ?? ""
  };
}

function settingsSnapshot(): DesktopSettingsSnapshot {
  const config = structuredClone(defaultConfig);
  return {
    projectId: "a", hasRunningTasks: false, preferenceRevision: 1, configRevision: "config:1",
    themePreference: "light", fontPreference: { family: "system", size: 14 },
    activity: { ...config.activity, outputDirectory: "/synthetic/activity" }, identity: config.context.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat, toolExecutionMode: config.agent.toolExecutionMode,
    subagent: { enabled: false, runtime: "builtin" }, externalSubagentBlockers: [],
    permission: config.permission, webSearch: config.web.search,
    models: { configured: models, connections: [{ providerAlias: "inert", displayName: "Inert Provider", providerType: "openai-compatible", baseUrl: "https://provider.example.invalid/v1", requiresApiKey: false, hasCredential: false }],
      embeddingModels: [], defaultModel: "alpha", thinking: "high", modelProfiles: {} },
    skills: { projectId: "a", projectKey: "a", globalDefaults: {}, projectOverrides: {}, activations: [] }
  };
}

const profileForm = 'form[aria-label="模型设置"]';
const createForm = 'form[aria-label="添加自定义服务商"]';
async function openProfile(t: TestContext) {
  const h = await fixture(t);
  await h.openModels();
  await h.click('button[aria-label="alpha 模型选项"]');
  await h.type(`${profileForm} input[type="number"]`, "64000");
  return h;
}
async function openCreate(t: TestContext) {
  const h = await fixture(t);
  await h.openModels();
  await h.click('.provider-settings-toolbar button.settings-primary-button');
  await h.type('#custom-provider-create-name', "Inert Gateway");
  await h.type('#custom-provider-create-url', "https://gateway.example.invalid/v1");
  return h;
}
for (const kind of ["profile", "create"] as const) {
  const form = kind === "profile" ? profileForm : createForm;
  const primaryField = kind === "profile" ? `${profileForm} input[type="number"]` : '#custom-provider-create-name';
  const first = kind === "profile" ? "64000" : "Inert Gateway";
  const second = kind === "profile" ? "128000" : "Updated Gateway";
  const open = kind === "profile" ? openProfile : openCreate;
  test(`${kind}: all mutating controls are disabled during save`, async t => {
    const h = await open(t);
    const controls = [...h.document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>(`${form} input, ${form} select, ${form} textarea, ${form} button`)].filter(control => !control.closest('select button'));
    assert.ok(controls.length >= (kind === "profile" ? 17 : 8));
    await h.click(`${form} button[type="submit"]`);
    assert.equal(h.saves.length, 1);
    assert.deepEqual(controls.filter(control => !control.matches(":disabled")).map(control => control.getAttribute("aria-label") ?? control.id ?? control.tagName), [], "Every dialog mutation must share the pending-save lock");
  });
  test(`${kind}: successful save cannot lose newly accepted fields`, async t => {
    const h = await open(t);
    await h.click(`${form} button[type="submit"]`);
    const accepted = await h.type(primaryField, second);
    if (accepted) assert.equal(h.document.querySelector<HTMLInputElement>(primaryField)!.value, second);
    await h.resolve(0);
    assert.equal(h.document.querySelector(form), null, "The successful transaction closes the source dialog");
    assert.equal(accepted, false, "The closed transaction must not admit values newer than its submitted payload");
  });
  for (const failure of ["reject", "rollback"] as const) {
    test(`${kind}: ${failure} retains fields and unlocks a correct retry`, async t => {
      const h = await open(t);
      await h.click(`${form} button[type="submit"]`);
      if (failure === "reject") await h.reject(0);
      else await h.React.act(async () => h.saves[0]!.gate.resolve({ status: "rolled_back", draftRetained: true, journalId: "inert", snapshot: settingsSnapshot(), message: "Inert rollback" }));
      assert.equal(h.document.querySelector<HTMLInputElement>(primaryField)!.value, first);
      assert.match(h.document.querySelector(form)!.textContent ?? "", failure === "reject" ? /Inert save failure/u : /Inert rollback/u);
      assert.equal(await h.type(primaryField, second), true);
      await h.click(`${form} button[type="submit"]`);
      assert.equal(h.saves.length, 2);
      assert.equal(kind === "profile" ? h.saves[1]!.input.models!.upserts[0]!.modelProfile?.contextWindow : h.saves[1]!.input.models!.customProviders![0]!.displayName, kind === "profile" ? 128000 : second);
      await h.resolve(1);
      assert.equal(h.document.querySelector(form), null);
    });
  }
  test(`${kind}: pending cancel, Escape, backdrop and repeated clicks retain the owner`, async t => {
    const h = await open(t);
    await h.click(`${form} button[type="submit"]`);
    await h.click(`${form} button[type="submit"]`);
    await h.click(`${form} button.ghost-button`);
    await h.React.act(async () => {
      h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      h.document.querySelector('.settings-detail-layer')!.dispatchEvent(new h.window.MouseEvent("mousedown", { bubbles: true }));
    });
    assert.ok(h.document.querySelector(form));
    assert.equal(h.saves.length, 1);
    await h.reject(0);
    await h.click(`${form} button.ghost-button`);
    assert.equal(h.document.querySelector(form), null);
    assert.equal(h.saves.length, 1);
  });
  test(`${kind}: cancel before saving performs no transaction`, async t => {
    const h = await open(t);
    await h.click(`${form} button.ghost-button`);
    assert.equal(h.document.querySelector(form), null);
    assert.equal(h.saves.length, 0);
  });
  test(`${kind}: settings tab switch waits for admitted save and keeps its result`, async t => {
    const h = await open(t);
    await h.click(`${form} button[type="submit"]`);
    await h.click('button[data-settings-tab="关于"]');
    assert.ok(h.document.querySelector(form));
    assert.equal(h.document.querySelector('button[data-settings-tab="模型"]')!.getAttribute("aria-current"), "page");
    await h.resolve(0);
    assert.equal(h.document.querySelector(form), null);
    assert.equal(h.document.querySelector('button[data-settings-tab="关于"]')!.getAttribute("aria-current"), "page");
    assert.equal(h.saves.length, 1);
  });
}
test("model recommended-reset cannot change the pending payload", async t => {
  const h = await openProfile(t);
  await h.click(`${profileForm} button[type="submit"]`);
  await h.click(`${profileForm} .provider-reset-button`);
  assert.equal(h.document.querySelector<HTMLInputElement>(`${profileForm} input[type="number"]`)!.value, "64000");
  await h.reject(0);
  await h.click(`${profileForm} .provider-reset-button`);
  assert.equal(h.document.querySelector<HTMLInputElement>(`${profileForm} input[type="number"]`)!.value, "");
});
test("creation locks an already portaled icon picker while saving", async t => {
  const h = await openCreate(t);
  await h.click('#custom-provider-create-icon');
  assert.ok(h.document.querySelector('.provider-icon-popover'));
  await h.click(`${createForm} button[type="submit"]`);
  const enabled = [...h.document.querySelectorAll('.provider-icon-popover button, .provider-icon-popover input')].filter(control => !control.matches(":disabled"));
  assert.equal(enabled.length, 0, "A portal cannot remain editable outside the pending form lock");
  await h.reject(0);
  assert.equal(h.document.querySelector('#custom-provider-create-icon')!.matches(":disabled"), false);
  await h.click('#custom-provider-create-icon');
  assert.ok(h.document.querySelector('.provider-icon-popover'));
  assert.ok(h.document.querySelector('.provider-icon-popover button:not(:disabled)'));
  await h.type('input[aria-label="搜索图标…"]', "OpenAI");
  await h.click('.provider-icon-popover button[title="OpenAI (ChatGPT)"]');
  assert.match(h.document.querySelector('#custom-provider-create-icon')!.textContent ?? "", /OpenAI/u);
  await h.click(`${createForm} button[type="submit"]`);
  assert.equal(h.saves[1]!.input.models!.customProviders![0]!.icon, "OpenAI");
  await h.resolve(1);
});
