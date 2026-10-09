/** 排队消息键盘重排的 DOM 回归；视觉验收由用户完成。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("Alt+上下方向键在内容按钮上重排队列，首尾越界不触发", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { QueuedMessages } = await import("../src/desktop/renderer/src/components/composer/QueuedMessages.js");
  const { act, createElement } = React;
  const moves: [string, string, boolean][] = [];
  const messages = ["a", "b", "c"].map((id) => ({ messageId: id, content: `消息 ${id}`, attachmentCount: 0 }));
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(createElement(QueuedMessages, { messages, running: false, onError() {}, onRemove: async () => {}, onSendNow: async () => {}, onSteer: async () => {}, onUpdate: async () => {},
        onMove: async (id: string, target: string, after: boolean) => { moves.push([id, target, after]); } }));
    });
    const contents = [...document.querySelectorAll<HTMLButtonElement>(".biny-queued-message-content")];
    const press = async (el: Element, key: string, altKey = true): Promise<void> => {
      await act(async () => { el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, altKey, bubbles: true, cancelable: true })); });
    };
    await press(contents[1]!, "ArrowUp");
    await press(contents[1]!, "ArrowDown");
    await press(contents[0]!, "ArrowUp");
    await press(contents[2]!, "ArrowDown");
    await press(contents[1]!, "ArrowUp", false);
    assert.deepEqual(moves, [["b", "a", false], ["b", "c", true]]);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
