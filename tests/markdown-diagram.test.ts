/** 图表公开输出与控件回归；外部渲染器用协议替身，视觉效果由用户人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import type { RenderingPreview } from "../src/desktop/renderer/src/components/RenderingPreviewContext.js";

interface DiagramHarness {
  initialize(config: Record<string, unknown>): void;
  render(source: string): Promise<{ svg: string }>;
  beautiful(source: string): string;
}

test("图表展示、交互和流式安全边界", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://localhost/" });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "MutationObserver", "DOMParser", "XMLSerializer", "Node", "Element", "HTMLElement", "SVGElement", "DocumentFragment", "MouseEvent", "Event", "getComputedStyle"]) globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const React = await import("react");
  Object.assign(globalThis, { React });
  const palette: Record<string, string> = { "--bg": "#f4f4f6", "--surface-soft": "#f1f1f4", "--text": "#1c1c21", "--border-strong": "#c8c8d2", "--text-secondary": "#4b4b53", "--accent-soft": "#eeedfd", "--accent": "#4f46e5", "--surface-raised": "#ffffff", "--amber-bg": "#fbf0df", "--amber-text": "#96520a", "--amber": "#b45309", "--border": "#e3e3e8" };
  const originalStyles = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = (element, pseudo) => element instanceof dom.window.HTMLElement && element.style.color.startsWith("var(") ? { color: palette[element.style.color.slice(4, -1)] } as CSSStyleDeclaration : originalStyles(element, pseudo);
  let config: Record<string, unknown> | undefined;
  const makeSvg = (text: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><text data-id="label">${text}</text></svg>`;
  let beautifulCalls = 0;
  const harness: DiagramHarness = { initialize(value) { config = value; }, async render(source) { if (source.includes("BAD")) throw new Error("unfinished"); return { svg: makeSvg(source) }; }, beautiful(source) { beautifulCalls++; if (source.includes("BAD")) throw new Error("unfinished"); return makeSvg(source); } };
  globals.diagramHarness = harness;
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === "mermaid" || specifier === "beautiful-mermaid" ? { url: `test:${specifier}`, shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:mermaid") return { format: "module", shortCircuit: true, source: 'export default {initialize(config){globalThis.diagramHarness.initialize(config)},async render(id,source){return globalThis.diagramHarness.render(source)}}' };
      if (url === "test:beautiful-mermaid") return { format: "module", shortCircuit: true, source: 'export function renderMermaidSVG(source){return globalThis.diagramHarness.beautiful(source)}' };
      return next(url, context);
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { MermaidBlock } = await import("../src/desktop/renderer/src/components/MermaidBlock.js");
  const { RenderingPreviewContext } = await import("../src/desktop/renderer/src/components/RenderingPreviewContext.js");
  let previewRendering: ((preview: RenderingPreview) => void) | undefined;
  let root = createRoot(document.getElementById("root")!);
  const render = (code: string, isStreaming = false) => flushSync(() => root.render(React.createElement(RenderingPreviewContext, { value: previewRendering }, React.createElement(MermaidBlock, { code, isStreaming }))));
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const observer = new MutationObserver(() => { if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve(); } });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error("diagram output timeout")); }, 2500);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    });
  };
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const newBlock = () => { flushSync(() => root.unmount()); root = createRoot(document.getElementById("root")!); };
  try {
    await t.test("可在 25%–400% 间缩放，拖动后重置同时复原位置", async () => {
      render("graph TD; A-->B");
      await waitFor(() => !!document.querySelector(".markdown-mermaid svg"));
      assert.ok(button("复制图表源码"));
      assert.equal(button("SVG"), null);
      assert.equal(button("展开图表预览"), null, "没有右栏上下文时不展示不可用入口");
      for (let i = 0; i < 3; i++) flushSync(() => button("缩小图表").click());
      assert.match(document.querySelector(".markdown-diagram")!.textContent!, /25%/);
      assert.equal(button("缩小图表").disabled, true);
      const viewport = document.querySelector<HTMLElement>(".markdown-diagram-viewport")!;
      const wheel = new dom.window.WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
      flushSync(() => viewport.dispatchEvent(wheel));
      assert.equal(wheel.defaultPrevented, false, "普通滚轮保留聊天滚动");
      const modifiedWheel = new dom.window.WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
      flushSync(() => viewport.dispatchEvent(modifiedWheel));
      assert.equal(modifiedWheel.defaultPrevented, true);
      flushSync(() => viewport.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 20, bubbles: true })));
      flushSync(() => dom.window.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 70, clientY: 55 })));
      flushSync(() => dom.window.dispatchEvent(new dom.window.MouseEvent("mouseup")));
      assert.equal(document.querySelector<HTMLElement>(".markdown-mermaid")!.style.transform, "translate(60px, 35px) scale(0.5)");
      flushSync(() => button("重置图表缩放").click());
      assert.equal(document.querySelector<HTMLElement>(".markdown-mermaid")!.style.transform, "translate(0px, 0px) scale(1)");
      assert.equal(button("重置图表缩放").disabled, true);
      for (let i = 0; i < 12; i++) flushSync(() => button("放大图表").click());
      assert.match(document.querySelector(".markdown-diagram")!.textContent!, /400%/);
      assert.equal(button("放大图表").disabled, true);
    });
    newBlock();
    await t.test("流式半行先渲染完整前缀，复制只对应有效图", async () => {
      render("sequenceDiagram\nAlice->>Bob: hello\nBAD", true);
      await waitFor(() => !!document.querySelector(".markdown-mermaid svg"));
      assert.equal(document.querySelector(".markdown-mermaid text")?.textContent, "sequenceDiagram\nAlice->>Bob: hello");
      const previousSvg = document.querySelector(".markdown-mermaid svg");
      render("sequenceDiagram\nAlice->>Bob: hello\nBAD BAD", true);
      assert.equal(document.querySelector(".markdown-mermaid svg"), previousSvg);
      let copied = "";
      Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { async writeText(text: string) { copied = text; } } });
      flushSync(() => button("复制图表源码").click());
      await waitFor(() => !!button("已复制"));
      assert.equal(copied, "sequenceDiagram\nAlice->>Bob: hello", "复制成功结果对应的完整源码，不带半行");
    });
    newBlock();
    await t.test("展开传递静态有效图，后续流式结果不覆盖右栏快照", async () => {
      let opened: RenderingPreview | undefined;
      previewRendering = value => { opened = value; };
      render("sequenceDiagram\nAlice->>Bob: stable\nBAD", true);
      await waitFor(() => !!document.querySelector(".markdown-mermaid svg"));
      flushSync(() => button("展开图表预览").click());
      assert.equal(opened?.source, "sequenceDiagram\nAlice->>Bob: stable");
      assert.equal(opened?.filename, "diagram.mmd");
      const host = document.createElement("div"); document.body.append(host);
      const previewRoot = createRoot(host);
      try {
        render("sequenceDiagram\nAlice->>Bob: updated", false);
        flushSync(() => previewRoot.render(opened!.renderPreview()));
        assert.equal(host.querySelector("text")?.textContent, "sequenceDiagram\nAlice->>Bob: stable");
        const viewport = host.querySelector<HTMLElement>(".markdown-diagram-viewport")!;
        const wheel = new dom.window.WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
        flushSync(() => viewport.dispatchEvent(wheel));
        assert.equal(wheel.defaultPrevented, true, "右栏内普通滚轮操作图表缩放");
        assert.match(host.textContent!, /125%/);
        assert.equal(host.querySelector('[aria-label="复制图表源码"]'), null, "源码操作由右栏页头提供");
      } finally { flushSync(() => previewRoot.unmount()); host.remove(); previewRendering = undefined; }
    });
    newBlock();
    await t.test("同明暗模式下更换主题仍重新绘制实际色值", async () => {
      harness.beautiful = source => { beautifulCalls++; return makeSvg(`${palette["--text"]} ${source}`); };
      render("graph TD; theme");
      await waitFor(() => document.querySelector(".markdown-mermaid text")?.textContent === "#1c1c21 graph TD; theme");
      const svg = document.querySelector(".markdown-mermaid svg");
      const before = beautifulCalls;
      palette["--text"] = "#262641";
      document.documentElement.dataset.base46Theme = "next-light";
      await waitFor(() => document.querySelector(".markdown-mermaid text")?.textContent === "#262641 graph TD; theme");
      assert.ok(beautifulCalls > before);
      assert.equal(document.querySelector(".markdown-mermaid svg"), svg, "主题重绘保留图表根节点");
      palette["--text"] = "#1c1c21";
    });
    newBlock();
    await t.test("右栏固定源码随当前主题重绘，缩放与 SVG root 保持不变", async () => {
      let opened: RenderingPreview | undefined;
      previewRendering = value => { opened = value; };
      harness.beautiful = source => makeSvg(`${palette["--text"]} ${source}`);
      render("graph TD; snapshot");
      await waitFor(() => document.querySelector(".markdown-mermaid text")?.textContent === "#1c1c21 graph TD; snapshot");
      flushSync(() => button("展开图表预览").click());
      const host = document.createElement("div"); document.body.append(host); const previewRoot = createRoot(host);
      try {
        flushSync(() => previewRoot.render(opened!.renderPreview()));
        const svg = host.querySelector(".markdown-mermaid svg");
        flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="放大图表"]')!.click());
        palette["--text"] = "#eeeeff";
        document.documentElement.dataset.base46Theme = "preview-dark";
        await waitFor(() => host.querySelector(".markdown-mermaid text")?.textContent === "#eeeeff graph TD; snapshot");
        assert.equal(host.querySelector(".markdown-mermaid svg"), svg);
        assert.equal(host.querySelector(".markdown-diagram-scale")?.textContent, "125%");
        render("graph TD; replacement");
        assert.equal(opened?.source, "graph TD; snapshot");
        assert.equal(host.querySelector(".markdown-mermaid text")?.textContent, "#eeeeff graph TD; snapshot");
      } finally { flushSync(() => previewRoot.unmount()); host.remove(); previewRendering = undefined; palette["--text"] = "#1c1c21"; }
    });
    newBlock();
    await t.test("渲染器返回的主动内容、外链和事件不可进入图表", async () => {
      harness.beautiful = () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">unsafe</div></foreignObject><image href="https://example.com/track"/><a href="javascript:alert(1)"><text onclick="alert(1)" style="fill:url(https://example.com/a)">safe label</text></a></svg>';
      render("graph TD; safe");
      await waitFor(() => !!document.querySelector(".markdown-mermaid svg"));
      assert.equal(document.querySelector(".markdown-mermaid script, .markdown-mermaid foreignObject, .markdown-mermaid image"), null);
      assert.equal(document.querySelector(".markdown-mermaid [onclick], .markdown-mermaid [href]"), null);
      assert.equal(document.querySelector(".markdown-mermaid text")?.textContent, "safe label");
      assert.doesNotMatch(document.querySelector(".markdown-mermaid")!.innerHTML, /https:|javascript:/);
    });
    newBlock();
    await t.test("美化渲染不支持的类型走严格标准渲染并读取实际主题色", async () => {
      harness.beautiful = () => { throw new Error("unsupported diagram"); };
      render("gantt\ntitle Release");
      await waitFor(() => document.querySelector(".markdown-mermaid text")?.textContent === "gantt\ntitle Release");
      assert.equal(config?.securityLevel, "strict");
      assert.equal(config?.theme, "base");
      assert.equal((config?.themeVariables as Record<string, unknown>)?.primaryColor, "#f1f1f4");
      assert.equal((config?.themeVariables as Record<string, unknown>)?.noteTextColor, "#96520a");
    });
    newBlock();
    await t.test("过期异步标准图不能覆盖更新的有效图", async () => {
      let resolveOld: ((value: { svg: string }) => void) | undefined;
      let startOld: (() => void) | undefined;
      const started = new Promise<void>(resolve => { startOld = resolve; });
      harness.render = async source => source.includes("old") ? new Promise(resolve => { resolveOld = resolve; startOld!(); }) : { svg: makeSvg(source) };
      render("gantt\ntitle old");
      await started;
      render("gantt\ntitle new");
      resolveOld!({ svg: makeSvg("gantt\ntitle old") });
      await waitFor(() => document.querySelector(".markdown-mermaid text")?.textContent === "gantt\ntitle new");
      assert.equal(document.querySelector(".markdown-mermaid text")?.textContent, "gantt\ntitle new");
      assert.equal(document.querySelectorAll('body > div[id^="dbiny-mermaid-"]').length, 0);
    });
  } finally { flushSync(() => root.unmount()); hooks.deregister(); dom.window.close(); Reflect.deleteProperty(globals, "diagramHarness"); }
});
