import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopApi, DesktopTerminalEvent, DesktopTerminalHandle } from "../src/desktop/protocol.js";

test("embedded terminal preserves themes and routes explicit preview restarts without a fallback shell", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const React = await import("react");
  const changes = new Set<() => void>();
  const media = { matches: true, addEventListener(_type: string, callback: () => void) { changes.add(callback); },
    removeEventListener(_type: string, callback: () => void) { changes.delete(callback); } };
  const colors: Record<string, readonly [string, string]> = {
    "--code": ["#f1f1f4", "#1f1f23"], "--text": ["#1c1c21", "#ededf1"],
    "--text-secondary": ["#4b4b53", "#b9b9c1"], "--text-tertiary": ["#676772", "#a2a2ad"],
    "--accent": ["#4f46e5", "#a5b4fc"], "--text-selection": ["#dcdafa", "#414568"],
    "--red-text": ["#bf3343", "#f28b82"], "--green-text": ["#137644", "#6fd99b"],
    "--amber-text": ["#96520a", "#f2b544"], "--syntax-function": ["#1d4ed8", "#93c5fd"],
    "--syntax-keyword": ["#7c3aed", "#c4b5fd"], "--syntax-type": ["#0e7490", "#67e8f9"],
    "--syntax-operator": ["#a21caf", "#f0abfc"]
  };
  const resolveColor = (value: string): string => {
    const token = /^var\((--[\w-]+)\)$/u.exec(value)?.[1];
    const pair = token ? colors[token] : undefined;
    assert.ok(pair, value);
    const preference = dom.window.document.documentElement.dataset.theme;
    const hex = pair[preference === "dark" || (preference !== "light" && media.matches) ? 1 : 0];
    return `rgb(${hex.slice(1).match(/../gu)!.map((channel) => Number.parseInt(channel, 16)).join(", ")})`;
  };
  const originalStyles = dom.window.getComputedStyle.bind(dom.window);
  const styles = (element: Element): CSSStyleDeclaration => {
    if (element.matches(".terminal-screen")) return {
      getPropertyValue(token: string) {
        if (token === "--font-mono") return "Menlo, monospace";
        const pair = colors[token];
        return pair ? `light-dark(${pair[0]}, ${pair[1]})` : "";
      }
    } as CSSStyleDeclaration;
    if (element instanceof dom.window.HTMLElement && element.style.color.startsWith("var(")) {
      return { color: resolveColor(element.style.color) } as CSSStyleDeclaration;
    }
    return originalStyles(element);
  };
  let listedSlot = "default";
  let genericHandle: DesktopTerminalHandle = { terminalId: "terminal", sequence: 0, replay: "" };
  type PreviewResult = Awaited<ReturnType<DesktopApi["startProjectPreview"]>>;
  let previewResult: Promise<PreviewResult> | undefined;
  const ipcCalls: string[] = [];
  const disposedIds: string[] = [];
  const terminalListeners = new Set<(event: DesktopTerminalEvent) => void>();
  const deferred = <T,>(): { promise: Promise<T>; resolve(value: T): void } => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };
  Object.assign(dom.window, { matchMedia: () => media, getComputedStyle: styles, biny: {
    listTerminals: async () => [{ terminalId: genericHandle.terminalId, slotId: listedSlot }],
    createTerminal: async () => { ipcCalls.push("create"); return genericHandle; },
    startProjectPreview: async () => { ipcCalls.push("preview"); assert.ok(previewResult); return await previewResult; },
    disposeTerminal: async (id: string) => { disposedIds.push(id); },
    onTerminalEvent: (listener: (event: DesktopTerminalEvent) => void) => { terminalListeners.add(listener); return () => { terminalListeners.delete(listener); }; },
    writeTerminal() {}, resizeTerminal() {}
  } });
  const terminalInstances: { options: { theme?: Record<string, string> }; disposed: boolean; writes: string[] }[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: styles, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true, terminalInstances })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@xterm/xterm" || specifier === "@xterm/addon-fit") return { url: `test:${specifier}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
      if (url === "test:@xterm/xterm") return { format: "module", shortCircuit: true, source: `
        export class Terminal {
          constructor(options) { this.options = options; this.disposed = false; this.writes = []; globalThis.terminalInstances.push(this); }
          loadAddon() {} open() {} write(value) { if (this.disposed) throw new Error("write after dispose"); this.writes.push(value); } focus() {}
          onData() { return { dispose() {} }; } onResize() { return { dispose() {} }; }
          dispose() { this.disposed = true; }
        }` };
      if (url === "test:@xterm/addon-fit") return { format: "module", shortCircuit: true, source: "export class FitAddon { fit() {} }" };
      return next(url, context);
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { TerminalView } = await import("../src/desktop/renderer/src/components/TerminalView.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let unmounted = false;
  try {
    await React.act(async () => root.render(React.createElement(TerminalView, { projectId: "project" })));
    const terminal = terminalInstances[0];
    assert.ok(terminal);
    assert.equal(terminal.options.theme?.foreground, "#ededf1");
    assert.equal(terminal.options.theme?.background, "#1f1f23");
    assert.equal(terminal.options.theme?.green, "#6fd99b");
    assert.equal(terminal.options.theme?.selectionBackground, "#414568");
    for (const value of Object.values(terminal.options.theme!)) assert.match(value, /^#[\da-f]{6}$/iu);

    await React.act(async () => { media.matches = false; for (const change of changes) change(); });
    assert.equal(terminal.options.theme?.foreground, "#1c1c21");
    assert.equal(terminal.options.theme?.green, "#137644");

    await React.act(async () => { dom.window.document.documentElement.dataset.theme = "dark"; });
    assert.equal(terminal.options.theme?.foreground, "#ededf1");
    await React.act(async () => { for (const change of changes) change(); });
    assert.equal(terminal.options.theme?.foreground, "#ededf1");

    // Exercise the real click/effect/IPC path; xterm and IPC remain mocked.
    const emit = (event: DesktopTerminalEvent): void => { for (const listener of terminalListeners) listener(event); };
    const restart = async (): Promise<void> => {
      const button = [...dom.window.document.querySelectorAll("button")].find(item => item.textContent === "重新启动");
      assert.ok(button);
      await React.act(async () => button.click());
    };
    let mountKey = 0;
    const mount = async (slot: string): Promise<void> => {
      listedSlot = slot;
      genericHandle = { terminalId: `old-${++mountKey}`, sequence: 0, replay: "" };
      ipcCalls.length = 0;
      await React.act(async () => root.render(React.createElement(TerminalView, { key: mountKey, projectId: "project" })));
      assert.deepEqual(ipcCalls, ["create"], "initial attachment never starts a server");
    };
    const exit = async (): Promise<void> => {
      await React.act(async () => emit({ terminalId: genericHandle.terminalId, type: "exit", exitCode: 1, sequence: 1 }));
    };
    await mount("ordinary-uuid");
    await exit(); await restart();
    assert.deepEqual(ipcCalls, ["create", "create"], "ordinary terminal restart keeps the generic API");

    await mount("preview");
    const ready = deferred<PreviewResult>(); previewResult = ready.promise;
    await exit(); await restart();
    assert.deepEqual(ipcCalls, ["create", "preview"]);
    const restarted = terminalInstances.at(-1)!;
    await React.act(async () => {
      emit({ terminalId: "preview-new", type: "data", data: "already in replay", sequence: 2 });
      emit({ terminalId: "foreign", type: "data", data: "foreign", sequence: 99 });
      emit({ terminalId: "preview-new", type: "data", data: "live", sequence: 4 });
      emit({ terminalId: "preview-new", type: "exit", exitCode: 0, sequence: 5 });
      ready.resolve({ kind: "script", terminalId: "preview-new", replay: "replay", sequence: 3, command: "npm run dev" });
    });
    assert.deepEqual(restarted.writes, ["replay", "live"], "queued replay-covered and foreign events are excluded");
    assert.match(dom.window.document.body.textContent!, /进程已退出（0）/u, "exit before the IPC reply remains visible");
    await React.act(async () => root.render(React.createElement(TerminalView, { key: mountKey, projectId: "project", active: false })));
    // Keep listTerminals consistent with the newly adopted terminal when visible again.
    genericHandle = { terminalId: "preview-new", replay: "", sequence: 5 };
    await React.act(async () => root.render(React.createElement(TerminalView, { key: mountKey, projectId: "project", active: true })));
    assert.deepEqual(ipcCalls, ["create", "preview"], "visibility changes do not restart the preview");
    await React.act(async () => (dom.window.document.querySelector('[aria-label="关闭终端 1 并终止进程"]') as HTMLButtonElement).click());
    assert.equal(disposedIds.at(-1), "preview-new", "the script handle reaches the parent tab");

    for (const outcome of ["static", "no-entry", "reject"] as const) {
      await mount("preview");
      // Rejection is created lazily when the dedicated IPC is invoked.
      const failed = deferred<PreviewResult>();
      previewResult = outcome === "static"
        ? Promise.resolve({ kind: "static", url: "http://127.0.0.1:3000/" })
        : failed.promise.then(() => { throw new Error(outcome === "no-entry" ? "没有预览入口" : "IPC unavailable"); });
      await exit(); await restart();
      if (outcome !== "static") await React.act(async () => failed.resolve({ kind: "static", url: "" }));
      assert.deepEqual(ipcCalls, ["create", "preview"], "failure/static never creates a fallback shell");
      assert.match(dom.window.document.body.textContent!, outcome === "static" ? /静态预览.*浏览器面板/u : outcome === "no-entry" ? /没有预览入口/u : /IPC unavailable/u);
    }

    await mount("preview");
    const late = deferred<PreviewResult>(); previewResult = late.promise;
    await exit(); await restart();
    const removed = terminalInstances.at(-1)!;
    await React.act(async () => root.unmount());
    unmounted = true;
    await React.act(async () => late.resolve({ kind: "script", terminalId: "late", replay: "must not write", sequence: 1, command: "npm run dev" }));
    assert.equal(removed.disposed, true);
    assert.deepEqual(removed.writes, [], "late reply does not write into an unmounted terminal");
    assert.equal(terminalListeners.size, 0);
    assert.equal(changes.size, 0);
    assert.equal(terminal.disposed, true);
    assert.equal(dom.window.document.querySelector('[style*="var(--"]'), null);
  } finally {
    if (!unmounted) await React.act(async () => root.unmount());
    hooks.deregister();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
