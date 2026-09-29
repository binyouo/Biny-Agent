import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("embedded terminal resolves palette colors, follows system changes and releases theme observers", async () => {
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
  Object.assign(dom.window, { matchMedia: () => media, getComputedStyle: styles, biny: {
    listTerminals: async () => [{ terminalId: "terminal", slotId: "default" }],
    createTerminal: async () => ({ terminalId: "terminal", sequence: 0, replay: "" }),
    onTerminalEvent: () => () => {}, writeTerminal() {}, resizeTerminal() {}
  } });
  const terminalInstances: { options: { theme?: Record<string, string> }; disposed: boolean }[] = [];
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
          constructor(options) { this.options = options; this.disposed = false; globalThis.terminalInstances.push(this); }
          loadAddon() {} open() {} write() {} focus() {}
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

    await React.act(async () => root.unmount());
    unmounted = true;
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
