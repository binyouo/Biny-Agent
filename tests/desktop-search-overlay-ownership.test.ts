import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { DesktopProject, DesktopSessionSummary } from "../src/desktop/protocol.js";
import type { DesktopWorkspaceFileIndex } from "../src/desktop/projectFiles.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const time = "2026-10-20T00:00:00.000Z";
const projects: DesktopProject[] = ["a", "b"].map(id => ({
  id, name: `Project ${id}`, path: `/synthetic/${id}`, dirty: false, missing: false,
  pinned: false, addedAt: time, lastOpenedAt: time
}));
const sessions: DesktopSessionSummary[] = projects.map(project => ({
  id: `session-${project.id}`, projectId: project.id, fileName: `${project.id}.jsonl`,
  title: `Conversation ${project.id}`, firstUserMessage: `Discuss ${project.id}`, lastAssistantMessage: "",
  createdAt: time, updatedAt: time, eventCount: 1, pinned: false, status: "completed"
}));
const index = (...paths: string[]): DesktopWorkspaceFileIndex => ({
  files: paths.map(path => ({ name: path.split("/").at(-1)!, path })), incomplete: false
});

// Published UI dependencies can retain RAF's function identity across fixtures.
// Forward through the currently owned queue instead of retaining a closed DOM.
let frameHost: { request(callback: FrameRequestCallback): number; cancel(id: number): void } | undefined;
let nextFrame = 0;
function requestFrame(callback: FrameRequestCallback): number {
  assert.ok(frameHost, "Animation frames need an active fixture");
  return frameHost.request(callback);
}
function cancelFrame(id: number): void { frameHost?.cancel(id); }

async function fixture(t: TestContext) {
  const resources: { dom?: JSDOM; root?: Root; React?: typeof import("react") } = {};
  const restore: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const scans: Array<{ projectId: string; gate: ReturnType<typeof deferred<DesktopWorkspaceFileIndex>> }> = [];
  const files: Array<{ projectId: string | undefined; path: string }> = [];
  const projectSelections: string[] = [];
  const sessionSelections: Array<[string, string]> = [];
  const network: string[] = [];
  let timersEnabled = false;
  let selectedProjectId: string | undefined = "a";
  let open = true;
  let currentSessions = sessions;

  // Install teardown before any fallible import, DOM replacement, or render.
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      if (resources.React) await resources.React.act(async () => {
        for (const scan of scans) scan.gate.resolve(index());
        await Promise.allSettled(scans.map(scan => scan.gate.promise));
        if (timersEnabled) t.mock.timers.runAll();
      });
    } catch (error) { errors.push(error); }
    try {
      if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount());
    } catch (error) { errors.push(error); }
    try { resources.dom?.window.close(); } catch (error) { errors.push(error); }
    try { if (timersEnabled) t.mock.timers.reset(); } catch (error) { errors.push(error); }
    frames.clear();
    frameHost = undefined;
    for (const undo of restore.reverse()) {
      try { undo(); } catch (error) { errors.push(error); }
    }
    assert.deepEqual(network, [], "The renderer fixture must not contact external services");
    if (errors.length) throw new AggregateError(errors, "Search fixture cleanup failed");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    restore.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  const { JSDOM: DOM } = await import("jsdom");
  const dom = new DOM('<!doctype html><button id="outside">Outside</button><div id="root"></div>',
    { url: "https://biny.test", pretendToBeVisual: true });
  resources.dom = dom;
  const window = dom.window;
  const document = window.document;
  assert.equal(frameHost, undefined);
  frameHost = {
    request(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancel(id) { frames.delete(id); }
  };
  class LayoutObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  for (const [key, value] of Object.entries({
    window, document, self: window, navigator: window.navigator, CSS: window.CSS,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLDialogElement: window.HTMLDialogElement, HTMLInputElement: window.HTMLInputElement,
    Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: LayoutObserver,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    IS_REACT_ACT_ENVIRONMENT: true
  })) replace(globalThis, key, value);
  replace(window, "requestAnimationFrame", requestFrame);
  replace(window, "cancelAnimationFrame", cancelFrame);
  replace(window, "ResizeObserver", LayoutObserver);
  replace(window, "matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true
  }));
  replace(window.HTMLElement.prototype, "scrollIntoView", () => {});
  replace(window.HTMLCanvasElement.prototype, "getContext", () => null);
  replace(window, "scrollTo", () => {});
  replace(window.HTMLDialogElement.prototype, "showModal", function (this: HTMLDialogElement): void { this.open = true; });
  replace(window.HTMLDialogElement.prototype, "close", function (this: HTMLDialogElement): void { this.open = false; });
  t.mock.method(globalThis, "fetch", async () => { network.push("fetch"); throw new Error("Unexpected fetch"); });
  t.mock.method(Socket.prototype, "connect", () => { network.push("socket"); throw new Error("Unexpected socket"); });
  replace(window, "biny", {
    workspaceFileIndex(projectId: string) {
      const gate = deferred<DesktopWorkspaceFileIndex>();
      scans.push({ projectId, gate });
      return gate.promise;
    }
  });
  const React = await import("react");
  resources.React = React;
  replace(globalThis, "React", React);
  // Own the dependency's live-region auto-clear timers, including failure
  // teardown paths that never selected an item or explicitly closed search.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  timersEnabled = true;
  const { createRoot } = await import("react-dom/client");
  const { SearchOverlay } = await import("../src/desktop/renderer/src/components/overlays/SearchOverlay.js");
  const { act, createElement } = React;
  const root = createRoot(document.getElementById("root")!);
  resources.root = root;
  const draw = (): void => root.render(createElement(SearchOverlay, {
    open, projects, sessions: currentSessions, selectedProjectId,
    onClose() { open = false; draw(); },
    onFile(path) { files.push({ projectId: selectedProjectId, path }); },
    onProject(projectId) { projectSelections.push(projectId); },
    onSession(projectId, sessionId) { sessionSelections.push([projectId, sessionId]); }
  }));
  const render = async (projectId: string | undefined = selectedProjectId, isOpen = true): Promise<void> => {
    selectedProjectId = projectId; open = isOpen;
    await act(async () => { draw(); });
  };
  const input = (): HTMLInputElement => {
    const found = document.querySelector<HTMLInputElement>('dialog[open] input[role="combobox"]');
    assert.ok(found, "The actual command palette input must be open");
    return found;
  };
  const type = async (query: string): Promise<void> => {
    await act(async () => {
      const field = input();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, query);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(input().value, query, "The real input must accept the query");
  };
  const options = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('dialog[open] [role="option"]')];
  const fileOptions = (): HTMLElement[] => options().filter(option => option.dataset.value?.startsWith("file:"));
  const resolve = async (scan: number, result: DesktopWorkspaceFileIndex): Promise<void> => {
    assert.ok(scans[scan], `Expected scan ${scan}`);
    await act(async () => { scans[scan]!.gate.resolve(result); await scans[scan]!.gate.promise; });
  };
  const choose = async (value: string): Promise<void> => {
    const option = options().find(item => item.dataset.value === value);
    assert.ok(option, `Expected selectable ${value}`);
    await act(async () => { option.click(); });
  };
  const assertNoStaleSelection = async (): Promise<void> => {
    // Exercise the actual stale option if the regression is present. A stale
    // path would otherwise be passed to App's current-project file inspector.
    const stale = fileOptions();
    if (stale[0]) await act(async () => { stale[0]!.click(); });
    assert.deepEqual(files, [], "A previous workspace result must not open a path under the new project");
    assert.equal(stale.length, 0, "A previous workspace must not leave selectable file rows");
  };
  document.getElementById("outside")!.focus();
  await render();
  assert.deepEqual(scans.map(scan => scan.projectId), ["a"]);
  return {
    scans, files, projectSelections, sessionSelections, render, input, type, resolve, choose,
    fileOptions, assertNoStaleSelection, storage: window.localStorage,
    activeElementId: () => document.activeElement?.id,
    async frame() {
      await act(async () => {
        for (const [id, callback] of [...frames]) { frames.delete(id); callback(16); }
      });
    },
    async key(key: string) { await act(async () => { input().dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })); }); },
    async refreshSessions() { currentSessions = sessions.map(session => ({ ...session })); await act(async () => { draw(); }); }
  };
}

test("workspace search rejects a late index result after the selected project changes", async t => {
  const h = await fixture(t);
  await h.type("shared");
  await h.render("b");
  assert.deepEqual(h.scans.map(scan => scan.projectId), ["a", "b"]);
  await h.resolve(0, index("a/shared.txt"));
  await h.assertNoStaleSelection();
  await h.type("shared");
  await h.resolve(1, index("b/shared.txt"));
  await h.choose("file:b:b/shared.txt");
  assert.deepEqual(h.files, [{ projectId: "b", path: "b/shared.txt" }]);
});

test("workspace search retires already displayed file results when the project changes", async t => {
  const h = await fixture(t);
  await h.resolve(0, index("a/shared.txt"));
  await h.type("shared");
  assert.deepEqual(h.fileOptions().map(item => item.dataset.value), ["file:a:a/shared.txt"]);
  await h.render("b");
  await h.assertNoStaleSelection();
  assert.equal(h.input().value, "");
  await h.resolve(1, index("b/shared.txt"));
  await h.type("shared");
  await h.choose("file:b:b/shared.txt");
  assert.deepEqual(h.files, [{ projectId: "b", path: "b/shared.txt" }]);
});

test("returning to the same workspace does not revive its previous search lifetime", async t => {
  const h = await fixture(t);
  await h.type("shared");
  await h.render("b");
  await h.render("a");
  assert.deepEqual(h.scans.map(scan => scan.projectId), ["a", "b", "a"]);
  await h.resolve(0, index("old/shared.txt"));
  await h.resolve(1, index("b/shared.txt"));
  await h.assertNoStaleSelection();
  await h.type("shared");
  await h.resolve(2, index("new/shared.txt"));
  await h.choose("file:a:new/shared.txt");
  assert.deepEqual(h.files, [{ projectId: "a", path: "new/shared.txt" }]);
});

test("closing and reopening search discards a pending previous scan", async t => {
  const h = await fixture(t);
  await h.frame();
  await h.type("shared");
  await h.key("Escape");
  assert.equal(h.activeElementId(), "outside", "Close must return focus to the original opener");
  await h.resolve(0, index("old/shared.txt"));
  assert.deepEqual(h.files, []);
  await h.render("a");
  assert.deepEqual(h.scans.map(scan => scan.projectId), ["a", "a"]);
  assert.equal(h.input().value, "");
  await h.type("shared");
  await h.resolve(1, index("new/shared.txt"));
  assert.deepEqual(h.fileOptions().map(item => item.dataset.value), ["file:a:new/shared.txt"]);
  await h.choose("file:a:new/shared.txt");
  assert.deepEqual(h.files, [{ projectId: "a", path: "new/shared.txt" }]);
  assert.equal(h.activeElementId(), "outside", "Selection must return focus to the opener");
});

test("switching the search project preserves dialog focus return on Escape", async t => {
  const h = await fixture(t);
  await h.frame();
  await h.render("b");
  await h.frame();
  await h.key("Escape");
  assert.equal(h.activeElementId(), "outside", "A project change must not replace the dialog's opener");
  assert.deepEqual(h.files, []);
});

test("same-project query supersession and ordinary source refresh keep the latest query", async t => {
  const h = await fixture(t);
  await h.type("alpha");
  await h.type("beta");
  await h.refreshSessions();
  assert.equal(h.input().value, "beta");
  assert.equal(h.scans.length, 1, "A catalog refresh must not remount the same search owner");
  await h.resolve(0, index("alpha.txt", "beta.txt"));
  assert.deepEqual(h.fileOptions().map(item => item.dataset.value), ["file:a:beta.txt"]);
  await h.key("ArrowDown");
  await h.key("Enter");
  assert.deepEqual(h.files, [{ projectId: "a", path: "beta.txt" }]);
  assert.deepEqual(JSON.parse(h.storage.getItem("biny.desktop.recent-searches") ?? "null"), ["beta"]);
});

test("a failed file scan preserves project and session search navigation", async t => {
  const h = await fixture(t);
  h.scans[0]!.gate.reject(new Error("Synthetic scan failure"));
  await h.type("Conversation b");
  await h.choose("session:b:session-b");
  assert.deepEqual(h.sessionSelections, [["b", "session-b"]]);
  assert.deepEqual(h.files, []);
  await h.render("a");
  await h.resolve(1, index());
  await h.type("Project b");
  await h.choose("project:b");
  assert.deepEqual(h.projectSelections, ["b"]);
});
