/** DOM 单元测试仅验证菜单交互契约，不代替客户端视觉验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
test("上下文菜单支持键盘展开、显示真实清单并用 Escape 收起", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://localhost" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { MessageContextMenu } = await import("../src/desktop/renderer/src/components/chat/MessageContextMenu.js");
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(async () => root.render(React.createElement(MessageContextMenu, { tools: ["Bash", "Bash", "Skill"], skills: ["references"] })));
    const button = document.querySelector<HTMLButtonElement>("button")!;
    await React.act(async () => button.focus());
    assert.equal(button.getAttribute("aria-expanded"), "true");
    const panel = document.querySelector('[aria-label="本轮上下文"]')!;
    assert.equal(panel.parentElement, document.body, "浮层脱离菜单动画的 transform 包含块");
    assert.match(panel.textContent!, /Bash/); assert.match(panel.textContent!, /技能调用/); assert.match(panel.textContent!, /references/);
    await React.act(async () => button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[aria-label="本轮上下文"]'), null);
    const dialogHook = registerHooks({
      resolve(specifier, context, next) { return specifier === "@astryxdesign/core/Dialog" ? { url: "trace-test:dialog", shortCircuit: true } : next(specifier, context); },
      load(url, context, next) { return url === "trace-test:dialog" ? { format: "module", source: "export function Dialog(p){return globalThis.React.createElement('div',{role:'dialog'},p.children)};export function DialogHeader(p){return globalThis.React.createElement('h2',null,p.title)}", shortCircuit: true } : next(url, context); }
    });
    try {
      let calls = 0;
      Object.assign(dom.window, { biny: { readSessionTrace: async (project: string, session: string) => {
        assert.equal(project,"p"); assert.equal(session,"s");
        if (++calls === 1) throw new Error("磁盘暂不可读");
        return [{type:"user_message",content:"go",messageId:"u"},{type:"model_request",metrics:{requestId:"fresh",provider:"p",modelId:"m",startedAt:"2026-09-25T00:00:00Z",durationMs:1000,attempts:[],eventCount:1,requestContext:{operation:"agent"}}},{type:"assistant_message",content:"done",messageId:"a",replyToMessageId:"u"}];
      } } });
      const { ExecutionTraceDialog } = await import("../src/desktop/renderer/src/components/chat/ExecutionTraceDialog.js");
      await React.act(async () => root.render(React.createElement(ExecutionTraceDialog, { projectId:"p",sessionId:"s",onClose(){},turn:{id:"history-1",user:"go",userMessageId:"u",assistantMessageId:"a",assistant:"done",reasoning:"",skills:[],status:"completed",tools:[],steps:[]} })));
      assert.match(document.querySelector('[role="alert"]')!.textContent!,/磁盘暂不可读/);
      await React.act(async () => (document.querySelector('[role="alert"] button') as HTMLButtonElement).click());
      assert.equal(calls,2);
      assert.equal(document.querySelectorAll('.trace-step-heading').length,1,"重新读取磁盘明细替换旧的零请求投影");
      assert.match(document.body.textContent!,/p\/m/);
      assert.doesNotMatch(document.body.textContent!,/fresh|HTTP 状态|缓存命中/);
    } finally { dialogHook.deregister(); }

  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
