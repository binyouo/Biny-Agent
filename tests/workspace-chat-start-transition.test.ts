/** 欢迎页首发只改变展示；使用原生动画替身检查交接和清理，视觉仍由人工验收。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { ComponentProps } from "react";

test("欢迎页首发连续移动输入框，保留气泡与退场内容，回执接管不重播", async () => {
  const h = await fixture();
  try {
    await h.render({ heroStart: true });
    const composer = document.querySelector(".biny-chat-composer");
    const input = composer?.querySelector("textarea");
    const hero = document.querySelector(".biny-hero");
    await h.render({ heroStart: true, pendingPrompt: h.pending });
    assert.equal(document.querySelector(".biny-workspace-main")?.classList.contains("is-hero"), false, "发送立即切换到对话布局，不等待回执");
    assert.equal(document.querySelector(".biny-chat-composer"), composer);
    assert.equal(composer?.querySelector("textarea"), input);
    assert.equal(document.querySelector(".biny-hero"), hero, "原欢迎内容保留到淡出完成");
    assert.equal(hero?.getAttribute("aria-hidden"), "true");
    const move = h.animations.find(item => item.element === composer);
    assert.ok(move, "输入框从欢迎页位置移到聊天底部");
    assert.deepEqual(move.keyframes, [{ transform: "translate(0px, -220px)", width: "630px" }, { transform: "translate(0px, 0px)", width: "1096px" }]);
    assert.equal(move.options.duration, 500);
    assert.equal(move.options.easing, "cubic-bezier(0.32, 0.72, 0, 1)");
    const bubble = document.querySelector(".user-bubble");
    assert.ok(h.animations.some(item => item.element === bubble), "实际用户气泡参与入场，不另建预览副本");
    assert.equal(document.querySelectorAll(".user-bubble").length, 1);
    const count = h.animations.length;
    await h.render({ heroStart: false, sessionId: "session", pendingPrompt: { ...h.pending, sessionId: "session" } });
    assert.equal(document.querySelector(".user-bubble"), bubble);
    assert.equal(h.animations.length, count);
    assert.equal(move.cancelled, false, "新会话回执不能中断正在进行的位移");
    const { buildSessionTimeline } = await import("../src/desktop/renderer/src/sessionTimeline.js");
    await h.render({ heroStart: false, sessionId: "session", turns: buildSessionTimeline([
      { type: "user_message", messageId: "first", content: "hi" }
    ], []) });
    assert.equal(document.querySelector(".user-bubble"), bubble, "正式消息复用正在入场的气泡");
    assert.equal(h.animations.length, count);
    assert.equal(move.cancelled, false, "清理发送占位不结束本次过渡");
    await h.React.act(() => { h.animations.find(item => item.element === hero)?.finish(); });
    assert.equal(document.querySelector(".biny-hero"), null);
    assert.equal(move.cancelled, false, "欢迎内容退场后输入框继续移动");
    await h.React.act(() => { move.finish(); });
    assert.equal((composer as HTMLElement).style.willChange, "");
  } finally { await h.close(); }
});

for (const reason of ["失败", "切换会话", "切换项目", "减少动态效果", "卸载"] as const) {
  test(`首发过渡在${reason}时清理，不能影响后续页面`, async () => {
    const h = await fixture();
    let closed = false;
    try {
      await h.render({ heroStart: true });
      await h.render({ heroStart: true, pendingPrompt: h.pending });
      assert.ok(h.animations.length > 0);
      if (reason === "失败") {
        await h.render({ heroStart: true });
        assert.ok(document.querySelector(".biny-workspace-main.is-hero"));
        assert.equal(document.querySelector(".biny-hero")?.getAttribute("aria-hidden"), null);
        assert.equal(document.querySelector(".user-bubble"), null);
      } else if (reason === "切换会话") {
        await h.render({ heroStart: false, sessionId: "other-session" });
        assert.equal(document.querySelector(".biny-hero"), null);
      } else if (reason === "切换项目") {
        await h.render({ heroStart: true, projectId: "other-project" });
        assert.ok(document.querySelector(".biny-workspace-main.is-hero"));
        assert.equal((document.querySelector(".biny-hero") as HTMLElement).style.top, "");
      } else if (reason === "减少动态效果") {
        await h.React.act(() => { h.reduceMotion(); });
        assert.equal(document.querySelector(".biny-hero"), null);
        assert.equal(document.querySelectorAll(".user-bubble").length, 1);
      } else {
        await h.close(); closed = true;
      }
      assert.ok(h.animations.every(item => item.cancelled), "退出必须取消所有旧动画");
      if (reason === "失败") {
        const count = h.animations.length;
        await h.render({ heroStart: true, pendingPrompt: { ...h.pending, id: "retry", messageId: "retry" } });
        assert.ok(h.animations.length > count, "失败后重新发送仍有完整过渡");
      }
    } finally { if (!closed) await h.close(); }
  });
}

test("减少动态效果时首发直接呈现", async () => {
  const h = await fixture();
  try {
    h.reduceMotion();
    await h.render({ heroStart: true });
    await h.render({ heroStart: true, pendingPrompt: h.pending });
    assert.equal(h.animations.length, 0);
    assert.equal(document.querySelector(".biny-hero"), null);
    assert.equal(document.querySelectorAll(".user-bubble").length, 1);
  } finally { await h.close(); }
});

test("从已有会话发送不使用欢迎页过渡", async () => {
  const h = await fixture();
  try {
    await h.render({ heroStart: false, sessionId: "session" });
    await h.render({ heroStart: false, sessionId: "session", pendingPrompt: { ...h.pending, sessionId: "session" } });
    assert.equal(h.animations.length, 0);
  } finally { await h.close(); }
});

async function fixture() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const mediaListeners = new Set<() => void>();
  const media = { matches: false, addEventListener(_type: string, listener: () => void) { mediaListeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { mediaListeners.delete(listener); } };
  const animations: Array<{ element: HTMLElement; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean; onfinish?: () => void; finish(): void; cancel(): void }> = [];
  class ResizeObserverStub { observe() {} disconnect() {} unobserve() {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.matchMedia = () => media as unknown as MediaQueryList;
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.HTMLElement.prototype.animate = function (keyframes, options) {
    const animation = { element: this, keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions,
      cancelled: false, onfinish: undefined as (() => void) | undefined,
      finish() { if (!this.cancelled) this.onfinish?.(); }, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation as unknown as Animation;
  };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hero = this.closest(".biny-workspace-main")?.classList.contains("is-hero");
    if (this.classList.contains("biny-chat-composer")) return new dom.window.DOMRect(hero ? 482 : 249, hero ? 470 : 690, hero ? 630 : 1096, 128);
    if (this.classList.contains("biny-hero")) return new dom.window.DOMRect(237, 258, 1120, 212);
    if (this.classList.contains("user-bubble")) return new dom.window.DOMRect(1249, 72, 44, 48);
    return new dom.window.DOMRect(237, 52, 1120, 776);
  };
  const assets = registerHooks({ load(url, context, next) {
    return /\.(png|svg)$/u.test(url) ? { format: "module", source: 'export default "asset";', shortCircuit: true } : next(url, context);
  } });
  const { Workspace } = await import("../src/desktop/renderer/src/components/Workspace.js");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const noop = (): void => {};
  const noopAsync = async (): Promise<void> => {};
  const props: ComponentProps<typeof Workspace> = {
    projectId: "project", turns: [], loading: false, runtimePanelOpen: false, thinking: false, running: false,
    onOpenProject: noop, onPreviewFile: noop, onRuntimePanelOpenChange: noop, onOpenExternal: noop,
    onReferenceMessage: noop, onShowMessageReferences: noop, onAddQuoteToConversation: noopAsync,
    onResolvePermission: noopAsync, onRetry: noopAsync, onSwitchVersion: noopAsync, onRetryRuntime: noopAsync,
    onEditRequest: noop, onDismissGenerationError: noop, onCreateBranch: noopAsync, onRollbackFiles: noop,
    onRuntimeError: noop, onRuntimeMutation: noopAsync, onRuntimeRefresh: noopAsync,
    onOpenRuntime: noop, onOpenExtensions: noop, children: React.createElement("textarea", { "aria-label": "消息" })
  };
  return { React, animations, pending: { id: "first", messageId: "first", projectId: "project", text: "hi" },
    reduceMotion() { media.matches = true; for (const listener of mediaListeners) listener(); },
    async render(extra: Partial<ComponentProps<typeof Workspace>>) { await React.act(() => root.render(React.createElement(Workspace, { ...props, ...extra }))); },
    async close() {
      await React.act(() => root.unmount());
      assert.equal(mediaListeners.size, 0, "卸载后释放动态效果偏好的监听");
      dom.window.close(); assets.deregister();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}
