import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopApi, DesktopTerminalEvent, DesktopTerminalHandle } from "../src/desktop/protocol.js";

test("terminal tab close owns pending connection handles without closing hidden views", async t => {
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
  let createResult: Promise<DesktopTerminalHandle> | undefined;
  let listResult: Promise<{ terminalId: string; slotId: string }[]> | undefined;
  let disposeResult: Promise<void> | undefined;
  const ipcCalls: string[] = [];
  const disposedIds: string[] = [];
  const terminalListeners = new Set<(event: DesktopTerminalEvent) => void>();
  const deferred = <T,>(): { promise: Promise<T>; resolve(value: T): void } => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };
  Object.assign(dom.window, { matchMedia: () => media, getComputedStyle: styles, biny: {
    listTerminals: async () => await (listResult ?? Promise.resolve([{ terminalId: genericHandle.terminalId, slotId: listedSlot }])),
    createTerminal: async () => { ipcCalls.push("create"); return await (createResult ?? Promise.resolve(genericHandle)); },
    startProjectPreview: async () => { ipcCalls.push("preview"); assert.ok(previewResult); return await previewResult; },
    disposeTerminal: async (id: string) => { disposedIds.push(id); await disposeResult; },
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
  let key = 0;
  const handle = (terminalId: string): DesktopTerminalHandle => ({ terminalId, replay: "", sequence: 0 });
  const render = async (active = true) => { await React.act(async () => root.render(React.createElement(TerminalView, { key, projectId: "project", active }))); };
  const mount = async (slot: string) => {
    listedSlot = slot; genericHandle = handle(`old-${++key}`);
    createResult = listResult = disposeResult = undefined; previewResult = undefined;
    disposedIds.length = 0; ipcCalls.length = 0;
    await render();
  };
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === label || button.getAttribute("aria-label") === label);
    assert.ok(button, label); await React.act(async () => button.click());
  };
  const exit = async () => {
    await React.act(async () => { for (const listener of terminalListeners) listener({ terminalId: genericHandle.terminalId, type: "exit", exitCode: 1, sequence: 1 }); });
  };
  const closeLabel = "关闭终端 1 并终止进程";
  try {
    for (const slot of ["default", "preview"]) {
      await t.test(`${slot}: close during restart releases the replacement, not just the exited ID`, async () => {
        await mount(slot); await exit();
        const pending = deferred<DesktopTerminalHandle>();
        if (slot === "preview") previewResult = pending.promise.then(value => ({ ...value, kind: "script", command: "npm run dev" }));
        else createResult = pending.promise;
        await click("重新启动");
        const closeButton = dom.window.document.querySelector(`[aria-label="${closeLabel}"]`) as HTMLButtonElement;
        await React.act(async () => { closeButton.click(); closeButton.click(); });
        await React.act(async () => pending.resolve(handle("replacement")));
        assert.deepEqual(disposedIds, ["replacement"]);
        assert.equal(Boolean(dom.window.document.querySelector('[role="tab"]')), false);
      });
    }
    await t.test("missing preview read-only attachment remains closable without starting a server", async () => {
      await mount("default");
      listedSlot = "preview"; genericHandle = handle(`missing-${++key}`);
      const absent = deferred<void>(); createResult = absent.promise.then(() => { throw Error("开发服务器已退出，请点击重新启动。"); });
      await render(); await React.act(async () => absent.resolve()); assert.match(dom.window.document.body.textContent!, /开发服务器已退出/);
      await click(closeLabel); assert.deepEqual(disposedIds, [genericHandle.terminalId]);
      assert.equal(Boolean(dom.window.document.querySelector('[role="tab"]')), false);
      assert.equal(ipcCalls.includes("preview"), false);
    });
    await t.test("closing one terminal does not block creating an independent tab", async () => {
      await mount("default"); const disposal = deferred<void>(); disposeResult = disposal.promise;
      await click(closeLabel); createResult = Promise.resolve(handle("independent")); await click("新建终端");
      await React.act(async () => disposal.resolve());
      assert.equal(dom.window.document.querySelectorAll('[role="tab"]').length, 1);
      assert.deepEqual(disposedIds, [genericHandle.terminalId]);
    });
    await t.test("leaving the view without close preserves a late connection", async () => {
      await mount("default"); await exit(); const pending = deferred<DesktopTerminalHandle>(); createResult = pending.promise;
      await click("重新启动"); await React.act(async () => root.render(null));
      await React.act(async () => pending.resolve(handle("preserved")));
      assert.deepEqual(disposedIds, []);
    });
    await t.test("explicit close still releases its late handle after unmount", async () => {
      await mount("default"); await exit(); const pending = deferred<DesktopTerminalHandle>(); createResult = pending.promise;
      await click("重新启动"); await click(closeLabel); await React.act(async () => root.render(null));
      await React.act(async () => pending.resolve(handle("closed-after-leaving")));
      assert.deepEqual(disposedIds, ["closed-after-leaving"]);
    });
    await t.test("dispose failure preserves the replacement for an explicit close retry", async () => {
      await mount("default"); await exit(); const pending = deferred<DesktopTerminalHandle>(); createResult = pending.promise;
      const disposal = deferred<void>(); disposeResult = disposal.promise.then(() => { throw Error("dispose failed"); });
      await click("重新启动"); await click(closeLabel);
      await React.act(async () => { pending.resolve(handle("retryable")); disposal.resolve(); });
      assert.ok(dom.window.document.querySelector('[role="tab"]'));
      assert.match(dom.window.document.body.textContent!, /dispose failed/);
      disposeResult = undefined; await click(closeLabel);
      assert.deepEqual(disposedIds, ["retryable", "retryable"]);
      assert.equal(Boolean(dom.window.document.querySelector('[role="tab"]')), false);
    });
    await t.test("uncertain creation rejection never reports old-ID disposal as successful close", async () => {
      await mount("default"); await exit(); const pending = deferred<void>();
      createResult = pending.promise.then(() => { throw Error("IPC result lost"); });
      await click("重新启动"); await click(closeLabel);
      await React.act(async () => pending.resolve());
      assert.deepEqual(disposedIds, []); assert.ok(dom.window.document.querySelector('[role="tab"]'));
      assert.match(dom.window.document.body.textContent!, /IPC result lost/);
      createResult = Promise.resolve(handle("recovered")); await click("重新启动"); await click(closeLabel);
      assert.deepEqual(disposedIds, ["recovered"]);
    });
    await t.test("a stale visibility list cannot restore a terminal closed while it was loading", async () => {
      await mount("default"); await render(false); const list = deferred<{ terminalId: string; slotId: string }[]>(); listResult = list.promise;
      await render(true); await click(closeLabel);
      await React.act(async () => list.resolve([{ terminalId: genericHandle.terminalId, slotId: "default" }]));
      assert.equal(Boolean(dom.window.document.querySelector('[role="tab"]')), false);
      assert.deepEqual(disposedIds, [genericHandle.terminalId]);
    });
    await t.test("accepted fresh preview identity reattaches the screen and closes the new ID", async () => {
      await mount("preview"); await render(false); genericHandle = handle("external-preview");
      await render(true); await click(closeLabel);
      assert.deepEqual(disposedIds, ["external-preview"]);
      assert.equal(ipcCalls.filter(call => call === "create").length, 2);
    });
    for (const listFirst of [false, true]) {
      await t.test(`visibility list and pending restart preserve new identity (listFirst=${listFirst})`, async () => {
        await mount("default"); const old = genericHandle; await exit();
        const pending = deferred<DesktopTerminalHandle>(); createResult = pending.promise; await click("重新启动");
        await render(false); const list = deferred<{ terminalId: string; slotId: string }[]>(); listResult = list.promise; await render(true);
        if (listFirst) await React.act(async () => list.resolve([{ terminalId: old.terminalId, slotId: "default" }]));
        await React.act(async () => pending.resolve(handle("restart-winner")));
        if (!listFirst) await React.act(async () => list.resolve([{ terminalId: old.terminalId, slotId: "default" }]));
        await click(closeLabel); assert.deepEqual(disposedIds, ["restart-winner"]);
      });
    }
    await t.test("closing an old identity never removes a separately observed replacement tab", async () => {
      await mount("default"); const old = genericHandle, disposal = deferred<void>(); disposeResult = disposal.promise;
      await click(closeLabel); await render(false); genericHandle = handle("new-independent-instance"); await render(true);
      await React.act(async () => disposal.resolve());
      assert.deepEqual(disposedIds, [old.terminalId]);
      assert.equal(dom.window.document.querySelectorAll('[role="tab"]').length, 1);
      disposeResult = undefined; await click(closeLabel);
      assert.deepEqual(disposedIds, [old.terminalId, "new-independent-instance"]);
    });
  } finally {
    await React.act(async () => root.unmount()); hooks.deregister(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
