/** 信息图使用静态图形展示；视觉与原生资源操作由人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";
import { JSDOM } from "jsdom";

const validSource = "infographic list-row-simple-horizontal-arrow\ndata\n  items\n    - label 第一步\n    - label 第二步";
const theme = { dark: false, background: "#ffffff", primary: "#0055aa", palette: ["#0055aa", "#00aa55"], font: "sans-serif" };

function setupDom() {
  const dom = new JSDOM("<!doctype html><html data-theme='light'><head></head><body><div id='root'></div></body></html>", { url: "https://localhost/", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, MutationObserver: dom.window.MutationObserver, DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  // 第三方文字组件使用浏览器 innerText；此处只补齐无布局 DOM 的系统接口。
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; }, set(value: string) { this.textContent = value; } });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  Object.defineProperty(dom.window.document, "fonts", { configurable: true, value: { forEach() {} } });
  return dom;
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "可观察结果应在五秒内出现");
    await React.act(async () => new Promise<void>(resolve => setImmediate(resolve)));
  }
}

test("信息图围栏具有独立展示、源码复制与图形导出入口", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, {
    projectId: "p", onPreviewFile() {}, onOpenExternal() {},
    content: "```infographic\ninfographic list-row-simple-horizontal-arrow\ndata\n  items\n    - label 第一步\n    - label 第二步\n```"
  }));
  assert.match(html, /markdown-infographic/);
  assert.match(html, /复制信息图源码/);
  assert.match(html, /下载信息图/);
});

test("真实信息图库绘制文本、继承主题并移除用户主题，原始容器与字体资源被回收", async () => {
  const dom = setupDom();
  try {
    const { renderInfographic } = await import("../src/desktop/renderer/src/components/infographicRendering.js");
    const source = validSource.replace("infographic ", "").replace("data\n", "data\n  theme\n    colorBg red\n");
    const output = await renderInfographic(source, 480, theme, new AbortController().signal);
    const svg = new dom.window.DOMParser().parseFromString(output.svg, "image/svg+xml").documentElement;
    assert.equal(svg.localName, "svg");
    assert.match(svg.textContent ?? "", /第一步/);
    assert.match(svg.textContent ?? "", /第二步/);
    assert.equal(svg.getAttribute("width"), "480px");
    assert.match(svg.getAttribute("viewBox") ?? "", /^-20 -20 /);
    assert.match(output.svg, /#0055aa/i);
    assert.equal(output.code, source);
    assert.equal(output.resourceErrors, 0);
    assert.equal(document.querySelectorAll("body > div").length, 1, "离屏容器已移除");
    assert.equal(document.querySelectorAll("head link").length, 0, "沿用现有字体，不注入远程 CSS");
    await assert.rejects(renderInfographic("infographic unknown-template\ndata\n  items\n    - label incomplete", 600, theme, new AbortController().signal));
    assert.equal(document.querySelectorAll("body > div").length, 1);
  } finally { dom.window.close(); }
});

test("外部图标先读取为净化静态 SVG，脚本、事件、CSS URL 与主动地址不能进入宿主", async () => {
  const dom = setupDom();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; credentials: RequestCredentials | undefined; redirect: RequestRedirect | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), credentials: options?.credentials, redirect: options?.redirect });
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><style>.x{fill:url(\'https://evil.example/a\')}</style><a href="javascript:alert(1)"><circle r="4" fill="blue"/></a></svg>', { headers: { "content-type": "image/svg+xml" } });
  };
  try {
    const { renderInfographic, sanitizeInfographicSvg } = await import("../src/desktop/renderer/src/components/infographicRendering.js");
    const source = "infographic list-row-horizontal-icon-arrow\ndata\n  items\n    - label icon\n      icon ref:url:svg:https://example.com/icon.svg";
    const output = await renderInfographic(source, 600, theme, new AbortController().signal);
    assert.deepEqual(requests, [{ url: "https://example.com/icon.svg", credentials: "omit", redirect: "error" }]);
    assert.match(output.svg, /<circle/);
    assert.doesNotMatch(output.svg, /<script|onload=|javascript:|https:\/\/evil|@import/i);
    const raster = await sanitizeInfographicSvg('<svg xmlns="http://www.w3.org/2000/svg"><image width="12" height="12" href="data:image/png;base64,AAAA" onerror="alert(1)"/><image href="https://evil.example/p.png"/><style>@import "https://evil.example/x.css";</style></svg>');
    assert.match(raster, /data:image\/png;base64,AAAA/);
    assert.doesNotMatch(raster, /onerror|evil\.example|@import/);
    const text = await sanitizeInfographicSvg('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="20"><span xmlns="http://www.w3.org/1999/xhtml" style="font-size:14px;color:red;display:flex;position:fixed;background-image:u\\72l(&quot;https://evil.example/p.png&quot;)" onclick="alert(1)">中文标签<iframe src="https://evil.example/"></iframe><script>alert(1)</script><img src="https://evil.example/p.png" onerror="alert(1)"/></span></foreignObject></svg>');
    assert.match(text, /中文标签/);
    assert.match(text, /foreignObject/);
    assert.match(text, /font-size:\s*14px/);
    assert.doesNotMatch(text, /iframe|<script|onclick|onerror|evil\.example|url\(|position|background-image/);
    const failed = await renderInfographic(source.replace("ref:url:svg:https://example.com/icon.svg", "javascript:alert(1)"), 600, theme, new AbortController().signal);
    assert.equal(failed.resourceErrors, 1, "资源拒绝有可见的失败结果");
    assert.equal(requests.length, 1, "主动地址不会转为网络探测");
    const prefixed = await renderInfographic(source.replace("https://example.com/icon.svg", "javascript:alert(1)"), 600, theme, new AbortController().signal);
    assert.equal(prefixed.resourceErrors, 1);
    assert.equal(requests.length, 1, "远程资源前缀不能将主动地址转为图标检索");
  } finally { globalThis.fetch = originalFetch; dom.window.close(); }
});

test("PNG 复制从有效静态 SVG 的内联地址绘制，保持中文文本、两倍像素和原生写入结果", async () => {
  const dom = setupDom();
  const originalImage = globalThis.Image;
  const originalClipboardItem = globalThis.ClipboardItem;
  const originalComputed = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = (element: Element, pseudo?: string | null) => {
    const original = originalComputed(element, pseudo);
    return new Proxy(original, { get(target, key) {
      if (key === "color" && element instanceof dom.window.HTMLElement && element.style.color.startsWith("var(")) return "#0055aa";
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  let imageSource = "";
  Object.assign(globalThis, { Image: class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) { imageSource = value; queueMicrotask(() => this.onload?.()); }
  } });
  const canvases: HTMLCanvasElement[] = [];
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: function(this: HTMLCanvasElement) {
    canvases.push(this);
    return { fillRect() {}, clearRect() {}, drawImage() {}, scale() {} };
  } });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "toBlob", { configurable: true, value: (callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" })) });
  let copied: Blob | undefined;
  Object.assign(globalThis, { ClipboardItem: class { constructor(readonly data: Record<string, Blob>) {} } });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async (items: Array<{ data: Record<string, Blob> }>) => { copied = items[0]?.data["image/png"]; } } });
  const { createRoot } = await import("react-dom/client");
  const { InfographicBlock } = await import("../src/desktop/renderer/src/components/InfographicBlock.js");
  const root = createRoot(document.getElementById("root")!);
  try {
    React.act(() => root.render(React.createElement(InfographicBlock, { code: validSource })));
    await until(() => !!document.querySelector(".markdown-infographic-canvas svg"));
    const displayed = document.querySelector(".markdown-infographic-canvas svg")!;
    assert.ok(displayed.getAttribute("viewBox"), "有效图形保留固有尺寸");
    const [,, width, height] = displayed.getAttribute("viewBox")!.split(/[\s,]+/u).map(Number);
    await React.act(async () => (document.querySelector('[aria-label="复制信息图 PNG"]') as HTMLButtonElement).click());
    await until(() => !!copied || !!document.querySelector('[role="alert"]'));
    assert.ok(copied, `原生 PNG 写入失败：${document.querySelector('[role="alert"]')?.textContent ?? ""}；图像地址 ${imageSource}；尺寸 ${displayed.getAttribute("viewBox")}`);
    assert.match(imageSource, /^data:image\/svg\+xml;charset=utf-8,/u);
    assert.match(decodeURIComponent(imageSource.slice(imageSource.indexOf(",") + 1)), /中文|第一步/u);
    const canvas = canvases.at(-1);
    assert.equal(canvas?.width, Math.round(width! * 2));
    assert.equal(canvas?.height, Math.round(height! * 2));
    assert.equal(copied?.type, "image/png");
    assert.equal(document.querySelector('[aria-label="复制信息图 PNG"]')?.getAttribute("title"), "已复制");
  } finally {
    React.act(() => root.unmount());
    Object.assign(globalThis, { Image: originalImage, ClipboardItem: originalClipboardItem });
    dom.window.close();
  }
});

test("信息图在资源读取取消后拒绝旧结果，不留下原始渲染节点", async () => {
  const dom = setupDom();
  const originalFetch = globalThis.fetch;
  let entered = false;
  globalThis.fetch = async (_url, options) => new Promise<Response>((_resolve, reject) => {
    entered = true;
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  });
  try {
    const { renderInfographic } = await import("../src/desktop/renderer/src/components/infographicRendering.js");
    const controller = new AbortController();
    const pending = renderInfographic("infographic list-row-horizontal-icon-arrow\ndata\n  items\n    - label old\n      icon ref:url:https://example.com/icon.svg", 600, theme, controller.signal);
    const rejected = assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
    await until(() => entered);
    controller.abort();
    await rejected;
    assert.equal(document.querySelectorAll("body > div").length, 1);
  } finally { globalThis.fetch = originalFetch; dom.window.close(); }
});

test("库开始离屏绘制时取消也释放实际 DOM 观察器", async () => {
  const dom = setupDom();
  const controller = new AbortController();
  const active = new Set<MutationObserver>();
  class TrackedObserver extends dom.window.MutationObserver {
    override observe(target: Node, options?: MutationObserverInit): void {
      active.add(this);
      super.observe(target, options);
      if (target === document && !controller.signal.aborted) controller.abort();
    }
    override disconnect(): void { active.delete(this); super.disconnect(); }
  }
  Object.assign(globalThis, { MutationObserver: TrackedObserver });
  try {
    const { renderInfographic } = await import("../src/desktop/renderer/src/components/infographicRendering.js");
    await assert.rejects(renderInfographic(validSource, 600, theme, controller.signal), error => error instanceof Error && error.name === "AbortError");
    assert.equal(active.size, 0, "取消不遗留第三方离屏节点的 document 观察器");
    assert.equal(document.querySelectorAll("body > div").length, 1);
  } finally {
    for (const observer of active) observer.disconnect();
    Object.assign(globalThis, { MutationObserver: dom.window.MutationObserver });
    dom.window.close();
  }
});

test("流式信息图保留最后有效图形和源码导出，缩放与宽度变化保持展示容器", async () => {
  const dom = setupDom();
  const originalComputed = dom.window.getComputedStyle.bind(dom.window);
  const colors: Record<string, string> = { "--bg": "#ffffff", "--surface-raised": "#ffffff", "--accent": "#0055aa", "--green": "#00aa55", "--file-purple": "#9944aa", "--red": "#aa3344", "--amber": "#aa7700" };
  dom.window.getComputedStyle = (element: Element, pseudo?: string | null) => {
    const original = originalComputed(element, pseudo);
    return new Proxy(original, { get(target, key) {
      if (key === "color" && element instanceof dom.window.HTMLElement) return colors[element.style.color.match(/^var\((.+)\)$/)?.[1] ?? ""] ?? target.color;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  let width = 480;
  let onResize: ResizeObserverCallback | undefined;
  let disconnected = false;
  Object.assign(globalThis, { ResizeObserver: class {
    constructor(callback: ResizeObserverCallback) { onResize = callback; }
    observe() {} disconnect() { disconnected = true; }
  } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value: string) => { copied = value; } } });
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { InfographicBlock } = await import("../src/desktop/renderer/src/components/InfographicBlock.js");
  const root = createRoot(document.getElementById("root")!);
  const render = (code: string, isStreaming = false) => React.act(() => flushSync(() => root.render(React.createElement(InfographicBlock, { code, isStreaming }))));
  try {
    render(validSource);
    await until(() => !!document.querySelector(".markdown-infographic-canvas svg"));
    const region = document.querySelector(".markdown-infographic-body") as HTMLElement;
    const canvas = region.querySelector(".markdown-infographic-canvas");
    assert.equal(canvas?.querySelector("svg")?.getAttribute("width"), "480px");
    React.act(() => (document.querySelector('[aria-label="放大信息图"]') as HTMLButtonElement).click());
    assert.match((canvas as HTMLElement).style.transform, /scale\(1\.2\)/);
    render("infographic incomplete\ndata\n  items", true);
    await React.act(async () => (document.querySelector('[aria-label="复制信息图源码"]') as HTMLButtonElement).click());
    assert.equal(copied, validSource);
    assert.equal(document.querySelector(".markdown-infographic-body"), region);
    assert.equal(region.querySelector(".markdown-infographic-canvas"), canvas);
    assert.match(region.textContent ?? "", /第一步/);
    render(validSource);
    width = 700;
    React.act(() => onResize?.([], {} as ResizeObserver));
    await until(() => canvas?.querySelector("svg")?.getAttribute("width") === "700px");
    assert.equal(document.querySelector(".markdown-infographic-body"), region);
    assert.match((canvas as HTMLElement).style.transform, /scale\(1\.2\)/);
    render("infographic incomplete\ndata\n  items");
    await until(() => !!document.querySelector('[role="alert"]'));
    assert.match(region.textContent ?? "", /第一步/);
  } finally {
    React.act(() => root.unmount());
    assert.equal(disconnected, true);
    dom.window.close();
  }
});
