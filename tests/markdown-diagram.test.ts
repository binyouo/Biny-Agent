/** 图表使用外部渲染器替身验证公开控件，不依赖布局或截图。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
test("图表渲染完成提供复制、导出和缩放控件", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver });
  Object.assign(dom.window, { matchMedia: () => ({matches:false,addEventListener(){},removeEventListener(){}}) });
  const React = await import("react"); Object.assign(globalThis,{React});
  let themeConfig: { theme: string; themeVariables?: Record<string, string | boolean> } | undefined;
  const previousCapture = Object.getOwnPropertyDescriptor(globalThis, "captureDiagramTheme");
  Object.defineProperty(globalThis, "captureDiagramTheme", { configurable: true, value: (config: typeof themeConfig) => { themeConfig = config; } });
  const palette: Record<string, string> = { "--bg": "#f4f4f6", "--surface-soft": "#f1f1f4", "--text": "#1c1c21",
    "--border-strong": "#c8c8d2", "--text-secondary": "#4b4b53", "--accent-soft": "#eeedfd", "--accent": "#4f46e5",
    "--surface-raised": "#ffffff", "--amber-bg": "#fbf0df", "--amber-text": "#96520a", "--amber": "#b45309", "--border": "#e3e3e8" };
  const originalStyles = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = (element, pseudo) => element instanceof dom.window.HTMLElement && element.style.color.startsWith("var(")
    ? { color: palette[element.style.color.slice(4, -1)] } as CSSStyleDeclaration : originalStyles(element, pseudo);
  const hooks = registerHooks({
    resolve(s,c,next) { return s === "mermaid" ? {url:"test:mermaid",shortCircuit:true} : next(s,c); },
    load(u,c,next) { return u === "test:mermaid" ? {format:"module",shortCircuit:true,source:'export default {initialize(config){globalThis.captureDiagramTheme(config)},async render(){return {svg:"<svg viewBox=\\"0 0 10 10\\"><text>diagram</text></svg>"}}}'} : next(u,c); }
  });
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { MermaidBlock } = await import("../src/desktop/renderer/src/components/MermaidBlock.js");
  const root = createRoot(document.getElementById("root")!);
  try {
    flushSync(() => root.render(React.createElement(MermaidBlock,{code:"graph TD; A-->B"})));
    // 渲染器本身有 300ms debounce；以 DOM 事件观察完成，2s 为失败上限。
    await new Promise<void>((resolve,reject) => {
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error("diagram timeout"));},2000);
      const observer=new MutationObserver(()=>{if(document.querySelector(".markdown-mermaid svg")){clearTimeout(timer);observer.disconnect();resolve();}});
      observer.observe(document.body,{subtree:true,childList:true});
    });
    assert.ok(document.querySelector('button[aria-label="复制图表源码"]'));
    assert.ok(document.querySelector('button[aria-label="放大图表"]'));
    assert.ok(document.querySelector('button[aria-label="SVG"]'));
    assert.equal(themeConfig?.theme, "base");
    assert.equal(themeConfig?.themeVariables?.primaryColor, "#f1f1f4");
    assert.equal(themeConfig?.themeVariables?.primaryTextColor, "#1c1c21");
    assert.equal(themeConfig?.themeVariables?.secondaryColor, "#eeedfd");
    assert.equal(themeConfig?.themeVariables?.noteTextColor, "#96520a");
    assert.equal(themeConfig?.themeVariables?.darkMode, false);
  } finally {
    flushSync(()=>root.unmount()); hooks.deregister(); dom.window.close();
    if (previousCapture) Object.defineProperty(globalThis, "captureDiagramTheme", previousCapture); else Reflect.deleteProperty(globalThis, "captureDiagramTheme");
  }
});
