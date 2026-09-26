/** 原生模态 API 使用 DOM 替身；客户端层级和焦点视觉效果待人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("技能导入进入独立模态层，保留选择与忙碌关闭保护", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  await new Promise<void>((resolve) => dom.window.addEventListener("load", () => resolve(), { once: true }));
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.scrollTo = () => {};
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, (char) => `\\${char}`), supports: () => false }, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }

  const { createRoot } = await import("react-dom/client");
  const { SkillImportDialog } = await import("../src/desktop/renderer/src/components/SkillImportDialog.js");
  const { act, createElement } = React;
  const root = createRoot(document.getElementById("root")!);
  let closed = 0;
  let parentEscapes = 0;
  let imported: string[] = [];
  document.getElementById("root")!.addEventListener("keydown", () => { parentEscapes++; });
  const render = async (importing: boolean): Promise<void> => {
    await act(() => root.render(createElement(SkillImportDialog, {
      candidates: [{ id: "one", name: "One", description: "Example", path: "/skills/one", foundIn: [] }],
      importing, onClose: () => { closed++; }, onImport: (ids) => { imported = ids; }
    })));
  };
  try {
    await render(false);
    const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="导入已有技能"]');
    assert.ok(dialog?.open, "通过 showModal 进入原生顶层，不被设置侧栏遮挡");
    assert.equal(document.getElementById("root")!.contains(dialog), false, "脱离设置窗口的 DOM 和事件层级");
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(checkbox.checked, true);
    await act(() => checkbox.click());
    const submit = dialog.querySelector<HTMLButtonElement>(".is-primary")!;
    assert.equal(submit.disabled, true);
    await act(() => checkbox.click());
    await act(() => submit.click());
    assert.deepEqual(imported, ["one"]);
    await render(true);
    assert.equal(checkbox.disabled, true);
    await act(() => dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(closed, 0);
    await render(false);
    await act(() => dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(closed, 1);
    assert.equal(parentEscapes, 0, "Escape 不传播给底层设置窗口");
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
