import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopBootstrap, DesktopProject, DesktopRuntimeMutation, DesktopRuntimeProjection, DesktopSessionDocument, DesktopSessionHandoff, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import { applyRuntimeControlReceipt, readRuntimeControlReceipt } from "../src/desktop/renderer/src/app/runtimeControlProjection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const time = "2026-11-03T00:00:00.000Z";
function project(id: string): DesktopProject {
  return { id, name: `Project ${id}`, path: `/synthetic/${id}`, dirty: false, missing: false, pinned: false, addedAt: time, lastOpenedAt: time };
}
function session(projectId: string, id = `session-${projectId}`): DesktopSessionSummary {
  return { id, projectId, fileName: `${id}.jsonl`, title: `Conversation ${id}`, firstUserMessage: "Discuss", lastAssistantMessage: "", createdAt: time, updatedAt: time, eventCount: 1, pinned: false, status: "completed", isolation: "worktree" };
}
function task(taskRunId = "task-target", status = "running", revision = 1) {
  return { taskRunId, workspaceId: "workspace", status, revision, task: { prompt: taskRunId }, createdAt: time, updatedAt: time, attempts: [] };
}
function graph(graphId = "graph-target", status = "running", revision = 1) {
  return { graphId, workspaceId: "workspace", status, revision, mode: "supervised", supervisorSessionId: "session-a", maxReplans: 3, replanCount: 0, payload: {}, createdAt: time, updatedAt: time, nodes: [] };
}
function projection(): DesktopRuntimeProjection {
  return { tasks: { tasks: [task(), task("task-other")], hasMore: true, nextCursor: 8 }, graphs: [graph(), graph("graph-other")],
    automations: [{ automationId: "automation" }], pendingFires: [{ fireId: "fire" }], capabilities: [{ capabilityId: "capability" }],
    worktrees: ["a", "b"].map(id => ({ sessionId: `session-${id}`, status: "active", exists: true, dirty: false, mergedIntoBase: false })) };
}
function workspace(id: string): DesktopWorkspaceSnapshot {
  return { project: project(id), sessions: [session(id), session(id, `second-${id}`)], permissionMode: "ask", capabilityDefaults: { tools: "auto", skills: "auto" }, requiresModelConfiguration: false,
    models: [], pickerModels: [], connections: [], runtimeProjection: projection() };
}
let frameHost: Map<number, FrameRequestCallback> | undefined;
let nextFrame = 0;
function requestFrame(callback: FrameRequestCallback): number { const id = ++nextFrame; frameHost?.set(id, callback); return id; }
function cancelFrame(id: number): void { frameHost?.delete(id); }

// Mount the production App and RuntimePanel. Only IPC, assets and native DOM
// facilities are replaced; no extracted App handler or component substitutes.
async function fixture(t: TestContext) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react"); imports?: ReturnType<typeof registerHooks> } = {};
  const restore: Array<() => void> = [];
  const unknown: string[] = [];
  const network: string[] = [];
  const reads: Array<{ projectId: string; gate: ReturnType<typeof deferred<DesktopRuntimeProjection>> }> = [];
  const mutations: Array<{ projectId: string; operation: DesktopRuntimeMutation; payload: Record<string, unknown>; gate: ReturnType<typeof deferred<unknown>> }> = [];
  const listeners = new Map<string, (value: DesktopSessionHandoff) => void>();
  let timersEnabled = false;
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.root && resources.React) await resources.React.act(async () => {
        resources.root!.unmount();
        for (const mutation of mutations) mutation.gate.resolve(undefined);
        await Promise.allSettled(mutations.map(item => item.gate.promise));
        for (const read of reads) read.gate.resolve(projection());
        await Promise.allSettled(reads.map(item => item.gate.promise));
      });
    } catch (error) { errors.push(error); }
    try { resources.dom?.window.close(); } catch (error) { errors.push(error); }
    try { if (timersEnabled) t.mock.timers.reset(); } catch (error) { errors.push(error); }
    resources.imports?.deregister(); frameHost = undefined;
    for (const undo of restore.reverse()) { try { undo(); } catch (error) { errors.push(error); } }
    assert.deepEqual(network, [], "No external network calls");
    assert.deepEqual(unknown, [], "All IPC effects have explicit inert boundaries");
    if (errors.length) throw new AggregateError(errors, "Runtime App fixture cleanup failed");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  resources.imports = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@xterm/xterm") return next("@xterm/xterm/lib/xterm.mjs", context);
      if (specifier === "@xterm/addon-fit") return next("@xterm/addon-fit/lib/addon-fit.mjs", context);
      return next(specifier, context);
    }, load(url, context, next) {
      if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
      return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
    }
  });
  const { JSDOM: DOM } = await import("jsdom");
  const dom = new DOM('<!doctype html><div id="root"></div>', { url: "https://desktop.test", pretendToBeVisual: true });
  resources.dom = dom;
  const window = dom.window; const document = window.document;
  frameHost = new Map();
  class LayoutObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({ window, document, self: window, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, HTMLDialogElement: window.HTMLDialogElement,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect, getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: LayoutObserver, CSS: { escape: (value: string) => value, supports: () => false },
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
  replace(window, "scrollTo", () => {}); replace(window, "confirm", () => true);
  t.mock.method(globalThis, "fetch", async () => { network.push("fetch"); throw new Error("Unexpected fetch"); });
  t.mock.method(Socket.prototype, "connect", () => { network.push("socket"); throw new Error("Unexpected socket"); });
  const api: Record<string, unknown> = {
    bootstrap: async (): Promise<DesktopBootstrap> => ({ version: "test", platform: "linux", projects: [project("a"), project("b")],
      sidebarSessions: [session("a"), session("a", "second-a"), session("b")], workspace: workspace("a"), activeView: "runtime",
      sidebarWidth: 240, filePanelWidth: 320, themePreference: "light", fontPreference: { family: "system", size: 14 } }),
    selectProject: async (id: string) => workspace(id),
    openSession: async (id: string, sessionId: string): Promise<DesktopSessionDocument> => ({ session: session(id, sessionId), events: [{ type: "user_message", content: `Discuss ${id}` }], liveEvents: [] }),
    commitSelection: async () => {}, setActiveView: async () => {},
    listSessionTreePage: async (id: string) => ({ sessions: workspace(id).sessions, hasMore: false, revision: "1" }),
    skillCatalog: async () => ({ skills: [], warnings: [] }), skillSettings: async () => ({ activations: [] }), toolCatalog: async () => [],
    listProjectBranches: async () => [], recipeSuggestions: async () => [], planProjection: async () => ({ plans: [] }), activitySuggestions: async () => [],
    setSidebarWidth: async () => {}, setFilePanelWidth: async () => {},
    runtimeProjection(projectId: string) { const gate = deferred<DesktopRuntimeProjection>(); reads.push({ projectId, gate }); return gate.promise; },
    runtimeMutation(projectId: string, operation: DesktopRuntimeMutation, payload: Record<string, unknown>) { const gate = deferred<unknown>(); mutations.push({ projectId, operation, payload, gate }); return gate.promise; }
  };
  for (const name of ["onAppearanceChanged", "onApplicationImportsChanged", "onAgentEvent", "onSessionHandoff", "onMenuAction", "onSettingsCloseRequest", "onBrowserOpenRequest", "onReferenceOpen"]) {
    api[name] = (listener: (value: DesktopSessionHandoff) => void) => { listeners.set(name, listener); return () => listeners.delete(name); };
  }
  replace(window, "biny", new Proxy(api, { get(target, name: string) {
    if (name in target) return target[name];
    return () => { unknown.push(name); throw new Error(`Unexpected IPC ${name}`); };
  } }));
  const React = await import("react"); resources.React = React; replace(globalThis, "React", React);
  t.mock.timers.enable({ apis: ["setTimeout"] }); timersEnabled = true;
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/desktop/renderer/src/App.js");
  const root = createRoot(document.getElementById("root")!); resources.root = root;
  await React.act(async () => root.render(React.createElement(App, { settingsEnabled: false })));
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector); assert.ok(button, selector); assert.equal(button.disabled, false);
    await React.act(async () => button.click());
  };
  await click('[aria-label="刷新后台运行状态"]');
  return { document, React, reads, mutations, click,
    text: () => document.body.textContent ?? "",
    row: (id: string) => document.querySelector(`[title="${id}"]`)!.closest(".biny-runtime-row")!,
    async navigate(projectId: string, sessionId = `session-${projectId}`) {
      await React.act(async () => listeners.get("onSessionHandoff")!({ projectId, sessionId }));
      await click(".biny-worktree-indicator");
    },
    async resolveRead(index: number, value = projection()) { await React.act(async () => reads[index]!.gate.resolve(value)); },
    async resolveMutation(index: number, value: unknown) { await React.act(async () => mutations[index]!.gate.resolve(value)); }
  };
}

async function control(h: Awaited<ReturnType<typeof fixture>>, id: string) {
  const button = h.row(id).querySelector<HTMLButtonElement>("button")!;
  assert.ok(button); assert.equal(button.disabled, false);
  await h.React.act(async () => button.click());
}

test("task cancel and graph pause/resume use receipts without rereading unrelated runtime domains", { timeout: 30_000 }, async t => {
  const h = await fixture(t); await h.resolveRead(0);
  const unrelated = () => [h.row("task-other").textContent, h.row("Graph · graph-other").textContent, h.document.querySelector(".biny-runtime-panel-footer")!.textContent];
  const before = unrelated();
  for (const [id, operation, receipt, status] of [
    ["task-target", "task.cancel", task("task-target", "cancelled", 2), "cancelled"],
    ["Graph · graph-target", "graph.pause", graph("graph-target", "paused", 2), "paused"],
    ["Graph · graph-target", "graph.resume", graph("graph-target", "running", 3), "running"]
  ] as const) {
    await control(h, id); const index = h.mutations.length - 1;
    assert.equal(h.mutations[index]!.operation, operation); assert.equal(h.mutations[index]!.projectId, "a");
    await h.resolveMutation(index, receipt);
    assert.equal(h.reads.length, 1, `${operation} must not read the six-domain projection`);
    assert.equal(h.row(id).querySelector("small")!.textContent, status);
    assert.deepEqual(unrelated(), before);
  }
  await h.click('[aria-label="刷新后台运行状态"]'); assert.equal(h.reads.length, 2);
  const fresh = projection(); fresh.graphs = [graph("graph-target", "completed", 4), graph("graph-other")];
  await h.resolveRead(1, fresh);
  assert.equal(h.row("Graph · graph-target").querySelector("small")!.textContent, "completed");
});

test("a projection already reading cannot roll a control receipt back", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  await control(h, "Graph · graph-target");
  await h.resolveMutation(0, graph("graph-target", "paused", 2));
  await h.resolveRead(0);
  assert.equal(h.row("Graph · graph-target").querySelector("small")!.textContent, "paused");
  assert.equal(h.reads.length, 1);
});

for (const operation of ["graph.pause", "task.cancel"] as const) {
  test(`reopening the panel during ${operation} preserves its full refresh demand exactly once`, { timeout: 15_000 }, async t => {
    const h = await fixture(t); await h.resolveRead(0);
    await h.navigate("a");
    const initial = projection();
    if (operation === "task.cancel") initial.graphs = [{ ...graph(), nodes: [{ nodeId: "node", taskRunId: "task-target", status: "running" }] }, graph("graph-other")];
    await h.resolveRead(h.reads.length - 1, initial);
    const id = operation === "graph.pause" ? "Graph · graph-target" : "task-target";
    const status = operation === "graph.pause" ? "paused" : "cancelled";
    await control(h, id);
    await h.click('[aria-label="关闭后台运行面板"]');
    const before = h.reads.length;
    await h.click(".biny-worktree-indicator");
    assert.equal(h.reads.length, before + 1);
    await h.resolveMutation(0, operation === "graph.pause" ? graph("graph-target", "paused", 2) : task("task-target", "cancelled", 2));
    assert.equal(h.reads.length, before + 2, "the newer refresh demand is retained; an associated graph does not add a second reread");
    await h.resolveRead(before, initial);
    assert.equal(h.row(id).querySelector("small")!.textContent, status, "the retired read cannot roll the control back");
    const fresh = projection();
    fresh.graphs = [graph("graph-target", operation === "graph.pause" ? "paused" : "blocked", 3), graph("graph-other", "completed", 2)];
    if (operation === "task.cancel") fresh.tasks = { tasks: [task("task-target", "cancelled", 2), task("task-other")], hasMore: false };
    await h.resolveRead(before + 1, fresh);
    assert.equal(h.row("Graph · graph-other").querySelector("small")!.textContent, "completed");
    assert.equal(h.row(id).querySelector("small")!.textContent, status);
    assert.equal(h.reads.length, before + 2);
  });
}

test("a late receipt cannot replace a row already at a newer authority revision", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  await control(h, "Graph · graph-target");
  const fresh = projection(); fresh.graphs = [graph("graph-target", "completed", 5), graph("graph-other")];
  await h.resolveRead(0, fresh);
  await h.resolveMutation(0, graph("graph-target", "paused", 2));
  assert.equal(h.row("Graph · graph-target").querySelector("small")!.textContent, "completed");
  assert.equal(h.reads.length, 1);
});

for (const route of [["b"], ["b", "a"], ["a"]]) {
  test(`control receipt is retired after navigation ${route.join(" -> ")}`, { timeout: 15_000 }, async t => {
    const h = await fixture(t); await h.resolveRead(0);
    await control(h, "Graph · graph-target");
    for (const id of route) { await h.navigate(id, id === "a" ? "second-a" : "session-b"); await h.resolveRead(h.reads.length - 1); }
    const reads = h.reads.length;
    await h.resolveMutation(0, graph("graph-target", "paused", 2));
    assert.equal(h.row("Graph · graph-target").querySelector("small")!.textContent, "running");
    assert.equal(h.reads.length, reads, "An old control does not refresh the new navigation");
  });
}

for (const [name, receipt] of [
  ["another target", graph("graph-other", "paused", 2)],
  ["invalid status", graph("graph-target", "invented", 2)],
  ["missing revision", { ...graph("graph-target", "paused"), revision: undefined }],
  ["missing graph nodes", { ...graph("graph-target", "paused", 2), nodes: undefined }]
] as const) {
  test(`invalid ${name} receipt preserves the row and reports failure`, { timeout: 15_000 }, async t => {
    const h = await fixture(t); await h.resolveRead(0); await control(h, "Graph · graph-target");
    await h.resolveMutation(0, receipt);
    assert.equal(h.row("Graph · graph-target").querySelector("small")!.textContent, "running");
    assert.match(h.text(), /回执/u); assert.equal(h.reads.length, 1);
  });
}

test("failed control leaves the visible row unchanged", { timeout: 15_000 }, async t => {
  const h = await fixture(t); await h.resolveRead(0); await control(h, "task-target");
  await h.React.act(async () => h.mutations[0]!.gate.reject(new Error("synthetic cancel failure")));
  assert.equal(h.row("task-target").querySelector("small")!.textContent, "running");
  assert.match(h.text(), /synthetic cancel failure/u); assert.equal(h.reads.length, 1);
});

test("cancel uses the actual terminal receipt if the task finished before cancellation", { timeout: 15_000 }, async t => {
  const h = await fixture(t); await h.resolveRead(0); await control(h, "task-target");
  await h.resolveMutation(0, task("task-target", "completed", 2));
  assert.equal(h.row("task-target").querySelector("small")!.textContent, "completed");
  assert.equal(h.row("task-target").querySelector("button"), null);
  assert.equal(h.reads.length, 1);
});

for (const hasVisibleLink of [true, false]) test(`graph task cancellation refreshes its closure with ${hasVisibleLink ? "visible" : "not yet projected"} node association`, { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  const taskRunId = hasVisibleLink ? "task-target" : "graph:graph-target:node";
  const linked = projection();
  linked.tasks = { tasks: [task(taskRunId), task("task-other")], hasMore: false };
  if (hasVisibleLink) linked.graphs = [{ ...graph(), nodes: [{ nodeId: "node", taskRunId, status: "running" }] }, graph("graph-other")];
  await h.resolveRead(0, linked); await control(h, taskRunId);
  await h.resolveMutation(0, task(taskRunId, "cancelled", 2));
  assert.equal(h.row(taskRunId).querySelector("small")!.textContent, "cancelled");
  assert.equal(h.reads.length, 2, "Cancellation also changes its graph; retain the existing full read for this case");
  const closed = projection(); closed.tasks = { tasks: [task(taskRunId, "cancelled", 2), task("task-other")], hasMore: false };
  closed.graphs = [{ ...graph("graph-target", "blocked", 2), nodes: [{ nodeId: "node", taskRunId, status: "failed" }] }, graph("graph-other")];
  await h.resolveRead(1, closed);
  assert.equal(h.row("Graph · graph-target").querySelector("small")!.textContent, "blocked");
  assert.equal(h.row("task-other").querySelector("small")!.textContent, "running");
});

test("worktree actions still refresh the complete runtime projection", { timeout: 15_000 }, async t => {
  const h = await fixture(t); await h.resolveRead(0); await h.navigate("a"); await h.resolveRead(1);
  const button = [...h.document.querySelectorAll<HTMLButtonElement>(".biny-runtime-worktree button")].find(node => node.textContent?.includes("合并到项目"));
  assert.ok(button); await h.React.act(async () => button.click());
  assert.equal(h.mutations[0]!.operation, "worktree.merge");
  await h.resolveMutation(0, { sessionId: "session-a" });
  assert.equal(h.reads.length, 3); await h.resolveRead(2);
});

test("receipt projection keeps unrelated domains, rows and pagination, and replaces the complete target record", () => {
  const before = projection();
  const page = before.tasks as { tasks: Array<ReturnType<typeof task>>; hasMore: boolean; nextCursor: number };
  Object.assign(page.tasks[0]!, { removedField: "old-only" });
  const cancelled = { ...task("task-target", "cancelled", 2), terminalEventId: "terminal", attempts: [{ attemptId: "attempt", status: "cancelled" }] };
  const afterTask = applyRuntimeControlReceipt(before, readRuntimeControlReceipt("task.cancel", { taskRunId: "task-target" }, cancelled))!;
  const nextPage = afterTask.tasks as typeof page;
  assert.equal(nextPage.tasks[0], cancelled);
  assert.equal("removedField" in nextPage.tasks[0]!, false);
  assert.equal(nextPage.tasks[1], page.tasks[1]);
  assert.equal(nextPage.hasMore, true); assert.equal(nextPage.nextCursor, 8);
  assert.equal(page.tasks[0]!.status, "running", "Do not mutate the preceding snapshot");
  for (const key of ["graphs", "automations", "pendingFires", "capabilities", "worktrees"] as const) assert.equal(afterTask[key], before[key]);
  const paused = { ...graph("graph-target", "paused", 2), nodes: [{ nodeId: "node", status: "running" }] };
  const afterGraph = applyRuntimeControlReceipt(afterTask, readRuntimeControlReceipt("graph.pause", { graphId: "graph-target" }, paused))!;
  assert.equal((afterGraph.graphs as unknown[])[0], paused);
  assert.equal((afterGraph.graphs as unknown[])[1], (before.graphs as unknown[])[1]);
  for (const key of ["tasks", "automations", "pendingFires", "capabilities", "worktrees"] as const) assert.equal(afterGraph[key], afterTask[key]);
});

test("out-of-order and duplicate receipts cannot replace a newer graph row or insert absent targets", () => {
  const before = projection();
  const resumed = readRuntimeControlReceipt("graph.resume", { graphId: "graph-target" }, graph("graph-target", "running", 3));
  const newest = applyRuntimeControlReceipt(before, resumed);
  const paused = readRuntimeControlReceipt("graph.pause", { graphId: "graph-target" }, graph("graph-target", "paused", 2));
  assert.equal(applyRuntimeControlReceipt(newest, paused), newest);
  assert.equal(applyRuntimeControlReceipt(newest, resumed), newest);
  assert.equal(applyRuntimeControlReceipt(undefined, resumed), undefined);
  const missing = readRuntimeControlReceipt("task.cancel", { taskRunId: "not-in-page" }, task("not-in-page", "cancelled", 2));
  assert.equal(applyRuntimeControlReceipt(before, missing), before);
});
