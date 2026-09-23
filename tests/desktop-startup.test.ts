/** 启动过渡的生命周期契约；这里只验证 DOM 状态，视觉和交互仍由人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SIDEBAR_LAYOUT, resolveSidebarLayout } from "../src/desktop/sidebarLayout.js";

test("启动直接保留聊天布局，分区淡入后不重建正文，后续导航不重播", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://localhost/" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let reducedMotion = false;
  // Chromium 提供标准 AnimationEvent；jsdom 缺少它时 React 会选择旧 webkit 事件名。
  Object.defineProperty(dom.window, "AnimationEvent", { value: dom.window.Event });
  dom.window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") && reducedMotion,
    media: query,
    addEventListener() {},
    removeEventListener() {}
  })) as unknown as typeof window.matchMedia;
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "getComputedStyle", "matchMedia"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globals, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
  }
  const React = await import("react");
  const { createElement, StrictMode, act } = React;
  for (const [key, value] of Object.entries({ React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globals, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { DesktopShell } = await import("../src/desktop/renderer/src/components/DesktopShell.js");
  const root = createRoot(document.getElementById("root")!);
  const render = async (starting: boolean, content = "历史正文", key = "main", chat = true): Promise<void> => {
    await act(() => root.render(createElement(StrictMode, {}, createElement(DesktopShell, {
      key,
      starting,
      sidebarLayout: resolveSidebarLayout(DEFAULT_SIDEBAR_LAYOUT),
      theme: "light",
      sideNav: createElement("nav", {}, "会话列表"),
      children: chat ? createElement("div", { className: "biny-workspace-chat" },
        createElement("header", { className: "biny-chat-toolbar" }, "标题"),
        createElement("div", { className: "biny-chat-body" }, createElement("p", {}, content)),
        createElement("div", { className: "biny-chat-composer" }, "模型与输入区")) : createElement("p", {}, content)
    }))));
  };
  try {
    await render(true);
    const body = document.querySelector("main p");
    assert.ok(body);
    assert.equal(document.querySelector(".biny-app-shell")?.hasAttribute("inert"), true);
    assert.equal(document.querySelector("main")?.getAttribute("aria-busy"), "true");
    assert.equal(document.querySelector('[role="status"]'), null);
    assert.ok(!document.querySelector(".biny-startup-loading"), "不应插入独立加载画面");

    // 就绪由 bootstrap 的完成或失败触发；不等待动画才解除内容的 inert。
    await render(false);
    assert.equal(document.querySelector(".biny-app-shell")?.hasAttribute("inert"), false);
    assert.equal(document.querySelector("main p"), body);
    assert.equal(document.querySelector('[role="status"]'), null);
    const completed = new dom.window.Event("animationend", { bubbles: true });
    Object.defineProperty(completed, "animationName", { value: "biny-startup-reveal" });
    await act(() => { document.querySelector(".biny-chat-body")!.dispatchEvent(completed); });
    assert.equal(document.querySelector("[data-startup]")?.getAttribute("data-startup"), "revealing", "正文先完成时不能使输入区突然出现");
    await act(() => { document.querySelector(".biny-chat-composer")!.dispatchEvent(completed); });
    await render(false, "另一个会话");
    assert.equal(document.querySelector("main p"), body);
    assert.equal(document.querySelector("[data-startup]"), null);
    assert.equal(body.textContent, "另一个会话");

    // 恢复到扩展页时没有输入区，由主区自己的动画完成清理。
    await render(true, "扩展", "extensions", false);
    await render(false, "扩展", "extensions", false);
    await act(() => { document.querySelector("main")!.dispatchEvent(completed); });
    assert.equal(document.querySelector("[data-startup]"), null);

    // 减少动态效果时没有 animationend，仍须直接结束启动状态。
    reducedMotion = true;
    await render(true, "启动错误也可见", "reduced");
    await render(false, "启动错误也可见", "reduced");
    assert.ok(!document.querySelector(".biny-startup-loading"));
    assert.equal(document.querySelector("[data-startup]"), null);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
});
