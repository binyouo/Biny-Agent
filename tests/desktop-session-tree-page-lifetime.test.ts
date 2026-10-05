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
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";
import type { DesktopAgentEventEnvelope, DesktopBootstrap, DesktopSessionSummary, DesktopSessionTreePage, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";

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
  onLoadSessionChildren(projectId: string, parentSessionId: string, cursor?: string): Promise<DesktopSessionTreePage>;
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
  const actual = new Set(["react", "./app/desktopState.js", "./app/desktopApi.js", "./app/sessionTreePageLifetime.js", "./app/useDesktopEventBridge.js", "./navigationHistory.js", "../../../runtime/agentEvents.js"]);
  const implementations: Record<string, string> = {
    ChatResponseContext: "createContext(undefined)", RenderingPreviewContext: "createContext(undefined)",
    AppearanceProvider: "({children}) => children",
    DesktopShell: "({sideNav}) => sideNav",
    Sidebar: "(props) => { window.__sidebar = props; return window.__realSidebar ? createElement(RealSidebar, props) : createElement('pre', null, JSON.stringify(props.sessions)); }",
    Tooltip: "({children}) => children", Collapse: "({children, open, ...props}) => open ? createElement('div', props, children) : null",
    useFluidHover: "() => ({registerItem: noop, handlers: {}})",
    useClosingPresence: "() => ({present: false})", useAppearance: "() => ({})",
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
      if ((args.importer === entry && actual.has(args.path)) || !imports.has(key)) return undefined;
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
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const initialBootstrap = deferred<DesktopBootstrap>();
  const pages: Array<{ projectId: string; parentSessionId: string; cursor?: string; result: ReturnType<typeof deferred<DesktopSessionTreePage>> }> = [];
  const snapshots: Array<ReturnType<typeof deferred<DesktopWorkspaceSnapshot>>> = [];
  const mutations: Array<ReturnType<typeof deferred<DesktopWorkspaceSnapshot>>> = [];
  const bootstraps: Array<ReturnType<typeof deferred<DesktopBootstrap>>> = [];
  let subscriber: ((envelope: DesktopAgentEventEnvelope) => void) | undefined;
  Object.assign(dom.window, { __realSidebar: realSidebar, biny: {
    bootstrap: async () => deferBootstrap ? await initialBootstrap.promise : bootstrap(),
    refreshProject() { const value = deferred<DesktopWorkspaceSnapshot>(); snapshots.push(value); return value.promise; },
    listSessionTreePage(projectId: string, options: { parentSessionId: string; cursor?: string }) {
      const result = deferred<DesktopSessionTreePage>(); pages.push({ projectId, ...options, result }); return result.promise;
    },
    deleteSession() { const value = deferred<DesktopWorkspaceSnapshot>(); mutations.push(value); return value.promise; },
    pinSession() { const value = deferred<DesktopWorkspaceSnapshot>(); mutations.push(value); return value.promise; },
    selectProject: async (id: string) => workspace(id), startDraft: async (id: string) => workspace(id),
    removeProject() { const value = deferred<DesktopBootstrap>(); bootstraps.push(value); return value.promise; },
    commitSelection: async () => {}, listProjectBranches: async () => [],
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
  return { props, pages, snapshots, mutations, bootstraps, initialBootstrap, load, resolvePage, refresh, unmount,
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
