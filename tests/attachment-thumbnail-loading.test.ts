import assert from "node:assert/strict";
import { test } from "node:test";

test("图片消息先读缩略图，仅在用户展开时读取原图", async () => {
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AttachmentCard } = await import("../src/desktop/renderer/src/components/AttachmentCard.js");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://desktop.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const calls: Array<boolean | undefined> = [];
  Object.assign(dom.window, { biny: { readInlineImage: async (_project: string, _path: string, thumbnail?: boolean) => {
    calls.push(thumbnail);
    return "data:image/png;base64,AA==";
  } } });
  Object.assign(dom.window.HTMLDialogElement.prototype, { showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); } });
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(async () => root.render(React.createElement(AttachmentCard, { projectId: "thumb-project", attachment: {
      name: "photo.png", path: "@attachments/unique-thumb-photo.png", mimeType: "image/png", size: 500_000
    } })));
    assert.deepEqual(calls, [true]);
    await React.act(async () => (document.querySelector(".attachment-card-main") as HTMLButtonElement).click());
    assert.deepEqual(calls, [true, false]);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
