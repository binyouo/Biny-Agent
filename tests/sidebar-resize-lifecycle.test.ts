/** Exercise production Sidebar gestures with inert native capture/layout boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Sidebar } from "../src/desktop/renderer/src/components/Sidebar.js";
import { resolveSidebarLayout } from "../src/desktop/sidebarLayout.js";

test("sidebar resize owns listeners across capture loss, replacement and unmount", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://localhost" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, ResizeObserver, requestAnimationFrame: (): number => 1, cancelAnimationFrame: () => {}, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const noop = () => {};
  let starts = 0;
  const widths: number[] = [], ends: number[] = [];
  const props: React.ComponentProps<typeof Sidebar> = { layout: resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle" }),
    peekDrawerHandlers: { onPointerEnter: noop, onPointerLeave: noop, onPointerMove: noop }, peekDrawerRef: { current: null }, peekTriggerHandlers: { onPointerEnter: noop, onPointerLeave: noop, onPointerMove: noop },
    resizeHandlers: { onResizeStart: () => starts++, onWidthChange: width => widths.push(width), onResizeEnd: width => ends.push(width) }, projects: [], sessions: [],
    onOpenProject: noop, onCreateEmptyProject: noop, onSelectSession: noop,
    onLoadSessionChildren: async () => ({ projectId: "dialogue", parentSessionId: "s0", revision: "r1", sessions: [] }),
    onSessionAction: noop, onDeleteSessions: async () => ({ deleted: [], failures: [], cancelled: false }),
    onProjectPinned: noop, onReorderProjects: noop, onRefreshProject: noop, onRevealProject: noop,
    onOpenTerminalProject: noop, onRenameProject: noop, onNewTask: noop, onNewTopLevelTask: noop,
    onImportSession: noop, onRemoveProject: noop, onSearch: noop, onToggleSidebar: noop };
  const root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(() => root.render(React.createElement(Sidebar, props))); };
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const originalAdd = window.addEventListener.bind(window), originalRemove = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type.startsWith("pointer")) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); }
    originalAdd(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    listeners.get(type)?.delete(listener); originalRemove(type, listener, options);
  }) as typeof window.removeEventListener;
  const pointer = async (target: EventTarget, type: string, id: number, x: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
    Object.defineProperty(event, "pointerId", { value: id });
    await act(() => target.dispatchEvent(event));
  };
  const handle = () => {
    const el = document.querySelector<HTMLDivElement>(".biny-sidebar-resizer")!;
    el.setPointerCapture = () => {};
    return el;
  };
  const count = () => listeners.get("pointermove")?.size ?? 0;
  try {
    await render();
    let el = handle();
    await pointer(el, "pointerdown", 1, 200);
    assert.equal(count(), 1);
    await pointer(window, "pointermove", 1, 220);
    assert.equal(widths.length, 1); assert.equal(widths[0], 280);
    await pointer(el, "lostpointercapture", 1, 220);
    assert.equal(count(), 0, "losing capture must retire the gesture");
    assert.equal(ends.length, 1, "capture loss finishes resizing once");
    assert.equal(ends[0], 280);
    await pointer(window, "pointermove", 1, 300);
    await pointer(window, "pointerup", 1, 300);
    assert.equal(widths.length, 1); assert.equal(ends.length, 1);
    await pointer(el, "pointerdown", 2, 200);
    await pointer(window, "pointermove", 99, 350);
    await pointer(window, "pointerup", 99, 350);
    await pointer(window, "pointercancel", 99, 350);
    await pointer(el, "lostpointercapture", 99, 350);
    assert.equal(widths.length, 1, "another pointer must not change width");
    assert.equal(count(), 1, "another pointer must not end the gesture");
    await pointer(window, "pointermove", 2, 900);
    await pointer(window, "pointerup", 2, 230);
    assert.equal(widths.length, 2); assert.equal(ends.length, 2); assert.equal(count(), 0);
    assert.equal(widths[1], 400); assert.equal(ends[1], 400);
    await pointer(el, "pointerdown", 3, 200);
    const retired = [...listeners.get("pointermove")!][0]!;
    await pointer(el, "pointerdown", 4, 200);
    assert.equal(count(), 1, "replacement owns only one listener");
    const oldEvent = new dom.window.MouseEvent("pointermove", { clientX: 400 });
    Object.defineProperty(oldEvent, "pointerId", { value: 3 });
    await act(() => typeof retired === "function" ? retired(oldEvent) : retired.handleEvent(oldEvent));
    assert.equal(widths.length, 2, "already dispatched retired callback is inert");
    await pointer(window, "pointercancel", 4, 200);
    assert.equal(count(), 0);
    await act(() => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.equal(widths.at(-1), 244); assert.equal(ends.at(-1), 244);
    await pointer(el, "pointerdown", 5, 200);
    props.layout = resolveSidebarLayout({ baseMode: "collapsed", peekPhase: "idle" });
    await render();
    assert.equal(count(), 0, "removing separator retires its gesture");
    props.layout = resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle" });
    await render(); el = handle();
    await pointer(el, "pointerdown", 6, 200);
    await act(() => root.unmount());
    assert.equal(count(), 0, "unmount releases global listeners");
    assert.equal(listeners.get("pointerup")?.size, 0); assert.equal(listeners.get("pointercancel")?.size, 0);
    const finished = ends.length;
    await pointer(window, "pointermove", 6, 400); await pointer(window, "pointerup", 6, 400);
    assert.equal(ends.length, finished); assert.equal(starts, 6);
  } finally {
    await act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
