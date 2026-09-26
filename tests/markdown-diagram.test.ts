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
  const hooks = registerHooks({
    resolve(s,c,next) { return s === "mermaid" ? {url:"test:mermaid",shortCircuit:true} : next(s,c); },
    load(u,c,next) { return u === "test:mermaid" ? {format:"module",shortCircuit:true,source:'export default {initialize(){},async render(){return {svg:"<svg viewBox=\\"0 0 10 10\\"><text>diagram</text></svg>"}}}'} : next(u,c); }
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
  } finally { flushSync(()=>root.unmount()); hooks.deregister(); dom.window.close(); }
});
