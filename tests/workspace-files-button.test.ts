import assert from "node:assert/strict";
import { test } from "node:test";

test("顶部文件入口不依赖会话变更，点击打开文件面板", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFilesButton } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceFilesButton.js");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  let opened = 0;
  const props = { inspectorOpen: false, onOpenFiles() { opened++; } };
  try {
    await React.act(async () => root.render(React.createElement(WorkspaceFilesButton, props)));
    const button = document.querySelector<HTMLButtonElement>(".biny-files-trigger");
    assert.ok(button);
    assert.equal(button.getAttribute("aria-label"), "打开文件");
    assert.equal(button.getAttribute("aria-haspopup"), null);
    await React.act(async () => button.click());
    assert.equal(opened, 1);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("文件面板展开时顶部入口退出交互，并将键盘焦点交给面板", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div><div class="desktop-inspector"><button role="tab" aria-selected="true">文件</button></div>', { url: "https://desktop.local" });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceFilesButton } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceFilesButton.js");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  const props = { onOpenFiles() {} };
  try {
    await React.act(async () => root.render(React.createElement(WorkspaceFilesButton, { ...props, inspectorOpen: false })));
    const trigger = document.querySelector<HTMLButtonElement>(".biny-files-trigger");
    assert.ok(trigger);
    trigger.focus();
    await React.act(async () => root.render(React.createElement(WorkspaceFilesButton, { ...props, inspectorOpen: true })));
    assert.equal(trigger.getAttribute("aria-hidden"), "true");
    assert.equal(trigger.tabIndex, -1);
    assert.equal(document.activeElement?.textContent, "文件");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
