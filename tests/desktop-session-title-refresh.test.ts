/** Real App metadata DOM and manager snapshots; only presentation and transport boundaries are isolated. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import type { DesktopAgentEventEnvelope, DesktopBootstrap, DesktopProject, DesktopSessionDocument, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

interface SidebarProbe {
  sessions: DesktopSessionSummary[];
  activeProjectId?: string;
  selectedSessionId?: string;
}
interface ReadGate {
  entered: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
}

// Preserve App, event bridge, metadata reducers, real Sidebar and RenameOverlay.
// The imported ancillary views are not part of the title/read-publication contract.
async function appModule() {
  const { build } = await import("esbuild");
  const ts = await import("typescript");
  const directory = await mkdtemp(path.resolve(".session-title-refresh-test-"));
  const entry = path.resolve("src/desktop/renderer/src/App.tsx");
  const sidebarEntry = path.resolve("src/desktop/renderer/src/components/Sidebar.tsx");
  const imports = new Map<string, string[]>();
  for (const file of [entry, sidebarEntry]) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        imports.set(`${file}:${statement.moduleSpecifier.text}`, bindings.elements.filter(item => !item.isTypeOnly).map(item => item.name.text));
      }
    }
  }
  const actual = new Set(["react", "./app/desktopState.js", "./app/desktopApi.js", "./app/sessionTreePageLifetime.js",
    "./app/useDesktopEventBridge.js", "./navigationHistory.js", "../../../runtime/agentEvents.js",
    "./components/overlays/RenameOverlay.js"]);
  const implementations: Record<string, string> = {
    ChatResponseContext: "createContext(undefined)", RenderingPreviewContext: "createContext(undefined)",
    AppearanceProvider: "({children}) => children",
    DesktopShell: "({sideNav, children, overlays}) => createElement('div', null, sideNav, children, overlays)",
    Workspace: "(props) => createElement('output', {'data-current-title': true}, props.sessionTitle)",
    DesktopToast: "({message}) => message ? createElement('p', {role: 'status', 'data-title-toast': true}, message) : null",
    Sidebar: "(props) => { window.__titleSidebar = props; return createElement(RealSidebar, props); }",
    Tooltip: "({children}) => children",
    Collapse: "({children, open, ...props}) => open ? createElement('div', props, children) : null",
    useFluidHover: "() => ({registerItem: noop, handlers: {}})",
    useClosingPresence: "(open) => ({present: open, phase: 'open'})",
    useAppearance: "() => ({})",
    useDesktopAppearance: "() => appearance",
    useSidebarLayout: "() => sidebarLayout",
    useCompactionCommand: "() => compaction",
    useDesktopSettingsActions: "() => ({})",
    useWorkspaceInspector: "() => ({})",
    useSessionTimeline: "() => []",
    collectSessionChanges: "() => []",
    DEFAULT_FILE_PANEL_WIDTH: "320", DEFAULT_SIDEBAR_WIDTH: "240"
  };
  try {
    await build({
      entryPoints: [entry], outfile: path.join(directory, "app.mjs"), bundle: true,
      platform: "node", format: "esm", packages: "external", jsx: "automatic",
      plugins: [{
        name: "title-presentation-fixture",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, args => {
            if (args.path === "react" || args.path === "react-dom") return { path: args.path, external: true };
            if (args.path === "production-sidebar") return { path: sidebarEntry };
            const key = `${args.importer}:${args.path}`;
            if ((args.importer === entry && actual.has(args.path))
              || (args.importer === sidebarEntry && ["./SessionDeleteButton.js", "../../../sidebarSizing.js"].includes(args.path)) || !imports.has(key)) return undefined;
            return { path: key, namespace: "fixture" };
          });
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
            contents: `
              import { createContext, createElement } from 'react';
              ${args.path === `${entry}:./components/Sidebar.js` ? "import { Sidebar as RealSidebar } from 'production-sidebar';" : ""}
              const noop = () => {};
              const appearance = {snapshot: {}, bootstrap: noop, adopt: noop};
              const sidebarLayout = {layout: {mode: 'expanded', contentWidth: 240}, drawerRef: {current: null}, setExpandedWidth: noop, toggle: noop};
              const compaction = {start: noop, fail: noop, run: noop};
              ${imports.get(args.path)!.map(name => `export const ${name} = ${implementations[name] ?? "() => null"};`).join("\n")}
            `, loader: "js"
          }));
        }
      }]
    });
    const module = await import(pathToFileURL(path.join(directory, "app.mjs")).href) as { App: () => import("react").JSX.Element };
    return { ...module, close: async () => { await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function fixture(context: TestContext) {
  const rootPath = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-title-refresh-")));
  const cleanup: Array<() => void | Promise<void>> = [async () => { await rm(rootPath, { recursive: true, force: true }); }];
  context.after(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Title refresh fixture cleanup failed");
  });
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  cleanup.push(() => {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
  });
  process.env.BINY_AGENT_DIR = path.join(rootPath, "agent");
  globalThis.fetch = async () => { throw new Error("Unexpected network request in title refresh fixture"); };
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  cleanup.push(() => {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLDialogElement: dom.window.HTMLDialogElement,
    Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.scrollTo = () => {};
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.matchMedia = query => ({ matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  context.mock.timers.enable({ apis: ["setTimeout"] });
  Object.assign(dom.window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
    cancelAnimationFrame: clearTimeout
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { configSchema, defaultConfig } = await import("../src/config/schema.js");
  const { createFileConfigStore } = await import("../src/config/store.js");
  const { DesktopStateStore } = await import("../src/desktop/electron/main/DesktopStateStore.js");
  const { DesktopUserDataStore } = await import("../src/desktop/electron/main/DesktopUserDataStore.js");
  const { DesktopProjectService } = await import("../src/desktop/electron/main/DesktopProjectService.js");
  const { DesktopAgentManager } = await import("../src/desktop/electron/main/DesktopAgentManager.js");
  const { FileModelsStore } = await import("../src/llm/ModelsStore.js");
  const { SessionRecorder } = await import("../src/session/recorder.js");
  const { generateSessionTitle } = await import("../src/session/title.js");
  const catalog = await import("../src/session/catalog.js");
  const { deleteSessionArtifacts } = await import("../src/session/cleanup.js");
  const workspacePath = path.join(rootPath, "workspace");
  await mkdir(workspacePath);
  const configStore = createFileConfigStore(workspacePath, {
    globalDir: path.join(rootPath, "config"),
    credentialStore: { persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {} }
  });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save(configSchema.parse({
    ...defaultConfig,
    providers: { "title-fixture": { type: "openai-compatible", baseUrl: "https://title-fixture.invalid/v1", requiresApiKey: false } },
    models: { unused: { provider: "title-fixture", model: "synthetic-title-model", contextWindow: 128_000 } },
    defaultModel: "unused"
  }));
  const state = new DesktopStateStore(path.join(rootPath, "state.json"));
  await state.load();
  const storage = new DesktopUserDataStore(path.join(rootPath, "desktop"));
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createProject(workspacePath);
  const otherPath = path.join(rootPath, "other");
  await mkdir(otherPath);
  const otherProject = await projects.createProject(otherPath);
  const modelsStore = new FileModelsStore(path.join(rootPath, "models.json"));
  await writeFile(modelsStore.filePath, JSON.stringify({ version: 2, providers: {} }));
  const manager = new DesktopAgentManager(state, projects, configStore, () => {}, undefined, modelsStore);
  cleanup.push(async () => { await manager.closeAll(); });
  const dataRoot = await projects.dataRoot(project);
  const otherRoot = await projects.dataRoot(otherProject);
  cleanup.push(async () => {
    await catalog.refreshSessionIndex(dataRoot);
    await catalog.refreshSessionIndex(otherRoot);
  });
  const seed = async (targetRoot: string, label: string): Promise<string> => {
    const recorder = new SessionRecorder(targetRoot);
    try { await recorder.recordAndFlush({ type: "user_message", content: label }); }
    finally { await recorder.close(); }
    const model: AgentModel = { provider: "synthetic", modelId: "title-refresh", async stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: label };
        yield { type: "finish", reason: "stop" };
      })();
    } };
    assert.equal(await generateSessionTitle(targetRoot, recorder.sessionId, model), label);
    return recorder.sessionId;
  };
  const sessionId = await seed(dataRoot, "Generated title");
  const removableId = await seed(dataRoot, "Removable title");
  const otherId = await seed(otherRoot, "Other project title");
  const initial = await manager.workspaceSnapshot(project.id, false);
  const otherInitial = await manager.workspaceSnapshot(otherProject.id, false);
  const original = initial.sessions.find(session => session.id === sessionId)!;
  assert.ok(original.metadataRevision, "the UI must already hold the generated title's real CAS revision");
  const bootstrap: DesktopBootstrap = {
    version: "test", projects: [project, otherProject],
    sidebarSessions: [...initial.sessions, ...otherInitial.sessions], workspace: initial,
    selectedSessionId: sessionId, activeView: "chat"
  } as DesktopBootstrap;
  const refreshes: Array<{ projectId: string; result: Promise<DesktopWorkspaceSnapshot> }> = [];
  const renames: Array<{ projectId: string; sessionId: string; title: string; expectedRevision?: string; result: Promise<DesktopWorkspaceSnapshot> }> = [];
  const pins: Array<{ projectId: string; sessionId: string; pinned: boolean; expectedRevision?: string; result: Promise<DesktopWorkspaceSnapshot> }> = [];
  const opens: Promise<DesktopSessionDocument>[] = [];
  const gates: ReadGate[] = [];
  let armed: ReadGate | undefined;
  let subscriber: ((envelope: DesktopAgentEventEnvelope) => void) | undefined;
  const noop = () => {};
  const projectFor = (id: string): DesktopProject => projects.requireProject(id);
  Object.assign(dom.window, { biny: {
    bootstrap: async () => bootstrap,
    refreshProject(projectId: string) {
      const result = manager.workspaceSnapshot(projectId, true);
      refreshes.push({ projectId, result });
      void result.catch(noop);
      return result;
    },
    renameSession(projectId: string, targetId: string, title: string, expectedRevision?: string) {
      const result = manager.renameSession(projectId, targetId, title, expectedRevision);
      renames.push({ projectId, sessionId: targetId, title, expectedRevision, result });
      void result.catch(noop);
      return result;
    },
    pinSession(projectId: string, targetId: string, pinned: boolean, expectedRevision?: string) {
      const result = manager.pinSession(projectId, targetId, pinned, expectedRevision);
      pins.push({ projectId, sessionId: targetId, pinned, expectedRevision, result });
      void result.catch(noop);
      return result;
    },
    // Read the real project document without launching an unrelated Runtime Host.
    openSession(projectId: string, targetId: string) {
      const result = projects.openSession(projectFor(projectId), targetId, [], new Map());
      opens.push(result);
      void result.catch(noop);
      return result;
    },
    selectProject: async (projectId: string) => await manager.workspaceSnapshot(projectId, false),
    commitSelection: async () => undefined,
    listProjectBranches: async () => [], recipeSuggestions: async () => [],
    planProjection: async () => undefined,
    skillCatalog: async () => ({ skills: [], warnings: [] }), skillSettings: async () => ({ activations: [] }),
    toolCatalog: async () => [],
    onAgentEvent(listener: typeof subscriber) { subscriber = listener; return () => { subscriber = undefined; }; },
    onReferenceOpen: () => noop, onSessionHandoff: () => noop, onMenuAction: () => noop,
    onSettingsCloseRequest: () => noop, onBrowserOpenRequest: () => noop
  } });
  const compiled = await appModule();
  cleanup.push(compiled.close);
  const root = createRoot(dom.window.document.getElementById("root")!);
  let mounted = true;
  const unmount = async () => { if (mounted) { await React.act(() => root.unmount()); mounted = false; } };
  cleanup.push(unmount);
  const realReadFile = fs.readFile;
  const readSpy = context.mock.method(fs, "readFile", (async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await realReadFile(...args);
    if (args[0] === modelsStore.filePath && armed) {
      const gate = armed;
      armed = undefined;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return bytes;
  }) as typeof fs.readFile);
  cleanup.push(() => { readSpy.mock.restore(); });
  cleanup.push(async () => {
    try { await unmount(); }
    finally {
      for (const gate of gates) gate.release.resolve();
      await Promise.allSettled([...refreshes.map(call => call.result), ...renames.map(call => call.result), ...pins.map(call => call.result), ...opens]);
    }
  });
  await React.act(async () => { root.render(React.createElement(compiled.App)); });
  await React.act(async () => { await Promise.all(opens); });
  const probe = (): SidebarProbe => (dom.window as unknown as { __titleSidebar: SidebarProbe }).__titleSidebar;
  const summary = (id = sessionId): DesktopSessionSummary => {
    const session = probe().sessions.find(item => item.id === id);
    assert.ok(session);
    return session;
  };
  assert.equal(summary().metadataRevision, original.metadataRevision);
  assert.equal(summary().title, "Generated title");
  const tick = async (ms: number) => { await React.act(async () => { context.mock.timers.tick(ms); }); };
  const arm = (): ReadGate => {
    assert.equal(armed, undefined);
    const gate = { entered: deferred<void>(), release: deferred<void>() };
    gates.push(gate);
    armed = gate;
    return gate;
  };
  const event = async (targetProject = project.id, targetSession = sessionId) => {
    subscriber!({ projectId: targetProject, event: {
      type: "session.title", title: "Generated title", sessionId: targetSession, runId: "",
      timestamp: new Date().toISOString()
    } } as DesktopAgentEventEnvelope);
    await tick(16);
    await tick(260);
  };
  const settleRefresh = async (index: number) => {
    const refresh = refreshes[index];
    assert.ok(refresh);
    await React.act(async () => { await refresh.result.catch(noop); await Promise.allSettled(opens); });
  };
  const selectSessionAction = async (label: string, targetId = sessionId) => {
    const target = summary(targetId);
    const title = target.title;
    const folder = [...dom.window.document.querySelectorAll<HTMLElement>(".biny-project-row")]
      .find(item => item.title === projectFor(target.projectId).path);
    assert.ok(folder);
    if (folder.getAttribute("aria-expanded") === "false") {
      await React.act(async () => { folder.click(); });
    }
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".biny-sidebar-session-item")]
      .find(item => item.title === title);
    assert.ok(button, `Missing sidebar row: ${title}`);
    await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })); });
    await tick(16);
    const action = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(item => item.textContent?.trim() === label);
    assert.ok(action);
    await React.act(async () => { action.click(); });
  };
  const openRename = async (targetId = sessionId) => { await selectSessionAction("重命名", targetId); };
  const savePinned = async (pinned: boolean, targetId = sessionId) => {
    assert.notEqual(Boolean(summary(targetId).pinned), pinned, "the menu action must change the current pin state");
    const before = pins.length;
    await selectSessionAction(pinned ? "置顶" : "取消置顶", targetId);
    assert.equal(pins.length, before + 1, "the DOM action must reach the real pin API exactly once");
    const request = pins[before]!;
    await React.act(async () => { await request.result.catch(noop); });
    return request;
  };
  const enterTitle = async (title: string) => {
    const input = dom.window.document.querySelector<HTMLInputElement>('input[placeholder="输入新名称…"]');
    assert.ok(input);
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    assert.ok(setValue);
    await React.act(async () => {
      setValue.call(input, title);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    return input;
  };
  const submit = async () => {
    const form = dom.window.document.querySelector<HTMLFormElement>(".desktop-dialog-form");
    assert.ok(form);
    await React.act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  };
  const rename = async (title: string, targetId = sessionId) => {
    const before = renames.length;
    await openRename(targetId);
    await enterTitle(title);
    await submit();
    assert.equal(renames.length, before + 1, "DOM submission must reach the real rename API exactly once");
    const request = renames[before]!;
    await React.act(async () => { await request.result.catch(noop); });
    return request;
  };
  return {
    project, otherProject, dataRoot, otherRoot, sessionId, removableId, otherId, original,
    refreshes, renames, pins, opens, probe, summary, tick, arm, event, settleRefresh, openRename, enterTitle, submit, rename, savePinned, unmount,
    document: dom.window.document,
    readTitle: async () => (await catalog.readSessionCatalogRecord(dataRoot, sessionId))?.title,
    readMetadata: async (targetId = sessionId) => {
      const record = await catalog.readSessionCatalogRecord(targetId === otherId ? otherRoot : dataRoot, targetId);
      assert.ok(record);
      return { pinned: Boolean(record.pinned), revision: catalog.sessionCatalogRecordRevision(record), title: record.title };
    },
    pin: async () => { await catalog.updateSessionCatalogMetadata(dataRoot, sessionId, { pinned: true }, undefined, { indexRefresh: "wait" }); },
    externalRename: async (title: string) => { await catalog.updateSessionCatalogMetadata(dataRoot, sessionId, { title }, undefined, { indexRefresh: "wait" }); },
    changeMembers: async () => {
      const addedId = await seed(dataRoot, "Added title");
      await deleteSessionArtifacts(dataRoot, removableId);
      await catalog.refreshSessionIndex(dataRoot);
      return addedId;
    }
  };
}

test("an old generated-title snapshot cannot undo a confirmed DOM rename and a reread preserves fresh metadata and membership", { timeout: 30_000 }, async context => {
  const view = await fixture(context);
  const gate = view.arm();
  await view.event();
  await gate.entered.promise;
  const request = await view.rename("Manual title");
  await request.result;
  assert.equal(request.expectedRevision, view.original.metadataRevision);
  assert.equal(await view.readTitle(), "Manual title");
  assert.equal(view.summary().title, "Manual title");
  await view.pin();
  const addedId = await view.changeMembers();
  gate.release.resolve();
  await view.settleRefresh(0);
  assert.equal((await view.refreshes[0]!.result).sessions.find(session => session.id === view.sessionId)?.title, "Generated title",
    "the original real manager read must actually contain the old title");
  assert.equal(view.summary().title, "Manual title", "the delayed old snapshot must not roll back a confirmed rename");
  await view.tick(260);
  assert.equal(view.refreshes.length, 2, "the invalidated read must schedule a real replacement read");
  await view.settleRefresh(1);
  assert.equal(view.summary().title, "Manual title");
  assert.equal(view.summary().pinned, true, "the replacement snapshot must preserve later legitimate metadata");
  assert.ok(view.probe().sessions.some(session => session.id === addedId));
  assert.ok(!view.probe().sessions.some(session => session.id === view.removableId));
  const fresh = (await view.refreshes[1]!.result).sessions.find(session => session.id === view.sessionId)!;
  assert.equal(view.summary().metadataRevision, fresh.metadataRevision);
  assert.equal(view.document.querySelector("[data-current-title]")?.textContent, "Manual title");
  assert.equal(await view.readTitle(), "Manual title");
});

test("a second successful rename invalidates the replacement read and eventually publishes the latest complete snapshot", { timeout: 30_000 }, async context => {
  const view = await fixture(context);
  const first = view.arm();
  await view.event();
  await first.entered.promise;
  await (await view.rename("Manual one")).result;
  first.release.resolve();
  await view.settleRefresh(0);
  const second = view.arm();
  await view.tick(260);
  assert.equal(view.refreshes.length, 2);
  await second.entered.promise;
  await (await view.rename("Manual two")).result;
  second.release.resolve();
  await view.settleRefresh(1);
  assert.equal(view.summary().title, "Manual two");
  await view.tick(260);
  assert.equal(view.refreshes.length, 3);
  await view.settleRefresh(2);
  assert.equal(view.summary().title, "Manual two");
  assert.equal(await view.readTitle(), "Manual two");
  await view.tick(1_000);
  assert.equal(view.refreshes.length, 3, "a stable epoch cannot keep retrying");
});

test("a failed real rename keeps its input and does not reschedule an otherwise unchanged event refresh", { timeout: 30_000 }, async context => {
  const view = await fixture(context);
  const gate = view.arm();
  await view.event();
  await gate.entered.promise;
  await view.externalRename("Changed elsewhere");
  const request = await view.rename("Unconfirmed edit");
  await assert.rejects(request.result, /revision conflict/u);
  assert.match(view.document.querySelector('[role="alert"]')?.textContent ?? "", /revision conflict/u);
  assert.equal(view.document.querySelector<HTMLInputElement>('input[placeholder="输入新名称…"]')?.value, "Unconfirmed edit");
  gate.release.resolve();
  await view.settleRefresh(0);
  await view.tick(1_000);
  assert.equal(view.refreshes.length, 1);
  assert.equal(await view.readTitle(), "Changed elsewhere");
});

test("a rename in another project cannot invalidate this project's in-flight refresh", { timeout: 30_000 }, async context => {
  const view = await fixture(context);
  const gate = view.arm();
  await view.event();
  await gate.entered.promise;
  await (await view.rename("Other manual title", view.otherId)).result;
  assert.equal(view.probe().activeProjectId, view.project.id, "expanding another project's folder must not navigate away");
  gate.release.resolve();
  await view.settleRefresh(0);
  await view.tick(1_000);
  assert.equal(view.refreshes.length, 1);
  assert.equal(view.summary(view.otherId).title, "Other manual title");
  assert.equal(view.summary().title, "Generated title");
});

test("blank title submission is inert and does not turn an ordinary refresh into a retry", { timeout: 30_000 }, async context => {
  const view = await fixture(context);
  const gate = view.arm();
  await view.event();
  await gate.entered.promise;
  await view.openRename();
  await view.enterTitle("   ");
  await view.submit();
  assert.equal(view.renames.length, 0);
  gate.release.resolve();
  await view.settleRefresh(0);
  await view.tick(1_000);
  assert.equal(view.refreshes.length, 1);
  assert.equal(await view.readTitle(), "Generated title");
});

test("unmount cancels a rename-invalidated refresh before its replacement timer can run", { timeout: 30_000 }, async context => {
  const view = await fixture(context);
  const gate = view.arm();
  await view.event();
  await gate.entered.promise;
  await (await view.rename("Manual title")).result;
  gate.release.resolve();
  await view.settleRefresh(0);
  await view.unmount();
  await view.tick(1_000);
  assert.equal(view.refreshes.length, 1);
  assert.equal(await view.readTitle(), "Manual title");
});

for (const pinned of [true, false]) {
  test(`an old title-event snapshot cannot undo a confirmed DOM ${pinned ? "pin" : "unpin"}`, { timeout: 30_000 }, async context => {
    const view = await fixture(context);
    if (!pinned) await (await view.savePinned(true)).result;
    const initial = view.summary();
    const gate = view.arm();
    await view.event();
    await gate.entered.promise;
    const request = await view.savePinned(pinned);
    const confirmed = (await request.result).sessions.find(session => session.id === view.sessionId)!;
    assert.equal(request.expectedRevision, initial.metadataRevision);
    assert.equal(confirmed.pinned, pinned);
    assert.notEqual(confirmed.metadataRevision, initial.metadataRevision);
    assert.deepEqual(await view.readMetadata(), { pinned, revision: confirmed.metadataRevision, title: "Generated title" });
    assert.equal(view.summary().pinned, pinned);
    assert.equal(view.renames.length, 0, "rename invalidation must not hide a missing pin invalidation");
    gate.release.resolve();
    await view.settleRefresh(0);
    const old = (await view.refreshes[0]!.result).sessions.find(session => session.id === view.sessionId)!;
    assert.equal(Boolean(old.pinned), !pinned, "the real old manager snapshot must contain the earlier pin state");
    assert.equal(old.metadataRevision, initial.metadataRevision);
    assert.equal(view.summary().pinned, pinned, "the delayed old snapshot must not roll back a confirmed pin change");
    assert.equal(view.summary().metadataRevision, confirmed.metadataRevision);
    const pinnedRow = [...view.document.querySelectorAll<HTMLButtonElement>('section[aria-label="置顶"] .biny-sidebar-session-item')]
      .find(row => row.title === "Generated title");
    assert.equal(Boolean(pinnedRow), pinned, "the visible pinned section must match the confirmed state");
    await view.tick(260);
    assert.equal(view.refreshes.length, 2, "the pin-invalidated read must schedule a real replacement");
    await view.settleRefresh(1);
    assert.equal(view.summary().pinned, pinned);
    const persisted = await view.readMetadata();
    assert.equal(view.summary().metadataRevision, persisted.revision);
    assert.equal(persisted.pinned, pinned);
    await view.tick(1_000);
    assert.equal(view.refreshes.length, 2, "a stable pin revision cannot keep retrying");
  });
}

test("a failed real DOM pin leaves an in-flight title refresh valid", { timeout: 30_000 }, async context => {
  const view = await fixture(context);
  const gate = view.arm();
  await view.event();
  await gate.entered.promise;
  await view.externalRename("Changed elsewhere");
  const request = await view.savePinned(true);
  await assert.rejects(request.result, /revision conflict/u);
  const toast = view.document.querySelector('[data-title-toast]');
  assert.ok(toast, "the App warning toast must be rendered");
  assert.match(toast.textContent ?? "", /revision conflict/u);
  assert.equal(view.renames.length, 0);
  assert.equal((await view.readMetadata()).pinned, false);
  gate.release.resolve();
  await view.settleRefresh(0);
  await view.tick(1_000);
  assert.equal(view.refreshes.length, 1, "a failed pin must not invalidate or retry the existing read");
  assert.equal((await view.readMetadata()).title, "Changed elsewhere");
});

test("a DOM pin in another project cannot invalidate this project's in-flight title refresh", { timeout: 30_000 }, async context => {
  const view = await fixture(context);
  const gate = view.arm();
  await view.event();
  await gate.entered.promise;
  await (await view.savePinned(true, view.otherId)).result;
  assert.equal(view.probe().activeProjectId, view.project.id);
  assert.equal(view.renames.length, 0);
  gate.release.resolve();
  await view.settleRefresh(0);
  await view.tick(1_000);
  assert.equal(view.refreshes.length, 1);
  assert.equal(view.summary(view.otherId).pinned, true);
  assert.equal(view.summary(view.otherId).metadataRevision, (await view.readMetadata(view.otherId)).revision);
});
