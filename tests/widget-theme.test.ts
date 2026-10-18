import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("可视化首帧使用宿主主题和按钮前景色，主题切换保留 iframe 文档", async () => {
  const imports = registerHooks({
    resolve(specifier, context, next) {
      if (!specifier.endsWith("?raw")) return next(specifier, context);
      const resolved = next(specifier.slice(0, -4), context);
      return { ...resolved, url: `${resolved.url}?raw` };
    },
    load(url, context, next) {
      return url.endsWith("?raw") ? { format: "module", source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`, shortCircuit: true } : next(url, context);
    }
  });
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body style="font-family:system-ui;--biny-radius-control:12px"><div id="root"></div></body></html>', { url: "https://desktop.local" });
  const React = await import("react");
  const mediaListeners = new Set<() => void>();
  dom.window.matchMedia = (() => ({ matches: true, addEventListener: (_: string, callback: () => void) => mediaListeners.add(callback),
    removeEventListener: (_: string, callback: () => void) => mediaListeners.delete(callback) })) as unknown as typeof window.matchMedia;
  const colors: Record<string, [string, string]> = {
    "--surface": ["rgb(250, 250, 250)", "rgb(31, 31, 31)"], "--biny-text": ["rgb(23, 23, 23)", "rgb(237, 237, 237)"],
    "--accent": ["rgb(15, 95, 168)", "rgb(116, 182, 251)"], "--accent-foreground": ["rgb(255, 255, 255)", "rgb(23, 23, 23)"],
    "--biny-surface-soft": ["rgb(240, 240, 240)", "rgb(43, 43, 43)"], "--biny-text-secondary": ["rgb(82, 82, 82)", "rgb(184, 184, 184)"],
    "--biny-border": ["rgb(222, 222, 222)", "rgb(59, 59, 59)"], "--surface-raised": ["rgb(255, 255, 255)", "rgb(36, 36, 36)"],
    "--green": ["rgb(0, 188, 125)", "rgb(0, 188, 125)"], "--file-purple": ["rgb(121, 87, 157)", "rgb(185, 155, 221)"],
    "--red": ["rgb(251, 44, 54)", "rgb(251, 44, 54)"], "--amber": ["rgb(254, 154, 0)", "rgb(254, 154, 0)"]
  };
  const originalStyles = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = ((element: Element) => {
    if (element instanceof dom.window.HTMLElement && element.style.color.startsWith("var(")) {
      const token = /^var\((--[\w-]+)\)$/u.exec(element.style.color)?.[1];
      assert.ok(token && colors[token], element.style.color);
      return { color: colors[token][dom.window.document.documentElement.dataset.theme === "dark" ? 1 : 0] } as CSSStyleDeclaration;
    }
    return originalStyles(element);
  }) as typeof window.getComputedStyle;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { WidgetRenderer } = await import("../src/desktop/renderer/src/components/WidgetRenderer.js");
  const root = createRoot(document.getElementById("root")!);
  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, "可视化文档应在有界时间内就绪");
      await React.act(async () => await new Promise<void>(resolve => setImmediate(resolve)));
    }
  };
  try {
    await React.act(async () => root.render(React.createElement(WidgetRenderer, {
      tool: { id: "theme", tool: "WidgetRenderer", status: "success", result: { kind: "widget", title: "Theme", html: '<button class="primary">播放</button>' } },
      running: false, onOpenExternal() {}
    } as React.ComponentProps<typeof WidgetRenderer>)));
    const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
    await waitFor(() => frame.srcdoc.includes("<!doctype html>"));
    const initialDocument = frame.srcdoc;
    const content = new JSDOM(initialDocument);
    try {
      assert.equal(content.window.document.documentElement.dataset.theme, "dark");
      const style = content.window.getComputedStyle(content.window.document.documentElement);
      assert.equal(style.getPropertyValue("--primary"), "#74b6fb");
      assert.equal(style.getPropertyValue("--primary-foreground"), "#171717");
      assert.equal(style.getPropertyValue("--radius"), "12px");
    } finally { content.window.close(); }
    const token = /const token="([^"]+)"/u.exec(initialDocument)?.[1];
    assert.ok(token);
    const messages: Array<{ type: string; css?: string; dark?: boolean }> = [];
    frame.contentWindow!.postMessage = (message: typeof messages[number]) => { messages.push(message); };
    await React.act(async () => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: frame.contentWindow, data: { type: "widget-resize", token, height: 312 } })));
    assert.equal(frame.style.height, "0px", "文档就绪前不展示空白 iframe");
    await React.act(async () => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: frame.contentWindow, data: { type: "widget-ready", token } })));
    assert.equal(frame.style.height, "320px");
    await React.act(async () => { document.documentElement.dataset.theme = "light"; });
    await waitFor(() => messages.some(message => message.type === "set-theme" && message.dark === false));
    assert.match(messages.filter(message => message.type === "set-theme").at(-1)?.css ?? "", /--primary-foreground:#ffffff/u);
    assert.equal(frame.srcdoc, initialDocument, "切换主题不能重新加载正在播放的文档");
  } finally {
    await React.act(() => root.unmount());
    assert.equal(mediaListeners.size, 0);
    dom.window.close(); imports.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
