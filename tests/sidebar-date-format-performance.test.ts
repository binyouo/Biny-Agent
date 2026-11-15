/** Count actual Intl construction, not jsdom timing or native FPS. */
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Sidebar } from "../src/desktop/renderer/src/components/Sidebar.js";
import { resolveSidebarLayout } from "../src/desktop/sidebarLayout.js";
import type { DesktopSessionSummary } from "../src/desktop/protocol.js";

test("sidebar reuses a date formatter per list render while preserving timestamps and updates", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://localhost" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, ResizeObserver, requestAnimationFrame: (): number => 1, cancelAnimationFrame: () => {}, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const originalTZ = process.env.TZ;
  process.env.TZ = "UTC";
  let formatterConstructions = 0;
  const OriginalFormatter = Intl.DateTimeFormat;
  Intl.DateTimeFormat = new Proxy(OriginalFormatter, { construct(target, args) {
    formatterConstructions++; return Reflect.construct(target, args);
  } });
  const at = "2026-11-13T00:00:00.000Z";
  const session = (id: string, parent?: string): DesktopSessionSummary => ({ id, projectId: "dialogue", fileName: `${id}.jsonl`, title: id,
    firstUserMessage: id, lastAssistantMessage: "", eventCount: 1, createdAt: at, updatedAt: at,
    pinned: false, status: "completed", hasChildren: id === "s0",
    parentSessionId: parent });
  const noop = () => {};
  let sessions = Array.from({ length: 200 }, (_, i) => session(`s${i}`, i === 1 ? "s0" : undefined));
  const props: React.ComponentProps<typeof Sidebar> = { layout: resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle" }),
    peekDrawerHandlers: { onPointerEnter: noop, onPointerLeave: noop, onPointerMove: noop }, peekDrawerRef: { current: null }, peekTriggerHandlers: { onPointerEnter: noop, onPointerLeave: noop, onPointerMove: noop },
    resizeHandlers: { onResizeStart: noop, onWidthChange: noop, onResizeEnd: noop }, projects: [], sessions,
    onOpenProject: noop, onCreateEmptyProject: noop, onSelectSession: noop,
    onLoadSessionChildren: async () => ({ projectId: "dialogue", parentSessionId: "s0", revision: "r1", sessions: [] }),
    onSessionAction: noop, onDeleteSessions: async () => ({ deleted: [], failures: [], cancelled: false }),
    onProjectPinned: noop, onReorderProjects: noop, onRefreshProject: noop, onRevealProject: noop,
    onOpenTerminalProject: noop, onRenameProject: noop, onNewTask: noop, onNewTopLevelTask: noop,
    onImportSession: noop, onRemoveProject: noop, onSearch: noop, onToggleSidebar: noop };
  const root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(() => root.render(React.createElement(Sidebar, props))); };
  const more = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "显示更多")!;
  try {
    await render();
    await act(() => more().click());
    assert.equal(document.querySelectorAll(".biny-sidebar-session-tree-row").length, 200);
    const timestamps = [...document.querySelectorAll<HTMLElement>(".biny-sidebar-session-meta")].map(node => node.title);
    assert.equal(timestamps[0], new OriginalFormatter("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(at)));
    const before = formatterConstructions;
    for (let i = 0; i < 20; i++) {
      props.layout = resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle", expandedWidth: 240 + i });
      await render();
    }
    console.log(JSON.stringify({ workload: "200 sessions / 20 sidebar width updates", formatterConstructions: formatterConstructions - before }));
    assert.equal(formatterConstructions - before, 20, "one formatter per populated list render, not per session row");
    assert.deepEqual([...document.querySelectorAll<HTMLElement>(".biny-sidebar-session-meta")].map(node => node.title), timestamps);
    sessions = sessions.map((s, i) => i === 1 ? { ...session("s1", "s0"), updatedAt: "2026-11-12T01:00:00.000Z" } : s);
    props.sessions = sessions;
    await render();
    assert.equal(document.querySelectorAll(".biny-sidebar-session-tree-row").length, 200);
    assert.ok([...document.querySelectorAll<HTMLElement>(".biny-sidebar-session-meta")].some(node => node.title === new OriginalFormatter("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-11-12T01:00:00.000Z"))));
    process.env.TZ = "Asia/Tokyo";
    props.layout = resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle", expandedWidth: 270 });
    await render();
    const tokyo = new OriginalFormatter("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(new Date(at));
    assert.notEqual(tokyo, timestamps[0]);
    assert.equal(document.querySelector<HTMLElement>(".biny-sidebar-session-meta")!.title, tokyo, "a later render must follow the current system time zone");
    const beforeHiddenDates = formatterConstructions;
    props.sessions = [
      { ...session("running"), status: "running" },
      { ...session("invalid"), updatedAt: "invalid" }
    ];
    await render();
    assert.equal(formatterConstructions, beforeHiddenDates, "running and invalid dates need no formatter");
    assert.equal(document.querySelectorAll(".biny-sidebar-session-meta").length, 0);
    props.sessions = [];
    await render();
    assert.equal(formatterConstructions, beforeHiddenDates, "empty lists need no formatter");
  } finally {
    await act(() => root.unmount()); dom.window.close();
    Intl.DateTimeFormat = OriginalFormatter;
    if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
