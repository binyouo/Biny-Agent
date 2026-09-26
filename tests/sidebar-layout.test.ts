/** 侧栏按钮直接调用控制器公开入口；fake clock 验证阶段切换，不替代界面人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { useSidebarLayout } from "../src/desktop/renderer/src/app/useSidebarLayout.js";
import { SIDEBAR_PEEK_OPEN_DELAY_MS, SIDEBAR_PEEK_PINNING_MS } from "../src/desktop/sidebarSizing.js";

test("按钮展开不借道预览浮层，快速反向与预览固定均保留最终意图", async (context) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let controller!: ReturnType<typeof useSidebarLayout>;
  function Harness(): null { controller = useSidebarLayout(); return null; }
  const toggle = async (): Promise<void> => { await act(() => controller.toggle()); };
  const advance = async (ms: number): Promise<void> => { await act(() => context.mock.timers.tick(ms)); };
  try {
    await act(() => root.render(createElement(Harness)));
    const handlers = { drawer: controller.drawerHandlers, trigger: controller.triggerHandlers };
    await act(() => root.render(createElement(Harness)));
    assert.equal(controller.drawerHandlers, handlers.drawer, "无关父层更新不应破坏侧栏渲染缓存");
    assert.equal(controller.triggerHandlers, handlers.trigger, "预览触发器回调集合应保持稳定");
    assert.equal(controller.layout.mode, "expanded");
    await toggle();
    assert.equal(controller.layout.mode, "collapsed");
    await toggle();
    assert.equal(controller.layout.mode, "expanded", "普通展开不应短暂添加抽屉层与阴影");
    assert.equal(controller.layout.transition, "idle");
    await toggle();
    assert.equal(controller.layout.mode, "collapsed", "展开途中也能立刻收起");
    await advance(SIDEBAR_PEEK_PINNING_MS * 2);
    assert.equal(controller.layout.mode, "collapsed", "旧定时器不能重新打开侧栏");

    // 直接调用悬停意图回调，验证真实预览才使用固定过程。
    await act(() => controller.triggerHandlers.onPointerEnter({} as React.PointerEvent<HTMLElement>));
    await advance(SIDEBAR_PEEK_OPEN_DELAY_MS);
    assert.equal(controller.layout.mode, "peek");
    await toggle();
    assert.equal(controller.layout.transition, "pinning");
    await toggle();
    assert.equal(controller.layout.mode, "collapsed", "预览固定途中也能反向收起");
    await advance(SIDEBAR_PEEK_PINNING_MS * 2);
    assert.equal(controller.layout.mode, "collapsed");

    await act(() => controller.triggerHandlers.onPointerEnter({} as React.PointerEvent<HTMLElement>));
    await advance(SIDEBAR_PEEK_OPEN_DELAY_MS);
    await toggle();
    await advance(499);
    assert.equal(controller.layout.transition, "pinning", "500ms 推开完成前不能把预览换回流内");
    await advance(1);
    assert.equal(controller.layout.mode, "expanded");
    assert.equal(controller.layout.transition, "idle");
  } finally {
    await act(() => root.unmount());
    context.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
