import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopSessionDeleteResult, DesktopSessionTarget, DesktopSessionTreePage, DesktopRunReceipt, DesktopSlashResult, DesktopSettingsSnapshot, DesktopBootstrap, DesktopMenuAction, DesktopProject, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

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
    eventCount: 1, pinned: false, status: "completed", metadataRevision: `revision:${id}:initial` };
}
const models = [{ alias: "inert", displayName: "inert", provider: "inert", providerType: "openai-compatible" as const,
  model: "inert", modelKey: "inert/inert", available: true, source: "configured" as const, supportsTools: true,
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
        archives.forEach(item => item.gate.resolve(workspace(item.projectId)));
        deletions.forEach(item => item.gate.resolve({cancelled:false, deleted:[], failures:[]}));
        refreshes.forEach(item => item.gate.resolve(workspace(item.projectId)));
        pages.forEach(item => item.gate.resolve({projectId:item.projectId, parentSessionId:item.parentSessionId, revision:"r1", sessions:[]}));
        removals.forEach(item => item.gate.resolve(bootstrapFor(ids.filter(id => id !== item.id))));
        reads.forEach(item => item.gate.resolve(documentFor(item.projectId, item.sessionId)));
        selections.forEach(item => item.gate.resolve(workspace(item.id)));
        sends.forEach(item => item.resolve({ sessionId: "session-a", runId: "inert-run", messageId: "inert-message" }));
        slashes.forEach(item => item.resolve({ command: "/tasks", title: "Inert result", content: "Source action result" }));
        await Promise.allSettled([...archives.map(item=>item.gate.promise), ...deletions.map(item=>item.gate.promise), ...refreshes.map(item=>item.gate.promise), ...pages.map(item=>item.gate.promise), ...removals.map(item => item.gate.promise), ...reads.map(item => item.gate.promise), ...selections.map(item => item.gate.promise), ...sends.map(item => item.promise), ...slashes.map(item => item.promise)]);
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
  const emit = async (name: string, value: DesktopMenuAction | DesktopSessionHandoff | { uri: string; projectId?: string }): Promise<void> => {
    assert.ok(listeners.has(name), `Production App subscribed to ${name}`);
    await React.act(async () => listeners.get(name)!(value as never));
  };
  return { document, window, React,
    async tick(ms:number){await React.act(async()=>t.mock.timers.tick(ms));},
    async unmount(){if(resources.root){await React.act(()=>resources.root!.unmount());resources.root=undefined;}},
    archives, deletions, refreshes, pages, removals, selections, sends, slashes, actions, commitments, api, click, emit,
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


async function acceptCurrentCatalog(h:Awaited<ReturnType<typeof fixture>>, snapshot:DesktopWorkspaceSnapshot):Promise<void> {
  // A current catalog may arrive through manual refresh independently of an
  // older archive-owned read. Pin mutation ownership has its own regression suite.
  const refresh = h.api.refreshProject;
  let calls = 0;
  h.api.refreshProject = async (projectId:string) => {
    assert.equal(projectId,snapshot.project.id); calls += 1; return snapshot;
  };
  try { await h.menuEntry(snapshot.project.id,'刷新项目状态'); }
  finally { h.api.refreshProject = refresh; }
  assert.equal(calls,1,'The actual manual-refresh entry publishes the current catalog');
}

function archivedSnapshot(id='a'): DesktopWorkspaceSnapshot { const snapshot=workspace(id); snapshot.sessions=snapshot.sessions.map(item=>item.id===`session-${id}`?{...item,archived:true,metadataRevision:`revision:${item.id}:archived`}:item); return withPage(snapshot,'catalog:archived'); }
function archived(h:Awaited<ReturnType<typeof fixture>>,id='session-a'):boolean {const row=h.document.querySelector(`button.biny-sidebar-session-item[title="Conversation ${id}"]`);assert.ok(row);return Boolean(row.closest('.biny-sidebar-session-entry.is-archived'));}
type View=Awaited<ReturnType<typeof fixture>>;
async function finishArchive(h:View,index:number,result:DesktopWorkspaceSnapshot,fresh=result,beforeRead?:()=>void):Promise<void>{
 const start=h.refreshes.length;await h.React.act(async()=>h.archives[index]!.gate.resolve(result));beforeRead?.();await h.tick(260);
 const requests=h.refreshes.slice(start);assert.ok(requests.length<=1,'Archive work coalesces to one initial catalog read');
 if(requests.length)await h.React.act(async()=>requests[0]!.gate.resolve(fresh));
 await h.tick(1040);assert.equal(h.refreshes.length,start+requests.length,'Settled catalog reconciliation stops reading');
}
for(const crossProject of [false,true])test(`archive preserves ${crossProject?'other-project':'same-project'} newer conversation and draft`,async t=>{
 const h=await fixture(t);await h.chooseSession('session-a');await h.sessionMenu('session-a','归档');if(crossProject){await h.chooseProject('b');await h.chooseSession('session-b');}else await h.chooseSession('second-a');await h.fillDraft('Keep new draft');const before=[h.heading(),h.body(),h.selectedTitle(),h.draft()];
 await finishArchive(h,0,archivedSnapshot());assert.deepEqual([h.heading(),h.body(),h.selectedTitle(),h.draft()],before);assert.equal(archived(h),true);
});
for(const deletedId of ['session-a','second-a'])for(const refreshFirst of [true,false])test(`archive A cannot resurrect deleted ${deletedId}; deletion refresh ${refreshFirst?'first':'last'}`,async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.sessionMenu(deletedId,'删除');await h.React.act(async()=>h.deletions[0]!.gate.resolve({cancelled:false,deleted:h.deletions[0]!.targets,failures:[]}));const fresh=archivedSnapshot();fresh.sessions=fresh.sessions.filter(x=>x.id!==deletedId);const current=withPage(fresh,'catalog:deleted');
 if(refreshFirst)await h.React.act(async()=>h.refreshes[0]!.gate.resolve(current));assert.equal(h.hasSession(deletedId),false);
 await finishArchive(h,0,archivedSnapshot(),current,()=>assert.equal(h.hasSession(deletedId),false,'Archive response cannot resurrect before replacement read'));
 if(!refreshFirst)await h.React.act(async()=>h.refreshes[0]!.gate.resolve(current));assert.equal(h.hasSession(deletedId),false);
});
for(const cancelled of [false,true])test(`${cancelled?'cancelled':'failed'} deletion does not discard successful archive`,async t=>{
 const h=await fixture(t);let started=false;if(cancelled)h.api.deleteSessions=(targets:DesktopSessionTarget[],_confirm:boolean,start:()=>void)=>{const gate=deferred<DesktopSessionDeleteResult>();h.deletions.push({targets,start:()=>{started=true;start();},gate});return gate.promise;};
 await h.sessionMenu('session-a','归档');await h.sessionMenu('second-a','删除');await h.React.act(async()=>h.deletions[0]!.gate.resolve({cancelled,deleted:[],failures:cancelled?[]:[{...h.deletions[0]!.targets[0]!,error:'Synthetic deletion failed'}]}));if(cancelled)assert.equal(started,false);
 await finishArchive(h,0,archivedSnapshot());assert.equal(archived(h),true);assert.equal(h.hasSession('second-a'),true);
});
test('later committed unarchive survives old archive response and any reconciliation',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');const intermediate=archivedSnapshot();intermediate.sessions=intermediate.sessions.map(x=>x.id==='pin-a'?{...x,pinned:false}:x);await acceptCurrentCatalog(h,withPage(intermediate,'catalog:intermediate'));assert.equal(archived(h),true);
 await h.sessionMenu('session-a','取消归档');assert.equal(h.archives[1]!.expectedRevision,'revision:session-a:archived');const fresh=withPage({...intermediate,sessions:intermediate.sessions.map(x=>x.id==='session-a'?{...x,archived:false,metadataRevision:'revision:session-a:unarchived'}:x)},'catalog:unarchived');
 await finishArchive(h,1,fresh);assert.equal(archived(h),false);await finishArchive(h,0,archivedSnapshot(),fresh,()=>assert.equal(archived(h),false));assert.equal(archived(h),false);
});
for(const kind of ['pin','new-session'] as const)test(`archive preserves newer accepted ${kind}`,async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');const fresh=archivedSnapshot();fresh.sessions=fresh.sessions.map(x=>x.id==='second-a'?{...x,pinned:true,metadataRevision:'revision:second-a:pinned'}:x);fresh.sessions.push(session('a','new-a'));const current=withPage(fresh,'catalog:pinned');await acceptCurrentCatalog(h,current);const pinned=()=>Boolean(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation second-a"]'));assert.equal(pinned(),true);assert.equal(h.hasSession('new-a'),true);
 const check=()=>assert.equal(kind==='pin'?pinned():h.hasSession('new-a'),true);await finishArchive(h,0,archivedSnapshot(),current,check);check();
});
test('archive rejection preserves newer catalog and does not start a replacement read',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');const fresh=workspace('a');fresh.sessions=fresh.sessions.map(x=>x.id==='second-a'?{...x,pinned:true}:x);fresh.sessions.push(session('a','new-a'));await acceptCurrentCatalog(h,withPage(fresh,'catalog:pinned'));await h.React.act(async()=>h.archives[0]!.gate.reject(new Error('Synthetic archive conflict')));await h.tick(1040);assert.equal(h.hasSession('new-a'),true);assert.equal(archived(h),false);assert.equal(h.refreshes.length,0);
});
test('other project deletion cannot retire archive work',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.sessionMenu('session-b','删除');await h.React.act(async()=>h.deletions[0]!.gate.resolve({cancelled:false,deleted:h.deletions[0]!.targets,failures:[]}));const fresh=workspace('b');fresh.sessions=fresh.sessions.filter(x=>x.id!=='session-b');await h.React.act(async()=>h.refreshes[0]!.gate.resolve(withPage(fresh,'catalog:deleted')));await finishArchive(h,0,archivedSnapshot());assert.equal(archived(h),true);assert.equal(h.hasSession('session-b'),false);
});
test('refresh accepted before archive write commits cannot make successful archive disappear',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.sessionMenu('second-a','删除');await h.React.act(async()=>h.deletions[0]!.gate.resolve({cancelled:false,deleted:h.deletions[0]!.targets,failures:[]}));const before=workspace('a');before.sessions=before.sessions.filter(x=>x.id!=='second-a');await h.React.act(async()=>h.refreshes[0]!.gate.resolve(withPage(before,'catalog:before-archive')));assert.equal(archived(h),false);
 const after=archivedSnapshot();after.sessions=after.sessions.filter(x=>x.id!=='second-a');await finishArchive(h,0,withPage(after,'catalog:after-archive'));assert.equal(archived(h),true);assert.equal(h.hasSession('second-a'),false);
});
test('replacement-read failure reports saved archive, stops, and manual refresh can retry',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.React.act(async()=>h.archives[0]!.gate.resolve(archivedSnapshot()));await h.tick(260);assert.equal(h.refreshes.length,1,'Successful archive requests a catalog-only read');await h.React.act(async()=>h.refreshes[0]!.gate.reject(new Error('Synthetic refresh failure')));await h.tick(1040);assert.equal(h.refreshes.length,1,'Current read failure never retries itself');assert.match(h.text(),/已保存.*刷新失败/);
 await h.menuEntry('a','刷新项目状态');assert.equal(h.refreshes.length,2);await h.React.act(async()=>h.refreshes[1]!.gate.resolve(archivedSnapshot()));assert.equal(archived(h),true);assert.equal(h.archives.length,1,'Refresh retry never repeats archive write');
});
test('newer accepted pin supersedes an archive reread and coalesces one delayed replacement',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.React.act(async()=>h.archives[0]!.gate.resolve(archivedSnapshot()));await h.tick(260);assert.equal(h.refreshes.length,1);const fresh=archivedSnapshot();fresh.sessions=fresh.sessions.map(x=>x.id==='second-a'?{...x,pinned:true}:x);const current=withPage(fresh,'catalog:pinned');await acceptCurrentCatalog(h,current);
 await h.React.act(async()=>h.refreshes[0]!.gate.resolve(archivedSnapshot()));const pinned=()=>Boolean(h.document.querySelector('section[aria-label="置顶"] button[title="Conversation second-a"]'));assert.equal(pinned(),true,'Stale reread cannot undo newer pin');assert.equal(h.refreshes.length,1);await h.tick(259);assert.equal(h.refreshes.length,1);await h.tick(1);assert.equal(h.refreshes.length,2);await h.React.act(async()=>h.refreshes[1]!.gate.resolve(current));await h.tick(1040);assert.equal(h.refreshes.length,2);assert.equal(pinned(),true);
});
test('later successful unarchive invalidates an in-flight archive reread without overlapping reads',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.React.act(async()=>h.archives[0]!.gate.resolve(archivedSnapshot()));await h.tick(260);assert.equal(h.refreshes.length,1);const intermediate=archivedSnapshot();intermediate.sessions=intermediate.sessions.map(x=>x.id==='pin-a'?{...x,pinned:false}:x);await acceptCurrentCatalog(h,withPage(intermediate,'catalog:intermediate'));await h.sessionMenu('session-a','取消归档');const fresh=withPage({...intermediate,sessions:intermediate.sessions.map(x=>x.id==='session-a'?{...x,archived:false,metadataRevision:'revision:session-a:unarchived'}:x)},'catalog:unarchived');await h.React.act(async()=>h.archives[1]!.gate.resolve(fresh));await h.tick(1040);assert.equal(h.refreshes.length,1,'Successful second write cannot overlap an in-flight read');
 await h.React.act(async()=>h.refreshes[0]!.gate.resolve(archivedSnapshot()));await h.tick(260);assert.equal(h.refreshes.length,2);await h.React.act(async()=>h.refreshes[1]!.gate.resolve(fresh));await h.tick(1040);assert.equal(h.refreshes.length,2);assert.equal(archived(h),false);assert.equal(h.archives.length,2);
});
test('unmount retires a pending archive before its successful response',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.unmount();await h.React.act(async()=>h.archives[0]!.gate.resolve(archivedSnapshot()));await h.tick(1040);assert.equal(h.refreshes.length,0);
});
test('project removal retires its pending archive rather than recreating project catalog',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.removeEntry('a');await h.resolveRemoval(0);assert.ok(!h.projectIds().includes('Project a 项目操作'));await finishArchive(h,0,archivedSnapshot());assert.equal(h.refreshes.length,0);assert.ok(!h.projectIds().includes('Project a 项目操作'));
});
test('stable successful archive performs one catalog read and self-publication stays idle',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.React.act(async()=>h.archives[0]!.gate.resolve(archivedSnapshot()));await h.tick(260);assert.equal(h.refreshes.length,1);await h.React.act(async()=>h.refreshes[0]!.gate.resolve(archivedSnapshot()));await h.tick(2600);assert.equal(h.refreshes.length,1);assert.equal(archived(h),true);
});
test('deletion success retires archive started after deletion confirmation',async t=>{
 const h=await fixture(t);await h.sessionMenu('second-a','删除');await h.sessionMenu('session-a','归档');await h.React.act(async()=>h.deletions[0]!.gate.resolve({cancelled:false,deleted:h.deletions[0]!.targets,failures:[]}));const fresh=archivedSnapshot();fresh.sessions=fresh.sessions.filter(x=>x.id!=='second-a');await finishArchive(h,0,archivedSnapshot(),withPage(fresh,'catalog:deleted'),()=>assert.equal(h.hasSession('second-a'),false));await h.React.act(async()=>h.refreshes[0]!.gate.resolve(withPage(fresh,'catalog:deleted')));assert.equal(archived(h),true);
});
test('bootstrap retaining an empty project keeps its completed archive reconciliation live',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');const empty=withPage({...workspace('a'),sessions:[]},'catalog:empty');h.api.bootstrap=async()=>({...bootstrapFor(['a','b','c']),sidebarSessions:[...workspace('b').sessions,...workspace('c').sessions],workspace:empty});await h.emit('onApplicationImportsChanged',undefined as never);assert.equal(h.hasSession('session-a'),false);
 await h.React.act(async()=>h.archives[0]!.gate.resolve(archivedSnapshot()));await h.tick(260);assert.equal(h.refreshes.length,1,'Still-listed empty project retains operation lifetime');await h.React.act(async()=>h.refreshes[0]!.gate.resolve(empty));await h.tick(1040);assert.equal(h.hasSession('session-a'),false);assert.equal(h.refreshes.length,1);
});
test('removed and re-added same project ID does not inherit old archive work',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.removeEntry('a');await h.resolveRemoval(0);h.api.bootstrap=async()=>bootstrapFor(['a','b','c']);await h.emit('onApplicationImportsChanged',undefined as never);assert.equal(archived(h),false);await finishArchive(h,0,archivedSnapshot());assert.equal(h.refreshes.length,0);assert.equal(archived(h),false);
});
test('obsolete catalog-read rejection serves newer demand without surfacing stale error',async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.React.act(async()=>h.archives[0]!.gate.resolve(archivedSnapshot()));await h.tick(260);assert.equal(h.refreshes.length,1);const fresh=archivedSnapshot();fresh.sessions=fresh.sessions.map(x=>x.id==='second-a'?{...x,pinned:true}:x);const current=withPage(fresh,'catalog:pinned');await acceptCurrentCatalog(h,current);await h.React.act(async()=>h.refreshes[0]!.gate.reject(new Error('Obsolete read failure')));assert.ok(!h.text().includes('Obsolete read failure'));await h.tick(260);assert.equal(h.refreshes.length,2);await h.React.act(async()=>h.refreshes[1]!.gate.resolve(current));await h.tick(1040);assert.equal(h.refreshes.length,2);assert.equal(archived(h),true);
});
for(const dispatched of [false,true])test(`unmount retires ${dispatched?'running':'scheduled'} catalog reconciliation`,async t=>{
 const h=await fixture(t);await h.sessionMenu('session-a','归档');await h.React.act(async()=>h.archives[0]!.gate.resolve(archivedSnapshot()));if(dispatched){await h.tick(260);assert.equal(h.refreshes.length,1);}await h.unmount();if(dispatched)await h.React.act(async()=>h.refreshes[0]!.gate.resolve(archivedSnapshot()));await h.tick(1040);assert.equal(h.refreshes.length,dispatched?1:0);
});
