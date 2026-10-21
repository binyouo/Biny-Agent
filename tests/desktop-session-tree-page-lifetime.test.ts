import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { after, test, type TestContext } from "node:test";
import { build } from "esbuild";
import ts from "typescript";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { querySessionCatalog, querySessionCatalogItems, refreshSessionIndex, registerSessionBranch, type SessionCatalogItem } from "../src/session/catalog.js";
import { EnvironmentCredentialStore } from "../src/config/credentials.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { SessionRunLedger } from "../src/session/runLedger.js";
import { readSessionCatalogRecord, updateSessionCatalogMetadata } from "../src/session/catalog.js";
import type { LoadedSessionTreePage } from "../src/desktop/renderer/src/app/sessionTreePageLifetime.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";
import type { DesktopAgentEventEnvelope, DesktopBootstrap, DesktopSessionSummary, DesktopSessionTreePage, DesktopSessionTreePageOptions, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const timestamp = "2026-10-05T00:00:00.000Z";
function session(id: string, projectId = "project", parentSessionId?: string): DesktopSessionSummary {
  return { id, projectId, parentSessionId, fileName: `${id}.jsonl`, title: id, firstUserMessage: id,
    lastAssistantMessage: "", eventCount: 1, createdAt: timestamp, updatedAt: timestamp,
    pinned: false, status: "completed", hasChildren: parentSessionId === undefined };
}
function workspace(projectId = "project", sessions = [session("parent", projectId), session("child", projectId, "parent")]): DesktopWorkspaceSnapshot {
  return { project: { id: projectId, path: `/test/${projectId}`, name: projectId, dirty: false, missing: false,
    pinned: false, addedAt: timestamp, lastOpenedAt: timestamp }, sessions,
    sessionPage: { projectId, revision: "catalog", sessions: sessions.filter((entry) => !entry.parentSessionId) },
    permissionMode: "ask", capabilityDefaults: { tools: "auto", skills: "auto" },
    requiresModelConfiguration: false, models: [], pickerModels: [], connections: [] };
}
function bootstrap(snapshot = workspace()): DesktopBootstrap {
  return { version: "test", projects: [snapshot.project], sidebarSessions: snapshot.sessionPage!.sessions,
    workspace: snapshot, activeView: "chat" } as DesktopBootstrap;
}
interface SidebarProps {
  sessions: DesktopSessionSummary[];
  activeProjectId?: string;
  selectedSessionId?: string;
  onSelectSession(projectId: string, sessionId: string): void;
  onDeleteSessions(sessions: DesktopSessionSummary[], confirm: boolean): Promise<import("../src/desktop/protocol.js").DesktopSessionDeleteResult>;
  onLoadSessionChildren(projectId: string, parentSessionId: string, cursor?: string): Promise<LoadedSessionTreePage>;
  onRefreshProject(projectId: string): void;
  onRemoveProject(projectId: string): void;
  onNewTask(projectId: string): void;
  onSessionAction(session: DesktopSessionSummary, action: "delete" | "pin"): void;
}

// Mount the production App, stubbing unrelated views and ancillary hooks. Its IPC callbacks,
// snapshot commit points, event bridge, Sidebar (when requested), and reducers stay production code.
async function appModule() {
  const directory = await mkdtemp(path.resolve(".session-page-test-"));
  const entry = path.resolve("src/desktop/renderer/src/App.tsx");
  const sidebarEntry = path.resolve("src/desktop/renderer/src/components/Sidebar.tsx");
  const imports = new Map<string, string[]>();
  for (const file of [entry, sidebarEntry]) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) imports.set(`${file}:${statement.moduleSpecifier.text}`, bindings.elements.filter((item) => !item.isTypeOnly).map((item) => item.name.text));
    }
  }
  const actual = new Set(["react", "./app/desktopState.js", "./app/desktopApi.js", "./app/sessionTreePageLifetime.js", "./app/useSessionRootPages.js", "./app/useDesktopEventBridge.js", "./navigationHistory.js", "../../../runtime/agentEvents.js"]);
  const implementations: Record<string, string> = {
    ChatResponseContext: "createContext(undefined)", RenderingPreviewContext: "createContext(undefined)", SubagentNavigationContext: "createContext(undefined)",
    AppearanceProvider: "({children}) => children",
    DesktopShell: "({sideNav, children, overlays}) => createElement(\"div\", null, sideNav, children, overlays)",
    Workspace: "({children}) => children",
    Composer: "(props) => { window.__composer = props; return null; }",
    SearchOverlay: "(props) => { window.__search = props; return null; }",
    Sidebar: "(props) => { window.__sidebar = props; return window.__realSidebar ? createElement(RealSidebar, props) : createElement('pre', null, JSON.stringify(props.sessions)); }",
    Tooltip: "({children}) => children", Collapse: "({children, open, ...props}) => open ? createElement('div', props, children) : null",
    useFluidHover: "() => ({registerItem: noop, handlers: {}})",
    useClosingPresence: "(open) => ({present: open, phase: 'open'})", useAppearance: "() => ({})",
    useDesktopAppearance: "() => appearance",
    useSidebarLayout: "() => sidebarLayout",
    useCompactionCommand: "() => compaction",
    useDesktopSettingsActions: "() => ({})",
    useWorkspaceInspector: "() => ({})",
    useSessionTimeline: "() => []",
    collectSessionChanges: "() => []",
    DEFAULT_FILE_PANEL_WIDTH: "320", DEFAULT_SIDEBAR_WIDTH: "240"
  };
  await build({ entryPoints: [entry], outfile: path.join(directory, "app.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", plugins: [{ name: "presentation-fixture", setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => {
      if (args.path === "react" || args.path === "react-dom") return { path: args.path, external: true };
      if (args.path === "production-sidebar") return { path: sidebarEntry };
      const key = `${args.importer}:${args.path}`;
      if ((args.importer === entry && actual.has(args.path)) || (args.importer === sidebarEntry && args.path === "./SessionDeleteButton.js") || !imports.has(key)) return undefined;
      return { path: key, namespace: "fixture" };
    });
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: `
      import { createContext, createElement } from 'react';
      ${args.path === `${entry}:./components/Sidebar.js` ? `import { Sidebar as RealSidebar } from 'production-sidebar';` : ''}
      const noop = () => {};
      const appearance = { snapshot: {}, bootstrap: noop, adopt: noop };
      const sidebarLayout = { layout: {mode: "expanded", contentWidth: 240}, drawerRef: {current: null}, setExpandedWidth: noop, toggle: noop };
      const compaction = { start: noop, fail: noop, run: noop };
      ${imports.get(args.path)!.map((name) => `export const ${name} = ${implementations[name] ?? "() => null"};`).join("\n")}
    `, loader: "js" }));
  } }] });
  const module = await import(pathToFileURL(path.join(directory, "app.mjs")).href) as { App: () => React.JSX.Element };
  return { ...module, dispose: () => rm(directory, { recursive: true, force: true }) };
}
let compiled: Awaited<ReturnType<typeof appModule>> | undefined;
async function fixture(context: TestContext, realSidebar = false, deferBootstrap = false) {
  compiled ??= await appModule();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, Element: dom.window.Element, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const initialBootstrap = deferred<DesktopBootstrap>();
  const opens: Array<{ projectId: string; sessionId: string; result: ReturnType<typeof deferred<import("../src/desktop/protocol.js").DesktopSessionDocument>> }> = [];
  const selections: string[] = [];
  const sends: string[] = [];
  const pages: Array<DesktopSessionTreePageOptions & { projectId: string; parentSessionId: string; result: ReturnType<typeof deferred<DesktopSessionTreePage>> }> = [];
  const snapshots: Array<ReturnType<typeof deferred<DesktopWorkspaceSnapshot>>> = [];
  const mutations: Array<ReturnType<typeof deferred<DesktopWorkspaceSnapshot>>> = [];
  const bootstraps: Array<ReturnType<typeof deferred<DesktopBootstrap>>> = [];
  let subscriber: ((envelope: DesktopAgentEventEnvelope) => void) | undefined;
  Object.assign(dom.window, { requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16), cancelAnimationFrame: clearTimeout, __realSidebar: realSidebar, biny: {
    bootstrap: async () => deferBootstrap ? await initialBootstrap.promise : bootstrap(),
    refreshProject() { const value = deferred<DesktopWorkspaceSnapshot>(); snapshots.push(value); return value.promise; },
    listSessionTreePage(projectId: string, options: DesktopSessionTreePageOptions & { parentSessionId: string }) {
      const result = deferred<DesktopSessionTreePage>(); pages.push({ projectId, ...options, result }); return result.promise;
    },
    deleteSessions(targets: import("../src/desktop/protocol.js").DesktopSessionTarget[], _confirm: boolean, onStarted?: () => void) {
      onStarted?.();
      const value = deferred<DesktopWorkspaceSnapshot>(); mutations.push(value);
      return value.promise.then(() => ({ cancelled: false, deleted: targets, failures: [] }));
    },
    pinSession() { const value = deferred<DesktopWorkspaceSnapshot>(); mutations.push(value); return value.promise; },
    selectProject: async (id: string) => workspace(id), startDraft: async (id: string) => workspace(id),
    removeProject() { const value = deferred<DesktopBootstrap>(); bootstraps.push(value); return value.promise; },
    openSession(projectId: string, sessionId: string) {
      const result = deferred<import("../src/desktop/protocol.js").DesktopSessionDocument>();
      opens.push({ projectId, sessionId, result }); return result.promise;
    },
    commitSelection: async (projectId: string, sessionId?: string) => { selections.push(`${projectId}:${sessionId}`); }, listProjectBranches: async () => [],
    sendPrompt: async (projectId: string, sessionId: string) => { sends.push(`${projectId}:${sessionId}`); throw new Error("unexpected send"); },
    recipeSuggestions: async () => [],
    skillCatalog: async () => ({ skills: [], warnings: [] }), skillSettings: async () => ({ activations: [] }), toolCatalog: async () => [],
    onAgentEvent(listener: typeof subscriber) { subscriber = listener; return () => { subscriber = undefined; }; },
    onReferenceOpen: () => () => {}, onSessionHandoff: () => () => {}, onMenuAction: () => () => {}, onSettingsCloseRequest: () => () => {}, onBrowserOpenRequest: () => () => {}
  } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(() => root.unmount()); mounted = false; } };
  context.after(async () => {
    await unmount(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(createElement(compiled!.App)));
  const props = () => (dom.window as unknown as { __sidebar: SidebarProps }).__sidebar;
  assert.equal(props().activeProjectId, deferBootstrap ? undefined : "project");
  const load = (projectId = "project", parentSessionId = "parent", cursor?: string) => {
    const result = props().onLoadSessionChildren(projectId, parentSessionId, cursor);
    // Attach both branches immediately so rejected stale pages never become unhandled rejections.
    return result.then((page) => ({ page, error: undefined }), (error: unknown) => ({ page: undefined, error }));
  };
  const resolvePage = async (index = 0, rows = [session("child", pages[index]!.projectId, pages[index]!.parentSessionId)], nextCursor?: string) => {
    const request = pages[index]!;
    await act(async () => request.result.resolve({ projectId: request.projectId, parentSessionId: request.parentSessionId, revision: "page-revision", sessions: rows, nextCursor }));
  };
  const refresh = async (snapshot: DesktopWorkspaceSnapshot) => {
    props().onRefreshProject(snapshot.project.id);
    await act(async () => snapshots.at(-1)!.resolve(snapshot));
  };
  return { props, pages, snapshots, mutations, bootstraps, initialBootstrap, load, resolvePage, refresh, unmount, opens, selections, sends, document: dom.window.document,
    composer: () => (dom.window as unknown as { __composer: { onSend(text: string, attachments: []): Promise<void> } }).__composer,
    search: () => (dom.window as unknown as { __search: { onProject(projectId: string): void } }).__search,
    buttons: () => Array.from(dom.window.document.querySelectorAll("button")),
    click: async (button: HTMLButtonElement) => { await act(async () => button.click()); },
    send: async (envelope: DesktopAgentEventEnvelope) => { await act(async () => { subscriber!(envelope); context.mock.timers.tick(16); }); } };
}

test("production App rejects a child page sampled before a successful deletion", async (context) => {
  const view = await fixture(context);
  const pending = view.load();
  view.props().onSessionAction(session("child", "project", "parent"), "delete");
  await act(async () => view.mutations[0]!.resolve(workspace("project", [session("parent")])));
  await view.resolvePage();
  assert.equal(view.props().sessions.some((entry) => entry.id === "child"), false);
  assert.ok((await pending).error instanceof Error);
});

test("complete catalog replacement invalidates deferred next pages, including same-ID recreation", async (context) => {
  const view = await fixture(context);
  const pending = view.load("project", "parent", "opaque-cursor");
  const replacement = { ...session("child", "project", "parent"), title: "Recreated", metadataRevision: "different-hash" };
  await view.refresh(workspace("project", [session("parent")]));
  await view.refresh(workspace("project", [session("parent"), replacement]));
  await view.resolvePage(0, [session("child", "project", "parent")], "old-next-cursor");
  assert.equal(view.props().sessions.some((entry) => entry.title === "child"), false);
  assert.ok((await pending).error instanceof Error);
  const retry = view.load("project", "parent", "opaque-cursor");
  await view.resolvePage(1, [replacement], "fresh-next-cursor");
  assert.equal((await retry).page?.nextCursor, "fresh-next-cursor");
  assert.equal(view.props().sessions.find((entry) => entry.id === "child")?.title, "Recreated");
});

test("sibling pages, other-project snapshots, and live runtime events keep child pages useful", async (context) => {
  const view = await fixture(context);
  const first = view.load();
  const sibling = view.load("project", "other-parent");
  await view.refresh(workspace("other-project"));
  await view.send({ projectId: "project", event: { type: "message.user", sessionId: "parent", runId: "run", messageId: "message", timestamp, content: "New input" } } as DesktopAgentEventEnvelope);
  await view.resolvePage(1, [session("other-child", "project", "other-parent")], "sibling-next");
  await view.resolvePage(0, [session("child", "project", "parent")], "first-next");
  assert.equal((await first).page?.nextCursor, "first-next");
  assert.equal((await sibling).page?.nextCursor, "sibling-next");
  assert.ok(view.props().sessions.some((entry) => entry.id === "child"));
  assert.ok(view.props().sessions.some((entry) => entry.id === "other-child"));
  assert.equal(view.props().sessions.find((entry) => entry.id === "parent")?.status, "running");
});

test("failed refresh and failed mutation do not invalidate a pending page", async (context) => {
  const view = await fixture(context);
  const pending = view.load();
  view.props().onRefreshProject("project");
  view.props().onSessionAction(session("parent"), "pin");
  await act(async () => {
    view.snapshots[0]!.reject(new Error("refresh failed"));
    view.mutations[0]!.reject(new Error("mutation failed"));
  });
  await view.resolvePage(0, undefined, "next");
  assert.equal((await pending).page?.nextCursor, "next");
});

test("rebootstrap rejects old child page completions", async (context) => {
  const view = await fixture(context);
  const pending = view.load();
  view.props().onRemoveProject("project");
  await act(async () => view.bootstraps[0]!.resolve(bootstrap(workspace("other-project"))));
  await view.resolvePage();
  assert.ok((await pending).error instanceof Error);
  assert.equal(view.props().sessions.some((entry) => entry.projectId === "project"), false);
});

test("initial bootstrap replacement rejects an earlier child page", async (context) => {
  const view = await fixture(context, false, true);
  const pending = view.load();
  await act(async () => view.initialBootstrap.resolve(bootstrap(workspace("project", [session("parent")]))));
  await view.resolvePage();
  assert.equal(view.props().sessions.some((entry) => entry.id === "child"), false);
  assert.ok((await pending).error instanceof Error);
});

test("failed rebootstrap leaves the current page lifetime intact", async (context) => {
  const view = await fixture(context);
  const pending = view.load();
  view.props().onRemoveProject("other-project");
  await act(async () => view.bootstraps[0]!.reject(new Error("remove failed")));
  await view.resolvePage();
  assert.ok((await pending).page);
});

test("unmount alone rejects an outstanding page", async (context) => {
  const view = await fixture(context);
  const pending = view.load();
  await view.unmount();
  await view.resolvePage();
  assert.ok((await pending).error instanceof Error);
});

test("switching the active project keeps an unrelated project's pending child page", async (context) => {
  const view = await fixture(context);
  const pending = view.load();
  await act(async () => view.props().onNewTask("other-project"));
  assert.equal(view.props().activeProjectId, "other-project");
  await view.resolvePage();
  assert.ok((await pending).page);
  assert.ok(view.props().sessions.some((entry) => entry.projectId === "project" && entry.id === "child"));
});

test("real Sidebar retries stale first and next pages without stuck loading or obsolete cursors", async (context) => {
  const view = await fixture(context, true);
  const toggle = () => view.buttons().find((button) => button.classList.contains("biny-sidebar-session-toggle") && !button.classList.contains("is-empty"))!;
  await view.click(toggle());
  assert.equal(view.pages.length, 1);
  await view.refresh(workspace());
  await view.resolvePage(0, undefined, "obsolete-first-next");
  assert.equal(toggle().disabled, false, "stale rejection must release Sidebar's loading flag");
  await view.click(toggle()); // collapse
  await view.click(toggle()); // re-expand; stale first page was not marked loaded
  assert.equal(view.pages.length, 2);
  await view.resolvePage(1, undefined, "kept-next");
  const more = () => view.buttons().find((button) => button.textContent === "显示更多")!;
  await view.click(more());
  assert.equal(view.pages[2]!.cursor, "kept-next");
  await view.refresh(workspace());
  await view.refresh(workspace()); // repeated unrelated complete refreshes are safe too
  await view.resolvePage(2, [session("stale-child", "project", "parent")], "obsolete-next");
  assert.equal(toggle().disabled, false);
  assert.equal(view.props().sessions.some((entry) => entry.id === "stale-child"), false);
  await view.click(more());
  assert.equal(view.pages[3]!.cursor, "kept-next", "a rejected next page must not replace the previous valid cursor");
  await view.resolvePage(3, [session("fresh-child", "project", "parent")]);
  assert.ok(view.props().sessions.some((entry) => entry.id === "fresh-child"));
  assert.equal(more(), undefined);
});

function catalog(count: number): SessionCatalogItem[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `child-${String(999 - index).padStart(3, "0")}`;
    return { id, fileName: `${id}.jsonl`, summary: session(id, "project", "parent"),
      rootSessionId: "parent", parentSessionId: "parent", hasChildren: false };
  });
}
function catalogSessions(items: SessionCatalogItem[]): DesktopSessionSummary[] {
  return items.map((item) => ({ ...session(item.id, "project", "parent"), title: item.title ?? item.id, hasChildren: item.hasChildren }));
}
function catalogPage(view: Awaited<ReturnType<typeof fixture>>, index: number, items: SessionCatalogItem[]): DesktopSessionTreePage {
  const request = view.pages[index]!;
  const page = querySessionCatalogItems(items, { parentSessionId: request.parentSessionId, cursor: request.cursor, limit: 32 });
  return { projectId: request.projectId, parentSessionId: request.parentSessionId, revision: page.revision,
    revisionChanged: page.revisionChanged, sessions: catalogSessions(page.items), nextCursor: page.nextCursor };
}
async function resolveCatalogPage(view: Awaited<ReturnType<typeof fixture>>, index: number, items: SessionCatalogItem[]) {
  const page = catalogPage(view, index, items);
  await act(async () => view.pages[index]!.result.resolve(page));
  return page;
}
function treeButtons(view: Awaited<ReturnType<typeof fixture>>) {
  return {
    toggle: () => view.buttons().find((button) => button.classList.contains("biny-sidebar-session-toggle") && !button.classList.contains("is-empty"))!,
    more: () => view.buttons().find((button) => button.textContent === "显示更多" && button.closest(".biny-sidebar-session-children"))!
  };
}

test("production cursor recovery reloads page one and reaches child 33 after a held last page is invalidated", async (context) => {
  const view = await fixture(context, true);
  const buttons = treeButtons(view);
  const old = catalog(33);
  await view.click(buttons.toggle());
  await resolveCatalogPage(view, 0, old);
  await view.click(buttons.more());
  const held = catalogPage(view, 1, old);
  assert.equal(held.sessions.length, 1);
  const renamed = [{ ...old[0]!, title: "Renamed first child" }, ...old.slice(1)];
  await view.refresh(workspace("project", [session("parent"), ...catalogSessions(renamed)]));
  await act(async () => view.pages[1]!.result.resolve(held));
  assert.equal(view.props().sessions.some((row) => row.id === old[32]!.id), false);
  await view.click(buttons.more());
  assert.equal((await resolveCatalogPage(view, 2, renamed)).revisionChanged, true);
  assert.equal(view.pages.length, 4, "revisionChanged must start a fresh first-page request");
  assert.equal(view.pages[3]!.cursor, undefined);
  await resolveCatalogPage(view, 3, renamed);
  assert.equal(view.props().sessions.length, 33, "reloading page one must not duplicate the first 32 children");
  await view.click(buttons.more());
  assert.equal((await resolveCatalogPage(view, 4, renamed)).revisionChanged, false);
  await view.click(buttons.toggle());
  await view.click(buttons.toggle());
  assert.ok(view.props().sessions.some((row) => row.id === old[32]!.id));
  assert.equal(view.props().sessions.length, 34);
  assert.equal(buttons.more(), undefined);
});

test("production cursors survive repeated metadata changes and finish 65 children without duplicates", async (context) => {
  const view = await fixture(context, true);
  const buttons = treeButtons(view);
  let items = catalog(65);
  await view.click(buttons.toggle());
  await resolveCatalogPage(view, 0, items);
  for (let rename = 0; rename < 2; rename += 1) {
    items = [{ ...items[0]!, title: `Rename ${String(rename)}` }, ...items.slice(1)];
    await view.refresh(workspace("project", [session("parent"), ...catalogSessions(items)]));
    await view.click(buttons.more());
    const staleIndex = view.pages.length - 1;
    assert.equal((await resolveCatalogPage(view, staleIndex, items)).revisionChanged, true);
    assert.equal(view.pages.length, staleIndex + 2);
    assert.equal(view.pages.at(-1)!.cursor, undefined);
    await resolveCatalogPage(view, staleIndex + 1, items);
  }
  await view.click(buttons.more());
  await resolveCatalogPage(view, view.pages.length - 1, items);
  await view.click(buttons.more());
  await resolveCatalogPage(view, view.pages.length - 1, items);
  assert.equal(view.props().sessions.length, 66);
  assert.equal(new Set(view.props().sessions.map((row) => row.id)).size, 66);
  assert.equal(buttons.more(), undefined);
});

test("a failed first-page reset leaves the real Sidebar retryable", async (context) => {
  const view = await fixture(context, true);
  const buttons = treeButtons(view);
  const old = catalog(33);
  await view.click(buttons.toggle());
  await resolveCatalogPage(view, 0, old);
  const renamed = [{ ...old[0]!, title: "Renamed" }, ...old.slice(1)];
  await view.refresh(workspace("project", [session("parent"), ...catalogSessions(renamed)]));
  await view.click(buttons.more());
  await resolveCatalogPage(view, 1, renamed);
  assert.equal(view.pages.length, 3);
  assert.equal(view.pages[2]!.cursor, undefined);
  await act(async () => view.pages[2]!.result.reject(new Error("reset failed")));
  assert.equal(buttons.toggle().disabled, false);
  assert.ok(buttons.more());
  await view.click(buttons.more());
  await resolveCatalogPage(view, 3, renamed);
  assert.equal(view.pages[4]!.cursor, undefined);
  await resolveCatalogPage(view, 4, renamed);
  await view.click(buttons.more());
  await resolveCatalogPage(view, 5, renamed);
  assert.equal(view.props().sessions.length, 34);
});

test("catalog replacement and unmount during the reset cannot commit its stale first page", async (context) => {
  const view = await fixture(context);
  const old = catalog(33);
  const oldCursor = querySessionCatalogItems(old, { parentSessionId: "parent", limit: 32 }).nextCursor!;
  const renamed = [{ ...old[0]!, title: "Renamed" }, ...old.slice(1)];
  const pending = view.load("project", "parent", oldCursor);
  await resolveCatalogPage(view, 0, renamed);
  assert.equal(view.pages.length, 2);
  assert.equal(view.pages[1]!.cursor, undefined);
  await view.refresh(workspace("project", [session("parent")]));
  await resolveCatalogPage(view, 1, renamed);
  assert.ok((await pending).error instanceof Error);
  assert.equal(view.props().sessions.length, 1);
  const next = view.load("project", "parent", oldCursor);
  await resolveCatalogPage(view, 2, renamed);
  assert.equal(view.pages.length, 4);
  await view.unmount();
  await resolveCatalogPage(view, 3, renamed);
  assert.ok((await next).error instanceof Error);
});

test("reset prunes deleted children and nested grandchildren and releases their Sidebar loaded state", async (context) => {
  const view = await fixture(context, true);
  const buttons = treeButtons(view);
  const old = catalog(33);
  old[0]!.hasChildren = true;
  await view.click(buttons.toggle());
  await resolveCatalogPage(view, 0, old);
  const childToggle = () => view.buttons().find((button) => button.classList.contains("biny-sidebar-session-toggle")
    && button.closest(".biny-sidebar-session-tree-row")?.textContent?.includes(old[0]!.id))!;
  await view.click(childToggle());
  await view.resolvePage(1, [session("grandchild", "project", old[0]!.id)]);
  assert.ok(view.props().sessions.some((row) => row.id === "grandchild"));
  // The catalog changed outside the App: one old child disappeared, while a retained
  // child was renamed. There is no intervening complete snapshot to do the pruning.
  const changed = [{ ...old[0]!, title: "Renamed retained child" }, ...old.slice(2)];
  await view.click(buttons.more());
  await resolveCatalogPage(view, 2, changed);
  assert.equal(view.pages.length, 4);
  await resolveCatalogPage(view, 3, changed);
  assert.equal(view.props().sessions.some((row) => row.id === old[1]!.id || row.id === "grandchild"), false);
  const renamedToggle = view.buttons().find((button) => button.classList.contains("biny-sidebar-session-toggle")
    && button.closest(".biny-sidebar-session-tree-row")?.textContent?.includes("Renamed retained child"))!;
  assert.equal(renamedToggle.getAttribute("aria-expanded"), "false");
  await view.click(renamedToggle);
  assert.equal(view.pages.length, 5, "the retained child's discarded subtree must reload when re-expanded");
  await view.resolvePage(4, [session("fresh-grandchild", "project", old[0]!.id)]);
  assert.ok(view.props().sessions.some((row) => row.id === "fresh-grandchild"));
});

test("reset invalidates in-flight descendant pages but preserves sibling pages and rows", async (context) => {
  const view = await fixture(context);
  const old = catalog(33);
  const initial = view.load();
  await resolveCatalogPage(view, 0, old);
  const cursor = (await initial).page!.nextCursor!;
  const changed = [{ ...old[0]!, title: "Renamed" }, ...old.slice(1)];
  const reset = view.load("project", "parent", cursor);
  await resolveCatalogPage(view, 1, changed);
  assert.equal(view.pages.length, 3);
  const nested = view.load("project", old[0]!.id);
  const sibling = view.load("project", "sibling-parent");
  await view.resolvePage(4, [session("sibling-child", "project", "sibling-parent")], "sibling-next");
  assert.equal((await sibling).page?.nextCursor, "sibling-next");
  await resolveCatalogPage(view, 2, changed);
  assert.ok((await reset).page);
  await view.resolvePage(3, [session("stale-grandchild", "project", old[0]!.id)]);
  assert.ok((await nested).error instanceof Error);
  assert.equal(view.props().sessions.some((row) => row.id === "stale-grandchild"), false);
  assert.ok(view.props().sessions.some((row) => row.id === "sibling-child"));
});

test("a second revisionChanged response rejects deterministically without a retry loop", async (context) => {
  const view = await fixture(context);
  const old = catalog(33);
  const cursor = querySessionCatalogItems(old, { parentSessionId: "parent", limit: 32 }).nextCursor!;
  const changed = [{ ...old[0]!, title: "Renamed" }, ...old.slice(1)];
  const pending = view.load("project", "parent", cursor);
  const invalid = await resolveCatalogPage(view, 0, changed);
  assert.equal(view.pages.length, 2);
  await act(async () => view.pages[1]!.result.resolve(invalid));
  assert.ok((await pending).error instanceof Error);
  assert.equal(view.pages.length, 2);
  assert.equal(view.props().sessions.length, 1);
});

test("an obsolete revisionChanged response cannot start a reset request", async (context) => {
  const view = await fixture(context);
  const old = catalog(33);
  const cursor = querySessionCatalogItems(old, { parentSessionId: "parent", limit: 32 }).nextCursor!;
  const changed = [{ ...old[0]!, title: "Renamed" }, ...old.slice(1)];
  const pending = view.load("project", "parent", cursor);
  await view.refresh(workspace());
  await resolveCatalogPage(view, 0, changed);
  assert.ok((await pending).error instanceof Error);
  assert.equal(view.pages.length, 1);
});

test("a reset releases a pending nested Sidebar request without letting its late cleanup unlock a newer one", async (context) => {
  const view = await fixture(context, true);
  const buttons = treeButtons(view);
  const old = catalog(33);
  old[0]!.hasChildren = true;
  await view.click(buttons.toggle());
  await resolveCatalogPage(view, 0, old);
  const childToggle = () => view.buttons().find((button) => button.classList.contains("biny-sidebar-session-toggle")
    && button.closest(".biny-sidebar-session-tree-row")?.textContent?.includes(old[0]!.id))!;
  await view.click(childToggle());
  assert.equal(childToggle().disabled, true);
  const changed = [{ ...old[0]!, title: old[0]!.id + " renamed" }, ...old.slice(1)];
  await view.click(buttons.more());
  await resolveCatalogPage(view, 2, changed);
  assert.equal(view.pages.length, 4);
  await resolveCatalogPage(view, 3, changed);
  assert.equal(childToggle().disabled, false);
  assert.equal(childToggle().getAttribute("aria-expanded"), "false");
  await view.click(childToggle());
  assert.equal(view.pages.length, 5);
  assert.equal(childToggle().disabled, true);
  await view.resolvePage(1, [session("old-grandchild", "project", old[0]!.id)]);
  assert.equal(childToggle().disabled, true, "old finally must not clear the newer request's loading flag");
  await view.resolvePage(4, [session("new-grandchild", "project", old[0]!.id)]);
  assert.equal(childToggle().disabled, false);
  assert.equal(view.props().sessions.some((row) => row.id === "old-grandchild"), false);
  assert.ok(view.props().sessions.some((row) => row.id === "new-grandchild"));
});

test("persisted descendant changes make the production Sidebar reset and expose grandchildren", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-descendant-revision-"));
  const root = await realpath(temporary);
  const view = await fixture(context, true);
  try {
    await ensureAgentDirs(root);
    const create = async (id: string, parentSessionId?: string) => {
      await createSessionFile(root, id, Buffer.from(`${JSON.stringify({ type: "user_message", content: id, time: timestamp })}\n`));
      if (parentSessionId !== undefined) {
        await registerSessionBranch(root, { sessionId: id, parentSessionId, branchPoint: { kind: "event", index: 1 } });
      }
    };
    const resolvePersistedPage = async (index: number) => {
      const request = view.pages[index]!;
      const page = await querySessionCatalog(root, { parentSessionId: request.parentSessionId, cursor: request.cursor, limit: 32 });
      const sessions = page.items.map((item) => ({ ...session(item.id, request.projectId, item.parentSessionId), hasChildren: item.hasChildren }));
      await act(async () => request.result.resolve({ projectId: request.projectId, parentSessionId: request.parentSessionId,
        revision: page.revision, revisionChanged: page.revisionChanged, sessions, nextCursor: page.nextCursor }));
      return page;
    };
    await create("parent");
    for (const item of catalog(33)) await create(item.id, "parent");
    const buttons = treeButtons(view);
    const firstChild = catalog(33)[0]!.id;
    const childToggle = () => view.buttons().find((button) => button.classList.contains("biny-sidebar-session-toggle")
      && button.closest(".biny-sidebar-session-tree-row")?.textContent?.includes(firstChild))!;
    await view.click(buttons.toggle());
    await resolvePersistedPage(0);
    assert.ok(childToggle().classList.contains("is-empty"));
    await create("grandchild", firstChild);
    // No complete workspace refresh intervenes: the cursor response itself must reset the stale child page.
    await view.click(buttons.more());
    assert.equal((await resolvePersistedPage(1)).revisionChanged, true);
    assert.equal(view.pages.length, 3);
    assert.equal(view.pages[2]!.cursor, undefined);
    await resolvePersistedPage(2);
    assert.equal(childToggle().classList.contains("is-empty"), false);
    assert.equal(view.props().sessions.length, 33, "the first-page reset replaces its 32 children without duplicates");
    await view.click(childToggle());
    assert.equal(view.pages[3]!.parentSessionId, firstChild);
    await resolvePersistedPage(3);
    assert.ok(view.props().sessions.some((row) => row.id === "grandchild"));
    await view.click(buttons.more());
    assert.equal((await resolvePersistedPage(4)).revisionChanged, false);
    assert.ok(view.props().sessions.some((row) => row.id === catalog(33)[32]!.id));
    assert.equal(new Set(view.props().sessions.map((row) => row.id)).size, 35);
    assert.equal(buttons.more(), undefined);
  } finally {
    await refreshSessionIndex(root);
    await rm(temporary, { recursive: true, force: true });
  }
});

// The compiled module is only a test artifact and lives under this checkout.
after(async () => { await compiled?.dispose(); });

// The public App callback consumes production Desktop pages from real isolated catalog files.
// Synthetic page-only fixtures cannot cover authoritative pins outside the reloaded first page.
async function persistedPinResetFixture(context: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-child-pin-reset-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const configStore = createFileConfigStore(root, {
    globalDir: path.join(root, "config"), credentialStore: new EnvironmentCredentialStore()
  });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await state.load();
  await storage.initialize();
  const service = new DesktopProjectService(state, storage, configStore);
  const project = { ...workspace().project, path: root };
  context.after(async () => {
    await refreshSessionIndex(root);
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const view = await fixture(context);
  const create = async (id: string, minute: number, parentSessionId?: string) => {
    const file = await createSessionFile(root, id, Buffer.from(`${JSON.stringify({
      type: "user_message", content: id, time: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString()
    })}\n`));
    if (parentSessionId !== undefined) {
      await registerSessionBranch(root, { sessionId: id, parentSessionId, branchPoint: { kind: "event", index: 1 } });
    }
    return file;
  };
  await ensureAgentDirs(root);
  await create("parent", -1);
  for (let index = 0; index < 65; index += 1) await create(`child-${String(index).padStart(2, "0")}`, index, "parent");
  await updateSessionCatalogMetadata(root, "child-20", { pinned: true });
  const storedPage = async (index: number) => {
    const request = view.pages[index]!;
    return await service.listSessionTreePage(project, undefined, new Map(), {
      parentSessionId: request.parentSessionId, cursor: request.cursor, limit: 32, includeArchived: true,
      includePinnedSessions: request.includePinnedSessions
    });
  };
  const resolveStored = async (index: number) => {
    const page = await storedPage(index);
    await act(async () => view.pages[index]!.result.resolve(page));
    return page;
  };
  const initial = view.load();
  const first = await resolveStored(0); await initial;
  assert.equal(first.pinnedSessions, undefined, "ordinary pages do not project unrelated pins");
  const continuation = view.load("project", "parent", first.nextCursor);
  const second = await resolveStored(1); await continuation;
  assert.equal(second.pinnedSessions, undefined);
  assert.equal(view.props().sessions.find((row) => row.id === "child-20")?.pinned, true);
  assert.ok(second.nextCursor);
  return { root, view, create, storedPage, resolveStored, second };
}

test("persisted child pin survives cursor reset outside the fresh page with current metadata", async (context) => {
  const { root, view, resolveStored, second } = await persistedPinResetFixture(context);
  await updateSessionCatalogMetadata(root, "child-20", { title: "Updated pinned child", archived: true });
  const ledger = new SessionRunLedger(root);
  await ledger.start({ runId: "hidden-run", sessionId: "child-00", pid: 2_147_483_647 });
  const hiddenRun = await ledger.read("hidden-run");
  const restart = view.load("project", "parent", second.nextCursor);
  const invalid = await resolveStored(2);
  assert.equal(invalid.revisionChanged, true);
  assert.equal(invalid.pinnedSessions, undefined);
  assert.equal(view.pages[3]?.includePinnedSessions, true);
  const fresh = await resolveStored(3);
  const result = await restart;
  assert.equal(fresh.sessions.length, 32);
  assert.deepEqual(await ledger.read("hidden-run"), hiddenRun, "reset pin projection must not reconcile hidden runs");
  assert.equal(fresh.sessions.some((row) => row.id === "child-20"), false);
  assert.ok(result.page?.resetSessionIds?.includes("child-20"), "pinned shortcuts still discard old child expansion state");
  const pinned = view.props().sessions.find((row) => row.id === "child-20");
  assert.equal(pinned?.pinned, true, "cursor reset must preserve the persisted pin beyond its new first page");
  assert.ok(pinned);
  assert.equal(pinned.title, "Updated pinned child");
  assert.equal(pinned.archived, true);
  assert.equal((await readSessionCatalogRecord(root, "child-20"))?.pinned, true);
  assert.equal(view.props().sessions.length, 34, "unrelated stale descendants must be discarded");
  const next = view.load("project", "parent", result.page?.nextCursor);
  await resolveStored(4); await next;
  assert.equal(view.props().sessions.filter((row) => row.id === "child-20").length, 1);
});

// Previously loaded true flags are not authority after an external catalog mutation.
for (const mutation of ["unpin", "delete"] as const) {
  test(`persisted child pin is not resurrected by reset after external ${mutation}`, async (context) => {
    const { root, view, resolveStored, second } = await persistedPinResetFixture(context);
    if (mutation === "unpin") await updateSessionCatalogMetadata(root, "child-20", { pinned: false });
    else await deleteSessionArtifacts(root, "child-20");
    const restart = view.load("project", "parent", second.nextCursor);
    assert.equal((await resolveStored(2)).revisionChanged, true);
    await resolveStored(3); await restart;
    assert.equal(view.props().sessions.some((row) => row.id === "child-20"), false);
    assert.equal((await readSessionCatalogRecord(root, "child-20"))?.pinned, mutation === "unpin" ? false : undefined);
  });
}

test("persisted child pin stays tracked through repeated resets before external unpin", async (context) => {
  const { root, view, resolveStored, second } = await persistedPinResetFixture(context);
  await updateSessionCatalogMetadata(root, "child-64", { title: "First change" });
  const restart = view.load("project", "parent", second.nextCursor);
  await resolveStored(2); await resolveStored(3);
  const fresh = (await restart).page!;
  assert.equal(view.props().sessions.find((row) => row.id === "child-20")?.pinned, true);
  await updateSessionCatalogMetadata(root, "child-20", { pinned: false });
  const repeated = view.load("project", "parent", fresh.nextCursor);
  await resolveStored(4); await resolveStored(5);
  const result = await repeated;
  assert.ok(result.page?.resetSessionIds?.includes("child-20"));
  assert.equal(view.props().sessions.some((row) => row.id === "child-20"), false);
});

test("persisted nested pins survive reset while discarded descendants and their pending pages are invalidated", async (context) => {
  const { root, view, create, resolveStored, second } = await persistedPinResetFixture(context);
  await create("pinned-grandchild", 70, "child-20");
  await create("discarded-grandchild", 71, "child-20");
  await updateSessionCatalogMetadata(root, "pinned-grandchild", { pinned: true });
  const children = view.load("project", "child-20");
  await resolveStored(2); await children;
  const held = view.load("project", "pinned-grandchild");
  const restart = view.load("project", "parent", second.nextCursor);
  await resolveStored(4); await resolveStored(5);
  const result = await restart;
  assert.ok(result.page?.resetSessionIds?.includes("pinned-grandchild"));
  assert.ok(result.page?.resetSessionIds?.includes("discarded-grandchild"));
  assert.equal(view.props().sessions.find((row) => row.id === "pinned-grandchild")?.pinned, true);
  assert.equal(view.props().sessions.some((row) => row.id === "discarded-grandchild"), false);
  await view.resolvePage(3, [session("obsolete-nested", "project", "pinned-grandchild")]);
  assert.ok((await held).error instanceof Error);
  assert.equal(view.props().sessions.some((row) => row.id === "obsolete-nested"), false);
});

for (const invalidation of ["refresh", "unmount"] as const) {
  test(`persisted child pin response cannot commit after ${invalidation} invalidates the reset`, async (context) => {
    const { root, view, storedPage, resolveStored, second } = await persistedPinResetFixture(context);
    await updateSessionCatalogMetadata(root, "child-64", { title: "Trigger reset" });
    const restart = view.load("project", "parent", second.nextCursor);
    await resolveStored(2);
    const held = await storedPage(3);
    assert.equal(held.pinnedSessions?.find((row) => row.id === "child-20")?.pinned, true);
    await updateSessionCatalogMetadata(root, "child-20", { pinned: false });
    if (invalidation === "refresh") await view.refresh(workspace("project", [session("parent")]));
    else await view.unmount();
    await act(async () => view.pages[3]!.result.resolve(held));
    assert.ok((await restart).error instanceof Error);
    if (invalidation === "refresh") assert.equal(view.props().sessions.some((row) => row.id === "child-20"), false);
  });
}

test("persisted child pin reset leaves unrelated branch metadata and same-ID other-project pins intact", async (context) => {
  const { root, view, create, storedPage, resolveStored, second } = await persistedPinResetFixture(context);
  await create("sibling-parent", 70);
  await create("sibling-pin", 71, "sibling-parent");
  await updateSessionCatalogMetadata(root, "sibling-pin", { pinned: true, title: "Old sibling title" });
  const sibling = view.load("project", "sibling-parent");
  await resolveStored(2); await sibling;
  const other = { ...session("child-20", "other-project"), title: "Other project", pinned: true };
  await view.refresh(workspace("other-project", [other]));
  await updateSessionCatalogMetadata(root, "child-64", { title: "Trigger reset" });
  const restart = view.load("project", "parent", second.nextCursor);
  await resolveStored(3);
  const held = await storedPage(4);
  await updateSessionCatalogMetadata(root, "sibling-pin", { pinned: false, title: "Current sibling title" });
  const newerSibling = view.load("project", "sibling-parent");
  await resolveStored(5); await newerSibling;
  await act(async () => view.pages[4]!.result.resolve(held));
  await restart;
  assert.equal(view.props().sessions.find((row) => row.id === "sibling-pin")?.pinned, false);
  assert.equal(view.props().sessions.find((row) => row.id === "sibling-pin")?.title, "Current sibling title");
  assert.strictEqual(view.props().sessions.find((row) => row.projectId === "other-project" && row.id === "child-20"), other);
  assert.equal(view.props().sessions.find((row) => row.projectId === "project" && row.id === "child-20")?.pinned, true);
});

test("persisted child pin reset failure preserves loaded rows and allows a fresh retry", async (context) => {
  const { root, view, resolveStored, second } = await persistedPinResetFixture(context);
  await updateSessionCatalogMetadata(root, "child-64", { title: "Trigger reset" });
  const before = view.props().sessions;
  const restart = view.load("project", "parent", second.nextCursor);
  await resolveStored(2);
  await act(async () => view.pages[3]!.result.reject(new Error("catalog read failed")));
  assert.ok((await restart).error instanceof Error);
  assert.strictEqual(view.props().sessions, before, "failed reset must not partially publish or discard summaries");
  const retry = view.load("project", "parent", second.nextCursor);
  await resolveStored(4); await resolveStored(5);
  assert.ok((await retry).page);
  assert.equal(view.props().sessions.find((row) => row.id === "child-20")?.pinned, true);
});

// A nested pin still belongs to the reset subtree when its unpinned intermediate row ages out.
test("persisted nested pin keeps reset ownership after its intermediate parent is discarded", async (context) => {
  const { root, view, create, resolveStored, second } = await persistedPinResetFixture(context);
  await updateSessionCatalogMetadata(root, "child-20", { pinned: false });
  await create("nested-pin", 70, "child-20");
  await updateSessionCatalogMetadata(root, "nested-pin", { pinned: true });
  const nested = view.load("project", "child-20");
  await resolveStored(2); await nested;
  const restart = view.load("project", "parent", second.nextCursor);
  await resolveStored(3); await resolveStored(4);
  const fresh = (await restart).page!;
  assert.equal(view.props().sessions.some((row) => row.id === "child-20"), false);
  assert.equal(view.props().sessions.find((row) => row.id === "nested-pin")?.pinned, true);
  await updateSessionCatalogMetadata(root, "nested-pin", { pinned: false });
  await updateSessionCatalogMetadata(root, "child-64", { title: "Second reset" });
  const repeated = view.load("project", "parent", fresh.nextCursor);
  await resolveStored(5); await resolveStored(6);
  const result = await repeated;
  assert.ok(result.page?.resetSessionIds?.includes("nested-pin"), "off-page ancestor removal must not detach a restored pin from reset ownership");
  assert.equal(view.props().sessions.some((row) => row.id === "nested-pin"), false);
});

// Existing tree tests do not cover clicking the still-visible session while another project loads.
test("pending cross-project navigation can be superseded by selecting the original session", async (context) => {
  const view = await fixture(context);
  const select = async (projectId: string, sessionId: string) => {
    await act(async () => view.props().onSelectSession(projectId, sessionId));
  };
  const finish = async (index: number) => {
    const call = view.opens[index]!;
    await act(async () => call.result.resolve({ session: session(call.sessionId, call.projectId), events: [], liveEvents: [] }));
  };
  await select("project", "parent"); await finish(0);
  await select("other", "remote");
  await select("project", "parent");
  for (let index = 2; index < view.opens.length; index++) await finish(index);
  await finish(1);
  assert.equal(view.props().activeProjectId, "project", "late reads cannot undo the last selection");
  assert.equal(view.props().selectedSessionId, "parent");
  assert.equal(view.selections.at(-1), "project:parent");
});

// Checking only stale successful responses misses a failed newest navigation restoring an unfinished predecessor.
test("rapid navigation highlights the newest project and a failed read preserves the last loaded session", async (context) => {
  const view = await fixture(context);
  await act(async () => view.props().onSelectSession("project", "parent"));
  await act(async () => view.opens[0]!.result.resolve({ session: session("parent"), events: [], liveEvents: [] }));
  await act(async () => view.props().onSelectSession("project", "child"));
  await act(async () => view.props().onSelectSession("other", "remote"));
  assert.equal(view.props().activeProjectId, "other", "pending project selection must update immediately");
  assert.equal(view.props().selectedSessionId, "remote");
  await act(async () => view.opens[2]!.result.reject(new Error("history unavailable")));
  await act(async () => view.opens[1]!.result.resolve({ session: session("child"), events: [], liveEvents: [] }));
  assert.equal(view.props().activeProjectId, "project");
  assert.equal(view.props().selectedSessionId, "parent", "failure must not restore an unfinished intermediate session");
  assert.equal(view.selections.at(-1), "project:parent");
});


test("a pending session cannot send its composer draft to the previously loaded session", async (context) => {
  const view = await fixture(context);
  await act(async () => view.props().onSelectSession("project", "parent"));
  await act(async () => view.opens[0]!.result.resolve({ session: session("parent"), events: [], liveEvents: [] }));
  await act(async () => view.props().onSelectSession("other", "remote"));
  await act(async () => { void view.composer().onSend("draft", []).catch(() => {}); });
  assert.deepEqual(view.sends, [], "loading navigation must not dispatch a prompt to the old identity");
});


test("selecting the current project through search supersedes an in-flight session navigation", async (context) => {
  const view = await fixture(context);
  await act(async () => view.props().onSelectSession("other", "remote"));
  await act(async () => view.search().onProject("project"));
  await act(async () => view.opens[0]!.result.resolve({ session: session("remote", "other"), events: [], liveEvents: [] }));
  assert.equal(view.props().activeProjectId, "project");
  assert.equal(view.props().selectedSessionId, undefined);
  assert.deepEqual(view.selections, []);
});

// Navigation used to collapse the source folder, removing the next available target mid-switch.
test("selecting another project keeps the source session rows available during and after loading", async (context) => {
  const view = await fixture(context, true);
  const sourceRow = () => view.buttons().find(button => button.className === "biny-sidebar-session-item" && button.title === "parent");
  assert.ok(sourceRow());
  await act(async () => view.props().onSelectSession("other", "remote"));
  assert.ok(sourceRow(), "changing the highlighted project must not collapse the source folder");
  await act(async () => view.opens[0]!.result.resolve({ session: session("remote", "other"), events: [], liveEvents: [] }));
  assert.ok(sourceRow(), "completed navigation must preserve the source folder's expansion too");
});

// Previous navigation tests omit the browser snapshot API, so they cannot catch its window-wide hit-test overlay.
test("session navigation never starts a window snapshot transition that intercepts subsequent clicks", async (context) => {
  const view = await fixture(context);
  const transitions: string[] = [];
  Object.assign(view.document, { startViewTransition(update: () => void) {
    transitions.push("window snapshot");
    queueMicrotask(update);
  } });
  for (const [projectId, sessionId] of [["project", "parent"], ["project", "child"], ["other", "remote"]] as const) {
    await act(async () => view.props().onSelectSession(projectId, sessionId));
    await act(async () => view.opens.at(-1)!.result.resolve({ session: session(sessionId, projectId), events: [], liveEvents: [] }));
    assert.equal(view.props().selectedSessionId, sessionId);
  }
  assert.deepEqual(transitions, [], "even unchanged hero state must not create a 420 ms window-wide snapshot layer");
});

// Deletion must not reopen an unrelated session or overwrite navigation completed while IPC was pending.
test("deleting an old selection preserves the session opened while deletion was pending", async (context) => {
  const view = await fixture(context);
  await act(async () => view.props().onSelectSession("project", "parent"));
  await act(async () => view.opens[0]!.result.resolve({ session: session("parent"), events: [], liveEvents: [] }));
  let deletion!: Promise<unknown>;
  await act(async () => { deletion = view.props().onDeleteSessions([session("parent")], false); });
  assert.equal(view.props().selectedSessionId, undefined, "the deleted chat closes before the slow delete response");
  await act(async () => view.props().onSelectSession("other", "remote"));
  await act(async () => view.opens[1]!.result.resolve({ session: session("remote", "other"), events: [], liveEvents: [] }));
  await act(async () => { view.mutations[0]!.resolve(workspace()); await deletion; });
  assert.equal(view.props().activeProjectId, "other");
  assert.equal(view.props().selectedSessionId, "remote");
  assert.equal(view.opens.length, 2, "deletion must not reopen any session");
  assert.equal(view.props().sessions.some(row => row.projectId === "project" && row.id === "parent"), false);
});

// A slow delete must not delay the visual exit; rejection restores the row and keeps navigation available.
test("row delete exits before a slow response and restores failures without blocking navigation", async (context) => {
  const view = await fixture(context, true);
  await view.refresh(workspace("project", [session("parent"), session("second")]));
  const remove = () => view.buttons().find(button => button.getAttribute("aria-label") === "删除 parent");
  assert.ok(remove(), "session rows expose a delete action");
  await view.click(remove()!);
  assert.equal(view.mutations.length, 0, "first click must only arm confirmation");
  await act(async () => context.mock.timers.tick(3000));
  assert.ok(remove(), "confirmation expires");
  await view.click(remove()!);
  const confirm = view.buttons().find(button => button.getAttribute("aria-label") === "确认删除 parent");
  assert.ok(confirm);
  await view.click(confirm!);
  assert.equal(view.mutations.length, 1);
  assert.ok(view.document.querySelector(".is-removing"), "animation starts before the delete response");
  assert.ok(view.document.querySelector(".biny-sidebar-session-tree-row")?.classList.contains("is-removing"), "exit retains the original row position");
  await view.click(view.buttons().find(button => button.title === "second")!);
  assert.equal(view.opens.at(-1)?.sessionId, "second", "other sessions remain selectable during deletion");
  await act(async () => context.mock.timers.tick(750));
  assert.equal(remove(), undefined, "the row leaves on schedule even while the request remains pending");
  await act(async () => view.mutations[0]!.reject(new Error("file locked")));
  assert.ok(remove(), "a failed delete remains available for retry");
  assert.equal(view.document.querySelector(".is-removing"), null);
  assert.equal(view.document.querySelector(".biny-sidebar-session-item")?.getAttribute("title"), "parent");
  await view.click(remove()!);
  await view.click(view.buttons().find(button => button.getAttribute("aria-label") === "确认删除 parent")!);
  await act(async () => context.mock.timers.tick(750));
  await act(async () => view.mutations[1]!.resolve(workspace("project", [])));
  assert.equal(view.document.querySelector(".is-removing"), null);
  assert.equal(remove(), undefined);
});

// A timer from an early failure used to be able to remove a retried row before its own animation ended.
test("retrying a failed delete keeps its own animation deadline after an early success", async (context) => {
  const view = await fixture(context, true);
  const shiftDelete = async () => {
    const button = view.buttons().find(button => button.getAttribute("aria-label") === "删除 parent")!;
    await act(async () => button.dispatchEvent(new view.document.defaultView!.MouseEvent("click", { bubbles: true, shiftKey: true })));
  };
  await shiftDelete();
  await act(async () => context.mock.timers.tick(200));
  await act(async () => view.mutations[0]!.reject(new Error("file locked")));
  await shiftDelete();
  await act(async () => view.mutations[1]!.resolve(workspace("project", [])));
  assert.ok(view.document.querySelector(".is-removing"), "fast storage completion does not cut off the animation");
  await act(async () => context.mock.timers.tick(550));
  assert.ok(view.document.querySelector(".is-removing"), "the failed attempt's deadline cannot remove the retry");
  await act(async () => context.mock.timers.tick(199));
  assert.ok(view.document.querySelector(".is-removing"));
  await act(async () => context.mock.timers.tick(1));
  assert.equal(view.document.querySelector(".is-removing"), null);
});

// Deleting the next row must not wait for an earlier IPC response or its exit animation.
test("consecutive row deletes start independently while both storage replies are pending", async (context) => {
  const view = await fixture(context, true);
  await view.refresh(workspace("project", [session("parent"), session("second")]));
  for (const title of ["parent", "second"]) {
    const button = view.buttons().find(button => button.getAttribute("aria-label") === `删除 ${title}`)!;
    await act(async () => button.dispatchEvent(new view.document.defaultView!.MouseEvent("click", { bubbles: true, shiftKey: true })));
  }
  assert.equal(view.mutations.length, 2, "both requests are sent without waiting for the previous result");
  assert.equal(view.document.querySelectorAll(".is-removing").length, 2);
  await act(async () => context.mock.timers.tick(750));
  assert.equal(view.buttons().some(button => button.title === "parent" || button.title === "second"), false);
  await act(async () => view.mutations[1]!.resolve(workspace("project", [])));
  await act(async () => view.mutations[0]!.reject(new Error("file locked")));
  assert.ok(view.buttons().some(button => button.title === "parent"), "only the failed row is restored");
  assert.equal(view.buttons().some(button => button.title === "second"), false);
});

// Selection mode must toggle rows without navigating and keep failed targets selected after a partial batch.
test("multi-select deletes once, preserves failed rows, and Escape leaves selection mode", async (context) => {
  const view = await fixture(context, true);
  await view.refresh(workspace("project", [session("parent"), session("second")]));
  const parent = view.buttons().find(button => button.className === "biny-sidebar-session-item" && button.title === "parent")!;
  await act(async () => parent.dispatchEvent(new view.document.defaultView!.MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await view.click(view.buttons().find(button => button.textContent === "多选")!);
  const check = view.document.querySelector<HTMLInputElement>('input[aria-label="选择 second"]')!;
  assert.ok(check);
  await act(async () => check.click());
  assert.equal(view.opens.length, 0, "selecting rows must not navigate");
  const calls: unknown[] = [];
  const reply = deferred<import("../src/desktop/protocol.js").DesktopSessionDeleteResult>();
  let start!: () => void;
  Object.assign((view.document.defaultView as unknown as { biny: object }).biny, { deleteSessions: (targets: unknown, confirm: boolean, onStarted: () => void) => {
    calls.push({ targets, confirm });
    start = onStarted;
    return reply.promise;
  } });
  await view.click(view.buttons().find(button => button.closest('[aria-label="会话多选"]') && button.textContent === "删除")!);
  assert.deepEqual(calls, [{ targets: [{ projectId: "project", sessionId: "parent" }, { projectId: "project", sessionId: "second" }], confirm: true }]);
  assert.equal(view.document.querySelector(".is-removing"), null, "native confirmation must precede the batch animation");
  await act(async () => start());
  assert.equal(view.document.querySelectorAll(".is-removing").length, 2, "all confirmed rows animate before the slow batch response");
  await act(async () => context.mock.timers.tick(750));
  assert.equal(view.document.querySelector('input[aria-label="选择 second"]'), null);
  await act(async () => reply.resolve({ cancelled: false, deleted: [{ projectId: "project", sessionId: "parent" }], failures: [{ projectId: "project", sessionId: "second", error: "busy" }] }));
  assert.equal(view.document.querySelector('[aria-label="会话多选"] span')?.textContent, "已选 1 项");
  assert.equal(view.document.querySelector<HTMLInputElement>('input[aria-label="选择 second"]')?.checked, true);
  await act(async () => view.document.defaultView!.dispatchEvent(new view.document.defaultView!.KeyboardEvent("keydown", { key: "Escape" })));
  assert.equal(view.document.querySelector('[aria-label="会话多选"]'), null);
});

// Reduced-motion users must not wait for the visual exit; the Shift shortcut still issues only one delete.
test("Shift deletion skips inline confirmation and reduced motion removes successful rows immediately", async (context) => {
  const view = await fixture(context, true);
  Object.assign(view.document.defaultView!, { matchMedia: () => ({ matches: true }) });
  const button = view.buttons().find(button => button.getAttribute("aria-label") === "删除 parent")!;
  await act(async () => button.dispatchEvent(new view.document.defaultView!.MouseEvent("click", { bubbles: true, shiftKey: true })));
  assert.equal(view.mutations.length, 1);
  assert.equal(view.buttons().some(button => button.title === "parent"), false, "reduced motion hides the row before storage finishes");
  await act(async () => view.mutations[0]!.resolve(workspace("project", [])));
  assert.equal(view.document.querySelector(".is-removing"), null);
  assert.equal(view.buttons().some(button => button.title === "parent"), false);
});
