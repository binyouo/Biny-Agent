import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopAgentEventEnvelope, DesktopSessionDeleteResult, DesktopSessionTarget, DesktopSessionTreePage, DesktopRunReceipt, DesktopSlashResult, DesktopSettingsSnapshot, DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

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
    eventCount: 1, pinned: false, fastMode: false, status: "completed", metadataRevision: `revision:${id}:initial` };
}
const models = [{ alias: "inert", displayName: "inert", provider: "inert", providerType: "openai-compatible" as const,
  model: "inert", modelKey: "inert/inert", available: true, source: "configured" as const, supportsTools: true, capabilities: { serviceTiers: ["priority" as const] },
  efforts: ["high" as const], defaultThinking: "high" as const, thinkingLevelMap: { high: "high" } }];
function workspace(id: string): DesktopWorkspaceSnapshot {
  return withPage({ project: project(id), sessions: [session(id), session(id, `second-${id}`), {...session(id, `parent-${id}`), hasChildren: true}, {...session(id, `pin-${id}`), pinned: true}], permissionMode: "ask",
    capabilityDefaults: { tools: "auto", skills: "auto" }, requiresModelConfiguration: false,
    models, pickerModels: models, selectedModel: { modelAlias: "inert", provider: "inert", modelLabel: "inert", thinking: "high", reasoningLabel: "high" }, connections: [] });
}
function withPage(snapshot:DesktopWorkspaceSnapshot,revision="catalog:initial"):DesktopWorkspaceSnapshot { return {...snapshot,sessionPage:{projectId:snapshot.project.id,revision,sessions:snapshot.sessions}}; }
function documentFor(id: string, sessionId = `session-${id}`): DesktopSessionDocument {
  return { session: session(id, sessionId), events: [{ type: "user_message", content: `Discuss ${id}` }], liveEvents: [] };
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
async function fixture(t: TestContext, ids = ["a", "b", "c"]) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); imports?: ReturnType<typeof registerHooks> } = {};
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const network: string[] = [];
  const unknown: string[] = [];
  const reads: Array<{ projectId: string; sessionId: string; gate: ReturnType<typeof deferred<DesktopSessionDocument>> }> = [];
  const sends: Array<ReturnType<typeof deferred<DesktopRunReceipt>>> = [];
  const slashes: Array<ReturnType<typeof deferred<DesktopSlashResult>>> = [];
  const actions: Array<{ kind: string; projectId: string; sessionId?: string; input: string }> = [];
  const metadata: Array<{ kind: string; projectId: string; sessionId: string; value: string | boolean; expectedRevision?: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const fastModes: Array<{ projectId: string; sessionId: string; value: boolean; expectedRevision?: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const archives: Array<{ projectId: string; sessionId: string; archived: boolean; expectedRevision?: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const deletions: Array<{ targets: DesktopSessionTarget[]; start: () => void; gate: ReturnType<typeof deferred<DesktopSessionDeleteResult>> }> = [];
  const refreshes: Array<{ projectId: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const pages: Array<{ projectId: string; parentSessionId: string; gate: ReturnType<typeof deferred<DesktopSessionTreePage>> }> = [];
  const removals: Array<{ id: string; gate: ReturnType<typeof deferred<DesktopBootstrap>> }> = [];
  const selections: Array<{ id: string; gate: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  const commitments: Array<{ projectId: string; sessionId?: string; activeView: string }> = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.root && resources.React) { await resources.React.act(()=>resources.root!.unmount()); resources.root=undefined; }
      if (resources.React) await resources.React.act(async () => {
        fastModes.forEach(item => item.gate.resolve(workspace(item.projectId)));
        metadata.forEach(item => item.gate.resolve(workspace(item.projectId)));
        archives.forEach(item => item.gate.resolve(workspace(item.projectId)));
        deletions.forEach(item => item.gate.resolve({cancelled:false, deleted:[], failures:[]}));
        refreshes.forEach(item => item.gate.resolve(workspace(item.projectId)));
        pages.forEach(item => item.gate.resolve({projectId:item.projectId, parentSessionId:item.parentSessionId, revision:"r1", sessions:[]}));
        removals.forEach(item => item.gate.resolve(bootstrapFor(ids.filter(id => id !== item.id))));
        reads.forEach(item => item.gate.resolve(documentFor(item.projectId, item.sessionId)));
        selections.forEach(item => item.gate.resolve(workspace(item.id)));
        sends.forEach(item => item.resolve({ sessionId: "session-a", runId: "inert-run", messageId: "inert-message" }));
        slashes.forEach(item => item.resolve({ command: "/tasks", title: "Inert result", content: "Source action result" }));
        await Promise.allSettled([...fastModes.map(item=>item.gate.promise), ...metadata.map(item=>item.gate.promise), ...archives.map(item=>item.gate.promise), ...deletions.map(item=>item.gate.promise), ...refreshes.map(item=>item.gate.promise), ...pages.map(item=>item.gate.promise), ...removals.map(item => item.gate.promise), ...reads.map(item => item.gate.promise), ...selections.map(item => item.gate.promise), ...sends.map(item => item.promise), ...slashes.map(item => item.promise)]);
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
    settingsSnapshot: async (id: string) => settingsSnapshot(id),
    updateSettingsDraftState: async () => {}, previewAppearance: async () => {},
    applicationImports: async () => ({ sources: [], history: [], sync: { enabled: false, hasSelection: false } }),
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: ids.map(project),
      sidebarSessions: ids.flatMap(id => workspace(id).sessions), workspace: workspace("a"), activeView: "chat",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    setSessionFastMode(projectId: string, sessionId: string, value: boolean, expectedRevision?: string) { const gate = deferred<DesktopWorkspaceSnapshot>(); fastModes.push({projectId, sessionId, value, expectedRevision, gate}); return gate.promise; },
    pinSession(projectId: string, sessionId: string, value: boolean, expectedRevision?: string) { const gate = deferred<DesktopWorkspaceSnapshot>(); metadata.push({kind:'pin',projectId,sessionId,value,expectedRevision,gate}); return gate.promise; },
    renameSession(projectId: string, sessionId: string, value: string, expectedRevision?: string) { const gate = deferred<DesktopWorkspaceSnapshot>(); metadata.push({kind:'rename',projectId,sessionId,value,expectedRevision,gate}); return gate.promise; },
    archiveSession(projectId: string, sessionId: string, archived: boolean, expectedRevision?: string) { const gate = deferred<DesktopWorkspaceSnapshot>(); archives.push({projectId, sessionId, archived, expectedRevision, gate}); return gate.promise; },
    deleteSessions(targets: DesktopSessionTarget[], _confirm: boolean, start: () => void) { const gate = deferred<DesktopSessionDeleteResult>(); deletions.push({targets, start, gate}); start(); return gate.promise; },
    refreshProject(projectId: string) { const gate = deferred<DesktopWorkspaceSnapshot>(); refreshes.push({projectId, gate}); return gate.promise; },
    listSessionTreePage(projectId: string, options: {parentSessionId: string}) { const gate = deferred<DesktopSessionTreePage>(); pages.push({projectId, parentSessionId:options.parentSessionId, gate}); return gate.promise; },
    removeProject: (id: string) => { const gate = deferred<DesktopBootstrap>(); removals.push({ id, gate }); return gate.promise; },
    sendPrompt(projectId: string, sessionId: string | undefined, input: string) { actions.push({ kind: "send", projectId, sessionId, input }); const gate = deferred<DesktopRunReceipt>(); sends.push(gate); return gate.promise; },
    runSlashCommand(projectId: string, sessionId: string | undefined, input: string) { actions.push({ kind: "slash", projectId, sessionId, input }); const gate = deferred<DesktopSlashResult>(); slashes.push(gate); return gate.promise; },
    selectProject: async (id: string) => workspace(id),
    startDraft: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string) => { return documentFor(id, sessionId); },
    commitSelection: async (projectId: string, sessionId: string | undefined, activeView: string) => { commitments.push({ projectId, sessionId, activeView }); },
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
    await React.act(async () => target.click());
  };
  const emit = async (name: string, value: DesktopAgentEventEnvelope | DesktopMenuAction | DesktopSessionHandoff | { uri: string; projectId?: string }): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React, metadata, fastModes,
    async tick(ms:number) { await React.act(async()=>t.mock.timers.tick(ms)); },
    async unmount() { if(resources.root) { await React.act(()=>resources.root!.unmount()); resources.root=undefined; } }, archives, deletions, refreshes, pages, removals, selections, sends, slashes, actions, commitments, api, click, emit,
    async sessionMenu(id: string, label: string) {
      const row = document.querySelector<HTMLButtonElement>(`button.biny-sidebar-session-item[title="Conversation ${id}"]`); assert.ok(row, `Session ${id}`);
      await React.act(async () => row.dispatchEvent(new window.MouseEvent("contextmenu", {bubbles:true, clientX:100, clientY:100})));
      await React.act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(performance.now())); });
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"]:not([inert]) [role="menuitem"]')].find(item => item.textContent === label);
      assert.ok(button, `Session action ${label}`); await React.act(async () => button.click());
    },
    async chooseSession(id: string) { await click(`button.biny-sidebar-session-item[title="Conversation ${id}"]`); },
    async expandSession(id: string) {
      const row = document.querySelector<HTMLButtonElement>(`button.biny-sidebar-session-item[title="Conversation ${id}"]`)?.closest('.biny-sidebar-session-tree-row');
      const button = row?.querySelector<HTMLButtonElement>('.biny-sidebar-session-toggle'); assert.ok(button); await React.act(async () => button.click());
    },
    hasSession: (id: string) => Boolean(document.querySelector(`button.biny-sidebar-session-item[title="Conversation ${id}"]`)),
    async submit(kind: "send" | "slash", input = kind === "send" ? "Source action input" : "/tasks") {
      const textarea = document.querySelector<HTMLTextAreaElement>(".biny-chat-composer textarea"); assert.ok(textarea);
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, input);
        textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await click('button[aria-label="发送消息"]');
    },
    async settleAction(kind: "send" | "slash", id = "a") { await React.act(async () => {
      if (kind === "send") sends[0]!.resolve({ sessionId: `session-${id}`, runId: "inert-run", messageId: "inert-message" });
      else slashes[0]!.resolve({ command: "/tasks", title: "Inert result", content: "Source action result" });
    }); },
    holdSelection() {
      api.selectProject = (id: string) => { const gate = deferred<DesktopWorkspaceSnapshot>(); selections.push({ id, gate }); return gate.promise; };
    },
    async chooseProject(id: string) {
      await click('button[title="选择项目"]');
      await React.act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(performance.now())); });
      const button = [...document.querySelectorAll<HTMLButtonElement>('.biny-workspace-context-menu [role="menuitemradio"]')].find(item => item.textContent?.includes(`Project ${id}`));
      assert.ok(button, `Project ${id} option`);
      await React.act(async () => button.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })));
    },
    async menuEntry(id: string, label: string) {
      await click(`button[aria-label="Project ${id} 项目操作"]`);
      await React.act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(performance.now())); });
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"]:not([inert]) [role="menuitem"]')].find(item => item.textContent?.includes(label));
      assert.ok(button, `The production project menu exposes ${label}`);
      await React.act(async () => button.click());
    },
    async removeEntry(id: string) { await this.menuEntry(id, "移除项目"); },
    async resolveRemoval(index: number, result = bootstrapFor(ids.filter(id => id !== removals[index]!.id))) { await React.act(async () => removals[index]!.gate.resolve(result)); },
    async rejectRemoval(index: number) { await React.act(async () => removals[index]!.gate.reject(new Error("Removal unavailable"))); },
    async resolveSelection(index: number) { await React.act(async () => selections[index]!.gate.resolve(workspace(selections[index]!.id))); },
    async rejectSelection(index: number) { await React.act(async () => selections[index]!.gate.reject(new Error("Import project unavailable"))); },
    settingsTitle: () => document.querySelector(".settings-titlebar h2")?.textContent,

    holdRead() {
      const gate = deferred<DesktopSessionDocument>();
      let current: { projectId: string; sessionId: string; gate: typeof gate } | undefined;
      api.openSession = async (projectId: string, sessionId: string) => {
        assert.equal(current, undefined, "One controlled read per hold");
        current = { projectId, sessionId, gate }; reads.push(current); return await gate.promise;
      };
      return {
        async resolve(_id: string) { assert.ok(current); await React.act(async () => gate.resolve(documentFor(current!.projectId, current!.sessionId))); },
        async reject(error: Error) { await React.act(async () => gate.reject(error)); }
      };
    },
    async fillDraft(value: string) {
      const textarea = document.querySelector<HTMLTextAreaElement>(".biny-chat-composer textarea"); assert.ok(textarea);
      await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value); textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    },
    draft: () => document.querySelector<HTMLTextAreaElement>(".biny-chat-composer textarea")?.value,
    projectIds: () => [...document.querySelectorAll("button[aria-label$=' 项目操作']")].map(button => button.getAttribute("aria-label")),
    heading: () => document.querySelector(".biny-chat-title")?.textContent,
    selectedTitle: () => document.querySelector(".biny-sidebar-session-entry.is-selected")?.textContent,
    body: () => document.querySelector(".biny-chat-body")?.textContent ?? "",
    loading: () => document.querySelector('.biny-chat-composer')?.getAttribute("aria-busy"),
    projectName: () => document.querySelector('button[title="选择项目"]')?.textContent,
    text: () => document.body.textContent ?? ""
  };
}

function settingsSnapshot(projectId: string): DesktopSettingsSnapshot {
  const config = structuredClone(defaultConfig);
  return {
    projectId, hasRunningTasks: false, preferenceRevision: 1, configRevision: "config:1",
    themePreference: "light", fontPreference: { family: "system", size: 14 },
    activity: { ...config.activity, outputDirectory: "/synthetic/activity" }, identity: config.context.identity,
    memory: config.context.memory, compaction: config.context.compaction, chatParams: config.chat, toolExecutionMode: config.agent.toolExecutionMode,
    subagent: { enabled: false, runtime: "builtin" }, externalSubagentBlockers: [],
    permission: config.permission, webSearch: config.web.search,
    models: { configured: models, connections: [], embeddingModels: [], defaultModel: "inert", thinking: "high", modelProfiles: {} },
    skills: { projectId, projectKey: projectId, globalDefaults: {}, projectOverrides: {}, activations: [] }
  };
}

function bootstrapFor(ids: string[], activeId = ids[0]): DesktopBootstrap {
  return { version: "test", platform: "linux", projects: ids.map(project), sidebarSessions: ids.flatMap(id => workspace(id).sessions),
    workspace: activeId ? workspace(activeId) : undefined, activeView: "chat", sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } };
}



type Harness = Awaited<ReturnType<typeof fixture>>;
type Kind = 'pin' | 'rename';
function savedSnapshot(kind: Kind): DesktopWorkspaceSnapshot {
  const value=workspace('a');
  value.sessions=value.sessions.map(x=>x.id==='session-a'?{...x, ...(kind==='pin'?{pinned:true}:{title:'Renamed A'}), metadataRevision:`revision:session-a:${kind}`}:x);
  return withPage(value,`catalog:${kind}`);
}
function archived(h:Harness,id='second-a'):boolean {
  const row=h.document.querySelector(`button.biny-sidebar-session-item[title="Conversation ${id}"]`); assert.ok(row);
  return Boolean(row.closest('.biny-sidebar-session-entry.is-archived'));
}
async function begin(h:Harness,kind:Kind):Promise<void> {
  await h.sessionMenu('session-a',kind==='pin'?'置顶':'重命名');
  if(kind==='rename') {
    const input=h.document.querySelector<HTMLInputElement>('.desktop-dialog-form input'); assert.ok(input);
    await h.React.act(async()=>{
      Object.getOwnPropertyDescriptor(h.window.HTMLInputElement.prototype,'value')!.set!.call(input,'Renamed A');
      input.dispatchEvent(new h.window.Event('input',{bubbles:true}));
    });
    const form=h.document.querySelector('.desktop-dialog-form'); assert.ok(form);
    await h.React.act(async()=>form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true})));
  }
  assert.equal(h.metadata.length,1); assert.equal(h.metadata[0]!.kind,kind); assert.equal(h.metadata[0]!.expectedRevision,'revision:session-a:initial');
}
async function acceptEventCatalog(h:Harness,fresh:DesktopWorkspaceSnapshot):Promise<void> {
  // A legitimate background title event requests a fresh catalog even while the
  // real rename modal is saving. No click is dispatched through that modal.
  const id=fresh.project.id;
  await h.emit('onAgentEvent',{projectId:id,sessionId:`parent-${id}`,primary:false,event:{type:'session.title',sessionId:`parent-${id}`,runId:'inert-run',timestamp:time,title:`Conversation parent-${id}`},snapshot:{revision:1,permissionMode:'ask',state:{kind:'idle'},info:{workspaceRoot:`/synthetic/${id}`,sessionId:`parent-${id}`,sessionFile:`/synthetic/${id}/parent.jsonl`,provider:'inert',modelLabel:'inert',reasoningLabel:'high',modelAlias:'inert',thinking:'high'}}});
  await h.tick(16); await h.tick(260);
  const request=h.refreshes.at(-1);assert.ok(request);assert.equal(request.projectId,id);
  await h.React.act(async()=>request.gate.resolve(fresh));
}
for (const kind of ['pin','rename'] as const) for(const later of ['archive','delete','new-session'] as const) {
  test(`late ${kind} response cannot replace a later accepted ${later} catalog`,async t=>{
    const h=await fixture(t);await begin(h,kind);const old=savedSnapshot(kind);const fresh=savedSnapshot(kind);
    if(later==='archive')fresh.sessions=fresh.sessions.map(x=>x.id==='second-a'?{...x,archived:true,metadataRevision:'revision:second-a:archived'}:x);
    if(later==='delete')fresh.sessions=fresh.sessions.filter(x=>x.id!=='second-a');
    if(later==='new-session')fresh.sessions.push(session('a','new-a'));
    await acceptEventCatalog(h,withPage(fresh,`catalog:${kind}:${later}`));
    const current=()=>later==='archive'?archived(h):later==='delete'?!h.hasSession('second-a'):h.hasSession('new-a');
    assert.equal(current(),true,'Newer catalog has visibly arrived before the old metadata response');
    await h.React.act(async()=>h.metadata[0]!.gate.resolve(old));
    assert.equal(current(),true,'A source-obsolete metadata response must not replace already-accepted newer state');
  });
}
for(const deletedId of ['session-a','second-a'])test(`late pin cannot resurrect successfully deleted ${deletedId}`,async t=>{
  const h=await fixture(t);await begin(h,'pin');const old=savedSnapshot('pin');
  await h.sessionMenu(deletedId,'删除');
  await h.React.act(async()=>h.deletions[0]!.gate.resolve({cancelled:false,deleted:h.deletions[0]!.targets,failures:[]}));
  const fresh=savedSnapshot('pin');fresh.sessions=fresh.sessions.filter(x=>x.id!==deletedId);
  await h.React.act(async()=>h.refreshes[0]!.gate.resolve(withPage(fresh,'catalog:deleted')));
  assert.equal(h.hasSession(deletedId),false);
  await h.React.act(async()=>h.metadata[0]!.gate.resolve(old));
  assert.equal(h.hasSession(deletedId),false,'Late pin response cannot reinsert a deleted row');
});
test('late pin cannot reverse a later successful Sidebar archive',async t=>{
  const h=await fixture(t);await begin(h,'pin');const old=savedSnapshot('pin');
  await h.sessionMenu('second-a','归档');const fresh=savedSnapshot('pin');fresh.sessions=fresh.sessions.map(x=>x.id==='second-a'?{...x,archived:true,metadataRevision:'revision:second-a:archived'}:x);const current=withPage(fresh,'catalog:archived');
  await h.React.act(async()=>h.archives[0]!.gate.resolve(current));
  // #338 deliberately reconciles instead of adopting the archive receipt.
  await h.tick(260);if(h.refreshes.length)await h.React.act(async()=>h.refreshes[0]!.gate.resolve(current));
  assert.equal(archived(h),true);
  await h.React.act(async()=>h.metadata[0]!.gate.resolve(old));
  assert.equal(archived(h),true,'Confirmed archive display must survive older pin snapshot');
});
for(const kind of ['pin','rename'] as const)test(`ordinary ${kind} completion is visible`,async t=>{
  const h=await fixture(t);await begin(h,kind);await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot(kind)));
  await h.tick(260); assert.equal(h.refreshes.length,1,'Saved metadata demands one catalog-only read');
  await h.React.act(async()=>h.refreshes[0]!.gate.resolve(savedSnapshot(kind)));
  await h.tick(1040); assert.equal(h.refreshes.length,1,'Self-publication stops refresh demand');
  if(kind==='pin')assert.ok(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation session-a"]'));
  else assert.ok(h.document.querySelector('button.biny-sidebar-session-item[title="Renamed A"]'));
});

for(const kind of ['pin','rename'] as const)test(`${kind} write rejection does not trigger reconciliation`,async t=>{
  const h=await fixture(t);await begin(h,kind);await h.React.act(async()=>h.metadata[0]!.gate.reject(new Error('Metadata CAS conflict')));
  await h.tick(1040);assert.equal(h.metadata.length,1);assert.equal(h.refreshes.length,0);
  assert.match(h.text(),/Metadata CAS conflict/);
  if(kind==='rename')assert.equal(h.document.querySelector('.desktop-dialog-form')?.closest('dialog')?.open,true,'Failed rename remains editable');
  assert.equal(h.hasSession('session-a'),true);
});
for(const kind of ['pin','rename'] as const)test(`${kind} refresh failure reports saved state and never repeats write`,async t=>{
  const h=await fixture(t);await begin(h,kind);await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot(kind)));
  await h.tick(260);assert.equal(h.refreshes.length,1);await h.React.act(async()=>h.refreshes[0]!.gate.reject(new Error('Metadata read unavailable')));
  await h.tick(1040);assert.equal(h.metadata.length,1);assert.equal(h.refreshes.length,1);
  assert.match(h.text(),kind==='pin'?/置顶状态已保存.*刷新失败/:/名称已保存.*刷新失败/);assert.ok(!h.text().includes('归档状态已保存'));
  if(kind==='rename')assert.equal(h.document.querySelector('.desktop-dialog-form')?.closest('dialog')?.open,false,'Saved rename does not become a failed modal');
  await h.menuEntry('a','刷新项目状态');assert.equal(h.refreshes.length,2);await h.React.act(async()=>h.refreshes[1]!.gate.resolve(savedSnapshot(kind)));
  assert.equal(h.metadata.length,1,'Manual read retry does not repeat mutation');
});
for(const kind of ['pin','rename'] as const)test(`catalog accepted before ${kind} write commits cannot suppress success`,async t=>{
  const h=await fixture(t);await begin(h,kind);await acceptEventCatalog(h,withPage(workspace('a'),'catalog:before-write'));
  await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot(kind)));await h.tick(260);assert.equal(h.refreshes.length,2);
  await h.React.act(async()=>h.refreshes[1]!.gate.resolve(savedSnapshot(kind)));await h.tick(1040);assert.equal(h.refreshes.length,2);
  if(kind==='pin')assert.ok(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation session-a"]'));
  else assert.ok(h.document.querySelector('button.biny-sidebar-session-item[title="Renamed A"]'));
});
test('rename saves once, stays locked while writing, and closes before read settlement',async t=>{
  const h=await fixture(t);await begin(h,'rename');
  const form=h.document.querySelector('.desktop-dialog-form');assert.ok(form);
  const input=form.querySelector<HTMLInputElement>('input');assert.equal(input?.disabled,true);
  const cancel=[...form.querySelectorAll<HTMLButtonElement>('button')].find(x=>x.textContent?.includes('取消'));assert.ok(cancel);assert.equal(cancel.disabled,true);
  await h.React.act(async()=>form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(h.metadata.length,1,'Repeated submission while saving remains suppressed');
  assert.equal(h.refreshes.length,0,'Never refresh before write success');
  await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot('rename')));
  assert.equal(h.document.querySelector('.desktop-dialog-form')?.closest('dialog')?.open,false,'Successful save closes independently of refresh');
  await h.tick(259);assert.equal(h.refreshes.length,0);await h.tick(1);assert.equal(h.refreshes.length,1);
  await h.React.act(async()=>h.refreshes[0]!.gate.resolve(savedSnapshot('rename')));assert.equal(h.metadata.length,1);
});
test('rename cancellation before saving has no write or reconciliation',async t=>{
  const h=await fixture(t);await h.sessionMenu('session-a','重命名');const form=h.document.querySelector('.desktop-dialog-form');assert.ok(form);
  const cancel=[...form.querySelectorAll<HTMLButtonElement>('button')].find(x=>x.textContent?.includes('取消'));assert.ok(cancel);
  await h.React.act(async()=>cancel.click());await h.tick(1040);assert.equal(h.metadata.length,0);assert.equal(h.refreshes.length,0);
});
for(const kind of ['pin','rename'] as const)test(`${kind} completion after project removal and recreation cannot revive old ownership`,async t=>{
  const h=await fixture(t);await begin(h,kind);
  h.api.bootstrap=async()=>bootstrapFor(['b','c'],'b');await h.emit('onApplicationImportsChanged',undefined as never);assert.ok(!h.projectIds().includes('Project a 项目操作'));
  h.api.bootstrap=async()=>bootstrapFor(['a','b','c'],'b');await h.emit('onApplicationImportsChanged',undefined as never);
  await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot(kind)));await h.tick(1040);assert.equal(h.refreshes.length,0);
  assert.ok(h.hasSession('session-a'));assert.equal(Boolean(h.document.querySelector('button.biny-sidebar-session-item[title="Renamed A"]')),false);
  assert.equal(Boolean(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation session-a"]')),false);
});
for(const kind of ['pin','rename'] as const)test(`unmount before ${kind} completion prevents later read`,async t=>{
  const h=await fixture(t);await begin(h,kind);await h.unmount();await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot(kind)));await h.tick(1040);assert.equal(h.refreshes.length,0);
});
test('pin reconciliation remains source-qualified across newer project navigation and draft',async t=>{
  const h=await fixture(t);await begin(h,'pin');await h.chooseProject('b');await h.chooseSession('session-b');await h.fillDraft('Keep newer B draft');
  const before=[h.heading(),h.selectedTitle(),h.body(),h.draft(),h.projectName()];
  await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot('pin')));await h.tick(260);assert.equal(h.refreshes.length,1);assert.equal(h.refreshes[0]!.projectId,'a');
  await h.React.act(async()=>h.refreshes[0]!.gate.resolve(savedSnapshot('pin')));assert.deepEqual([h.heading(),h.selectedTitle(),h.body(),h.draft(),h.projectName()],before);
  assert.ok(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation session-a"]'));
});
test('explicit pin writes to distinct rows coalesce reads without inventing extra writes',async t=>{
  const h=await fixture(t);await begin(h,'pin');await h.sessionMenu('second-a','置顶');assert.equal(h.metadata.length,2,'Two explicit, independent target writes');
  const both=withPage({...savedSnapshot('pin'),sessions:savedSnapshot('pin').sessions.map(x=>x.id==='second-a'?{...x,pinned:true,metadataRevision:'revision:second-a:pin'}:x)},'catalog:both-pinned');
  await h.React.act(async()=>{h.metadata[0]!.gate.resolve(savedSnapshot('pin'));h.metadata[1]!.gate.resolve(both);});
  await h.tick(260);assert.equal(h.refreshes.length,1);await h.React.act(async()=>h.refreshes[0]!.gate.resolve(both));await h.tick(1040);
  assert.ok(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation second-a"]'));
  assert.equal(h.metadata.length,2);assert.equal(h.refreshes.length,1);
});
test('later confirmed unpin invalidates a running pin read without overlapping reads',async t=>{
  const h=await fixture(t);await begin(h,'pin');await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot('pin')));await h.tick(260);assert.equal(h.refreshes.length,1);
  await acceptEventCatalog(h,savedSnapshot('pin'));assert.equal(h.refreshes.length,2,'Event refresh is separate and establishes the pinned row');
  await h.sessionMenu('session-a','取消置顶');assert.equal(h.metadata.length,2);const current=withPage({...savedSnapshot('pin'),sessions:savedSnapshot('pin').sessions.map(x=>x.id==='session-a'?{...x,pinned:false,metadataRevision:'revision:session-a:unpin'}:x)},'catalog:unpin');
  await h.React.act(async()=>h.metadata[1]!.gate.resolve(current));await h.tick(1040);assert.equal(h.refreshes.length,2,'One catalog-owned read remains in flight');
  await h.React.act(async()=>h.refreshes[0]!.gate.resolve(savedSnapshot('pin')));await h.tick(260);assert.equal(h.refreshes.length,3);
  await h.React.act(async()=>h.refreshes[2]!.gate.resolve(current));await h.tick(1040);assert.equal(h.refreshes.length,3);assert.equal(h.metadata.length,2);
  assert.equal(Boolean(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation session-a"]')),false);
});

for(const kind of ['pin','rename'] as const)test(`late ${kind} receipt reconciles and terminates without losing newer membership`,async t=>{
  const h=await fixture(t);await begin(h,kind);const fresh=savedSnapshot(kind);fresh.sessions.push(session('a','new-a'));const current=withPage(fresh,'catalog:with-new-session');
  await acceptEventCatalog(h,current);await h.React.act(async()=>h.metadata[0]!.gate.resolve(savedSnapshot(kind)));assert.equal(h.hasSession('new-a'),true);
  await h.tick(260);assert.equal(h.refreshes.length,2);await h.React.act(async()=>h.refreshes[1]!.gate.resolve(current));await h.tick(1040);
  assert.equal(h.hasSession('new-a'),true);assert.equal(h.refreshes.length,2);assert.equal(h.metadata.length,1);
});
test('same-row repeated pin sends no implicit retry after real-contract CAS rejection',async t=>{
  const h=await fixture(t);await begin(h,'pin');await h.sessionMenu('session-a','置顶');assert.equal(h.metadata.length,2);assert.equal(h.metadata[0]!.expectedRevision,h.metadata[1]!.expectedRevision);
  await h.React.act(async()=>{h.metadata[0]!.gate.resolve(savedSnapshot('pin'));h.metadata[1]!.gate.reject(new Error('Repeated stale pin CAS conflict'));});
  await h.tick(260);assert.equal(h.refreshes.length,1);await h.React.act(async()=>h.refreshes[0]!.gate.resolve(savedSnapshot('pin')));await h.tick(1040);
  assert.equal(h.metadata.length,2);assert.equal(h.refreshes.length,1);assert.match(h.text(),/Repeated stale pin CAS conflict/);
  assert.ok(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation session-a"]'));
});
for(const latest of ['pin','rename'] as const)test(`coalesced archive and ${latest} failure names the latest saved operation`,async t=>{
  const h=await fixture(t);await h.sessionMenu('second-a','归档');const archived=withPage({...workspace('a'),sessions:workspace('a').sessions.map(x=>x.id==='second-a'?{...x,archived:true,metadataRevision:'revision:second-a:archived'}:x)},'catalog:archived');
  await h.React.act(async()=>h.archives[0]!.gate.resolve(archived));await h.tick(260);assert.equal(h.refreshes.length,1);
  await begin(h,latest);const current=savedSnapshot(latest);current.sessions=current.sessions.map(x=>x.id==='second-a'?{...x,archived:true,metadataRevision:'revision:second-a:archived'}:x);
  await h.React.act(async()=>h.metadata[0]!.gate.resolve(withPage(current,`catalog:archived:${latest}`)));await h.tick(1040);assert.equal(h.refreshes.length,1);
  await h.React.act(async()=>h.refreshes[0]!.gate.resolve(archived));await h.tick(260);assert.equal(h.refreshes.length,2);
  await h.React.act(async()=>h.refreshes[1]!.gate.reject(new Error('Coalesced read failed')));await h.tick(1040);
  assert.match(h.text(),latest==='pin'?/置顶状态已保存.*Coalesced read failed/:/名称已保存.*Coalesced read failed/);assert.ok(!h.text().includes('归档状态已保存'));
  assert.equal(h.archives.length,1);assert.equal(h.metadata.length,1);assert.equal(h.refreshes.length,2);
});


// Only inert IPC receipts are delayed: no Host, session files or real project removal.
function fastModeSnapshot(id: string): DesktopWorkspaceSnapshot {
  const value = workspace(id);
  return withPage({ ...value, sessions: value.sessions.map(item => item.id === `session-${id}`
    ? { ...item, fastMode: true, metadataRevision: `revision:session-${id}:fast` } : item) }, `catalog:${id}:fast`);
}
function fastModeButton(h: Harness): HTMLButtonElement {
  const button = h.document.querySelector<HTMLButtonElement>('button[data-fast-mode]');
  assert.ok(button, 'The real priority-capable Composer exposes FastMode');
  return button;
}
async function beginFastMode(h: Harness, id = 'a'): Promise<void> {
  await h.chooseSession(`session-${id}`);
  assert.equal(fastModeButton(h).getAttribute('aria-pressed'), 'false', 'Explicit persisted false must not fall back to lastFastMode');
  assert.equal(fastModeButton(h).disabled, false);
  await h.React.act(async () => fastModeButton(h).click());
  assert.equal(fastModeButton(h).getAttribute('aria-pressed'), 'true');
  const request = h.fastModes.at(-1); assert.ok(request);
  assert.equal(request.projectId, id); assert.equal(request.sessionId, `session-${id}`);
  assert.equal(request.value, true); assert.equal(request.expectedRevision, `revision:session-${id}:initial`);
}
for (const outcome of ['success', 'error'] as const) for (const recreate of [false, true]) {
  test(`FastMode ${outcome} after confirmed removal${recreate ? ' and same-ID recreation' : ''} has no old publication`, async t => {
    const h = await fixture(t); await beginFastMode(h);
    await h.removeEntry('a'); assert.equal(h.removals.length, 1);
    await h.resolveRemoval(0);
    assert.ok(!h.projectIds().includes('Project a 项目操作')); assert.equal(h.hasSession('session-a'), false);
    if (recreate) {
      h.api.bootstrap = async () => bootstrapFor(['a', 'b', 'c'], 'b');
      await h.emit('onApplicationImportsChanged', undefined as never);
      await h.chooseSession('session-a');
      // This branch models a write still pending BEFORE metadata commit. Reopening
      // legitimately reads persisted false; later completion may succeed or fail.
      assert.equal(fastModeButton(h).getAttribute('aria-pressed'), 'false', 'Retired pending override cannot color the recreated session');
    }
    await h.React.act(async () => {
      if (outcome === 'success') h.fastModes[0]!.gate.resolve(fastModeSnapshot('a'));
      else h.fastModes[0]!.gate.reject(new Error('Retired FastMode receipt'));
    });
    assert.equal(h.projectIds().includes('Project a 项目操作'), recreate);
    assert.equal(h.hasSession('session-a'), recreate);
    assert.ok(!h.text().includes('Retired FastMode receipt'));
    if (recreate) assert.equal(fastModeButton(h).getAttribute('aria-pressed'), 'false');
    assert.equal(h.fastModes.length, 1);
  });
}
for (const outcome of ['success', 'error'] as const) {
  test(`ordinary FastMode ${outcome} retains immediate completion behavior`, async t => {
    const h = await fixture(t); await beginFastMode(h);
    await h.React.act(async () => {
      if (outcome === 'success') h.fastModes[0]!.gate.resolve(fastModeSnapshot('a'));
      else h.fastModes[0]!.gate.reject(new Error('Current FastMode failure'));
    });
    assert.equal(fastModeButton(h).getAttribute('aria-pressed'), outcome === 'success' ? 'true' : 'false');
    assert.equal(h.text().includes('Current FastMode failure'), outcome === 'error');
    assert.equal(h.refreshes.length, 0, 'No delayed reconciliation or extra mutation');
    assert.equal(h.fastModes.length, 1);
  });
  test(`older session FastMode ${outcome} cannot clear a newer session override`, async t => {
    const h = await fixture(t); await beginFastMode(h, 'a');
    await beginFastMode(h, 'b');
    assert.equal(h.fastModes.length, 2);
    assert.notEqual(h.fastModes[0]!.expectedRevision, h.fastModes[1]!.expectedRevision, 'Independent sessions, not impossible same-revision successes');
    await h.React.act(async () => {
      if (outcome === 'success') h.fastModes[0]!.gate.resolve(fastModeSnapshot('a'));
      else h.fastModes[0]!.gate.reject(new Error('Earlier session FastMode failure'));
    });
    assert.equal(fastModeButton(h).getAttribute('aria-pressed'), 'true', 'B stays optimistic despite its persisted false');
    assert.ok(h.selectedTitle()?.includes('session-b'));
    await h.React.act(async () => h.fastModes[1]!.gate.resolve(fastModeSnapshot('b')));
    assert.equal(fastModeButton(h).getAttribute('aria-pressed'), 'true');
    assert.equal(h.fastModes.length, 2);
  });
}
test('failed project removal does not retire FastMode completion', async t => {
  const h = await fixture(t); await beginFastMode(h);
  await h.removeEntry('a'); await h.rejectRemoval(0);
  await h.React.act(async () => h.fastModes[0]!.gate.resolve(fastModeSnapshot('a')));
  assert.ok(h.projectIds().includes('Project a 项目操作'));
  assert.equal(fastModeButton(h).getAttribute('aria-pressed'), 'true');
});
