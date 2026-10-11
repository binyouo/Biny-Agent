import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { ComponentProps } from "react";
import type { TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";

test("发送确认和运行状态变化保留气泡节点与入场模式；静态渲染无法发现交接重建", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div class='biny-chat-scroll' id='root'></div>", { pretendToBeVisual: true });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
  const style = dom.window.document.createElement("style");
  style.textContent = await readFile(new URL("../src/desktop/renderer/src/styles/chat.css", import.meta.url), "utf8");
  dom.window.document.head.append(style);
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js");
  const { buildSessionTimeline } = await import("../src/desktop/renderer/src/sessionTimeline.js");
  const root = createRoot(document.getElementById("root")!);
  const noop = (): void => {};
  const noopAsync = async (): Promise<void> => {};
  const events: AgentHostEvent[] = [];
  let sessionId: string | undefined;
  const render = async (pendingUserMessage?: { id: string; messageId: string; content: string }, turns = buildSessionTimeline([], events)): Promise<void> => {
    await React.act(() => root.render(React.createElement(MessageTimeline, {
      projectId: "project", sessionId, turns,
      pendingUserMessage, thinking: Boolean(pendingUserMessage),
      onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
      onAddQuoteToConversation: noopAsync, onResolvePermission: noopAsync, onRetry: noopAsync,
      onSwitchVersion: noopAsync, onEditRequest: noop, onRollbackFiles: noop
    })));
  };
  try {
    for (const messageId of ["first", "second"]) {
      const pending = { id: messageId, messageId, content: `消息 ${messageId} [链接](https://example.com)` };
      await render(pending);
      const article = document.querySelector(`[data-message-id='${messageId}']`)!;
      const bubble = article.querySelector(".user-bubble");
      const link = article.querySelector("a");
      assert.ok(bubble && link);
      const entryClass = article.className;
      const entryAnimation = dom.window.getComputedStyle(bubble).animation;
      assert.match(entryAnimation, /chat-user-message-enter/, "新提交消息只在挂载时入场");
      assert.equal(dom.window.getComputedStyle(article).animation, "", "入场不能作用到通栏消息行");
      assert.equal(article.getAttribute("aria-busy"), "true");
      assert.equal(article.querySelector('[aria-label="编辑消息"]'), null, "确认前不提供持久消息操作");
      sessionId = "session";
      await render(pending);
      assert.ok(document.querySelector(`[data-message-id='${messageId}']`) === article, "新会话身份回填不重建气泡");
      const base = { sessionId: "session", runId: `run-${messageId}`, timestamp: "2026-10-10T00:00:00.000Z" };
      events.push({ ...base, type: "message.user", messageId, content: pending.content });
      await render();
      assert.ok(document.querySelector(`[data-message-id='${messageId}']`) === article, "正式事件应原地接管临时消息，不能重建气泡");
      assert.equal(article.getAttribute("aria-busy"), null);
      for (const status of ["running", "waiting_permission", "completed", "running"] as const) {
        const turns = buildSessionTimeline([], events);
        turns[turns.length - 1]!.status = status;
        await render(undefined, turns);
        assert.ok(article.querySelector(".user-bubble") === bubble);
        assert.ok(article.querySelector("a") === link);
        assert.equal(dom.window.getComputedStyle(bubble).animation, entryAnimation, "状态变化不能切换动画规则");
        assert.equal(article.className, entryClass, "确认、等待审批与结束不得重新触发用户消息入场");
      }
      const restored: TimelineTurn[] = buildSessionTimeline([], events).map((turn) => ({ ...turn, id: `history-${turn.userMessageId}`, status: "completed" }));
      await render(undefined, restored);
      assert.ok(document.querySelector(`[data-message-id='${messageId}']`) === article, "历史投影回填仍保留用户消息节点");
    }
    await render({ id: "failed", messageId: "failed", content: "发送失败" });
    await render();
    assert.equal(document.querySelector("[data-message-id='failed']"), null, "失败撤回临时气泡");
    assert.equal(document.querySelectorAll(".user-bubble").length, 2, "已确认消息不重复展示");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("首条消息提交不把仍可输入的 Composer 淡出再淡入；气泡测试未覆盖工作区动画", async () => {
  const React = await import("react");
  const savedReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  const assets = registerHooks({ load(url, context, next) {
    return url.endsWith(".png") ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
  } });
  try {
    const { Workspace } = await import("../src/desktop/renderer/src/components/Workspace.js");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { JSDOM } = await import("jsdom");
    const css = await readFile(new URL("../src/desktop/renderer/src/styles/biny.css", import.meta.url), "utf8");
    const noop = (): void => {};
    const noopAsync = async (): Promise<void> => {};
    const props: ComponentProps<typeof Workspace> = {
      projectId: "project", turns: [], loading: false, runtimePanelOpen: false, thinking: false, running: false,
      pendingPrompt: { id: "first", messageId: "first", projectId: "project", text: "第一条消息" },
      onOpenProject: noop, onPreviewFile: noop, onRuntimePanelOpenChange: noop, onOpenExternal: noop,
      onReferenceMessage: noop, onShowMessageReferences: noop, onAddQuoteToConversation: noopAsync,
      onResolvePermission: noopAsync, onRetry: noopAsync, onSwitchVersion: noopAsync, onRetryRuntime: noopAsync,
      onEditRequest: noop, onDismissGenerationError: noop, onCreateBranch: noopAsync, onRollbackFiles: noop,
      onRuntimeError: noop, onRuntimeMutation: noopAsync, onRuntimeRefresh: noopAsync,
      onOpenRuntime: noop, onOpenExtensions: noop, children: React.createElement("textarea", { "aria-label": "消息" })
    };
    const dom = new JSDOM(`<!doctype html>${renderToStaticMarkup(React.createElement(Workspace, props))}`);
    try {
      const style = dom.window.document.createElement("style");
      style.textContent = css;
      dom.window.document.head.append(style);
      const composer = dom.window.document.querySelector(".biny-chat-composer")!;
      assert.equal(dom.window.getComputedStyle(composer).animation, "", "提交消息不应给整个输入区加淡入动画");
      assert.ok(composer.querySelector("textarea"));
      assert.equal(dom.window.document.querySelectorAll(".user-bubble").length, 1);
    } finally { dom.window.close(); }
  } finally {
    assets.deregister();
    if (savedReact) Object.defineProperty(globalThis, "React", savedReact);
    else Reflect.deleteProperty(globalThis, "React");
  }
});
