/** HTML 文件默认阅读源码，运行需显式进入浏览器。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("HTML 文件默认代码阅读，运行页面动作明确指向选中文件", async () => {
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewPanel } = await import("../src/desktop/renderer/src/components/workspace/FilePreviewPanel.js");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://desktop.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const opened: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  const file = { path: "pages/game.html", content: "<script>play()</script>", bytes: 23, binary: false, truncated: false };
  const props = { projectId: "p", width: 600, directoryStates: new Map(), expandedDirectories: new Set<string>(),
    onOpenFile() {}, onPreviewFile() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}, onRunHtml: (path: string) => opened.push(path) };
  try {
    await React.act(async () => root.render(React.createElement(FilePreviewPanel, { ...props, preview: { source: "p:s", path: file.path, status: "ready", file, revision: 1 } })));
    assert.equal(document.querySelector("iframe"), null, "HTML 默认是稳定的源码阅读视图");
    assert.match(document.body.textContent ?? "", /play\(\)/u);
    await React.act(async () => (document.querySelector('[aria-label="运行页面"]') as HTMLButtonElement).click());
    assert.deepEqual(opened, [file.path]);
    await React.act(async () => (document.querySelector('[aria-label="关闭当前文件"]') as HTMLButtonElement).click());
    assert.equal(document.querySelector("iframe"), null);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
