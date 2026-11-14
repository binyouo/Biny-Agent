/** Real TerminalView with inert PTY, terminal renderer and DOM layout boundaries. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopTerminalEvent, DesktopTerminalHandle } from "../src/desktop/protocol.js";

test("failed terminal connection retires its event subscription and explicit retry gets a fresh one", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const React = await import("react");
  const listeners = new Set<(event: DesktopTerminalEvent) => void>();
  const unsubscribes: number[] = [];
  const writes: string[] = [];
  const requests: { resolve(value: DesktopTerminalHandle): void; reject(reason: Error): void }[] = [];
  const globals = new Map<string, PropertyDescriptor | undefined>();
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), biny: {
    listTerminals: async () => [{ terminalId: "old", slotId: "default" }],
    createTerminal: () => new Promise<DesktopTerminalHandle>((resolve, reject) => requests.push({ resolve, reject })),
    onTerminalEvent: (listener: (event: DesktopTerminalEvent) => void) => {
      const index = unsubscribes.push(0) - 1;
      listeners.add(listener);
      return () => { unsubscribes[index]!++; listeners.delete(listener); };
    },
    writeTerminal() { assert.fail("no terminal input expected"); },
    resizeTerminal() { assert.fail("inert layout must not resize"); }
  } });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true, terminalFailureWrites: writes })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@xterm/xterm" || specifier === "@xterm/addon-fit") return { url: `failure-test:${specifier}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
      if (url === "failure-test:@xterm/xterm") return { format: "module", shortCircuit: true, source: `
        export class Terminal {
          constructor() { this.options = {}; } loadAddon() {} open() {} focus() {} dispose() {}
          write(value) { globalThis.terminalFailureWrites.push(value); }
          onData() { return { dispose() {} }; } onResize() { return { dispose() {} }; }
        }` };
      if (url === "failure-test:@xterm/addon-fit") return { format: "module", source: "export class FitAddon { fit() {} }", shortCircuit: true };
      return next(url, context);
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { TerminalView } = await import("../src/desktop/renderer/src/components/TerminalView.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const emit = (terminalId: string, sequence: number, data: string): void => {
    for (const listener of listeners) listener({ terminalId, sequence, type: "data", data });
  };
  let unmounted = false;
  try {
    await React.act(async () => root.render(React.createElement(TerminalView, { projectId: "project" })));
    assert.equal(requests.length, 1);
    assert.equal(listeners.size, 1, "subscription precedes handle receipt");
    emit("other", 1, "other output while pending");
    await React.act(async () => requests[0]!.reject(new Error("connect failed")));
    assert.match(dom.window.document.body.textContent!, /connect failed/u);
    assert.equal(listeners.size, 0, "failed connection must not retain all future terminal output");
    assert.deepEqual(unsubscribes, [1]);
    for (let i = 0; i < 100; i++) emit("other", i + 2, "unrelated output");
    assert.deepEqual(writes, []);
    const restart = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "重新启动");
    assert.ok(restart);
    await React.act(async () => restart.click());
    assert.equal(requests.length, 2);
    assert.equal(listeners.size, 1);
    assert.deepEqual(unsubscribes, [1, 0], "failed subscription cleanup is idempotent");
    emit("new", 2, "already in replay");
    emit("other", 9, "wrong terminal");
    emit("new", 3, "new output");
    await React.act(async () => requests[1]!.resolve({ terminalId: "new", replay: "replay", sequence: 2 }));
    assert.deepEqual(writes, ["replay", "new output"]);
    const retiredListener = [...listeners][0]!;
    emit("new", 4, "live");
    assert.deepEqual(writes, ["replay", "new output", "live"]);
    await React.act(async () => root.render(React.createElement(TerminalView, { key: "replacement", projectId: "replacement" })));
    assert.equal(requests.length, 3);
    assert.equal(listeners.size, 1);
    assert.deepEqual(unsubscribes, [1, 1, 0]);
    retiredListener({ terminalId: "new", sequence: 5, type: "data", data: "late callback" });
    assert.deepEqual(writes, ["replay", "new output", "live"], "already dispatched callbacks cannot write to a retired screen");
    await React.act(async () => root.unmount()); unmounted = true;
    assert.equal(listeners.size, 0);
    assert.deepEqual(unsubscribes, [1, 1, 1]);
    await React.act(async () => requests[2]!.reject(new Error("late rejected connection")));
    assert.deepEqual(unsubscribes, [1, 1, 1], "late failure must not unsubscribe twice");
  } finally {
    if (!unmounted) await React.act(async () => root.unmount());
    hooks.deregister(); dom.window.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
