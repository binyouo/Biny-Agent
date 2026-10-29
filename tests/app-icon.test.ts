import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const { AppIcon } = await import("../src/desktop/renderer/src/components/AppIcon.js");

test("萌宠按活动切换倾听与休息姿态，隐藏和卸载停止展示任务", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual:true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key,value] of Object.entries({ window:dom.window, document:dom.window.document, React, IS_REACT_ACT_ENVIRONMENT:true })) {
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,value});
  }
  let mediaChanged: (() => void) | undefined;
  const media = { matches:false, addEventListener(_event: string, listener: () => void) { mediaChanged=listener; }, removeEventListener() { mediaChanged=undefined; } };
  Object.defineProperty(dom.window, "matchMedia", { value:() => media });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (props: Record<string, unknown> = {}) => {
    await act(() => root.render(React.createElement(AppIcon,{size:48,animated:true,...props})));
  };
  const state = () => dom.window.document.querySelector(".app-icon")?.getAttribute("data-state");
  try {
    await render();
    assert.equal(state(),"idle", "初始不展示休息姿态");
    await act(() => context.mock.timers.tick(60_000));
    assert.equal(state(),"sleep", "空闲计时结束后进入休息姿态");
    await act(() => dom.window.dispatchEvent(new dom.window.Event("pointerdown")));
    assert.equal(state(),"idle", "指针活动唤醒");
    await render({active:true});
    await act(() => context.mock.timers.tick(60_000));
    assert.equal(state(),"listen", "运行中不能因空闲计时进入休息姿态");
    await render({active:false});
    assert.equal(state(),"idle");
    Object.defineProperty(dom.window.document,"hidden",{configurable:true,value:true});
    await act(() => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    assert.equal(dom.window.document.querySelector(".app-icon")?.getAttribute("data-paused"),"true");
    Object.defineProperty(dom.window.document,"hidden",{configurable:true,value:false});
    media.matches=true;
    await act(() => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); mediaChanged?.(); });
    await render();
    await act(() => context.mock.timers.tick(60_000));
    assert.equal(state(),"idle", "减少动态效果时不启动睡眠计时");
    media.matches=false;
    await act(() => mediaChanged?.());
    assert.equal(state(),"idle");
    await act(() => root.unmount());
    assert.equal(mediaChanged,undefined);
    await act(() => context.mock.timers.tick(60_000));
    assert.equal(dom.window.document.getElementById("root")!.childElementCount,0);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key,value] of saved) {
      if (value) Object.defineProperty(globalThis,key,value);
      else Reflect.deleteProperty(globalThis,key);
    }
  }
});
