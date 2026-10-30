/** Real timeline menus carry their rendered source identity; no provider or Host. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";
const assets = registerHooks({ load(url, context, next) {
  return url.endsWith(".png") ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
} });
const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js").finally(() => assets.deregister());
test("消息分支菜单传递用户和助手自身 ID，无 ID 与运行中消息不可分支", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://biny.test", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  const calls: string[][] = [];
  const noop = (): void => undefined;
  const asyncNoop = async (): Promise<void> => undefined;
  const turn: TimelineTurn = { id: "turn", userMessageId: "user-id", assistantMessageId: "answer-id", user: "Question", assistant: "Answer",
    reasoning: "", skills: [], status: "completed", tools: [], steps: [] };
  const render = async (overrides: Partial<TimelineTurn> = {}) => act(() => root.render(React.createElement(MessageTimeline, {
    projectId: "origin-project", sessionId: "origin-session", turns: [{ ...turn, ...overrides }], thinking: false,
    onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
    onAddQuoteToConversation: asyncNoop, onResolvePermission: asyncNoop, onRetry: asyncNoop, onSwitchVersion: asyncNoop,
    onEditRequest: noop, onCreateBranch: (...args: string[]) => { calls.push(args); }, onRollbackFiles: noop
  })));
  const click = async (button: Element) => act(() => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  const branchButton = () => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes("创建分支"));
  try {
    await render();
    await click(document.querySelector('[aria-label="更多消息操作"]')!);
    assert.ok(branchButton()); await click(branchButton()!);
    assert.deepEqual(calls, [["origin-project", "origin-session", "user-id"]]);
    await click(document.querySelector('[aria-label="更多回复操作"]')!);
    assert.ok(branchButton()); await click(branchButton()!);
    assert.deepEqual(calls[1], ["origin-project", "origin-session", "answer-id"]);
    await render({ userMessageId: undefined, assistantMessageId: undefined });
    await click(document.querySelector('[aria-label="更多消息操作"]')!);
    assert.equal(branchButton(), undefined);
    await click(document.querySelector('[aria-label="更多消息操作"]')!);
    await click(document.querySelector('[aria-label="更多回复操作"]')!);
    assert.equal(branchButton(), undefined);
    await click(document.querySelector('[aria-label="更多回复操作"]')!);
    await render({ status: "running" });
    await click(document.querySelector('[aria-label="更多消息操作"]')!);
    assert.equal(branchButton(), undefined);
    assert.equal(document.querySelector('[aria-label="更多回复操作"]'), null);
  } finally {
    await act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
