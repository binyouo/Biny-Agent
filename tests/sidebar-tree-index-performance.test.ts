/** Count actual topology reads in the production Sidebar, not jsdom timing. */
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Sidebar } from "../src/desktop/renderer/src/components/Sidebar.js";
import { resolveSidebarLayout } from "../src/desktop/sidebarLayout.js";
import type { DesktopSessionSummary } from "../src/desktop/protocol.js";

test("sidebar reuses topology across presentation updates and invalidates on new session snapshots", async () => {
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
  let parentReads = 0;
  const at = "2026-11-13T00:00:00.000Z";
  const session = (id: string, parent?: string): DesktopSessionSummary => ({ id, projectId: "dialogue", fileName: `${id}.jsonl`, title: id,
    firstUserMessage: id, lastAssistantMessage: "", eventCount: 1, createdAt: at, updatedAt: at,
    pinned: false, status: "completed", hasChildren: id === "s0",
    get parentSessionId() { parentReads++; return parent; } });
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
    const before = parentReads;
    for (let i = 0; i < 20; i++) {
      props.layout = resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle", expandedWidth: 240 + i });
      await render();
    }
    console.log(JSON.stringify({ workload: "200 sessions / 20 sidebar width updates", parentReads: parentReads - before }));
    assert.equal(parentReads - before, 0, "presentation-only updates must reuse the parent index");
    props.selectedSessionId = "s2";
    await render();
    assert.equal(parentReads, before, "selection does not change topology");
    assert.equal(document.querySelector(".biny-sidebar-session-item[aria-current=page]")?.textContent?.includes("s2"), true);
    // A fresh immutable snapshot must rebuild relationships, not retain stale row objects.
    sessions = sessions.map((s, i) => i === 1 ? session("s1", "s2") : i === 2 ? { ...session("s2"), hasChildren: true } : s);
    props.sessions = sessions;
    await render();
    assert.ok(parentReads > before, "new snapshots invalidate topology");
    assert.equal(document.querySelectorAll(".biny-sidebar-session-tree-row").length, 200);
    const parent2 = [...document.querySelectorAll(".biny-sidebar-session-tree-row")].find(row => row.textContent?.includes("s2"))!;
    assert.ok(parent2.nextElementSibling?.textContent?.includes("s1"), "reparented child renders under its new parent");
    const afterSnapshot = parentReads;
    await act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "收起")!.click());
    assert.ok(parentReads > afterSnapshot, "collapsing changes the visible input slice");
    const collapsedReads = parentReads;
    for (let i = 0; i < 20; i++) {
      props.layout = resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle", expandedWidth: 240 + i });
      await render();
    }
    assert.equal(parentReads, collapsedReads, "collapsed slices also stay stable across layout changes");
    props.sessions = sessions.map(s => s.id === "s0" ? { ...s, title: "updated title", status: "running" } : s);
    await render();
    assert.ok(document.querySelector(".biny-sidebar-session-tree-row")?.textContent?.includes("updated title"));
    assert.equal(Boolean(document.querySelector(".biny-sidebar-session-tree-row")?.querySelector(".biny-sidebar-session-meta")), false, "new running state updates the row");
    props.sessions = [...props.sessions.slice(0, 3), session("loaded-child", "s2")];
    await render();
    assert.equal(document.querySelectorAll(".biny-sidebar-session-tree-row").length, 4, "loaded children invalidate the index");
    assert.ok([...document.querySelectorAll(".biny-sidebar-session-tree-row")].find(row => row.textContent?.includes("s2"))?.nextElementSibling?.textContent?.includes("loaded-child"));
    props.sessions = props.sessions.filter(s => s.id !== "loaded-child");
    await render();
    assert.equal(document.querySelectorAll(".biny-sidebar-session-tree-row").length, 3, "removed children leave the index");
    props.sessions = [];
    await render();
    assert.equal(document.querySelectorAll(".biny-sidebar-session-tree-row").length, 0);
  } finally {
    await act(() => root.unmount()); dom.window.close();
    if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
